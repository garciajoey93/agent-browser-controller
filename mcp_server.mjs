#!/usr/bin/env node
// mcp_server.mjs — MCP stdio server that exposes the Playwright driver
// as tools. This is the codex pattern: a small stdio JSON-RPC server
// (MCP 2024-11-05) that wraps the browser-control surface so any MCP
// client (Codex, Claude Desktop, an editor plugin) can drive Chrome
// without needing direct Node access.
//
// The driver itself is process-global (one Chrome instance per
// server lifetime), so concurrent tool calls are serialized at the
// driver level. For multi-tab or multi-driver setups, run multiple
// instances on different ports via the BRIDGE_PORT env var.
//
// Usage:
//   node mcp_server.mjs
//
// From an MCP client (e.g. Codex):
//   spawn: node /path/to/mcp_server.mjs
//   protocolVersion: 2024-11-05
import * as driver from './playwright-driver.mjs';

const TOOLS = [
  {
    name: 'browser_navigate',
    description: 'Navigate Chrome to a URL. Returns the resulting page title and URL.',
    inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'Absolute http/https URL or data: URL' } }, required: ['url'] }
  },
  {
    name: 'browser_evaluate',
    description: 'Execute JavaScript in the current page. A single expression is auto-returned. The result is serialized via the structured-clone algorithm so DOM nodes and functions come back as null.',
    inputSchema: { type: 'object', properties: { code: { type: 'string', description: 'JavaScript source. Use bare expressions for values, statements with return for side effects.' } }, required: ['code'] }
  },
  {
    name: 'browser_extract',
    description: 'Extract data from the current page using a CSS selector. Returns text content by default, or an attribute value if attr is set.',
    inputSchema: { type: 'object', properties: {
      selector: { type: 'string', description: 'CSS selector' },
      attr: { type: 'string', description: 'Optional attribute name to read instead of text content' },
      limit: { type: 'number', description: 'Max number of elements to return (default 50)' },
    }, required: ['selector'] }
  },
  {
    name: 'browser_screenshot',
    description: 'Take a screenshot of the current page. Returns base64-encoded PNG. Optionally save to a file path.',
    inputSchema: { type: 'object', properties: {
      path: { type: 'string', description: 'If set, write the PNG to this path and return {path, bytes}. Otherwise return {base64, bytes}.' },
      fullPage: { type: 'boolean', description: 'If true, capture the full scrollable page, not just the viewport.' },
    } }
  },
  {
    name: 'browser_click',
    description: 'Click an element in the current page. Provide a CSS selector OR x,y viewport coordinates.',
    inputSchema: { type: 'object', properties: {
      selector: { type: 'string' },
      x: { type: 'number', description: 'Viewport X coordinate (CSS pixels)' },
      y: { type: 'number', description: 'Viewport Y coordinate (CSS pixels)' },
    } }
  },
  {
    name: 'browser_type',
    description: 'Type text into an element. If selector is set, uses Playwright fill (clears + types). Otherwise clicks at x,y first then types. Set pressEnter to submit.',
    inputSchema: { type: 'object', properties: {
      selector: { type: 'string' },
      text: { type: 'string' },
      x: { type: 'number' },
      y: { type: 'number' },
      pressEnter: { type: 'boolean', description: 'If true, press Enter after typing' },
    }, required: ['text'] }
  },
  {
    name: 'browser_press_key',
    description: 'Press a key. Supports Enter, Escape, Tab, ArrowDown/Up/Left/Right, Backspace, Delete, and most named keys.',
    inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] }
  },
  {
    name: 'browser_scroll',
    description: 'Scroll the viewport. direction: up/down/left/right. amount: pixels.',
    inputSchema: { type: 'object', properties: {
      direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
      amount: { type: 'number', description: 'Pixels to scroll (default 600)' },
    } }
  },
  {
    name: 'browser_page_info',
    description: 'Get the current page URL and title.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'browser_close',
    description: 'Close the headless Chrome instance. The next tool call will spawn a fresh browser.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    // Visual mousing tool — codex-style "tag-then-click" affordance.
    // Far more robust than pixel coordinates on pages that reflow.
    name: 'browser_tag_elements',
    description: 'Scan the current page for interactive elements and return a numbered list. Each element gets a stable visible number (1..N, re-assigned on scroll). The agent picks a number to act on, not a pixel coordinate.',
    inputSchema: { type: 'object', properties: {
      max: { type: 'number', description: 'Max number of elements to tag (default 200)' },
    } }
  },
  {
    name: 'browser_click_by_tag',
    description: 'Click the element with the given visible tag number (from browser_tag_elements). Robust to scroll and layout shift.',
    inputSchema: { type: 'object', properties: { num: { type: 'number', description: 'Visible tag number (1..N)' } }, required: ['num'] }
  },
  {
    name: 'browser_type_by_tag',
    description: 'Focus and type into the element with the given visible tag number.',
    inputSchema: { type: 'object', properties: {
      num: { type: 'number' },
      text: { type: 'string' },
    }, required: ['num', 'text'] }
  },
  {
    name: 'browser_click_by_text',
    description: 'Click the first element matching the given text content. Useful for "click the button that says Submit".',
    inputSchema: { type: 'object', properties: {
      text: { type: 'string' },
      selector: { type: 'string', description: 'CSS selector to scope the search (default: button, a, [role=button])' },
    }, required: ['text'] }
  },
  {
    name: 'browser_show_crosshair',
    description: 'Show a coordinate crosshair that follows the mouse and reads out the x,y + element-under-pointer. Useful for previewing where a click would land before committing.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'browser_hide_crosshair',
    description: 'Hide the coordinate crosshair.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'browser_start_drag',
    description: 'Start a drag-and-drop visualization at (x, y). Pairs with update_drag + end_drag to preview the drag path before committing.',
    inputSchema: { type: 'object', properties: {
      x: { type: 'number' }, y: { type: 'number' },
    }, required: ['x', 'y'] }
  },
  {
    name: 'browser_update_drag',
    description: 'Update the end point of an in-progress drag visualization.',
    inputSchema: { type: 'object', properties: {
      x: { type: 'number' }, y: { type: 'number' },
    }, required: ['x', 'y'] }
  },
  {
    name: 'browser_end_drag',
    description: 'End a drag visualization and return the start/end coordinates.',
    inputSchema: { type: 'object', properties: {} }
  },
  // ---- Visual mousing tool: extended affordances ----
  {
    name: 'browser_move_mouse',
    description: 'Update the crosshair readout to match an out-of-band mouse move. Pairs with the chrome.debugger-driven pointer (Input.dispatchMouseEvent) when the page mousemove event is dropped.',
    inputSchema: { type: 'object', properties: {
      x: { type: 'number', description: 'Viewport X coordinate (CSS pixels)' },
      y: { type: 'number', description: 'Viewport Y coordinate (CSS pixels)' },
    }, required: ['x', 'y'] }
  },
  {
    name: 'browser_element_info',
    description: 'Return the full picture of the element at (x, y): tag, id, classes, text, rect, computed style, focused state, and the nearest clickable ancestor. Lets the agent verify what a click would do before committing.',
    inputSchema: { type: 'object', properties: {
      x: { type: 'number' }, y: { type: 'number' },
    }, required: ['x', 'y'] }
  },
  {
    name: 'browser_hover_preview',
    description: 'Combine elementInfo with synthetic pointerover/mouseover dispatch and scroll-container detection. The "is this where I want to click?" check.',
    inputSchema: { type: 'object', properties: {
      x: { type: 'number' }, y: { type: 'number' },
    }, required: ['x', 'y'] }
  },
  {
    name: 'browser_show_grid',
    description: 'Show a coordinate grid overlay at the given spacing (default 50px) for pixel-precise alignment. Combined with the crosshair, lets the model reason about exact coordinates on screenshots.',
    inputSchema: { type: 'object', properties: {
      spacing: { type: 'number', description: 'Grid spacing in pixels (default 50)' },
    } }
  },
  {
    name: 'browser_hide_grid',
    description: 'Hide the coordinate grid overlay.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'browser_show_selection',
    description: 'Highlight the currently focused element and any active text selection with a visible bracket. Auto-updates on focus/selection changes.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'browser_hide_selection',
    description: 'Hide the focus/selection highlight.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'browser_set_tag_filter',
    description: 'Control the tag system: pause re-tagging on scroll (freeze=true) and/or only show certain element types (types=["button","a"]). The next tagElements call will respect the filter.',
    inputSchema: { type: 'object', properties: {
      types: { type: 'array', items: { type: 'string' }, description: 'Element tag names to keep (null = no filter)' },
      freeze: { type: 'boolean', description: 'If true, pause re-tagging on scroll' },
    } }
  },
  {
    name: 'browser_flash_tag',
    description: 'Paint a pulsing ring around the element with the given visible tag number. Pairs with clickByTag so the model gets immediate visual confirmation of what it just hit.',
    inputSchema: { type: 'object', properties: {
      num: { type: 'number', description: 'Visible tag number (1..N)' },
      color: { type: 'string', description: 'Border color (default green #34c759)' },
    }, required: ['num'] }
  },
];

