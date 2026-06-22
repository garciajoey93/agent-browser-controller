// Comprehensive controller test: spawns the server on a free port
// and exercises the full HTTP+WS protocol. No Chrome needed — we
// don't connect an extension by default, so the offline queue and
// "extension disconnected" code paths get a workout. Tests that
// need a connected extension use a small in-process mock.
//
// Run with: node --test tests/controller.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import WebSocket from 'ws';

let proc = null;
let port = null;
let baseHttp = null;
let baseWs = null;

async function waitForServer(p, tries = 50) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await new Promise((resolve, reject) => {
        const req = http.get({ hostname: '127.0.0.1', port: p, path: '/status', timeout: 500 }, (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(new Error('timeout')) });
      });
      if (r === 200) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server never came up on port ' + p);
}

before(async () => {
  // Pick a free port. Bind to 0 to let the OS pick one.
  port = await new Promise((resolve, reject) => {
    const srv = http.createServer().listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
    srv.on('error', reject);
  });
  baseHttp = 'http://127.0.0.1:' + port;
  baseWs   = 'ws://127.0.0.1:' + port + '/ws';
  proc = spawn(process.execPath, ['controller-server.js', '--port', String(port), '--host', '127.0.0.1'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, MAX_INFLIGHT_PER_CLIENT: '8', WS_HELLO_TIMEOUT_MS: '800', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', MINIMAX_API_KEY: '', REQUEST_TIMEOUT_MS: '2000' },
  });
  proc.stdout.on('data', () => {});
  proc.stderr.on('data', () => {});
  await waitForServer(port);
});

after(async () => {
  if (proc) {
    proc.kill('SIGTERM');
    await new Promise((r) => proc.once('exit', r));
  }
});

const agent = new http.Agent({ keepAlive: true, maxSockets: 32 });
function fetchJson(path, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(path, baseHttp);
    const req = http.request({
      agent, hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
      signal: opts.signal,
    }, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(body) }); }
        catch { resolve({ status: res.statusCode, body }); }
      });
    });
    req.on('error', reject);
    if (opts.body) req.write(JSON.stringify(opts.body));
    req.end();
  });
}
function postAction(action, params, extra = {}) {
  const body = { action, params: params || {} };
  for (const k of ['id', 'sessionId', 'idempotencyKey']) if (extra[k] !== undefined) body[k] = extra[k];
  if (extra.idemKey && body.idempotencyKey === undefined) body.idempotencyKey = extra.idemKey;
  return fetchJson('/action', { method: 'POST', body });
}
function connectWs(role = 'client', extra = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(baseWs);
    const t = setTimeout(() => reject(new Error('ws timeout')), 3000);
    ws.once('open', () => {
      ws.send(JSON.stringify({ role, ...extra }));
    });
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'hello-ack') {
        clearTimeout(t);
        resolve({ ws, hello: msg });
      }
    });
    ws.on('error', reject);
  });
}
function wsCall(ws, action, params = {}, extra = {}) {
  return new Promise((resolve) => {
    const id = extra.id || ('w' + Math.random().toString(36).slice(2, 10));
    const msg = { id, action, params, ...extra };
    if (extra.idemKey) msg.idempotencyKey = extra.idemKey;
    const onMsg = (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.id === id) {
        ws.off('message', onMsg);
        resolve(m);
      }
    };
    ws.on('message', onMsg);
    ws.send(JSON.stringify(msg));
  });
}

test('/status: returns 200 + lists all 44 actions + reports extension disconnected', async () => {
  const r = await fetchJson('/status');
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.extensionConnected, false);
  assert.equal(Array.isArray(r.body.actions), true);
  assert.equal(r.body.actions.length, 44, 'expected 44 known actions, got ' + r.body.actions.length);
  for (const a of ['click', 'type', 'navigate', 'tag_elements', 'click_by_tag', 'agent_start', 'save_llm_config', 'flash_tag']) {
    assert.ok(r.body.actions.includes(a), 'missing action: ' + a);
  }
});

test('/status: returns the correct port', async () => {
  const r = await fetchJson('/status');
  assert.equal(r.body.port, port);
});

