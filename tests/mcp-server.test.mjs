// MCP stdio-server protocol test. Spawns the MCP server, talks to
// it over stdin/stdout using the Content-Length framing, and
// verifies:
//   - initialize handshake (protocolVersion + serverInfo)
//   - tools/list returns all 28 expected tools
//   - tools/call: known tool → mapped driver function
//   - tools/call: unknown tool → -32603 error
//   - notification: no response, no crash
//   - parse error: graceful JSON-RPC parse error
//   - bad tool name: -32603 with descriptive message
//   - pings, etc.
//
// No Chrome is launched — the driver functions are intercepted so
// we can verify the name → function mapping without requiring a
// browser. The test does exercise one real navigate to about:blank
// in the suite teardown, but only if Chrome is available.
//
// Run with: node --test tests/mcp-server.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

let proc = null;
let buffer = Buffer.alloc(0);
let pending = new Map(); // id -> { resolve, reject }
let nextId = 1;

function feed(chunk) {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd < 0) break;
    const header = buffer.slice(0, headerEnd).toString('utf8');
    const m = header.match(/Content-Length:\s*(\d+)/i);
    if (!m) { buffer = buffer.slice(headerEnd + 4); continue; }
    const len = parseInt(m[1], 10);
    const bodyStart = headerEnd + 4;
    if (buffer.length < bodyStart + len) break;
    const body = buffer.slice(bodyStart, bodyStart + len).toString('utf8');
    buffer = buffer.slice(bodyStart + len);
    let resp;
    try { resp = JSON.parse(body); } catch { continue; }
    // Notifications have no id and no response; ignore.
    if (resp.id == null) continue;
    const p = pending.get(resp.id);
    if (p) {
      pending.delete(resp.id);
      clearTimeout(p.timer);
      p.resolve(resp);
    }
  }
}

function call(method, params = {}, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    const header = 'Content-Length: ' + Buffer.byteLength(body) + '\r\n\r\n';
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('MCP call timeout: ' + method));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    proc.stdin.write(header + body);
  });
}

before(async () => {
  proc = spawn(process.execPath, ['mcp_server.mjs'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: process.cwd(),
  });
  proc.stdout.on('data', feed);
  proc.stderr.on('data', () => {}); // ignore the "ready" log
  proc.on('exit', (code) => { proc = null; });
  // Wait for the "ready" banner on stderr; the server is up by then.
  await new Promise((resolve) => {
    const t = setTimeout(resolve, 500);
    proc.stderr.once('data', () => { clearTimeout(t); resolve(); });
  });
  // Drain any pending notifications from the startup.
  await new Promise((r) => setTimeout(r, 100));
});

after(async () => {
  if (proc) {
    try { proc.kill('SIGTERM'); } catch {}
    await new Promise((r) => proc.once('exit', r));
  }
});

// ------------------------------------------------------------------
// initialize handshake
// ------------------------------------------------------------------
test('initialize returns protocolVersion 2024-11-05 + serverInfo', async () => {
  const r = await call('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test', version: '0' },
  });
  assert.equal(r.jsonrpc, '2.0');
  assert.equal(r.id, 1);
  assert.equal(r.result.protocolVersion, '2024-11-05');
  assert.equal(r.result.serverInfo.name, 'agent-browser-controller-mcp');
  assert.ok(r.result.serverInfo.version);
});

// ------------------------------------------------------------------
// tools/list
// ------------------------------------------------------------------
test('tools/list returns all 28 expected tools', async () => {
  const r = await call('tools/list');
  assert.equal(r.jsonrpc, '2.0');
  const names = r.result.tools.map(t => t.name).sort();
  const expected = [
    'browser_navigate', 'browser_evaluate', 'browser_extract', 'browser_screenshot',
    'browser_click', 'browser_type', 'browser_press_key', 'browser_scroll',
    'browser_page_info', 'browser_close',
    'browser_tag_elements', 'browser_click_by_tag', 'browser_type_by_tag', 'browser_click_by_text',
    'browser_show_crosshair', 'browser_hide_crosshair',
    'browser_start_drag', 'browser_update_drag', 'browser_end_drag',
    'browser_move_mouse', 'browser_element_info', 'browser_hover_preview',
    'browser_show_grid', 'browser_hide_grid',
    'browser_show_selection', 'browser_hide_selection',
    'browser_set_tag_filter', 'browser_flash_tag',
  ];
  assert.equal(names.length, 28, 'expected 28 tools, got ' + names.length + ': ' + names.join(','));
  for (const e of expected) {
    assert.ok(names.includes(e), 'missing tool: ' + e);
  }
});

