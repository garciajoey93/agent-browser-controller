/* =============================================================
 * background.js — Service worker for the Agent Browser Controller.
 *
 * The extension is a controllable surface: an external agent
 * (Codex, a Python script, a curl call) drives it by sending
 * JSON action requests over a WebSocket (or HTTP polling) and
 * receives state + results back.
 *
 *   ┌──────────────┐   WS / HTTP   ┌──────────────────┐
 *   │  controller  │ ────────────► │  background.js   │
 *   │  (Codex,     │ ◄──────────── │  (this file)     │
 *   │   Python,    │   results     │                  │
 *   │   curl)      │               │  tab API         │
 *   └──────────────┘               │  chrome.debugger │
 *                                  │  content.js      │
 *                                  └────────┬─────────┘
 *                                           │
 *                                  ┌────────▼─────────┐
 *                                  │   active tab     │
 *                                  └──────────────────┘
 *
 * Protocol (JSON, request/response correlated by `id`):
 *
 *   { id, action: "click",        params: { x, y } }
 *   { id, action: "type",         params: { x, y, text } }
 *   { id, action: "scroll",       params: { direction, amount } }
 *   { id, action: "navigate",     params: { url } }
 *   { id, action: "capture_state",params: {} }
 *   { id, action: "screenshot",   params: {} }
 *   { id, action: "inspect",      params: {} }
 *   { id, action: "evaluate",     params: { script } }
 *   { id, action: "tabs",         params: {} }
 *   { id, action: "open",         params: { url } }
 *   { id, action: "close",        params: { tabId? } }
 *   { id, action: "switch_tab",   params: { tabId } }
 *   { id, action: "wait",         params: { ms } }
 *
 *   Response: { id, ok, result? , error? }
 *
 * The controller is always the *initiator*. The extension is a
 * WebSocket / polling client. This keeps Chrome's MV3 sandbox
 * happy (extensions cannot bind ports) while still giving any
 * external client — including a local Codex-style agent — a
 * clean RPC surface.
 * ============================================================= */

'use strict';

// ------------------------------------------------------------------
// Configuration & runtime state
// ------------------------------------------------------------------
const DEFAULT_CONFIG = {
  controllerUrl:    'ws://localhost:9223/ws',
  usePolling:       false,
  pollingUrl:       'http://localhost:9223/poll',
  pollingSecret:    '',
  coordMode:        'normalized_1000', // 'normalized_1000' | 'normalized_1' | 'pixel'
  useDebugger:      true,              // trusted events via chrome.debugger
  typeDelayMs:      12,                // delay between per-character key events
  captureDelayMs:   350,
  maxImageDim:      1280,              // longest edge to resize screenshots to
  imageQuality:     0.82,              // JPEG quality 0..1
  requestTimeoutMs: 30000,
  autoConnect:      true,              // auto-reconnect on extension start
};

const STATE = {
  config:      { ...DEFAULT_CONFIG },
  ws:          null,
  pollTimer:   null,
  pollInflight:false,
  reconnectTimer: null,
  activeTabId: null,
  log:         [],
  agentChild:    null, // { process, runId } while an agent is running
  agentRunId:    null,
  agentTabId:    null,
  agentGoal:     null,
  // Agent-mode state. When an autonomous agent run is active:
  //  - agentTabId is the tab the agent is working on (overrides
  //    activeTabId for action routing)
  //  - agentPinned=true means we ignore user tab switches so the
  //    agent doesn't lose its work context
  //  - agentRunId is the unique id the controller's agent
  //    registry uses to track this run
  agentTabId:  null,
  agentPinned: false,
  agentRunId:  null,
  agentGoal:   null,
};

const LOG_LIMIT = 400;

// ------------------------------------------------------------------
// Logging
// ------------------------------------------------------------------
function log(level, ...args) {
  const entry = {
    ts: Date.now(),
    level,
    msg: args.map(a => typeof a === 'string' ? a : safeJson(a)).join(' '),
  };
  STATE.log.push(entry);
  if (STATE.log.length > LOG_LIMIT) STATE.log.shift();
  if (level === 'error') console.error('[agent-bg]', entry.msg);
  else                    console.log('[agent-bg]', entry.msg);
  chrome.runtime.sendMessage({ type: 'LOG', entry }).catch(() => {});
}
const logInfo  = (...a) => log('info',  ...a);
const logWarn  = (...a) => log('warn',  ...a);
const logError = (...a) => log('error', ...a);

function safeJson(v) {
  try { return JSON.stringify(v); } catch { return String(v); }
}

// ------------------------------------------------------------------
// Persistent config
// ------------------------------------------------------------------
async function loadConfig() {
  try {
    const { config = {} } = await chrome.storage.local.get('config');
    STATE.config = { ...DEFAULT_CONFIG, ...config };
  } catch (e) {
    logError('loadConfig failed', e.message);
    STATE.config = { ...DEFAULT_CONFIG };
  }
}
async function saveConfig() {
  try { await chrome.storage.local.set({ config: STATE.config }); }
  catch (e) { logError('saveConfig failed', e.message); }
}

// ------------------------------------------------------------------
// Tab helpers
// ------------------------------------------------------------------
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

async function ensureContentScript(tabId) {
  if (!tabId) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId }, files: ['content.js'],
    });
  } catch (_) { /* probably already injected */ }
}

async function sendToContent(tabId, message) {
  await ensureContentScript(tabId);
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, message, (resp) => {
        const err = chrome.runtime.lastError;
        if (err) return resolve({ ok: false, error: err.message });
        resolve(resp);
      });
    } catch (e) {
      resolve({ ok: false, error: String(e && e.message || e) });
    }
  });
}

async function waitForTabComplete(tabId, timeoutMs) {
  timeoutMs = timeoutMs || 15000;
  const start = Date.now();
  return new Promise((resolve) => {
    (function check() {
      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError) return resolve(false);
        if (tab && tab.status === 'complete') return resolve(true);
        if (Date.now() - start > timeoutMs)  return resolve(false);
        setTimeout(check, 200);
      });
    })();
  });
}