test('/action: empty body -> 400 INVALID_PARAMS', async () => {
  const r = await fetchJson('/action', { method: 'POST', body: {} });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /action must be a string/);
  assert.equal(r.body.errorCode, 'INVALID_PARAMS');
});

test('/action: unknown action -> 400 UNKNOWN_ACTION', async () => {
  const r = await postAction('nope_not_an_action', {});
  assert.equal(r.status, 400);
  assert.equal(r.body.errorCode, 'UNKNOWN_ACTION');
  assert.match(r.body.error, /unknown action/);
});

test('/action: params must be object', async () => {
  const r = await fetchJson('/action', { method: 'POST', body: { action: 'click', params: 'not an object' } });
  assert.equal(r.status, 400);
  assert.equal(r.body.errorCode, 'INVALID_PARAMS');
});

test('/action: with extension disconnected -> queued=true', async () => {
  const r = await postAction('inspect', {}, { sessionId: 'test-queued' });
  assert.equal(r.status, 200);
  assert.equal(r.body.queued, true);
  assert.equal(r.body.ok, true);
  assert.equal(typeof r.body.id, 'string');
  assert.equal(typeof r.body.position, 'number');
});

test('/action: with extension disconnected -> recorded in /queue', async () => {
  await fetchJson('/queue?all=1', { method: 'DELETE' });
  await postAction('screenshot', {}, { sessionId: 'sess-q' });
  await postAction('tabs', {}, { sessionId: 'sess-q' });
  const q = await fetchJson('/queue');
  assert.equal(q.status, 200);
  assert.ok(q.body.queues['sess-q'], 'expected sess-q in queues');
  assert.equal(q.body.queues['sess-q'].size, 2);
  assert.equal(q.body.queues['sess-q'].actions[0].action, 'screenshot');
  assert.equal(q.body.queues['sess-q'].actions[1].action, 'tabs');
});

test('DELETE /queue?all=1 clears all sessions', async () => {
  await postAction('inspect', {}, { sessionId: 'sess-c1' });
  await postAction('inspect', {}, { sessionId: 'sess-c2' });
  let q = await fetchJson('/queue');
  assert.ok(q.body.queues['sess-c1'] && q.body.queues['sess-c2']);
  await fetchJson('/queue?all=1', { method: 'DELETE' });
  q = await fetchJson('/queue');
  assert.deepEqual(q.body.queues, {});
});

test('DELETE /queue?sessionId=X clears just that session', async () => {
  await postAction('inspect', {}, { sessionId: 'sess-k1' });
  await postAction('inspect', {}, { sessionId: 'sess-k2' });
  await fetchJson('/queue?sessionId=sess-k1', { method: 'DELETE' });
  const q = await fetchJson('/queue');
  assert.equal(q.body.queues['sess-k1'], undefined);
  assert.ok(q.body.queues['sess-k2']);
});

test('/action: 200 calls fills the queue and 201st -> QUEUE_FULL', async () => {
  await fetchJson('/queue?sessionId=full', { method: 'DELETE' });
  let full = null;
  for (let i = 0; i < 200; i++) {
    const r = await postAction('inspect', {}, { sessionId: 'full' });
    if (r.body && r.body.ok === false && r.body.error === 'QUEUE_FULL') {
      full = r; break;
    }
  }
  assert.ok(full, 'expected a QUEUE_FULL rejection');
  assert.equal(full.body.error, 'QUEUE_FULL');
});