async function handleRequest(req) {
  const { id, method, params } = req;
  try {
    if (method === 'initialize') {
      return {
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'agent-browser-controller-mcp', version: '0.2.0' }
        }
      };
    }
    if (method === 'tools/list') {
      return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
    }
    if (method === 'tools/call') {
      const name = params && params.name;
      const args = (params && params.arguments) || {};
      // Map MCP tool names to driver functions. The driver uses
      // short names; the MCP tools use the longer browser_* convention
      // that matches codex-chrome-bridge.
      const map = {
        browser_navigate:       () => driver.navigate(args),
        browser_evaluate:       () => driver.evaluate(args),
        browser_extract:        () => driver.extract(args),
        browser_screenshot:     () => driver.screenshot(args),
        browser_click:          () => driver.click(args),
        browser_type:           () => driver.type(args),
        browser_press_key:      () => driver.pressKey(args),
        browser_scroll:         () => driver.scroll(args),
        browser_page_info:      () => driver.pageInfo(),
        browser_close:          () => driver.close(),
        browser_tag_elements:   () => driver.tagElements(args),
        browser_click_by_tag:   () => driver.clickByTag(args),
        browser_type_by_tag:    () => driver.typeByTag(args),
        browser_click_by_text:  () => driver.clickByText(args),
        browser_show_crosshair: () => driver.showCrosshair(),
        browser_hide_crosshair: () => driver.hideCrosshair(),
        browser_start_drag:      () => driver.startDrag(args),
        browser_update_drag:    () => driver.updateDrag(args),
        browser_end_drag:       () => driver.endDrag(),
        browser_move_mouse:     () => driver.moveMouse(args),
        browser_element_info:   () => driver.elementInfo(args),
        browser_hover_preview:  () => driver.hoverPreview(args),
        browser_show_grid:      () => driver.showGrid(args),
        browser_hide_grid:      () => driver.hideGrid(),
        browser_show_selection: () => driver.showSelection(),
        browser_hide_selection: () => driver.hideSelection(),
        browser_set_tag_filter: () => driver.setTagFilter(args),
        browser_flash_tag:      () => driver.flashTag(args),
      };
      const fn = map[name];
      if (!fn) throw new Error('Unknown tool: ' + name);
      const result = await fn();
      // Screenshot is special: it returns a big base64 string. We
      // truncate it in the MCP response to keep the model context
      // manageable, but include the byte count so the caller knows
      // the full size.
      let text = JSON.stringify(result, null, 2);
      if (name === 'browser_screenshot' && result && result.base64) {
        const kb = Math.round(result.base64.length / 1024);
        text = JSON.stringify({
          path: result.path,
          bytes: result.bytes,
          note: 'base64 truncated for MCP transport; ' + kb + ' KB total. Use a path arg to write to disk instead.',
          base64_preview: result.base64.slice(0, 200) + '...',
        }, null, 2);
      }
      return {
        jsonrpc: '2.0', id,
        result: { content: [{ type: 'text', text }], isError: false }
      };
    }
    if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
    if (method && method.startsWith('notifications/')) return null;
    return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } };
  } catch (e) {
    return { jsonrpc: '2.0', id, error: { code: -32603, message: (e && e.message) || String(e) } };
  }
}

let buffer = Buffer.alloc(0);
process.stdin.on('data', async (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  // MCP messages are framed as "Content-Length: N\r\n\r\n<body>"
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
    let req;
    try { req = JSON.parse(body); }
    catch (e) { writeMessage({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); continue; }
    const resp = await handleRequest(req);
    if (resp) writeMessage(resp);
  }
});

function writeMessage(msg) {
  const body = JSON.stringify(msg);
  const header = 'Content-Length: ' + Buffer.byteLength(body) + '\r\n\r\n';
  process.stdout.write(header + body);
}

process.on('SIGINT',  () => { process.stderr.write('agent-browser-controller-mcp: SIGINT\n'); process.exit(0); });
process.on('SIGTERM', () => { process.stderr.write('agent-browser-controller-mcp: SIGTERM\n'); process.exit(0); });
process.stderr.write('agent-browser-controller-mcp: ready (' + TOOLS.length + ' tools)\n');