// ------------------------------------------------------------------
// chrome.debugger — trusted input event dispatch
// ------------------------------------------------------------------
const attachedTabs = new Set();

async function attachDebugger(tabId) {
  if (attachedTabs.has(tabId)) return;
  await new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, '1.3', () => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message)); else resolve();
    });
  });
  attachedTabs.add(tabId);
}

async function detachDebugger(tabId) {
  if (!attachedTabs.has(tabId)) return;
  try {
    await new Promise((resolve) => {
      chrome.debugger.detach({ tabId }, () => resolve());
    });
  } catch (_) {}
  attachedTabs.delete(tabId);
}

async function detachAllDebuggers() {
  for (const id of Array.from(attachedTabs)) await detachDebugger(id);
}

function sendCDP(tabId, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params || {}, (result) => {
      const err = chrome.runtime.lastError;
      if (err) return reject(new Error(err.message));
      resolve(result);
    });
  });
}

// Capture a screenshot of the active tab via the CDP
// Page.captureScreenshot method. This bypasses the chrome.tabs
// captureVisibleTab activeTab requirement entirely. Returns
// a data:image/png;base64,... string. Requires the debugger to
// be attached to the tab — caller passes the tabId.
async function captureScreenshotViaCDP(tabId, format) {
  await attachDebugger(tabId);
  // IPI-322: support png (default), jpeg, webp
  const fmt = (format === 'jpeg' || format === 'webp') ? format : 'png';
  const params = { format: fmt, captureBeyondViewport: false };
  if (fmt !== 'png' && typeof p?.quality === 'number') params.quality = p.quality;
  const { data } = await sendCDP(tabId, 'Page.captureScreenshot', params);
  return 'data:image/' + fmt + ';base64,' + data;
}

// IPI-305: read-only screenshot via chrome.tabs.captureVisibleTab.
// Does NOT trigger the "Chrome is being controlled" banner. Requires
// activeTab permission to be in effect (i.e. the user has clicked
// the extension icon at least once). Throws if it fails.
async function captureScreenshotViaChrome(tabId) {
  const win = await new Promise((resolve, reject) => {
    chrome.windows.get(tabId ? { populate: false } : { windowId: chrome.windows.WINDOW_ID_CURRENT },
      (w) => {
        const err = chrome.runtime.lastError;
        if (err) return reject(new Error(err.message));
        resolve(w);
      });
  });
  if (!win) throw new Error('no current window');
  return new Promise((resolve, reject) => {
    chrome.tabs.captureVisibleTab(win.id, { format: 'png' }, (url) => {
      const err = chrome.runtime.lastError;
      if (err) return reject(new Error(err.message));
      resolve(url);
    });
  });
}

async function trustedClick(tabId, x, y) {
  await attachDebugger(tabId);
  const common = { x: Math.round(x), y: Math.round(y),
                   button: 'left', clickCount: 1, buttons: 1 };
  await sendCDP(tabId, 'Input.dispatchMouseEvent', { ...common, type: 'mousePressed' });
  await sendCDP(tabId, 'Input.dispatchMouseEvent', { ...common, type: 'mouseReleased' });
  return { ok: true, x, y, trusted: true };
}

// ------------------------------------------------------------------
// Per-character key dispatch tables
// ------------------------------------------------------------------
function charToKeyInfo(c) {
  const code = c.charCodeAt(0);
  if (code >= 97 && code <= 122) {
    return { key: c, code: 'Key' + c.toUpperCase(), vkey: code, shift: false, text: c };
  }
  if (code >= 65 && code <= 90) {
    return { key: c, code: 'Key' + c, vkey: code, shift: true, text: c };
  }
  if (code >= 48 && code <= 57) {
    return { key: c, code: 'Digit' + c, vkey: code, shift: false, text: c };
  }
  const sdig = { '!':49,'@':50,'#':51,'$':52,'%':53,
                 '^':54,'&':55,'*':56,'(':57,')':48 };
  if (Object.prototype.hasOwnProperty.call(sdig, c)) {
    return { key: c, code: 'Digit' + String.fromCharCode(sdig[c]),
             vkey: sdig[c], shift: true, text: c };
  }
  if (c === ' ')  return { key: ' ',    code: 'Space', vkey: 32, shift: false, text: ' ' };
  if (c === '\n') return { key: 'Enter', code: 'Enter', vkey: 13, shift: false, text: '\r' };
  if (c === '\t') return { key: 'Tab',   code: 'Tab',   vkey: 9,  shift: false, text: '\t' };
  const puncU = {
    ',': 188, '.': 190, '/': 191, ';': 186, "'": 222,
    '[': 219, ']': 221, '\\': 220, '`': 192, '-': 189, '=': 187,
  };
  if (Object.prototype.hasOwnProperty.call(puncU, c)) {
    return { key: c, code: c, vkey: puncU[c], shift: false, text: c };
  }
  const puncS = {
    '<': 188, '>': 190, '?': 191, ':': 186, '"': 222,
    '{': 219, '}': 221, '|': 220, '~': 192, '_': 189, '+': 187,
  };
  if (Object.prototype.hasOwnProperty.call(puncS, c)) {
    return { key: c, code: c, vkey: puncS[c], shift: true, text: c };
  }
  return null;
}

async function dispatchChar(tabId, c) {
  const k = charToKeyInfo(c);
  if (!k) {
    await sendCDP(tabId, 'Input.insertText', { text: c });
    return;
  }
  const downMod = k.shift ? 8 : 0; // 8 = Shift
  await sendCDP(tabId, 'Input.dispatchKeyEvent', {
    type: 'rawKeyDown', key: k.key, code: k.code,
    windowsVirtualKeyCode: k.vkey, nativeVirtualKeyCode: k.vkey,
    modifiers: downMod,
  });
  await sendCDP(tabId, 'Input.dispatchKeyEvent', {
    type: 'char', text: k.text, unmodifiedText: k.text, key: k.key,
  });
  await sendCDP(tabId, 'Input.dispatchKeyEvent', {
    type: 'keyUp', key: k.key, code: k.code,
    windowsVirtualKeyCode: k.vkey, nativeVirtualKeyCode: k.vkey,
    modifiers: 0,
  });
}

