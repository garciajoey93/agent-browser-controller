#!/usr/bin/env node
/* =============================================================
 * controller-server.js — Relay between the Agent Browser
 * Controller extension and any number of external clients
 * (Codex, a Python script, curl, …).
 *
 *   ┌──────────┐  WS  ┌─────────────────────┐  WS  ┌──────────┐
 *   │ extension│ ───► │  controller-server  │ ◄─── │  client  │
 *   │          │ ◄─── │  (this file)        │ ───► │  (Codex) │
 *   └──────────┘      └─────────┬───────────┘      └──────────┘
 *                               │
 *                      HTTP API: /status, /action, /inspect, …
 *
 * The server is intentionally tiny: it accepts WebSocket
 * connections on /ws, demuxes the "extension" role from "client"
 * roles, and routes request/response pairs by `id`. An HTTP API
 * is exposed on the same port so non-WebSocket clients (curl,
 * fetch, Python `requests`) can drive the browser just as easily.
 *
 * Usage:
 *   node controller-server.js [--port 9223] [--host 127.0.0.1]
 * ============================================================= */

'use strict';

import http from 'node:http';
import { WebSocketServer } from 'ws';
import { randomUUID } from 'node:crypto';

// ------------------------------------------------------------------
// CLI
// ------------------------------------------------------------------
function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return def;
  return process.argv[i + 1];
}
const PORT = parseInt(arg('port', process.env.PORT || '9223'), 10);
const HOST = arg('host', process.env.HOST || '127.0.0.1');

// ------------------------------------------------------------------
// State
// ------------------------------------------------------------------
let extensionWs = null;
const clients    = new Set();
const sseClients  = new Set();

// ------------------------------------------------------------------
// Agent registry: tracks every autonomous agent run (id, goal,
// working tab, last step). Populated by background.js when the
// agent mode is engaged; /agent/status exposes the list.
// ------------------------------------------------------------------
const agents = new Map(); // id -> { id, goal, startedAt, lastStepAt, steps, workingTabId, lastAction, log }

// ------------------------------------------------------------------
// LLM config cache: refreshed by background.js via the
// 'SAVE_LLM_CONFIG' message so the /llm proxy endpoint can
// forward requests using the user's stored key without ever
// exposing the key to the agent process.
// ------------------------------------------------------------------
let _llmConfig = null;
function agentsHaveLlm() {
  if (process.env.MINIMAX_API_KEY || process.env.OPENAI_API_KEY) return true;
  if (_llmConfig && _llmConfig.apiKey) return true;
  return false;
}
async function getLlmConfig() {
  // Refresh from the extension (the source of truth) if we have one.
  if (extensionWs && extensionWs.readyState === 1) {
    try {
      const r = await sendToExtension({ type: 'GET_LLM_CONFIG' }, 4000);
      if (r && r.ok && r.config && r.config.apiKey) {
        _llmConfig = r.config;
      }
    } catch {}
  }
  // Fall back to env vars if the extension didn't provide anything.
  if (!_llmConfig) {
    if (process.env.MINIMAX_API_KEY) {
      _llmConfig = {
        provider: 'minimax',
        url: (process.env.MINIMAX_BASE_URL || 'https://api.minimax.chat') + '/v1/chat/completions',
        model: process.env.LLM_MODEL || 'minimax/minimax-m3',
        apiKey: process.env.MINIMAX_API_KEY,
      };
    } else if (process.env.OPENAI_API_KEY) {
      _llmConfig = {
        provider: 'openai',
        url: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1/chat/completions',
        model: process.env.LLM_MODEL || 'gpt-4o-mini',
        apiKey: process.env.OPENAI_API_KEY,
      };
    }
  }
  return _llmConfig;
}

