// offscreen.js — owns the WebSocket connection to the controller.
// IPI-304: keeps the connection alive across MV3 service worker
// restarts because this document is a real page (not a worker).
const HEARTBEAT_MS = 25000;
import { spawn } from 'node:child_process';
let ws = null;
let reconnectTimer = null;
let shouldReconnect = true;

function getConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get('config', (r) => {
      resolve((r && r.config) || {});
    });
  });
}

function wsSend(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify(obj)); } catch (e) { /* ignore */ }
  }
}

function log(level, msg) {
  console.log('[offscreen]', level, msg);
}

function connect(url) {
  if (ws) {
    try { ws.close(); } catch {}
    ws = null;
  }
  if (!url) return;
  log('info', 'connecting to ' + url);
  ws = new WebSocket(url);
  ws.addEventListener('open', () => {
    log('info', 'connected');
    wsSend({ type: 'hello', role: 'extension', version: '1.0.0' });
  });
  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    // Controller asks us to reload (e.g. after a file change so
    // the service worker picks up the new background.js code).
    if (msg.type === 'reload') {
      log('info', 'reload requested by controller; calling chrome.runtime.reload()');
      try { chrome.runtime.reload(); } catch (e) { log('error', 'reload failed: ' + e.message); }
      return;
    }
    // Forward incoming action requests to the service worker.
    if (msg.action) {
      chrome.runtime.sendMessage({ kind: 'offscreen-action', msg })
        .then((result) => {
          wsSend({ id: msg.id, ...(result || { ok: false, error: 'no result' }) });
        })
        .catch((err) => {
          wsSend({ id: msg.id, ok: false, error: String(err && err.message || err) });
        });
    }
  });
  ws.addEventListener('close', () => {
    ws = null;
    if (shouldReconnect) {
      reconnectTimer = setTimeout(async () => {
        const c = await getConfig();
        if (c.controllerUrl) connect(c.controllerUrl);
      }, 3000);
    }
  });
  ws.addEventListener('error', () => { /* close will fire */ });
}

// Heartbeat: tell the background we're still alive.
setInterval(() => {
  chrome.runtime.sendMessage({ kind: 'offscreen-heartbeat' }).catch(() => {});
}, HEARTBEAT_MS);

// Listen for reconnect requests from the background (e.g. when
// the config changes).
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.kind === 'offscreen-reconnect') {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    connect(msg.url);
  }
});

// Boot
(async function () {
  const c = await getConfig();
  if (c.controllerUrl) connect(c.controllerUrl);
})();


// ------------------------------------------------------------------
// Agent process: spawn agent.mjs in a child Node process and
// stream its stdout/stderr back to the background (which then
// forwards to the popup as AGENT_LOG / AGENT_FINISHED messages).
//
// The service worker can't spawn children directly, so the popup
// asks the background, which delegates the spawn to us.
// ------------------------------------------------------------------

let agentProc = null;
let agentRunId = null;

function agentLog(level, line) {
  chrome.runtime.sendMessage({ kind: 'agent-log', level, line }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.kind === 'agent-start') {
    (async () => {
      try {
        if (agentProc) {
          sendResponse({ ok: false, error: 'agent already running' });
          return;
        }
        const { goal, startUrl, controllerUrl, env, runId } = msg;
        agentRunId = runId;
        const proc = spawn(process.execPath, [
          new URL('agent.mjs', location.href).pathname,
          goal,
          '--controller', controllerUrl,
          ...(startUrl ? ['--url', startUrl] : []),
        ], {
          cwd: new URL('.', location.href).pathname,
          env: Object.assign({}, process.env, env || {}),
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        agentProc = proc;
        agentLog('info', 'spawned agent pid=' + proc.pid);
        proc.stdout.on('data', (chunk) => {
          for (const line of chunk.toString().split('\n')) {
            if (!line.trim()) continue;
            // The agent emits "[info] msg" or "[ok] msg" etc.
            const m = line.match(/^\[(\w+)\]\s*(.*)$/);
            if (m) agentLog(m[1], m[2]);
            else agentLog('info', line);
          }
        });
        proc.stderr.on('data', (chunk) => {
          for (const line of chunk.toString().split('\n')) {
            if (line.trim()) agentLog('error', line);
          }
        });
        proc.on('exit', (code) => {
          agentLog(code === 0 ? 'ok' : 'error', 'agent exited with code ' + code);
          chrome.runtime.sendMessage({ kind: 'agent-finished', runId: agentRunId, code }).catch(() => {});
          agentProc = null;
          agentRunId = null;
        });
        sendResponse({ ok: true, runId, pid: proc.pid });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true; // async
  }
  if (msg && msg.kind === 'agent-stop') {
    if (!agentProc) { sendResponse({ ok: false, error: 'no agent running' }); return true; }
    try { agentProc.kill('SIGTERM'); }
    catch (e) { sendResponse({ ok: false, error: e.message }); return true; }
    sendResponse({ ok: true });
    return true;
  }
  if (msg && msg.kind === 'agent-status') {
    sendResponse({ ok: true, active: !!agentProc, runId: agentRunId, pid: agentProc ? agentProc.pid : null });
    return true;
  }
});