async function trustedClear(tabId) {
  // Two-pronged clear: Ctrl+A + Delete AND a triple-click select +
  // Delete. Some custom inputs (e.g. YouTube's search box) don't
  // respond to Ctrl+A; the triple-click is a more universal fallback.
  // We do both back-to-back so the second one is a no-op when the
  // first one already cleared.

  // Prong 1: explicit Ctrl key + rawKeyDown for 'a' + Delete.
  await sendCDP(tabId, 'Input.dispatchKeyEvent', {
    type: 'rawKeyDown', key: 'Control', code: 'ControlLeft',
    windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17, modifiers: 2,
  });
  await sendCDP(tabId, 'Input.dispatchKeyEvent', {
    type: 'rawKeyDown', key: 'a', code: 'KeyA',
    windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2,
  });
  await sendCDP(tabId, 'Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'a', code: 'KeyA',
    windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2,
  });
  await sendCDP(tabId, 'Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'Control', code: 'ControlLeft',
    windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17, modifiers: 0,
  });
  await sendCDP(tabId, 'Input.dispatchKeyEvent', {
    type: 'rawKeyDown', key: 'Delete', code: 'Delete',
    windowsVirtualKeyCode: 46, nativeVirtualKeyCode: 46, modifiers: 0,
  });
  await sendCDP(tabId, 'Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'Delete', code: 'Delete',
    windowsVirtualKeyCode: 46, nativeVirtualKeyCode: 46, modifiers: 0,
  });

  // Prong 2: Home (cursor to start), Shift+End (select to end),
  // Delete. Works on inputs that ignore Ctrl+A.
  await sendCDP(tabId, 'Input.dispatchKeyEvent', {
    type: 'rawKeyDown', key: 'Home', code: 'Home',
    windowsVirtualKeyCode: 36, nativeVirtualKeyCode: 36, modifiers: 0,
  });
  await sendCDP(tabId, 'Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'Home', code: 'Home',
    windowsVirtualKeyCode: 36, nativeVirtualKeyCode: 36, modifiers: 0,
  });
  await sendCDP(tabId, 'Input.dispatchKeyEvent', {
    type: 'rawKeyDown', key: 'End', code: 'End',
    windowsVirtualKeyCode: 35, nativeVirtualKeyCode: 35, modifiers: 8, // Shift
  });
  await sendCDP(tabId, 'Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'End', code: 'End',
    windowsVirtualKeyCode: 35, nativeVirtualKeyCode: 35, modifiers: 8,
  });
  await sendCDP(tabId, 'Input.dispatchKeyEvent', {
    type: 'rawKeyDown', key: 'Delete', code: 'Delete',
    windowsVirtualKeyCode: 46, nativeVirtualKeyCode: 46, modifiers: 0,
  });
  await sendCDP(tabId, 'Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'Delete', code: 'Delete',
    windowsVirtualKeyCode: 46, nativeVirtualKeyCode: 46, modifiers: 0,
  });
}

async function trustedType(tabId, x, y, text) {
  await attachDebugger(tabId);
  text = String(text == null ? '' : text);
  await trustedClick(tabId, x, y);
  await sleep(30);
  if (text.length > 0) {
    await trustedClear(tabId);
    await sleep(20);
  }
  const delay = Math.max(0, Math.min(200, Number(STATE.config.typeDelayMs) || 12));
  for (let i = 0; i < text.length; i++) {
    await dispatchChar(tabId, text[i]);
    if (delay) await sleep(delay);
  }
  return { ok: true, x, y, value: text, trusted: true,
           cleared: text.length > 0, charCount: text.length };
}

async function trustedScroll(tabId, direction, amount) {
  await attachDebugger(tabId);
  const yMap = { up: -1, down: 1 };
  const xMap = { left: -1, right: 1 };
  const dy = (yMap[direction] || 0) * Number(amount || 0);
  const dx = (xMap[direction] || 0) * Number(amount || 0);
  let tab;
  try { tab = await chrome.tabs.get(tabId); } catch { tab = null; }
  const cx = Math.round((tab && tab.width)  ? tab.width  / 2 : 640);
  const cy = Math.round((tab && tab.height) ? tab.height / 2 : 360);
  await sendCDP(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseWheel', x: cx, y: cy, deltaX: dx, deltaY: dy,
  });
  return { ok: true, direction, dy, dx, trusted: true };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ------------------------------------------------------------------
// Coordinate scaling
// ------------------------------------------------------------------
// Coordinate matrix alignment.
//
// The MiniMax vision model emits click coordinates in a chosen
// coordinate space. This layer converts them to CSS pixels for
// chrome.debugger's Input.dispatchMouseEvent. We support:
//
//   mode 'normalized_1000' (default): x,y in [0,1000] → px
//   mode 'normalized_1'             : x,y in [0,1]    → px
//   mode 'pixel'                    : already CSS px   → pass-through
//   mode 'device_pixel'             : divide by DPR     → CSS px
//
// DPR accounting: chrome.tabs.captureVisibleTab returns the
// screenshot at the viewport's CSS pixel resolution, and
// Input.dispatchMouseEvent takes CSS pixels too. So the
// conversion is 1:1 in the default config. If the model
// instead emits device-pixel coordinates (rare), set
// coordMode = 'device_pixel' and the DPR is applied.
function denormalizeCoord(value, max, mode, dpr) {
  const v = Number(value);
  if (!Number.isFinite(v)) return 0;
  let px;
  if (mode === 'normalized_1000')      px = (v / 1000) * max;
  else if (mode === 'normalized_1')    px = v * max;
  else if (mode === 'device_pixel')    px = v / (dpr || 1);
  else                                  px = v; // 'pixel' or unknown
  return Math.round(px);
}

function applyCoordScaling(params, viewport) {
  if (!viewport) return params || {};
  const mode = STATE.config.coordMode || 'normalized_1000';
  const dpr  = Number(viewport.dpr) || 1;
  const out  = { ...(params || {}) };
  if (typeof out.x === 'number') out.x = denormalizeCoord(out.x, viewport.width,  mode, dpr);
  if (typeof out.y === 'number') out.y = denormalizeCoord(out.y, viewport.height, mode, dpr);
  out._scaledFromMode = mode;
  out._scaledFromDpr  = dpr;
  return out;
}