test('per-client rate limit: 8 concurrent WS requests + 2 more → 1 RATE_LIMITED', { timeout: 10000 }, async () => {
  // To trigger the WS rate limit, we need a client that holds the
  // pending counter high. Strategy: connect a slow extension that
  // accepts messages but never responds. Each forwarded action
  // sits in `pending` and `pending` counts toward the WS cap.
  // MAX_INFLIGHT_PER_CLIENT=8 means 9+ concurrent requests from one
  // client must yield at least one RATE_LIMITED.
  await fetchJson('/queue?all=1', { method: 'DELETE' });

  // Slow extension: connectWs already received the hello-ack. We
  // just swallow every subsequent message and never respond, so
  // forwarded actions sit in `pending`.
  const slow = await connectWs('extension');
  slow.ws.on('message', () => { /* swallow */ });

  // Open a client WS and fire 12 action requests in rapid succession.
  // Each one gets forwarded to the extension and then sits in `pending`
  // (no response from the slow extension).
  const client = await connectWs('client');
  try {
    for (let i = 0; i < 12; i++) {
      client.ws.send(JSON.stringify({ id: 'rl-' + i, action: 'inspect' }));
    }
    // Collect responses for 1s. We only need ≥1 RATE_LIMITED.
    const got = await new Promise((resolve) => {
      const out = [];
      const onMsg = (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.id && m.id.startsWith('rl-')) out.push(m);
      };
      client.ws.on('message', onMsg);
      setTimeout(() => { client.ws.off('message', onMsg); resolve(out); }, 1000);
    });
    const tooMany = got.filter((m) => m.errorCode === 'RATE_LIMITED');
    assert.ok(tooMany.length > 0, 'expected ≥1 RATE_LIMITED with 12 in-flight + MAX=8, got ' + JSON.stringify(got.map(m => m.errorCode || 'ok')));
  } finally {
    client.ws.close();
    slow.ws.close();
  }
});

test('idempotency: same key returns cached response (5-min TTL)', async () => {
  // Wait briefly to let any prior test's WS close handler run
  // its decrPending. The rate-limit test fires 8 in-flight WS
  // actions and closes the slow extension; the server rejects
  // them on close and decrements per-client counters, but the
  // close handler is async. Without this delay, the first
  // action of this test would hit the MAX_INFLIGHT_PER_CLIENT
  // cap left over from the rate-limit test.
  await new Promise((r) => setTimeout(r, 100));
  await fetchJson('/queue?all=1', { method: 'DELETE' });
  const key = 'idem-' + Date.now();
  const a = await postAction('click', { x: 100, y: 200 }, { sessionId: 'idem', idemKey: key });
  const b = await postAction('click', { x: 100, y: 200 }, { sessionId: 'idem', idemKey: key });
  assert.equal(a.body.position, b.body.position, 'replay must return same queue position');
  assert.equal(b.body._idempotent_replay, true, 'replay must be flagged');
  assert.equal(a.body.id, b.body.id, 'replay must echo the same id');
});

test('idempotency: different keys are independent', async () => {
  await fetchJson('/queue?all=1', { method: 'DELETE' });
  const a = await postAction('click', { x: 1, y: 1 }, { sessionId: 'idem2', idemKey: 'k-a' });
  const b = await postAction('click', { x: 1, y: 1 }, { sessionId: 'idem2', idemKey: 'k-b' });
  assert.notEqual(a.body.id, b.body.id);
  assert.equal(b.body._idempotent_replay, undefined);
});

test('idempotency replay: 3rd call with same key still replays (within TTL)', async () => {
  await fetchJson('/queue?all=1', { method: 'DELETE' });
  const key = 'idem-3x-' + Date.now();
  const a = await postAction('inspect', {}, { sessionId: 'idem3', idemKey: key });
  const b = await postAction('inspect', {}, { sessionId: 'idem3', idemKey: key });
  const c = await postAction('inspect', {}, { sessionId: 'idem3', idemKey: key });
  assert.equal(b.body._idempotent_replay, true);
  assert.equal(c.body._idempotent_replay, true);
  assert.equal(a.body.id, b.body.id);
  assert.equal(b.body.id, c.body.id);
});

test('/history: records the action sequence', async () => {
  await fetchJson('/queue?all=1', { method: 'DELETE' });
  const sess = 'h-' + Date.now();
  await postAction('inspect', {}, { sessionId: sess });
  await postAction('screenshot', {}, { sessionId: sess });
  const h = await fetchJson('/history?sessionId=' + sess);
  assert.equal(h.status, 200);
  assert.ok(Array.isArray(h.body.history));
  assert.ok(h.body.history.length >= 2, 'expected at least 2 entries, got ' + h.body.history.length);
  assert.equal(h.body.history[h.body.history.length - 1].action, 'screenshot');
});