// IPI-307/310/311: metrics, history, in-flight tracking. Every action is
// recorded here so /history, /metrics, /action/replay/:id can serve
// it without re-asking the extension. Bounded by MAX_HISTORY entries.
const METRICS = {
  actions_total: 0,
  actions_ok: 0,
  actions_err: 0,
  inflight: new Map(),    // clientKey -> count
  history:   [],          // newest at the end
  MAX_INFLIGHT_PER_CLIENT: 64,
  MAX_HISTORY: 1000,
};
const pending    = new Map(); // id -> { resolve, reject, timer }
const completed  = new Map(); // idempotencyKey -> { response, ts }
const COMPLETED_TTL_MS = 5 * 60 * 1000;
function purgeCompleted() {
  const cutoff = Date.now() - COMPLETED_TTL_MS;
  for (const [k, v] of completed) {
    if (v.ts < cutoff) completed.delete(k);
  }
}
const REQUEST_TIMEOUT_MS = parseInt(arg('request-timeout', '30000'), 10);

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------
function send(ws, obj) {
  if (!ws || ws.readyState !== ws.OPEN) return false;
  try { ws.send(JSON.stringify(obj)); return true; }
  catch { return false; }
}

function rejectPending(id, err) {
  const p = pending.get(id);
  if (!p) return;
  clearTimeout(p.timer);
  pending.delete(id);
  p.reject(err);
}

function resolvePending(id, payload) {
  const p = pending.get(id);
  if (!p) return;
  clearTimeout(p.timer);
  pending.delete(id);
  p.resolve(payload);
}

function broadcastToClients(obj) {
  for (const c of clients) { try { send(c, obj); } catch {} }
  for (const cb of sseClients) { try { cb(obj); } catch {} }
}

// ---- METRICS helpers ----
function incrInflight(clientKey) {
  METRICS.inflight.set(clientKey, (METRICS.inflight.get(clientKey) || 0) + 1);
  METRICS.actions_total++;
}
function decrInflight(clientKey) {
  const n = METRICS.inflight.get(clientKey) || 0;
  if (n <= 1) METRICS.inflight.delete(clientKey);
  else METRICS.inflight.set(clientKey, n - 1);
}
function recordAction(entry) {
  METRICS.history.push(entry);
  if (METRICS.history.length > METRICS.MAX_HISTORY) {
    METRICS.history.splice(0, METRICS.history.length - METRICS.MAX_HISTORY);
  }
  if (entry.ok) METRICS.actions_ok++;
  else METRICS.actions_err++;
}

// ------------------------------------------------------------------
// Offline action queue
// ------------------------------------------------------------------
// Per-session FIFO queues for actions sent while the extension is
// disconnected. Bounded by MAX_QUEUE_SIZE actions and MAX_QUEUE_AGE_MS
// per entry; older entries are rejected on enqueue with QUEUE_FULL /
// QUEUE_ENTRY_TOO_OLD so a stuck session can't grow without bound.
const MAX_QUEUE_SIZE = 100;
const MAX_QUEUE_AGE_MS = 5 * 60 * 1000; // 5 min
const queues = new Map(); // sessionId -> [{ id, request, ts }]

function getQueue(sessionId) {
  if (!queues.has(sessionId)) queues.set(sessionId, []);
  return queues.get(sessionId);
}

// Drop expired entries from a queue. Returns the queue.
function pruneQueue(sessionId) {
  const q = getQueue(sessionId);
  const cutoff = Date.now() - MAX_QUEUE_AGE_MS;
  for (let i = q.length - 1; i >= 0; i--) {
    if (q[i].ts < cutoff) q.splice(i, 1);
  }
  return q;
}

function enqueueAction(sessionId, request) {
  pruneQueue(sessionId);
  const q = getQueue(sessionId);
  if (q.length >= MAX_QUEUE_SIZE) {
    return { ok: false, error: 'QUEUE_FULL', queueSize: q.length };
  }
  const entry = { id: request.id || randomUUID(), request, ts: Date.now() };
  q.push(entry);
  return {
    ok: true, queued: true,
    id: entry.id, sessionId,
    position: q.length,
    queueSize: q.length,
    estWaitMs: Math.min(MAX_QUEUE_AGE_MS, q.length * 2000),
  };
}

function drainQueueOnReconnect() {
  if (!extensionWs || extensionWs.readyState !== extensionWs.OPEN) return;
  for (const [sessionId, q] of queues) {
    const live = pruneQueue(sessionId);
    while (live.length) {
      const entry = live.shift();
      // Recursively forward via the same path; extension is now
      // connected, so it will execute immediately.
      forwardToExtension(entry.request).catch(err => {
        console.log('[queue] drained action failed:', err.message);
      });
    }
    if (live.length === 0) queues.delete(sessionId);
  }
  if (queues.size === 0) console.log('[queue] all queues drained');
}

