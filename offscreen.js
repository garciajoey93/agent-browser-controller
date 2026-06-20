// offscreen.js — owns the WebSocket connection to the controller.
// IPI-304: keeps the connection alive across MV3 service worker
// restarts because this document is a real page (not a worker).
const HEARTBEAT_MS = 25000;
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