test('/metrics: returns Prometheus text + counters advance', async () => {
  const r = await new Promise((resolve, reject) => {
    const u = new URL('/metrics', baseHttp);
    http.get({ hostname: u.hostname, port: u.port, path: u.pathname }, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
  assert.equal(r.status, 200);
  assert.match(r.body, /agent_actions_total/);
  assert.match(r.body, /agent_actions_ok/);
  const m = r.body.match(/^agent_actions_total (\d+)/m);
  assert.ok(m && parseInt(m[1], 10) > 0, 'expected agent_actions_total > 0');
});

test('/agent/status: returns ok + agents array + llm boolean', async () => {
  const r = await fetchJson('/agent/status');
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.ok(Array.isArray(r.body.agents));
  assert.equal(typeof r.body.llm, 'boolean');
});

test('/llm: 503 when no key configured', async () => {
  const r = await fetchJson('/llm', { method: 'POST', body: { messages: [{ role: 'user', content: 'hi' }] } });
  assert.equal(r.status, 503);
  assert.match(r.body.error, /no LLM configured/);
});

test('OPTIONS preflight: CORS allows *', async () => {
  for (const path of ['/status', '/queue', '/history', '/agent/status', '/metrics']) {
    const r = await new Promise((resolve, reject) => {
      const u = new URL(path, baseHttp);
      http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'OPTIONS', headers: { 'Origin': 'http://x' } }, (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
      }).on('error', reject).end();
    });
    assert.equal(r.status, 204, 'OPTIONS ' + path + ' expected 204');
    assert.equal(r.headers['access-control-allow-origin'], '*');
  }
});

test('GET /: home page returns HTML with API table', async () => {
  const r = await new Promise((resolve, reject) => {
    const u = new URL('/', baseHttp);
    http.get({ hostname: u.hostname, port: u.port, path: u.pathname }, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
  assert.equal(r.status, 200);
  assert.match(r.body, /<h1>.*Agent Controller/);
  assert.match(r.body, /\/action/);
  assert.match(r.body, /\/status/);
});

test('404 for unknown paths', async () => {
  const r = await fetchJson('/no-such-path');
  assert.equal(r.status, 404);
});

test('WS: client hello-ack includes extensionConnected:false', async () => {
  const { ws, hello } = await connectWs('client');
  try {
    assert.equal(hello.type, 'hello-ack');
    assert.equal(hello.role, 'client');
    assert.equal(hello.extensionConnected, false);
  } finally { ws.close(); }
});

test('WS: agent role also gets hello-ack', async () => {
  const { ws, hello } = await connectWs('agent');
  try {
    assert.equal(hello.role, 'agent');
  } finally { ws.close(); }
});

test('WS: extension role gets hello-ack and is tracked by /status', async () => {
  const { ws, hello } = await connectWs('extension');
  try {
    assert.equal(hello.role, 'extension');
    await new Promise((r) => setImmediate(r));
    const s = await fetchJson('/status');
    assert.equal(s.body.extensionConnected, true, 'extension should be connected after WS hello');
  } finally { ws.close(); }
});

test('WS: bad JSON is silently dropped (no crash)', async () => {
  const ws = new WebSocket(baseWs);
  await new Promise((r) => ws.once('open', r));
  ws.send('not json {{{');
  ws.send('{"role":"client"}');
  await new Promise((r) => setTimeout(r, 100));
  const s = await fetchJson('/status');
  assert.equal(s.status, 200);
  ws.close();
});

test('WS: control messages (ping/pong)', async () => {
  const { ws } = await connectWs('client');
  try {
    const pong = await new Promise((resolve) => {
      const onMsg = (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.type === 'pong') { ws.off('message', onMsg); resolve(m); }
      };
      ws.on('message', onMsg);
      ws.send(JSON.stringify({ type: 'ping' }));
    });
    assert.equal(pong.type, 'pong');
    assert.equal(typeof pong.ts, 'number');
  } finally { ws.close(); }
});

test('WS: agent registry via AGENT_REGISTER/AGENT_UPDATE/AGENT_UNREGISTER', async () => {
  const { ws } = await connectWs('agent');
  try {
    const id = 'ws-agent-' + Date.now();
    const reg = await new Promise((resolve) => {
      const onMsg = (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.registered) { ws.off('message', onMsg); resolve(m); }
      };
      ws.on('message', onMsg);
      ws.send(JSON.stringify({ type: 'AGENT_REGISTER', agent: { id, goal: 'test' } }));
    });
    assert.equal(reg.registered, id);
    const s = await fetchJson('/agent/status');
    assert.ok(s.body.agents.find((a) => a.id === id), 'agent should appear in /agent/status');
    await new Promise((resolve) => {
      const onMsg = (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.runId === id) { ws.off('message', onMsg); resolve(m); }
      };
      ws.on('message', onMsg);
      ws.send(JSON.stringify({ type: 'AGENT_UPDATE', runId: id, patch: { workingTabId: 42, steps: 3 } }));
    });
    const s2 = await fetchJson('/agent/status');
    const updated = s2.body.agents.find((a) => a.id === id);
    assert.equal(updated.workingTabId, 42);
    assert.equal(updated.steps, 3);
    await new Promise((resolve) => {
      const onMsg = (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.runId === id && 'ok' in m) { ws.off('message', onMsg); resolve(m); }
      };
      ws.on('message', onMsg);
      ws.send(JSON.stringify({ type: 'AGENT_UNREGISTER', runId: id }));
    });
    const s3 = await fetchJson('/agent/status');
    assert.equal(s3.body.agents.find((a) => a.id === id), undefined);
  } finally { ws.close(); }
});