// ------------------------------------------------------------------
// Request routing (client → extension → client)
// ------------------------------------------------------------------
function forwardToExtension(request) {
  return new Promise((resolve, reject) => {
    // IPI-307: dedupe by idempotencyKey for 5 minutes.
    const idemKey = request && request.idempotencyKey;
    if (idemKey) {
      purgeCompleted();
      const cached = completed.get(idemKey);
      if (cached) {
        return resolve({ ...cached.response, _idempotent_replay: true });
      }
    }
    if (!extensionWs || extensionWs.readyState !== extensionWs.OPEN) {
      return reject(new Error('Extension not connected'));
    }
    const id = request.id || randomUUID();
    const out = { ...request, id };
    const timer = setTimeout(() => {
      rejectPending(id, new Error('Extension timed out after ' + REQUEST_TIMEOUT_MS + 'ms'));
    }, REQUEST_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer, idemKey });
    if (!send(extensionWs, out)) {
      clearTimeout(timer);
      pending.delete(id);
      reject(new Error('Failed to send to extension'));
    }
  });
}

// Public entry: either forwards immediately or queues when the
// extension is down. `sessionId` defaults to a constant.
function sendToExtension(request, sessionId) {
  sessionId = sessionId || 'default';
  if (extensionWs && extensionWs.readyState === extensionWs.OPEN) {
    return forwardToExtension(request);
  }
  // Extension is down — queue and return QUEUED.
  const r = enqueueAction(sessionId, request);
  if (!r.ok) return Promise.reject(new Error(r.error));
  return Promise.resolve(r);
}

// ------------------------------------------------------------------
// HTTP server
// ------------------------------------------------------------------
function jsonResponse(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Length': Buffer.byteLength(data),
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { buf += c; if (buf.length > 10 * 1024 * 1024) reject(new Error('body too large')); });
    req.on('end', () => {
      if (!buf) return resolve({});
      try { resolve(JSON.parse(buf)); } catch (e) { reject(new Error('invalid JSON: ' + e.message)); }
    });
    req.on('error', reject);
  });
}

// IPI-315: minimal schema validator. Reject unknown action names
// and bad param shapes at the relay boundary so we don't waste a
// round trip and so the client gets a deterministic error.
const KNOWN_ACTIONS = new Set([
  'click', 'type', 'scroll', 'navigate', 'capture_state', 'screenshot',
  'inspect', 'evaluate', 'tabs', 'open', 'close', 'switch_tab',
  'set_active_tab', 'set_status', 'wait', 'find_tab', 'press_key', 'finish',
  // Visual mousing tool: numbered element tags. These are routed
  // to the content script and don't require chrome.debugger.
  'tag_elements', 'click_by_tag', 'type_by_tag', 'hover_by_tag',
  'clear_tags', 'list_tags',
  // Coordinate crosshair + drag visualization
  'show_crosshair', 'hide_crosshair', 'start_drag', 'update_drag', 'end_drag',
  // Visual mousing tool: extended affordances (move-mouse sync,
  // pixel inspect, hover preview, coordinate grid, focus/selection
  // highlight, tag filter, tag flash).
  'move_mouse', 'element_info', 'hover_preview',
  'show_grid', 'hide_grid', 'show_selection', 'hide_selection',
  'set_tag_filter', 'flash_tag',
  // Agent mode: pin the extension to a specific tab, heartbeat
  // progress, and read the agent's run state.
  'agent_start', 'agent_step', 'agent_stop', 'agent_status',
  // LLM config: the user stores their API key in the extension;
  // these actions let the agent (or the controller's /llm proxy)
  // read or update that config.
  'save_llm_config', 'get_llm_config',
]);
function validateAction(body) {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'body must be a JSON object', errorCode: 'INVALID_PARAMS' };
  }
  if (typeof body.action !== 'string') {
    return { ok: false, error: 'action must be a string', errorCode: 'INVALID_PARAMS' };
  }
  if (!KNOWN_ACTIONS.has(body.action)) {
    return { ok: false, error: 'unknown action: ' + body.action, errorCode: 'UNKNOWN_ACTION' };
  }
  if (body.params != null && typeof body.params !== 'object') {
    return { ok: false, error: 'params must be an object', errorCode: 'INVALID_PARAMS' };
  }
  return null;
}