// ------------------------------------------------------------------
// Action execution dispatcher
// ------------------------------------------------------------------
async function executeAction(request) {
  if (!request || !request.action) {
    return { ok: false, error: 'Action missing "action" field' };
  }
  const { id, action, params } = request;
  let tabId = params && params.tabId;
  if (!tabId) tabId = STATE.agentTabId || STATE.activeTabId;
  if (!tabId) {
    const t = await getActiveTab();
    tabId = t && t.id;
  }
  if (!tabId) return { ok: false, error: 'No active tab', errorCode: 'NO_TAB' };
  STATE.activeTabId = tabId;

  const useDbg = !!STATE.config.useDebugger;
  const p = params || {};

  try {
    switch (action) {
      case 'click': {
        if (!Number.isFinite(Number(p.x)) || !Number.isFinite(Number(p.y))) {
          return { ok: false, error: 'click requires numeric x, y' };
        }
        const scaled = applyCoordScaling(p, { width: 1, height: 1 });
        // We don't know the viewport until the click; the controller
        // is responsible for supplying pixel coords. We still call
        // denormalizeCoord using the active tab's viewport so the
        // controller can also send 0-1000 coords.
        let vp = await sendToContent(tabId, { type: 'GET_VIEWPORT' });
        const scaled2 = applyCoordScaling(p, vp || { width: 1, height: 1 });
        // Red anchor dot (validation Step 3): where the agent
        // clicked, visible briefly, then the authentic click fires.
        await sendToContent(tabId, { type: 'SHOW_ANCHOR',
                                     x: scaled2.x, y: scaled2.y, ms: 700 });
        return useDbg
          ? await trustedClick(tabId, scaled2.x, scaled2.y)
          : await sendToContent(tabId, { type: 'SYNTHETIC_CLICK',
                                         x: scaled2.x, y: scaled2.y });
      }
      case 'type': {
        if (!Number.isFinite(Number(p.x)) || !Number.isFinite(Number(p.y))) {
          return { ok: false, error: 'type requires numeric x, y' };
        }
        let vp = await sendToContent(tabId, { type: 'GET_VIEWPORT' });
        const s = applyCoordScaling(p, vp || { width: 1, height: 1 });
        await sendToContent(tabId, { type: 'SHOW_TARGET',
                                     x: s.x, y: s.y, ms: 1200 });
        const text = String(p.text || '');
        return useDbg
          ? await trustedType(tabId, s.x, s.y, text)
          : await sendToContent(tabId, { type: 'SYNTHETIC_TYPE',
                                         x: s.x, y: s.y, text });
      }
      case 'scroll': {
        const direction = String(p.direction || 'down').toLowerCase();
        const amount    = Number(p.amount) || 0;
        return useDbg
          ? await trustedScroll(tabId, direction, amount)
          : await sendToContent(tabId, { type: 'SYNTHETIC_SCROLL',
                                         direction, amount });
      }
      case 'navigate': {
        const url = String(p.url || '').trim();
        if (!/^https?:\/\//i.test(url)) {
          return { ok: false, error: 'navigate requires absolute http(s) URL' };
        }
        await chrome.tabs.update(tabId, { url });
        await waitForTabComplete(tabId, 15000);
        return { ok: true, url, tabId };
      }
      case 'capture_state':
      case 'inspect': {
        return await captureState(tabId, { readOnly: !!p.readOnly });
      }
      case 'screenshot': {
        try {
          // IPI-305: readOnly path uses chrome.tabs.captureVisibleTab.
          // Falls back to CDP if it fails (e.g. activeTab not in
          // effect because the user hasn't clicked the extension yet).
          let dataUrl;
          if (p.readOnly) {
            try {
              dataUrl = await captureScreenshotViaChrome(tabId);
            } catch (e) {
              logWarn('readOnly screenshot failed, falling back to CDP:', e.message);
              dataUrl = await captureScreenshotViaCDP(tabId, p.format);
            }
          } else {
            dataUrl = await captureScreenshotViaCDP(tabId, p.format);
          }
          const resized = await sendToContent(tabId, {
            type: 'RESIZE_IMAGE', dataUrl,
            maxDim:  STATE.config.maxImageDim  || 1280,
            quality: STATE.config.imageQuality || 0.82,
          });
          return { ok: true,
                   dataUrl: (resized && resized.dataUrl) || dataUrl,
                   width:  resized && resized.width,
                   height: resized && resized.height };
        } catch (e) {
          return { ok: false, error: e.message };
        }
      }
      case 'evaluate': {
        const script = String(p.script || '');
        if (!script) return { ok: false, error: 'evaluate requires script' };
        try {
          // Use the same CDP path the mock uses. This runs in the
          // page's main world (not the isolated world), so it sees
          // the real DOM and returns real values.
          await attachDebugger(tabId);
          const { result, exceptionDetails } = await sendCDP(tabId, 'Runtime.evaluate', {
            expression: script,
            returnByValue: true,
            awaitPromise: true,
          });
          if (exceptionDetails) return { ok: false, error: exceptionDetails.text || 'eval error' };
          return { ok: true, result: result && result.value };
        } catch (e) {
          return { ok: false, error: e.message };
        }
      }
      case 'find_tab': {
        // IPI-310: search open tabs by url/title/active and return matches.
        const all = await chrome.tabs.query({});
        const urlRe   = p.urlPattern ? new RegExp(p.urlPattern, 'i') : null;
        const titleRe = p.titlePattern ? new RegExp(p.titlePattern, 'i') : null;
        const wantActive = !!p.active;
        const matches = all.filter(t => {
          if (wantActive && !t.active) return false;
          if (urlRe && !urlRe.test(t.url || '')) return false;
          if (titleRe && !titleRe.test(t.title || '')) return false;
          return true;
        });
        // Pick the best match: prefer active, then most recently used.
        if (p.returnFirst !== false && matches.length) {
          const best = matches.find(t => t.active) || matches[0];
          return { ok: true, tab: { id: best.id, url: best.url, title: best.title, active: best.active }, matches: matches.length };
        }
        return { ok: true, tabs: matches.map(t => ({ id: t.id, url: t.url, title: t.title, active: t.active })) };
      }
      case 'tabs': {
        const tabs = await chrome.tabs.query({});
        return {
          ok: true,
          tabs: tabs.map(t => ({
            id: t.id, url: t.url, title: t.title, active: t.active,
          })),
        };
      }
      case 'open': {
        const t = await chrome.tabs.create({ url: p.url || 'about:blank' });
        STATE.activeTabId = t.id;
        return { ok: true, tabId: t.id, url: t.url };
      }
      case 'close': {
        const id = Number(p.tabId || tabId);
        await chrome.tabs.remove(id);
        return { ok: true };
      }
      case 'switch_tab': {
        const id = Number(p.tabId);
        if (!Number.isFinite(id)) return { ok: false, error: 'switch_tab requires tabId' };
        await chrome.tabs.update(id, { active: true });
        STATE.activeTabId = id;
        return { ok: true, activeTabId: id };
      }
      case 'press_key': {
        // IPI-308: press a single key (with optional modifiers) via CDP.
        const key = String(p.key || '');
        if (!key) return { ok: false, error: 'press_key requires key' };
        const KEY_TABLE = {
          'Enter':    { code: 'Enter',    vkey: 13 },
          'Tab':      { code: 'Tab',      vkey: 9  },
          'Escape':   { code: 'Escape',   vkey: 27 },
          'Backspace':{ code: 'Backspace',vkey: 8  },
          'Delete':   { code: 'Delete',   vkey: 46 },
          'ArrowUp':    { code: 'ArrowUp',    vkey: 38 },
          'ArrowDown':  { code: 'ArrowDown',  vkey: 40 },
          'ArrowLeft':  { code: 'ArrowLeft',  vkey: 37 },
          'ArrowRight': { code: 'ArrowRight', vkey: 39 },
          'Home':    { code: 'Home', vkey: 36 },
          'End':     { code: 'End',  vkey: 35 },
          'PageUp':   { code: 'PageUp',   vkey: 33 },
          'PageDown': { code: 'PageDown', vkey: 34 },
        };
        const k = KEY_TABLE[key] || { code: key, vkey: 0 };
        const modifiers = (p.shift ? 8 : 0) | (p.ctrl ? 2 : 0) |
                         (p.alt ? 1 : 0)   | (p.meta ? 4 : 0);
        try {
          await attachDebugger(tabId);
          await sendCDP(tabId, 'Input.dispatchKeyEvent', {
            type: 'rawKeyDown', key, code: k.code,
            windowsVirtualKeyCode: k.vkey, nativeVirtualKeyCode: k.vkey,
            modifiers,
          });
          await sendCDP(tabId, 'Input.dispatchKeyEvent', {
            type: 'keyUp', key, code: k.code,
            windowsVirtualKeyCode: k.vkey, nativeVirtualKeyCode: k.vkey,
            modifiers: 0,
          });
          // For printable chars, also send a 'char' event so the
          // page sees the actual character being typed (some
          // frameworks rely on this for text inputs).
          if (p.text) {
            await sendCDP(tabId, 'Input.dispatchKeyEvent', {
              type: 'char', text: String(p.text), key,
            });
          }
          return { ok: true, key, modifiers, trusted: true };
        } catch (e) {
          return { ok: false, error: e.message };
        }
      }
      case 'wait': {
        const ms = Math.max(0, Math.min(30000, Number(p.ms) || 500));
        await sleep(ms);
        return { ok: true, ms };
      }
      case 'set_active_tab': {
        if (Number.isFinite(Number(p.tabId))) STATE.activeTabId = Number(p.tabId);
        return { ok: true, activeTabId: STATE.activeTabId };
      }
      case 'set_status': {
        await sendToContent(tabId, {
          type: 'SET_STATUS',
          text: String(p.text || ''),
          mode: p.mode || 'on',
        });
        return { ok: true };
      }
      // ---- Visual mousing tool: numbered element tags ----
      case 'tag_elements': {
        // Paint [1] [2] [3] ... badges on every interactive
        // element in the viewport. Returns the full element list
        // so the agent can pick a target by visible number.
        const r = await sendToContent(tabId, {
          type: 'TAG_ELEMENTS',
          options: { max: p.max || 200 },
        });
        return r && r.ok ? r : (r || { ok: false, error: 'tag_elements failed' });
      }
      case 'click_by_tag': {
        // Click the element with visible tag number p.num (e.g. 3
        // for the third interactive element in the viewport). This
        // is more robust than pixel coordinates: the tags re-paint
        // on scroll/resize, so the agent can pick the same target
        // even after the page reflows.
        const r = await sendToContent(tabId, { type: 'CLICK_BY_TAG', num: p.num });
        return r && r.ok ? r : (r || { ok: false, error: 'click_by_tag failed' });
      }
      case 'type_by_tag': {
        const r = await sendToContent(tabId, {
          type: 'TYPE_BY_TAG', num: p.num, text: String(p.text || ''),
        });
        return r && r.ok ? r : (r || { ok: false, error: 'type_by_tag failed' });
      }
      case 'hover_by_tag': {
        const r = await sendToContent(tabId, { type: 'HOVER_BY_TAG', num: p.num });
        return r && r.ok ? r : (r || { ok: false, error: 'hover_by_tag failed' });
      }
      case 'clear_tags': {
        await sendToContent(tabId, { type: 'CLEAR_TAGS' });
        return { ok: true };
      }
      case 'show_crosshair': {
        await sendToContent(tabId, { type: 'SHOW_CROSSHAIR' });
        return { ok: true };
      }
      case 'hide_crosshair': {
        await sendToContent(tabId, { type: 'HIDE_CROSSHAIR' });
        return { ok: true };
      }
      case 'start_drag': {
        const r = await sendToContent(tabId, { type: 'START_DRAG', x: p.x, y: p.y });
        return r && r.ok ? r : (r || { ok: false, error: 'start_drag failed' });
      }
      case 'update_drag': {
        const r = await sendToContent(tabId, { type: 'UPDATE_DRAG', x: p.x, y: p.y });
        return r && r.ok ? r : (r || { ok: false, error: 'update_drag failed' });
      }
      case 'end_drag': {
        const r = await sendToContent(tabId, { type: 'END_DRAG' });
        return r && r.ok ? r : (r || { ok: false, error: 'end_drag failed' });
      }
      case 'list_tags': {
        const r = await sendToContent(tabId, { type: 'LIST_TAGS' });
        return r && r.ok ? r : (r || { ok: false, error: 'list_tags failed' });
      }
      // ---- Visual mousing tool: extended affordances ----
      case 'move_mouse': {
        // Out-of-band cursor sync for the crosshair. Used when the
        // agent drives the real OS pointer via chrome.debugger
        // and the synthetic mousemove doesn't reach the page.
        const r = await sendToContent(tabId, { type: 'MOVE_MOUSE', x: p.x, y: p.y });
        return r && r.ok ? r : (r || { ok: false, error: 'move_mouse failed' });
      }
      case 'element_info': {
        const r = await sendToContent(tabId, { type: 'ELEMENT_INFO', x: p.x, y: p.y });
        return r && r.ok ? r : (r || { ok: false, error: 'element_info failed' });
      }
      case 'hover_preview': {
        const r = await sendToContent(tabId, { type: 'HOVER_PREVIEW', x: p.x, y: p.y });
        return r && r.ok ? r : (r || { ok: false, error: 'hover_preview failed' });
      }
      case 'show_grid': {
        const r = await sendToContent(tabId, { type: 'SHOW_GRID', spacing: p.spacing });
        return r && r.ok ? r : (r || { ok: false, error: 'show_grid failed' });
      }
      case 'hide_grid': {
        const r = await sendToContent(tabId, { type: 'HIDE_GRID' });
        return r && r.ok ? r : (r || { ok: false, error: 'hide_grid failed' });
      }
      case 'show_selection': {
        const r = await sendToContent(tabId, { type: 'SHOW_SELECTION' });
        return r && r.ok ? r : (r || { ok: false, error: 'show_selection failed' });
      }
      case 'hide_selection': {
        const r = await sendToContent(tabId, { type: 'HIDE_SELECTION' });
        return r && r.ok ? r : (r || { ok: false, error: 'hide_selection failed' });
      }
      case 'set_tag_filter': {
        const r = await sendToContent(tabId, { type: 'SET_TAG_FILTER', types: p.types, freeze: p.freeze });
        return r && r.ok ? r : (r || { ok: false, error: 'set_tag_filter failed' });
      }
      case 'flash_tag': {
        const r = await sendToContent(tabId, { type: 'FLASH_TAG', num: p.num, color: p.color });
        return r && r.ok ? r : (r || { ok: false, error: 'flash_tag failed' });
      }
      default:
        return { ok: false, error: 'Unknown action: ' + action, errorCode: 'UNKNOWN_ACTION' };
    }
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

// ------------------------------------------------------------------
// Make sure the offscreen document is alive. MV3 service workers
// can be torn down at any time, but the offscreen document keeps
// a long-lived WebSocket + can spawn child processes.
// Forward agent log lines + finished events from offscreen to the
// popup so the user sees live progress.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !msg.kind) return;
  if (msg.kind === 'agent-log') {
    // Push to popup if it's open.
    try { chrome.runtime.sendMessage({ type: 'AGENT_LOG', level: msg.level, line: msg.line }); } catch {}
    return;
  }
  if (msg.kind === 'agent-finished') {
    STATE.agentChild = null;
    STATE.agentRunId = null;
    try { chrome.runtime.sendMessage({ type: 'AGENT_FINISHED', runId: msg.runId, code: msg.code }); } catch {}
    return;
  }
});

