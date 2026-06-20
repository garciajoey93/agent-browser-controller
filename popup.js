/* =============================================================
 * popup.js — UI controller for the Agent Controller popup.
 * ============================================================= */

'use strict';

const $ = (id) => document.getElementById(id);

let lastScreenshot = null;

async function loadConfig() {
  const r = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
  if (!r || !r.ok) return;
  const c = r.config || {};
  $('controllerUrl').value   = c.controllerUrl || 'ws://localhost:9223/ws';
  $('pollingUrl').value      = c.pollingUrl    || 'http://localhost:9223/poll';
  $('pollingSecret').value   = c.pollingSecret || '';
  $('autoConnect').checked   = !!c.autoConnect;
  $('transport').value       = c.usePolling ? 'polling' : 'websocket';
  $('coordMode').value       = c.coordMode   || 'normalized_1000';
  $('useDebugger').checked   = c.useDebugger !== false;
  $('typeDelay').value       = c.typeDelayMs    ?? 12;
  $('captureDelay').value    = c.captureDelayMs ?? 350;
  $('maxImageDim').value     = c.maxImageDim    ?? 1280;
  applyTransportVisibility();
  updateStatus(r);
  renderLog(r.log || []);
}

function applyTransportVisibility() {
  const t = $('transport').value;
  $('controllerUrl').closest('label').style.display = t === 'websocket' ? '' : 'none';
  $('pollingUrl').closest('label').style.display    = t === 'polling'   ? '' : 'none';
  $('pollingSecret').closest('label').style.display = t === 'polling'   ? '' : 'none';
}

function updateStatus(r) {
  const s = $('status');
  s.classList.remove('connected', 'disconnected', 'connecting');
  if (r.connected) {
    s.classList.add('connected');
    s.textContent = (r.transport === 'polling' ? 'Polling' : 'Connected');
  } else {
    s.classList.add('disconnected');
    s.textContent = 'Disconnected';
  }
  $('tabInfo').textContent = r.activeTabId
    ? `Tab ${r.activeTabId}`
    : 'No active tab';
}

function renderLog(entries) {
  const body = $('log');
  body.innerHTML = '';
  for (const e of entries) {
    const div = document.createElement('div');
    div.className = 'entry ' + (e.level || 'info');
    const ts = document.createElement('span');
    ts.className = 'ts';
    ts.textContent = '[' + new Date(e.ts).toLocaleTimeString() + ']';
    div.appendChild(ts);
    div.appendChild(document.createTextNode(e.msg));
    body.appendChild(div);
  }
  body.scrollTop = body.scrollHeight;
}

function showScreenshot(dataUrl) {
  if (!dataUrl) return;
  lastScreenshot = dataUrl;
  const box = $('screenshotBox');
  box.innerHTML = '';
  const img = document.createElement('img');
  img.src = dataUrl;
  box.appendChild(img);
}

function showActionResult(action, params, result) {
  const out = document.getElementById('lastAction');
  out.textContent = JSON.stringify({ action, params, result }, null, 2);
}

async function saveConfig() {
  await chrome.runtime.sendMessage({
    type: 'SAVE_CONFIG',
    config: {
      controllerUrl:  $('controllerUrl').value.trim() || 'ws://localhost:9223/ws',
      pollingUrl:     $('pollingUrl').value.trim()    || 'http://localhost:9223/poll',
      pollingSecret:  $('pollingSecret').value,
      autoConnect:    $('autoConnect').checked,
      usePolling:     $('transport').value === 'polling',
      coordMode:      $('coordMode').value,
      useDebugger:    $('useDebugger').checked,
      typeDelayMs:    parseInt($('typeDelay').value, 10)    ?? 12,
      captureDelayMs: parseInt($('captureDelay').value, 10) ?? 350,
      maxImageDim:    parseInt($('maxImageDim').value, 10)  ?? 1280,
    },
  });
}

$('transport').addEventListener('change', applyTransportVisibility);

$('connect').addEventListener('click', async () => {
  await saveConfig();
  const t = $('transport').value;
  let url, secret = '';
  if (t === 'websocket') {
    url = $('controllerUrl').value.trim();
  } else {
    url = $('pollingUrl').value.trim();
    secret = $('pollingSecret').value;
  }
  const r = await chrome.runtime.sendMessage({
    type: 'CONNECT', transport: t, url, secret,
  });
  if (!r || !r.ok) alert('Connect failed: ' + (r && r.error || 'unknown'));
  refreshStatus();
});

$('disconnect').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'DISCONNECT' });
  refreshStatus();
});

$('capture').addEventListener('click', async () => {
  const r = await chrome.runtime.sendMessage({ type: 'CAPTURE_STATE' });
  if (r && r.ok && r.dataUrl) showScreenshot(r.dataUrl);
  else alert('Capture failed: ' + (r && r.error || 'unknown'));
});

$('clearLog').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'CLEAR_LOG' });
  refreshStatus();
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'LOG') return refreshStatus();
  if (msg.type === 'CONNECTION_STATUS') return refreshStatus();
  if (msg.type === 'ACTION_RESULT') {
    showActionResult(msg.action, msg.params, msg.result);
    return refreshStatus();
  }
});

async function refreshStatus() {
  const r = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
  if (r && r.ok) {
    updateStatus(r);
    renderLog(r.log || []);
    // IPI-319: also pull /history from the controller.
    // Port comes from the controller; we sniff it from the
    // controller URL if available, else default 9223.
    const port = (window.location && 9223) || 9223;
    refreshHistory(port);
  }
}

loadConfig();
setInterval(refreshStatus, 2000);


// IPI-319: fetch and render the last few actions from the
// controller's /history endpoint. Refreshes when the status pill
// changes or every 5s.
async function refreshHistory(controllerPort) {
  const list = document.getElementById('historyList');
  if (!list) return;
  try {
    const r = await fetch('http://127.0.0.1:' + controllerPort + '/history');
    const j = await r.json();
    const items = (j.history || []).slice(0, 8);
    if (!items.length) { list.innerHTML = '<div class="muted">No actions yet.</div>'; return; }
    list.innerHTML = '';
    for (const h of items) {
      const div = document.createElement('div');
      div.className = 'entry ' + (h.ok ? 'info' : 'error');
      const ts = new Date(h.ts || Date.now()).toLocaleTimeString();
      const dur = (h.ms != null) ? (' (' + h.ms + 'ms)') : '';
      div.appendChild(document.createTextNode('[' + ts + '] ' + h.action + dur));
      list.appendChild(div);
    }
  } catch (e) { /* controller not running — ignore */ }
}