async function handleHttp(req, res) {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    });
    return res.end();
  }
  const url = new URL(req.url, 'http://' + (req.headers.host || HOST + ':' + PORT));
  try {
    if (url.pathname === '/status' && req.method === 'GET') {
      return jsonResponse(res, 200, {
        ok: true,
        extensionConnected: !!(extensionWs && extensionWs.readyState === 1),
        clients: clients.size,
        version: '1.0.0',
        port: PORT,
        actions: Array.from(KNOWN_ACTIONS),
      });
    }
    if (url.pathname === '/action' && req.method === 'POST') {
      const body = await readBody(req);
      const validationError = validateAction(body);
      if (validationError) return jsonResponse(res, 400, validationError);
      // Key by IP only. remotePort is ephemeral per connection, so
      // IP+port would let a single client bypass the limit by
      // opening many parallel connections.
      const clientKey = req.socket.remoteAddress || 'unknown';
      if ((METRICS.inflight.get(clientKey) || 0) >= METRICS.MAX_INFLIGHT_PER_CLIENT) {
        return jsonResponse(res, 429, { ok: false, error: 'too many in-flight requests for this client', errorCode: 'RATE_LIMITED' });
      }
      incrInflight(clientKey);
      const t0 = Date.now();
      try {
        const result = await sendToExtension(body);
        recordAction({ id: body.id, action: body.action, params: body.params, ok: !!(result && result.ok), ms: Date.now() - t0, ts: t0, sessionId: body.sessionId || 'default' });
        return jsonResponse(res, 200, result);
      } catch (e) {
        recordAction({ id: body.id, action: body.action, params: body.params, ok: false, error: e.message, ms: Date.now() - t0, ts: t0, sessionId: body.sessionId || 'default' });
        return jsonResponse(res, 502, { ok: false, error: e.message, errorCode: 'EXTENSION_UNAVAILABLE' });
      } finally {
        decrInflight(clientKey);
      }
    }
    if (url.pathname === '/inspect' && req.method === 'GET') {
      try {
        const result = await sendToExtension({ action: 'inspect' });
        return jsonResponse(res, 200, result);
      } catch (e) {
        return jsonResponse(res, 502, { ok: false, error: e.message });
      }
    }
    if (url.pathname === '/screenshot' && req.method === 'GET') {
      try {
        const result = await sendToExtension({ action: 'screenshot' });
        return jsonResponse(res, 200, result);
      } catch (e) {
        return jsonResponse(res, 502, { ok: false, error: e.message });
      }
    }
    if (url.pathname === '/tabs' && req.method === 'GET') {
      try {
        const result = await sendToExtension({ action: 'tabs' });
        return jsonResponse(res, 200, result);
      } catch (e) {
        return jsonResponse(res, 502, { ok: false, error: e.message });
      }
    }
    if (url.pathname === '/' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(HOMEPAGE_HTML);
    }
    if (url.pathname === '/queue' && req.method === 'GET') {
      const out = {};
      for (const [sid, q] of queues) {
        pruneQueue(sid);
        out[sid] = { size: q.length, actions: q.map(e => ({ id: e.id, action: e.request.action, ageMs: Date.now() - e.ts })) };
      }
      return jsonResponse(res, 200, { ok: true, queues: out });
    }
    if (url.pathname === '/queue' && req.method === 'DELETE') {
      const sessionId = url.searchParams.get('sessionId') || 'default';
      if (url.searchParams.get('all') === '1') {
        queues.clear();
      } else if (queues.has(sessionId)) {
        queues.delete(sessionId);
      }
      return jsonResponse(res, 200, { ok: true, remaining: Array.from(queues.keys()) });
    }
    if (url.pathname === '/llm' && req.method === 'POST') {
      // LLM proxy. The agent sends { messages, model?, ... } and
      // we forward to the configured MiniMax / OpenAI endpoint
      // using the API key the user stored in the extension. The
      // agent process never sees the key.
      //
      // The extension provides the key + endpoint via a
      // 'GET_LLM_CONFIG' WS message stored in a global. If no
      // key is set, we return a 503 so the agent can fall back
      // to using its own env var.
      const body = await readBody(req);
      const llmCfg = await getLlmConfig();
      if (!llmCfg) {
        return jsonResponse(res, 503, {
          ok: false,
          error: 'no LLM configured. Either set MINIMAX_API_KEY in the env, or open the extension popup and save an API key under Settings.',
        });
      }
      try {
        const upstream = await fetch(llmCfg.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + llmCfg.apiKey },
          body: JSON.stringify(Object.assign({ model: llmCfg.model }, body)),
        });
        const text = await upstream.text();
        res.writeHead(upstream.status, {
          'Content-Type': upstream.headers.get('content-type') || 'application/json',
          'Access-Control-Allow-Origin': '*',
        });
        return res.end(text);
      } catch (e) {
        return jsonResponse(res, 502, { ok: false, error: 'LLM upstream failed: ' + e.message });
      }
    }
    if (url.pathname === '/agent/status' && req.method === 'GET') {
      return jsonResponse(res, 200, {
        ok: true,
        agents: Array.from(agents.values()).map(a => ({
          id: a.id, goal: a.goal, startedAt: a.startedAt, lastStepAt: a.lastStepAt,
          steps: a.steps, workingTabId: a.workingTabId, lastAction: a.lastAction,
        })),
        llm: agentsHaveLlm(),
      });
    }
    if (url.pathname === '/metrics' && req.method === 'GET') {
      const lines = [
        '# HELP agent_actions_total Total actions dispatched',
        '# TYPE agent_actions_total counter',
        'agent_actions_total ' + METRICS.actions_total,
        'agent_actions_ok ' + METRICS.actions_ok,
        'agent_actions_err ' + METRICS.actions_err,
        '# HELP agent_actions_in_flight Current per-client in-flight actions',
        '# TYPE agent_actions_in_flight gauge',
      ];
      for (const [k, n] of METRICS.inflight) lines.push('agent_actions_in_flight{client="' + k + '"} ' + n);
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
      return res.end(lines.join('\n') + '\n');
    }
    if (url.pathname === '/history' && req.method === 'GET') {
      const session = url.searchParams.get('sessionId');
      const filtered = session ? METRICS.history.filter(h => h.sessionId === session) : METRICS.history;
      return jsonResponse(res, 200, { ok: true, history: filtered });
    }
    if (url.pathname.startsWith('/action/replay/') && req.method === 'POST') {
      const id = url.pathname.split('/').pop();
      const hist = METRICS.history.find(h => h.id === id);
      if (!hist) return jsonResponse(res, 404, { ok: false, error: 'unknown action id', errorCode: 'NOT_FOUND' });
      const replayReq = { id: randomUUID(), action: hist.action, params: Object.assign({}, hist.params || {}, { _replayOf: id }) };
      try {
        const result = await sendToExtension(replayReq);
        return jsonResponse(res, 200, { ok: true, replayOf: id, result });
      } catch (e) {
        return jsonResponse(res, 502, { ok: false, error: e.message });
      }
    }
    if (url.pathname === '/stream' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*' });
      res.write('event: hello\ndata: {"ok":true}\n\n');
      const onEvent = (p) => { try { res.write('data: ' + JSON.stringify(p) + '\n\n'); } catch {} };
      sseClients.add(onEvent);
      const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 15000);
      req.on('close', () => { clearInterval(ping); sseClients.delete(onEvent); });
      return;
    }
    if (url.pathname === '/reload' && (req.method === 'POST' || req.method === 'GET')) {
      // Force the connected extension to chrome.runtime.reload() so
      // any code edits (background.js / content.js / popup.*) are
      // picked up without a manual refresh in chrome://extensions.
      if (extensionWs && extensionWs.readyState === extensionWs.OPEN) {
        send(extensionWs, { type: 'reload' });
        return jsonResponse(res, 200, { ok: true, sent: true });
      }
      return jsonResponse(res, 503, { ok: false, error: 'Extension not connected' });
    }
    return jsonResponse(res, 404, { ok: false, error: 'Not found: ' + url.pathname });
  } catch (e) {
    return jsonResponse(res, 500, { ok: false, error: e.message });
  }
}