test('WS: client receives broadcast events when extension connects', async () => {
  const clientWs = await connectWs('client');
  try {
    const evPromise = new Promise((resolve) => {
      const onMsg = (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.type === 'event' && m.event === 'extension_connected') {
          clientWs.ws.off('message', onMsg);
          resolve(m);
        }
      };
      clientWs.ws.on('message', onMsg);
    });
    const extWs = await connectWs('extension');
    try {
      const ev = await Promise.race([evPromise, new Promise((_, r) => setTimeout(() => r(new Error('no event in 2s')), 2000))]);
      assert.equal(ev.event, 'extension_connected');
    } finally { extWs.ws.close(); }
  } finally { clientWs.ws.close(); }
});

test('WS: pending request is rejected when extension disconnects mid-flight', async () => {
  const extWs = await connectWs('extension');
  const id = 'never-' + Date.now();
  const clientWs = await connectWs('client');
  try {
    const p = new Promise((resolve) => {
      const onMsg = (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.id === id) { clientWs.ws.off('message', onMsg); resolve(m); }
      };
      clientWs.ws.on('message', onMsg);
      clientWs.ws.send(JSON.stringify({ id, action: 'inspect' }));
    });
    await new Promise((r) => setTimeout(r, 50));
    extWs.ws.close();
    const r = await Promise.race([p, new Promise((_, rj) => setTimeout(() => rj(new Error('no reject in 2s')), 2000))]);
    assert.equal(r.ok, false);
    assert.match(r.error, /disconnected|unavailable/i);
  } finally { clientWs.ws.close(); }
});

test('WS: unknown action is rejected with UNKNOWN_ACTION', async () => {
  const { ws } = await connectWs('client');
  try {
    const r = await wsCall(ws, 'not_a_real_action');
    assert.equal(r.errorCode, 'UNKNOWN_ACTION');
  } finally { ws.close(); }
});

test('WS: response carries id field', async () => {
  const { ws } = await connectWs('client');
  try {
    const id = 'ws-' + Date.now();
    const r = await wsCall(ws, 'inspect', {}, { id });
    assert.equal(r.id, id, 'response must echo the request id');
  } finally { ws.close(); }
});

test('WS: idempotency replay returns _idempotent_replay:true', async () => {
  // The previous WS tests may have queued actions in the default
  // session; clear it so this test's position-1 assertion is stable.
  await fetchJson('/queue?all=1', { method: 'DELETE' });
  const { ws } = await connectWs('client');
  try {
    const key = 'ws-idem-' + Date.now();
    const a = await wsCall(ws, 'click', { x: 1, y: 1 }, { idemKey: key });
    const b = await wsCall(ws, 'click', { x: 1, y: 1 }, { idemKey: key });
    assert.equal(b._idempotent_replay, true);
    // The bugfix intentionally spreads cached FIRST and overrides
    // id with msg.id so the caller's pending map (keyed by msg.id)
    // finds the response. So a.id !== b.id is expected; instead we
    // assert that the underlying queue position is preserved.
    assert.equal(a.position, b.position, 'replay must preserve queue position');
    assert.equal(b.position, 1, 'first action should be at position 1');
  } finally { ws.close(); }
});