// capture_state: full state bundle for the controller
// ------------------------------------------------------------------
async function captureState(tabId, opts) {
  if (!tabid) return { ok: false, error: 'No tab', errorCode: 'NO_TAB' };
  if (STATE.config.captureDelayMs) await sleep(STATE.config.captureDelayMs);
  // Screenshot. IPI-305: readOnly=true uses chrome.tabs.captureVisibleTab
  // (no debugger banner). Falls back to CDP if it fails.
  let dataUrl = null;
  try {
    if (opts && opts.readOnly) {
      try { dataUrl = await captureScreenshotViaChrome(tabId); }
      catch (e) {
        logWarn('readOnly inspect failed, falling back to CDP:', e.message);
        dataUrl = await captureScreenshotViaCDP(tabId);
      }
    } else {
      dataUrl = await captureScreenshotViaCDP(tabId);
    }
  } catch (e) {
    return { ok: false, error: 'Screenshot failed: ' + e.message };
  }
  const resized   = await sendToContent(tabId, {
    type: 'RESIZE_IMAGE', dataUrl,
    maxDim:  STATE.config.maxImageDim  || 1280,
    quality: STATE.config.imageQuality || 0.82,
  });
  const viewport  = await sendToContent(tabId, { type: 'GET_VIEWPORT' });
  const landmarks = await sendToContent(tabId, {
    type: 'EXTRACT_LANDMARKS', maxNodes: 150,
  });
  return {
    ok: true,
    dataUrl:   (resized && resized.dataUrl) || dataUrl,
    url:       viewport && viewport.url,
    title:     viewport && viewport.title,
    width:     viewport && viewport.width,
    height:    viewport && viewport.height,
    dpr:       viewport && viewport.dpr,
    scrollX:   viewport && viewport.scrollX,
    scrollY:   viewport && viewport.scrollY,
    landmarks: (landmarks && landmarks.landmarks) || [],
    activeTabId: tabId,
    coordMode: STATE.config.coordMode,
  };
}