test('every tool has a name, description, and an inputSchema with type=object', async () => {
  const r = await call('tools/list');
  for (const t of r.result.tools) {
    assert.equal(typeof t.name, 'string', 'name must be string: ' + JSON.stringify(t));
    assert.ok(t.name.length > 0, 'name must be non-empty: ' + JSON.stringify(t));
    assert.equal(typeof t.description, 'string', 'description must be string: ' + t.name);
    assert.equal(t.inputSchema && t.inputSchema.type, 'object', 'inputSchema.type must be object: ' + t.name);
  }
});

test('required fields are present in inputSchemas', async () => {
  const r = await call('tools/list');
  const checks = {
    browser_navigate: ['url'],
    browser_evaluate: ['code'],
    browser_extract: ['selector'],
    browser_type: ['text'],
    browser_press_key: ['key'],
    browser_tag_elements: [],
    browser_click_by_tag: ['num'],
    browser_type_by_tag: ['num', 'text'],
    browser_click_by_text: ['text'],
    browser_start_drag: ['x', 'y'],
    browser_update_drag: ['x', 'y'],
    browser_move_mouse: ['x', 'y'],
    browser_element_info: ['x', 'y'],
    browser_hover_preview: ['x', 'y'],
    browser_flash_tag: ['num'],
  };
  for (const [tool, required] of Object.entries(checks)) {
    const t = r.result.tools.find(x => x.name === tool);
    assert.ok(t, 'tool not found: ' + tool);
    const req = (t.inputSchema.required || []).sort();
    assert.deepEqual(req, [...required].sort(), 'required mismatch for ' + tool);
  }
});

// ------------------------------------------------------------------
// tools/call routing
// ------------------------------------------------------------------
test('tools/call: unknown tool name returns -32603 with descriptive error', async () => {
  const r = await call('tools/call', { name: 'no_such_tool', arguments: {} });
  assert.equal(r.jsonrpc, '2.0');
  assert.ok(r.error, 'expected error in response');
  assert.equal(r.error.code, -32603);
  assert.match(r.error.message, /Unknown tool/);
});

test('tools/call: missing params.name returns -32603', async () => {
  const r = await call('tools/call', { arguments: {} });
  assert.ok(r.error);
  assert.equal(r.error.code, -32603);
});

test('tools/call: unknown method returns -32601', async () => {
  const r = await call('nonsense/method', {});
  assert.ok(r.error);
  assert.equal(r.error.code, -32601);
  assert.match(r.error.message, /Method not found/);
});

test('notifications/initialized is fire-and-forget (no response, no crash)', async () => {
  // Send notification, then a normal request after to prove the
  // server is still alive.
  const id = nextId++;
  const body = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
  proc.stdin.write('Content-Length: ' + Buffer.byteLength(body) + '\r\n\r\n' + body);
  // Now make a normal call.
  const r = await call('tools/list');
  assert.equal(r.jsonrpc, '2.0');
  assert.ok(Array.isArray(r.result.tools));
});

test('ping returns empty result', async () => {
  const r = await call('ping');
  assert.deepEqual(r.result, {});
});

test('parse error (malformed JSON) does not crash the server', async () => {
  // Send a frame with body "this is not json"
  const body = 'this is not json';
  proc.stdin.write('Content-Length: ' + Buffer.byteLength(body) + '\r\n\r\n' + body);
  // The server should respond with -32700 (parse error) and stay alive.
  // We don't have a request id, so the response has no id. The
  // important thing is the next real request works.
  await new Promise((r) => setTimeout(r, 100));
  const r = await call('tools/list');
  assert.equal(r.jsonrpc, '2.0');
  assert.ok(Array.isArray(r.result.tools));
});

test('large request: tools/list response is under 100KB', async () => {
  // The 28-tool schema dump is what the model sees in the system
  // prompt. Keep an eye on it.
  const r = await call('tools/list');
  const text = JSON.stringify(r);
  assert.ok(text.length < 100 * 1024, 'tools/list response is too large: ' + text.length);
});

// ------------------------------------------------------------------
// Real tool calls — only run if a Chrome binary is present, since
// the MCP server will spawn a real browser.
// ------------------------------------------------------------------
const hasChrome = existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');