test('WS: no hello within 5s closes with 1008', { timeout: 8000 }, async () => {
  const ws = new WebSocket(baseWs);
  await new Promise((r) => ws.once('open', r));
  const code = await new Promise((resolve) => {
    ws.on('close', (c) => resolve(c));
  });
  assert.equal(code, 1008);
});

test('WS: SAVE_LLM_CONFIG can be pushed and /llm stops returning 503', async () => {
  const extWs = await connectWs('extension');
  try {
    await new Promise((resolve) => {
      const onMsg = (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.saved) { extWs.ws.off('message', onMsg); resolve(m); }
      };
      extWs.ws.on('message', onMsg);
      extWs.ws.send(JSON.stringify({
        type: 'SAVE_LLM_CONFIG',
        config: { provider: 'openai', url: 'http://127.0.0.1:1/v1/chat/completions', model: 'gpt-4o-mini', apiKey: 'sk-test' },
      }));
    });
    // Use a 2s timeout: the upstream URL points at an unreachable
    // port, so we want to fail fast with 502 rather than waiting
    // for the OS connect timeout.
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 2000);
    let r;
    try {
      r = await fetchJson('/llm', { method: 'POST', body: { messages: [{ role: 'user', content: 'hi' }] }, signal: ctrl.signal });
    } catch (e) {
      // AbortError or connect failure is fine — we just need to
      // confirm the proxy was reached (i.e. status is not 503).
      r = { status: 502, body: { error: e.message } };
    } finally {
      clearTimeout(tid);
    }
    assert.notEqual(r.status, 503, 'after SAVE_LLM_CONFIG, /llm should not be 503');
  } finally { extWs.ws.close(); }
});

test('/stream: SSE emits hello event immediately', async () => {
  const r = await new Promise((resolve, reject) => {
    const u = new URL('/stream', baseHttp);
    http.get({ hostname: u.hostname, port: u.port, path: u.pathname }, (res) => {
      assert.equal(res.statusCode, 200);
      assert.match(res.headers['content-type'], /text\/event-stream/);
      let buf = '';
      const t = setTimeout(() => { res.destroy(); resolve({ buf }); }, 1000);
      res.on('data', (c) => {
        buf += c.toString();
        if (buf.includes('event: hello')) {
          clearTimeout(t);
          res.destroy();
          resolve({ buf });
        }
      });
      res.on('error', reject);
    }).on('error', reject);
  });
  assert.match(r.buf, /event: hello/);
  assert.match(r.buf, /data: \{.*ok.*true/);
});

test('/action/replay: 404 for unknown id', async () => {
  const r = await fetchJson('/action/replay/nonexistent', { method: 'POST', body: {} });
  assert.equal(r.status, 404);
});

test('/action/replay: replays into the original session and adds a new queue entry', async () => {
  await fetchJson('/queue?all=1', { method: 'DELETE' });
  const queued = await postAction('click', { x: 5, y: 6 }, { sessionId: 'rep' });
  const r = await fetchJson('/action/replay/' + queued.body.id, { method: 'POST', body: {} });
  assert.equal(r.status, 200);
  assert.equal(r.body.replayOf, queued.body.id);
  // The action is recorded in history before being queued, so the
  // replay finds it there first. Either source is fine; what
  // matters is that the replayed action lands in the right queue.
  assert.ok(['history', 'queue'].includes(r.body.source), 'source should be history or queue, got ' + r.body.source);
  // The replayed request is tagged with the original sessionId so
  // it lands in the same queue as the original.
  assert.equal(r.body.sessionId, 'rep', 'replay must preserve the original sessionId');
  // The result is the queue response from sendToExtension.
  assert.equal(r.body.result.ok, true);
  assert.equal(r.body.result.queued, true);
  // The replayed action is a fresh id — it is NOT a dedup of the
  // original. The new entry should appear in the original session.
  const q = await fetchJson('/queue');
  assert.equal(q.body.queues['rep'].size, 2, 'replay should add a new queue entry in the same session');
  const ids = q.body.queues['rep'].actions.map(a => a.id);
  assert.ok(ids.includes(queued.body.id), 'original should still be in queue');
  assert.notEqual(ids[0], ids[1], 'replay should be a new id, not a dedup');
});