// ------------------------------------------------------------------
// WebSocket controller client
// ------------------------------------------------------------------
function sendToController(payload) {
  if (STATE.ws && STATE.ws.readyState === WebSocket.OPEN) {
    try { STATE.ws.send(JSON.stringify(payload)); }
    catch (e) { logError('ws send failed', e.message); }
  }
}

// IPI-304: WebSocket is owned by offscreen.js. The service worker
// delegates action requests to it and forwards results back.
function connectController(url) {
  url = url || STATE.config.controllerUrl;
  if (!url) {
    logWarn('connectController: no URL');
    return { ok: false, error: 'No controller URL configured' };
  }
  STATE.config.controllerUrl = url;
  // Tell the offscreen document to (re)connect.
  ensureOffscreen().then(() => {
    chrome.runtime.sendMessage({ kind: 'offscreen-reconnect', url }, () => {
      logInfo('offscreen reconnect requested for', url);
    });
  }).catch((e) => logWarn('ensureOffscreen failed:', e.message));
  return { ok: true };
}

function disconnectController() {
  if (STATE.reconnectTimer) {
    clearTimeout(STATE.reconnectTimer);
    STATE.reconnectTimer = null;
  }
  if (STATE.ws) { try { STATE.ws.close(); } catch {} }
  STATE.ws = null;
  stopPolling();
  chrome.runtime.sendMessage({ type: 'CONNECTION_STATUS',
                               connected: false, transport: 'none' }).catch(() => {});
}