const HOMEPAGE_HTML = `<!doctype html>
<html><head><title>Agent Controller</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;
       max-width:760px;margin:40px auto;padding:0 20px;color:#222;line-height:1.55}
  h1{margin:0 0 4px}
  code{background:#f4f4f4;padding:2px 6px;border-radius:3px;font-size:90%}
  pre{background:#f4f4f4;padding:12px;border-radius:6px;overflow:auto;font-size:13px}
  table{border-collapse:collapse;margin:16px 0}
  td,th{padding:6px 12px;border-bottom:1px solid #eee;text-align:left}
  .pill{display:inline-block;padding:2px 8px;border-radius:10px;
        background:#eee;font-size:12px}
  .pill.ok{background:#d4f7d4;color:#0a5a1a}
  .pill.no{background:#fde2e2;color:#7a1a1a}
</style></head><body>
<h1>🤖 Agent Controller</h1>
<p>The extension is the <em>controllable surface</em>. This server is the relay that any external client (Codex, a Python script, curl) talks to in order to drive it.</p>
<p>Extension status: <span id="ext" class="pill no">checking…</span> ·
   Clients connected: <span id="cli">0</span></p>
<script>
fetch('/status').then(r=>r.json()).then(s=>{
  document.getElementById('ext').textContent = s.extensionConnected ? 'connected' : 'disconnected';
  document.getElementById('ext').className = 'pill ' + (s.extensionConnected ? 'ok' : 'no');
  document.getElementById('cli').textContent = s.clients;
});
</script>
<h2>HTTP API</h2>
<table>
<tr><th>Method</th><th>Path</th><th>Purpose</th></tr>
<tr><td>GET</td><td><code>/status</code></td>     <td>Server + extension health</td></tr>
<tr><td>GET</td><td><code>/inspect</code></td>   <td>Full state: screenshot, URL, title, viewport, DOM landmarks</td></tr>
<tr><td>GET</td><td><code>/screenshot</code></td><td>Just a base64 screenshot</td></tr>
<tr><td>GET</td><td><code>/tabs</code></td>      <td>List all open tabs</td></tr>
<tr><td>POST</td><td><code>/action</code></td>   <td>Execute any action. Body: <code>{"action":"click","params":{...}}</code></td></tr>
</table>
<h2>WebSocket API</h2>
<p>Connect to <code>ws://${HOST}:${PORT}/ws</code>. Each message is JSON. Send <code>{"role":"client"}</code> first to identify yourself. Then send action requests:</p>
<pre>{"id":"1","action":"inspect"}
{"id":"2","action":"click","params":{"x":500,"y":300}}
{"id":"3","action":"type","params":{"x":500,"y":300,"text":"hello"}}
{"id":"4","action":"scroll","params":{"direction":"down","amount":600}}
{"id":"5","action":"navigate","params":{"url":"https://example.com"}}</pre>
<p>Coordinate convention defaults to <code>0-1000</code> normalized to viewport. Switch to <code>0-1</code> or <code>pixel</code> from the extension popup. The extension also reports the live viewport size in <code>/inspect</code> so you can scale yourself.</p>
<h2>Quick test</h2>
<pre>curl -s http://${HOST}:${PORT}/status | jq
curl -s -X POST http://${HOST}:${PORT}/action \\
  -H 'Content-Type: application/json' \\
  -d '{"action":"inspect"}' | jq '.result | {url, title, width, height}'</pre>
</body></html>`;