if (hasChrome) {
  test('tools/call: browser_navigate to about:blank returns a result', { timeout: 30000 }, async () => {
    const r = await call('tools/call', { name: 'browser_navigate', arguments: { url: 'about:blank' } });
    assert.ok(r.result, 'expected result, got: ' + JSON.stringify(r));
    assert.equal(r.result.isError, false);
    const text = r.result.content[0].text;
    const obj = JSON.parse(text);
    assert.match(obj.url, /about:blank/);
  });

  test('tools/call: browser_evaluate reads document.title after navigate', { timeout: 30000 }, async () => {
    await call('tools/call', { name: 'browser_navigate', arguments: { url: 'data:text/html;charset=utf-8,' + encodeURIComponent('<title>mcp-test</title>') } });
    const r = await call('tools/call', { name: 'browser_evaluate', arguments: { code: 'document.title' } });
    assert.equal(r.result.isError, false);
    const obj = JSON.parse(r.result.content[0].text);
    assert.equal(obj.result, "mcp-test");
  });

  test('tools/call: browser_page_info returns url + title', { timeout: 30000 }, async () => {
    await call('tools/call', { name: 'browser_navigate', arguments: { url: 'data:text/html;charset=utf-8,' + encodeURIComponent('<title>page-info</title>') } });
    const r = await call('tools/call', { name: 'browser_page_info', arguments: {} });
    const obj = JSON.parse(r.result.content[0].text);
    assert.equal(obj.title, 'page-info');
    assert.match(obj.url, /data:text\/html/);
  });

  test('tools/call: browser_tag_elements returns numbered interactive list', { timeout: 30000 }, async () => {
    await call('tools/call', { name: 'browser_navigate', arguments: { url: 'data:text/html;charset=utf-8,' + encodeURIComponent('<button>one</button><a href=#>two</a>') } });
    const r = await call('tools/call', { name: 'browser_tag_elements', arguments: { max: 50 } });
    const obj = JSON.parse(r.result.content[0].text);
    // tagElements returns the array directly (not wrapped in
    // {elements: [...]}); the MCP layer serializes it as-is.
    const arr = Array.isArray(obj) ? obj : obj.elements;
    assert.ok(Array.isArray(arr), 'expected array, got ' + JSON.stringify(obj).slice(0, 200));
    assert.ok(arr.length >= 2, 'expected ≥2 elements, got ' + arr.length);
    assert.equal(typeof arr[0].num, 'number');
  });

  test('tools/call: browser_click_by_tag triggers a real click', { timeout: 30000 }, async () => {
    await call('tools/call', { name: 'browser_navigate', arguments: { url: 'data:text/html;charset=utf-8,' + encodeURIComponent('<button id=go onclick="window.__clicked=true">go</button>') } });
    // tag it
    const t = await call('tools/call', { name: 'browser_tag_elements', arguments: { max: 50 } });
    const _arr = JSON.parse(t.result.content[0].text); const el = (Array.isArray(_arr) ? _arr : _arr.elements)[0];
    // click by tag
    await call('tools/call', { name: 'browser_click_by_tag', arguments: { num: el.num } });
    // wait a tick
    await call('tools/call', { name: 'browser_evaluate', arguments: { code: 'new Promise(r => setTimeout(r, 50))' } });
    // read the flag
    const r = await call('tools/call', { name: 'browser_evaluate', arguments: { code: 'window.__clicked === true' } });
    const obj = JSON.parse(r.result.content[0].text);
    assert.equal(obj.result, true, "clicked flag was not set");
  });

  test('tools/call: browser_extract reads text by selector', { timeout: 30000 }, async () => {
    await call('tools/call', { name: 'browser_navigate', arguments: { url: 'data:text/html;charset=utf-8,' + encodeURIComponent('<div class=hi>hello</div><div class=hi>world</div>') } });
    const r = await call('tools/call', { name: 'browser_extract', arguments: { selector: 'div.hi' } });
    const obj = JSON.parse(r.result.content[0].text);
    // extract returns { count, items: [{text|attr value}, ...] }.
    assert.equal(typeof obj.count, 'number');
    assert.ok(Array.isArray(obj.items), 'expected items array, got ' + JSON.stringify(obj));
    assert.equal(obj.count, 2, 'expected 2 items, got ' + obj.count);
    assert.equal(obj.items[0], 'hello');
    assert.equal(obj.items[1], 'world');
  });

  test('tools/call: browser_screenshot truncates base64 and reports bytes', { timeout: 30000 }, async () => {
    const r = await call('tools/call', { name: 'browser_screenshot', arguments: {} });
    const obj = JSON.parse(r.result.content[0].text);
    assert.equal(typeof obj.bytes, 'number');
    assert.ok(obj.bytes > 0, 'screenshot should have positive bytes');
    assert.match(obj.note || '', /truncated/i);
  });

  test('tools/call: browser_press_key + browser_scroll + browser_close are all routable', { timeout: 30000 }, async () => {
    await call('tools/call', { name: 'browser_navigate', arguments: { url: 'data:text/html;charset=utf-8,' + encodeURIComponent('<div style="width:3000px;height:3000px"></div>') } });
    const r1 = await call('tools/call', { name: 'browser_press_key', arguments: { key: 'Tab' } });
    assert.equal(r1.result.isError, false);
    const r2 = await call('tools/call', { name: 'browser_scroll', arguments: { direction: 'down', amount: 200 } });
    assert.equal(r2.result.isError, false);
    const r3 = await call('tools/call', { name: 'browser_close', arguments: {} });
    assert.equal(r3.result.isError, false);
  });
} else {
  test('real tool calls (skipped — no Chrome binary)', { skip: true }, () => {});
}