// ------------------------------------------------------------------
// HTTP polling fallback (when WebSocket isn't available)
// ------------------------------------------------------------------
function startPolling(url, secret) {
  stopPolling();
  STATE.config.usePolling = true;
  STATE.config.pollingUrl = url;
  STATE.config.pollingSecret = secret || '';
  saveConfig();
  logInfo('start polling', url);
  STATE.pollTimer = setInterval(pollOnce, 1000);
  chrome.runtime.sendMessage({ type: 'CONNECTION_STATUS',
                               connected: true, transport: 'polling' }).catch(() => {});
}

function stopPolling() {
  if (STATE.pollTimer) clearInterval(STATE.pollTimer);
  STATE.pollTimer = null;
  STATE.config.usePolling = false;
  chrome.runtime.sendMessage({ type: 'CONNECTION_STATUS',
                               connected: false, transport: 'none' }).catch(() => {});
}

async function pollOnce() {
  if (STATE.pollInflight) return;
  if (!STATE.config.pollingUrl) return;
  STATE.pollInflight = true;
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (STATE.config.pollingSecret) {
      headers['Authorization'] = 'Bearer ' + STATE.config.pollingSecret;
    }
    const res = await fetch(STATE.config.pollingUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        role: 'extension',
        activeTabId: STATE.activeTabId,
        ts: Date.now(),
      }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (Array.isArray(data.actions)) {
      for (const a of data.actions) {
        const result = await executeAction(a);
        // Fire-and-forget result POST if the controller provided a URL
        if (data.resultUrl) {
          fetch(data.resultUrl, {
            method: 'POST', headers,
            body: JSON.stringify({ id: a.id, ...result }),
          }).catch(() => {});
        }
        chrome.runtime.sendMessage({
          type: 'ACTION_RESULT',
          action: a.action, params: a.params, result,
        }).catch(() => {});
      }
    }
  } catch (e) {
    logWarn('poll error', e.message);
  } finally {
    STATE.pollInflight = false;
  }
}

// ------------------------------------------------------------------
// Popup ↔ background message handler
// ------------------------------------------------------------------
function publicConfig() {
  return { ...STATE.config };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case 'GET_STATUS': {
          sendResponse({
            ok: true,
            connected: !!(STATE.ws && STATE.ws.readyState === WebSocket.OPEN),
            polling:   !!STATE.pollTimer,
            transport: STATE.ws ? 'websocket' : (STATE.pollTimer ? 'polling' : 'none'),
            activeTabId: STATE.activeTabId,
            config:    publicConfig(),
            log:       STATE.log.slice(-100),
          });
          break;
        }
        case 'SAVE_CONFIG': {
          STATE.config = { ...STATE.config, ...(msg.config || {}) };
          await saveConfig();
          sendResponse({ ok: true });
          break;
        }
        case 'CONNECT': {
          if (msg.transport === 'polling') {
            disconnectController();
            startPolling(msg.url, msg.secret);
            sendResponse({ ok: true, transport: 'polling' });
          } else {
            stopPolling();
            sendResponse(connectController(msg.url));
          }
          break;
        }
        case 'DISCONNECT': {
          disconnectController();
          sendResponse({ ok: true });
          break;
        }
        case 'EXECUTE_ACTION': {
          sendResponse(await executeAction(msg.request || msg.action));
          break;
        }
        case 'CAPTURE_STATE': {
          let tabId = msg.tabId || STATE.activeTabId;
          if (!tabId) {
            const t = await getActiveTab();
            tabId = t && t.id;
          }
          if (!tabId) return sendResponse({ ok: false, error: 'No tab' });
          STATE.activeTabId = tabId;
          sendResponse(await captureState(tabId));
          break;
        }
        case 'CLEAR_LOG':     STATE.log = []; sendResponse({ ok: true }); break;
        // ---- Agent mode: spawned by the popup. We shell out to
        // `node agent.mjs` with the goal as the first arg. The
        // spawned process talks to the controller's WebSocket
        // directly; we just keep the popup informed of its
        // progress via chrome.runtime.sendMessage.
        case 'AGENT_START': {
          if (STATE.agentChild) {
            sendResponse({ ok: false, error: 'agent already running' });
            break;
          }
          const goal = String(msg.goal || '').trim();
          if (!goal) { sendResponse({ ok: false, error: 'goal is required' }); break; }
          const startUrl  = msg.startUrl || null;
          const provider  = msg.provider || 'auto';
          const apiKey    = msg.apiKey   || null;
          const controllerUrl = (STATE.config && STATE.config.controllerUrl)
            || (typeof process !== 'undefined' && process.env && process.env.CONTROLLER_URL)
            || 'ws://127.0.0.1:9223/ws';
          const portMatch = controllerUrl.match(/:(\d+)/);
          const controllerPort = portMatch ? portMatch[1] : '9223';
          const env = {
            CONTROLLER_URL: controllerUrl,
            CONTROLLER_PORT: controllerPort,
          };
          if (provider === 'proxy') env.LLM_PROXY = '1';
          if (apiKey) {
            if (provider === 'minimax') env.MINIMAX_API_KEY = apiKey;
            else if (provider === 'openai') env.OPENAI_API_KEY = apiKey;
            else env.OPENAI_API_KEY = apiKey; // default
          }
          // The service worker can't spawn child processes
          // directly. Delegate to the offscreen document, which
          // is a real page and has full Node access.
          await ensureOffscreen();
          const runId = 'run-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
          const r = await chrome.runtime.sendMessage({ kind: 'agent-start', goal, startUrl, controllerUrl, env, runId });
          if (r && r.ok) {
            STATE.agentChild = { runId, pid: r.pid };
            STATE.agentRunId = runId;
            STATE.agentGoal  = goal;
            // Pin the extension to a new tab for this run unless
            // the agent will open its own (it will, when given a
            // startUrl, otherwise reuses the active tab).
            if (startUrl) {
              const t = await chrome.tabs.create({ url: startUrl, active: false });
              STATE.agentTabId  = t.id;
              STATE.activeTabId = t.id;
            }
            sendResponse({ ok: true, runId, tabId: STATE.agentTabId, pid: r.pid });
          } else {
            sendResponse(r || { ok: false, error: 'agent start failed' });
          }
          break;
        }
        case 'AGENT_STOP': {
          try {
            await ensureOffscreen();
            const r = await chrome.runtime.sendMessage({ kind: 'agent-stop' });
            STATE.agentChild = null;
            STATE.agentRunId = null;
            STATE.agentTabId = null;
            STATE.agentGoal  = null;
            sendResponse(r || { ok: true });
          } catch (e) { sendResponse({ ok: false, error: e.message }); }
          break;
        }
        case 'AGENT_STATUS': {
          sendResponse({
            ok: true,
            active: !!STATE.agentChild,
            runId:  STATE.agentRunId,
            tabId:  STATE.agentTabId,
            goal:   STATE.agentGoal,
          });
          break;
        }
        default: sendResponse({ ok: false, error: 'Unknown message type: ' + msg.type });
      }
    } catch (e) {
      logError('popup message handler error', e.message);
      sendResponse({ ok: false, error: String(e && e.message || e) });
    }
  })();
  return true;
});