// ------------------------------------------------------------------
// WebSocket server
// ------------------------------------------------------------------
const server = http.createServer(handleHttp);
const wss    = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  const addr = req.socket.remoteAddress + ':' + req.socket.remotePort;
  console.log('[ws] connect', addr);

  let role = null;
  let helloTimer = setTimeout(() => {
    if (!role) {
      console.log('[ws] no hello; closing', addr);
      try { ws.close(1008, 'no hello'); } catch {}
    }
  }, 5000);

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || typeof msg !== 'object') return;

    try {
    // First message identifies role
    if (!role) {
      if (msg.role === 'agent') {
        // agent role: same surface as 'client' (can send actions,
        // receive events) but tracked separately so logs + future
        // policy can distinguish a real human user from an
        // autonomous agent run. The agent's own API key for the
        // LLM is held by the extension; the agent talks to the
        // controller's /llm HTTP endpoint to keep the key out of
        // the agent's process.
        role = 'agent';
        clients.add(ws);
        console.log('[ws] agent registered', addr);
        clearTimeout(helloTimer);
        send(ws, { type: 'hello-ack', role: 'agent',
                   extensionConnected: !!(extensionWs && extensionWs.readyState === 1) });
        return;
      }
      if (msg.role === 'extension') {
        // IPI-306: optional bearer-token auth. If CONTROLLER_AUTH_TOKEN
        // is set in the env, the first message from the extension
        // must include { role: 'extension', auth: '<token>' }.
        if (process.env.CONTROLLER_AUTH_TOKEN &&
            msg.auth !== process.env.CONTROLLER_AUTH_TOKEN) {
          console.log('[ws] extension auth failed, closing', addr);
          send(ws, { type: 'error', error: 'AUTH_FAILED' });
          try { ws.close(1008, 'auth failed'); } catch {}
          return;
        }
        role = 'extension';
        if (extensionWs && extensionWs !== ws) {
          try { extensionWs.close(1000, 'replaced'); } catch {}
        }
        extensionWs = ws;
        console.log('[ws] extension registered', addr);
        clearTimeout(helloTimer);
        send(ws, { type: 'hello-ack', role: 'extension' });
        broadcastToClients({ type: 'event', event: 'extension_connected' });
        // IPI-303: drain queued actions now that the extension is back.
        setImmediate(() => { try { drainQueueOnReconnect(); } catch (e) { console.log('[queue] drain error:', e.message); } });
      } else {
        role = 'client';
        clients.add(ws);
        console.log('[ws] client registered', addr);
        clearTimeout(helloTimer);
        send(ws, { type: 'hello-ack', role: 'client',
                   extensionConnected: !!(extensionWs && extensionWs.readyState === 1) });
      }
      return;
    }

    // Extension or agent → server: control messages (no id,
    // fire-and-forget). The agent process keeps its own entry in
    // the agent registry fresh by sending AGENT_UPDATE each step;
    // the extension pushes the user's stored LLM config so /llm
    // can proxy without re-asking.
    if ((role === 'extension' || role === 'agent') && !msg.id) {
      if (msg.type === 'SAVE_LLM_CONFIG') {
        _llmConfig = msg.config || null;
        send(ws, { ok: true, saved: !!_llmConfig });
        return;
      }
      if (msg.type === 'AGENT_REGISTER') {
        const a = Object.assign({ startedAt: Date.now(), lastStepAt: Date.now(), steps: 0, addr }, msg.agent || {});
        agents.set(a.id, a);
        send(ws, { ok: true, registered: a.id });
        return;
      }
      if (msg.type === 'AGENT_UPDATE') {
        const a = agents.get(msg.runId);
        if (a) Object.assign(a, msg.patch || {}, { lastStepAt: Date.now() });
        send(ws, { ok: !!a, runId: msg.runId });
        return;
      }
      if (msg.type === 'AGENT_UNREGISTER') {
        const had = agents.delete(msg.runId);
        send(ws, { ok: had, runId: msg.runId });
        return;
      }
    }

    // Extension → server: response to a pending request
    if (role === 'extension' && msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      if (p && p.idemKey) {
        completed.set(p.idemKey, { response: msg, ts: Date.now() });
      }
      resolvePending(msg.id, msg);
      // Mirror to all clients for observability
      broadcastToClients({ type: 'event', event: 'extension_result', payload: msg });
      return;
    }

    // Client / Agent → server: action request (or control)
    if (role === 'client' || role === 'agent') {
      if (msg.type === 'ping') return send(ws, { type: 'pong', ts: Date.now() });
      if (msg.type === 'broadcast') {
        broadcastToClients({ type: 'event', event: 'broadcast', from: addr, fromRole: role, payload: msg.payload });
        return;
      }
      if (msg.action) {
        const validationError = validateAction(msg);
        if (validationError) {
          send(ws, { id: msg.id, ...validationError });
          return;
        }
        try {
          const result = await sendToExtension(msg);
          send(ws, { id: msg.id, ...result });
        } catch (e) {
          send(ws, { id: msg.id, ok: false, error: e.message, errorCode: 'EXTENSION_UNAVAILABLE' });
        }
        return;
      }
    }
    } catch (e) {
      // Step 4: a single bad message must never crash the server.
      console.log('[ws] handler error', addr, e.message);
      try { send(ws, { ok: false, error: 'handler error: ' + e.message }); } catch {}
    }
  });

  // Step 4: socket-level error handler — log and close, never crash.
  ws.on('error', (e) => {
    console.log('[ws] socket error', addr, e && e.message);
    try { ws.close(); } catch {}
  });

  ws.on('close', () => {
    clearTimeout(helloTimer);
    if (role === 'extension' && extensionWs === ws) {
      // Only null out if this WS is still the current extension. When a
      // new extension replaces the old one, the new register path calls
      // extensionWs.close() which fires our close handler - but the new
      // extension has already taken over extensionWs, so we must NOT
      // clear it here or /status will lie.
      extensionWs = null;
      console.log('[ws] extension disconnected', addr);
      broadcastToClients({ type: 'event', event: 'extension_disconnected' });
      // Reject any in-flight requests
      for (const id of Array.from(pending.keys())) {
        rejectPending(id, new Error('Extension disconnected'));
      }
    } else if (role === 'client' || role === 'agent') {
      clients.delete(ws);
      console.log('[ws] ' + role + ' disconnected', addr);
    }
  });

  ws.on('error', (e) => console.log('[ws] error', addr, e.message));
});