// ------------------------------------------------------------------
// Lifecycle
// ------------------------------------------------------------------
chrome.runtime.onInstalled.addListener(async () => {
  await loadConfig();
  logInfo('extension installed');
});

chrome.runtime.onStartup.addListener(async () => {
  await loadConfig();
  if (STATE.config.autoConnect) {
    if (STATE.config.usePolling && STATE.config.pollingUrl) {
      startPolling(STATE.config.pollingUrl, STATE.config.pollingSecret);
    } else if (STATE.config.controllerUrl) {
      connectController(STATE.config.controllerUrl);
    }
  }
});

chrome.alarms.create('heartbeat', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(async () => {
  // Keep the service worker alive AND make sure we are still
  // connected. An idle worker never notices a server restart;
  // this alarm fires every 30s (MV3 minimum) and re-opens the
  // WebSocket if it has dropped.
  if (STATE.config.controllerUrl &&
      (!STATE.ws || STATE.ws.readyState !== WebSocket.OPEN)) {
    logInfo('heartbeat: reconnecting to controller');
    connectController();
  }
});

// ------------------------------------------------------------------
// IPI-304: Offscreen document owns the WebSocket so the connection
// survives MV3 service-worker restarts.
// ------------------------------------------------------------------
let offscreenReady = false;

async function ensureOffscreen() {
  if (chrome.offscreen && chrome.offscreen.hasDocument &&
      await chrome.offscreen.hasDocument()) {
    offscreenReady = true;
    return;
  }
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['IFRAME_SCRIPTING'],
    justification: 'Maintain a long-lived WebSocket to the Agent Controller server',
  });
  offscreenReady = true;
}

// Action router: forward to offscreen (which owns the WebSocket).
// Falls back to the in-worker WebSocket if the offscreen document
// isn't available (e.g. on MV2 or before the offscreen API loaded).
async function routeActionToOffscreen(msg) {
  try {
    await ensureOffscreen();
  } catch (e) {
    // Offscreen not available — fall back to direct WS
    return await executeAction(msg);
  }
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve({ ok: false, error: 'offscreen timeout' }), 35000);
    chrome.runtime.sendMessage({ kind: 'execute-action', msg }, (response) => {
      clearTimeout(t);
      resolve(response || { ok: false, error: 'no response from offscreen' });
    });
  });
}

// Handle messages from the offscreen document.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return false;
  if (msg.kind === 'offscreen-action') {
    // Offscreen forwards incoming WS action → service worker.
    executeAction(msg.msg).then(sendResponse);
    return true; // async
  }
  if (msg.kind === 'offscreen-heartbeat') {
    // Offscreen is alive — refresh the ready flag.
    offscreenReady = true;
    sendResponse({ ok: true });
    return false;
  }
  return false;
});

// ------------------------------------------------------------------
// Top-level boot: load config and auto-connect on EVERY service
// worker start, including chrome.runtime.reload(). onStartup and
// onInstalled only fire on browser launch / fresh install — they
// do NOT fire on reload — so we have to do this here.
// ------------------------------------------------------------------
(async function boot() {
  await loadConfig();
  logInfo('service worker boot, autoConnect=' + STATE.config.autoConnect +
         ' url=' + (STATE.config.controllerUrl || '(none)'));
  if (STATE.config.autoConnect && STATE.config.controllerUrl) {
    connectController(STATE.config.controllerUrl);
  }
})();

chrome.tabs.onRemoved.addListener((tabId) => { attachedTabs.delete(tabId); });
chrome.tabs.onActivated.addListener(({ tabId }) => {
  if (STATE.agentPinned && STATE.agentTabId && tabId !== STATE.agentTabId) {
    // The agent is running on another tab. The user can still
    // switch around in the UI, but the extension's own action
    // routing keeps pointing at the agent's tab. We just update
    // activeTabId for the popup to display, but the agent's
    // actions still flow to agentTabId.
  }
  STATE.activeTabId = tabId;
});