// ------------------------------------------------------------------
// Auto-reload: watch the extension dir, push /reload to the
// connected extension on any change. Debounced 400ms so an
// editor's save-burst doesn't fire multiple reloads.
// ------------------------------------------------------------------
import { watch as fsWatch, existsSync } from 'node:fs';
import { resolve as pathResolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname_c = dirname(fileURLToPath(import.meta.url));
const EXT_DIR = pathResolve(__dirname_c);
let reloadTimer = null;
let lastReload = 0;
function scheduleReload(reason) {
  if (reloadTimer) clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    reloadTimer = null;
    if (!extensionWs || extensionWs.readyState !== extensionWs.OPEN) return;
    const now = Date.now();
    if (now - lastReload < 500) return; // 500ms cooldown
    lastReload = now;
    console.log('[auto-reload] file change (' + reason + '), pushing reload to extension');
    send(extensionWs, { type: 'reload' });
  }, 400);
}

function startWatcher() {
  if (!existsSync(EXT_DIR)) return;
  try {
    fsWatch(EXT_DIR, { recursive: true }, (event, filename) => {
      if (!filename) return;
      const f = String(filename);
      const norm = f.split(/[\\/]/).pop();
      if (/^\.|~$|\.(swp|swo|bak|lock|log)$/.test(norm)) return;
      if (f.includes('node_modules') || f.includes('.git/') || f.includes('dist/') ||
          f.includes('build/') || f.includes('coverage/') || f.includes('.turbo/') ||
          f.includes('.next/') || f.includes('.cache/')) return;
      if (norm === 'package-lock.json' || norm === 'yarn.lock' || norm === 'pnpm-lock.yaml') return;
      if (!/\.(js|css|html|json|mjs)$/.test(f)) return;
      scheduleReload(f);
    });
    console.log('[auto-reload] watching ' + EXT_DIR);
  } catch (e) {
    console.log('[auto-reload] could not start watcher:', e.message);
  }
}

// ------------------------------------------------------------------
// Boot
// ------------------------------------------------------------------
server.listen(PORT, HOST, () => {
  console.log(`Agent Controller server listening on http://${HOST}:${PORT}`);
  console.log(`  WebSocket:  ws://${HOST}:${PORT}/ws`);
  console.log(`  HTTP API:   http://${HOST}:${PORT}/status`);
  console.log(`  Home page:  http://${HOST}:${PORT}/`);
  console.log(`Extension should connect to ws://${HOST}:${PORT}/ws`);
});

// Step 4: process-level guards so an unhandled error or rejection
// cannot take the relay down. The server logs the error and
// resets any in-flight requests so the next client can connect
// cleanly.
process.on('uncaughtException', (e) => {
  console.log('[server] uncaughtException:', e && e.message);
  for (const id of Array.from(pending.keys())) {
    rejectPending(id, new Error('Server reset: ' + e.message));
  }
});
process.on('unhandledRejection', (e) => {
  console.log('[server] unhandledRejection:', e && (e.message || e));
});
process.on('SIGINT',  () => { console.log('\nshutting down'); server.close(() => process.exit(0)); });
process.on('SIGTERM', () => { console.log('\nshutting down'); server.close(() => process.exit(0)); });

startWatcher();
