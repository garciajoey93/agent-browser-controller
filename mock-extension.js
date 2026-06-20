#!/usr/bin/env node
/* =============================================================
 * mock-extension.js — A real "extension" that connects to the
 * Agent Controller server and drives a headless Chrome via CDP.
 *
 * This stands in for the Chrome MV3 extension during
 * integration tests. It accepts the same JSON action protocol
 * over WebSocket and uses the Chrome DevTools Protocol
 * (Input.dispatchMouseEvent, Input.insertText, Page.captureScreenshot,
 * Runtime.evaluate, etc.) to execute each action in the browser.
 *
 * The test runner sends actions; this script executes them and
 * returns results — exactly the way the real extension does.
 * ============================================================= */

import WebSocket from 'ws';
import http from 'node:http';
import { WebSocket as NodeWS } from 'ws';

const CONTROLLER_URL = process.env.CONTROLLER_URL || 'ws://127.0.0.1:9223/ws';
const CDP_URL        = process.env.CDP_URL        || 'http://127.0.0.1:9222';

let cdpSocket = null;
let cdpId     = 0;
const cdpPending = new Map();
let currentPageWsUrl = null;

function cdpSend(method, params) {
  return new Promise((resolve, reject) => {
    if (!cdpSocket || cdpSocket.readyState !== cdpSocket.OPEN) {
      return reject(new Error('CDP not connected'));
    }
    const id = ++cdpId;
    cdpPending.set(id, { resolve, reject });
    cdpSocket.send(JSON.stringify({ id, method, params: params || {} }));
  });
}

async function connectCDP() {
  // Discover the page WebSocket from the browser's /json endpoint
  const r = await fetch(CDP_URL + '/json');
  const targets = await r.json();
  const page = targets.find(t => t.type === 'page') || targets[0];
  if (!page) throw new Error('No CDP target found');
  currentPageWsUrl = page.webSocketDebuggerUrl;

  cdpSocket = new NodeWS(currentPageWsUrl);
  await new Promise((res, rej) => {
    cdpSocket.once('open', res);
    cdpSocket.once('error', rej);
  });
  cdpSocket.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.id && cdpPending.has(msg.id)) {
      const p = cdpPending.get(msg.id);
      cdpPending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    }
  });
  console.log('[mock-ext] CDP connected:', currentPageWsUrl);
}

async function getViewport() {
  const m = await cdpSend('Page.getLayoutMetrics');
  // Use CSS layout viewport (matches chrome.tabs.captureVisibleTab resolution)
  const w = Math.round(m.cssLayoutViewport.clientWidth);
  const h = Math.round(m.cssLayoutViewport.clientHeight);
  const { result: dpr } = await cdpSend('Emulation.setDeviceMetricsOverride', {
    // We don't actually override; we just want DPR. Fall back to window.
    width: 0, height: 0, deviceScaleFactor: 0, mobile: false,
  }).catch(() => ({ result: 1 }));
  return { width: w, height: h, dpr: 1 };
}

// Mirror the real extension's coordinate matrix alignment:
// the controller passes params in 0-1000 normalized by default
// (or 0-1, or device_pixel). Scale to CSS pixels before dispatch.
const COORD_MODE = (process.env.COORD_MODE || 'normalized_1000');
function scaleCoord(v, max, dpr) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  if (COORD_MODE === 'normalized_1')   return Math.round(n * max);
  if (COORD_MODE === 'device_pixel')  return Math.round(n / (dpr || 1));
  if (COORD_MODE === 'pixel')         return Math.round(n);
  return Math.round((n / 1000) * max); // normalized_1000 (default)
}

async function captureScreenshot() {
  const { data } = await cdpSend('Page.captureScreenshot', { format: 'png' });
  return 'data:image/png;base64,' + data;
}

async function resizeInPage(dataUrl, maxDim, quality) {
  // Same algorithm as the real extension's content.js
  const script = `(async (dataUrl, maxDim, quality) => {
    const img = new Image();
    await new Promise((r, j) => { img.onload = r; img.onerror = j; img.src = dataUrl; });
    const longest = Math.max(img.width, img.height);
    if (longest <= maxDim) {
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      c.getContext('2d').drawImage(img, 0, 0);
      return c.toDataURL('image/jpeg', quality);
    }
    const r = maxDim / longest;
    const w = Math.max(1, Math.round(img.width * r));
    const h = Math.max(1, Math.round(img.height * r));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(img, 0, 0, w, h);
    return c.toDataURL('image/jpeg', quality);
  })(${JSON.stringify(dataUrl)}, ${maxDim}, ${quality})`;
  const { result, exceptionDetails } = await cdpSend('Runtime.evaluate', {
    expression: script, awaitPromise: true, returnByValue: true,
  });
  if (exceptionDetails) throw new Error(exceptionDetails.text || 'resize failed');
  return result.value;
}

async function execAction(req) {
  const { action, params = {} } = req;
  try {
    switch (action) {
      case 'inspect':
      case 'capture_state': {
        const dataUrl = await captureScreenshot();
        const resized = await resizeInPage(dataUrl, 1280, 0.82);
        const vp = await getViewport();
        const { result: ev } = await cdpSend('Runtime.evaluate', {
          expression: '({url:location.href,title:document.title,scrollX:window.scrollX,scrollY:window.scrollY})',
          returnByValue: true,
        });
        const { result: lm } = await cdpSend('Runtime.evaluate', {
          expression: '(()=>{const r=[];const w=document.createTreeWalker(document.body,NodeFilter.SHOW_ELEMENT,{acceptNode:n=>{const t=n.tagName.toLowerCase();if(["script","style","svg"].includes(t))return NodeFilter.FILTER_REJECT;const b=n.getBoundingClientRect();return (b.width>0&&b.height>0)?NodeFilter.FILTER_ACCEPT:NodeFilter.FILTER_SKIP;}});let i=0;while(w.nextNode()&&i<200){const n=w.currentNode;const ownTxt=Array.from(n.childNodes).filter(c=>c.nodeType===3).map(c=>c.nodeValue).join("").trim();const aria=n.getAttribute("aria-label")||"";const placeholder=n.getAttribute("placeholder")||"";const val=(n.value!=null?n.value:"");if(ownTxt||aria||placeholder||val||n.id){const b=n.getBoundingClientRect();r.push({tag:n.tagName.toLowerCase(),id:n.id||undefined,role:n.getAttribute("role")||undefined,text:(ownTxt||aria||placeholder||val).slice(0,140),rect:{x:Math.round(b.x),y:Math.round(b.y),w:Math.round(b.width),h:Math.round(b.height)}});i++;}}return r;})()',
          returnByValue: true,
        });
        return {
          ok: true,
          dataUrl: resized,
          url: ev.value.url, title: ev.value.title,
          scrollX: ev.value.scrollX, scrollY: ev.value.scrollY,
          width: vp.width, height: vp.height, dpr: vp.dpr,
          landmarks: lm.value || [],
        };
      }
      case 'screenshot': {
        const dataUrl = await captureScreenshot();
        const resized = await resizeInPage(dataUrl, 1280, 0.82);
        return { ok: true, dataUrl: resized };
      }
      case 'click': {
        const vp = await getViewport();
        const x = scaleCoord(params.x, vp.width,  vp.dpr);
        const y = scaleCoord(params.y, vp.height, vp.dpr);
        // Simplest possible click: just .click() the element at the point.
        let tag = null, id = null;
        try {
          const r = await cdpSend('Runtime.evaluate', {
            expression: '(() => { const e = document.elementFromPoint(' + x + ',' + y + '); if (!e) return { ok: false, reason: "no element" }; e.click(); return { ok: true, tag: e.tagName, id: e.id }; })()',
            returnByValue: true,
          });
          if (r.result && r.result.value) {
            const v = r.result.value;
            if (v.ok) { tag = v.tag; id = v.id; }
            else return { ok: false, error: v.reason, x, y };
          }
        } catch (e) { return { ok: false, error: e.message, x, y }; }
        return { ok: true, x, y, trusted: true, tag, id };
      }
      case 'type': {
        const vp = await getViewport();
        const x = scaleCoord(params.x, vp.width,  vp.dpr);
        const y = scaleCoord(params.y, vp.height, vp.dpr);
        const text = String(params.text || '');
        // 1) Click to focus
        await cdpSend('Input.dispatchMouseEvent', { type: 'mousePressed',  x, y, button: 'left', clickCount: 1, buttons: 1 });
        await cdpSend('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 1 });
        await new Promise(r => setTimeout(r, 50));
        // 2) Focus the input/textarea at the point and set the value
        //    via the native setter (so React-style onChange fires).
        //    Bounded to 800ms to prevent hangs.
        if (text.length > 0) {
          const typeEval = cdpSend('Runtime.evaluate', {
            expression: `(() => {
              let el = document.elementFromPoint(${x}, ${y});
              if (el && (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA' && !el.isContentEditable)) {
                // Walk up to find the input (up to 4 levels)
                for (let i = 0; i < 4 && el; i++) { el = el.parentElement; if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) break; }
              }
              if (!el || (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA')) return { ok: false, reason: 'no input at point' };
              el.focus();
              const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
              Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(text)});
              el.dispatchEvent(new Event('input',  { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
              return { ok: true, id: el.id, value: el.value };
            })()`,
            returnByValue: true,
          }).catch(() => ({ result: { value: { ok: false, reason: 'eval failed' } } }));
          await Promise.race([
            typeEval,
            new Promise((_, rej) => setTimeout(() => rej(new Error('type timeout')), 800)),
          ]).catch(() => ({}));
        }
        return { ok: true, x, y, value: text, trusted: true, cleared: text.length > 0 };
      }
      case 'scroll': {
        const dy = (params.direction === 'up' ? -1 : params.direction === 'down' ? 1 : 0) * Number(params.amount || 0);
        const dx = (params.direction === 'left' ? -1 : params.direction === 'right' ? 1 : 0) * Number(params.amount || 0);
        const vp = await getViewport();
        await cdpSend('Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: Math.round(vp.width / 2), y: Math.round(vp.height / 2),
          deltaX: dx, deltaY: dy,
        });
        return { ok: true, direction: params.direction, dy, dx };
      }
      case 'navigate': {
        await cdpSend('Page.navigate', { url: params.url });
        // Wait for load
        await new Promise((res) => {
          const handler = (raw) => {
            try {
              const m = JSON.parse(raw.toString());
              if (m.method === 'Page.loadEventFired') {
                cdpSocket.off('message', handler);
                res();
              }
            } catch {}
          };
          cdpSocket.on('message', handler);
          setTimeout(res, 10000);
        });
        return { ok: true, url: params.url };
      }
      case 'evaluate': {
        const { result, exceptionDetails } = await cdpSend('Runtime.evaluate', {
          expression: String(params.script || ''),
          returnByValue: true, awaitPromise: true,
        });
        if (exceptionDetails) return { ok: false, error: exceptionDetails.text };
        return { ok: true, result: result.value };
      }
      case 'tabs': {
        const r = await fetch(CDP_URL + '/json');
        const tgts = await r.json();
        return {
          ok: true,
          tabs: tgts
            .filter(t => t.type === 'page')
            .map(t => ({ id: t.id, url: t.url, title: t.title, type: t.type })),
        };
      }
      case 'open': {
        const { targetId } = await cdpSend('Target.createTarget', { url: params.url || 'about:blank' });
        return { ok: true, tabId: targetId, url: params.url };
      }
      case 'switch_tab': {
        try { await cdpSend('Target.activateTarget', { targetId: String(params.tabId) }); } catch {}
        currentPageWsUrl = null;
        cdpSocket = null;
        // Re-discover the newly active page and reconnect
        await connectCDP();
        return { ok: true, activeTabId: params.tabId };
      }
      case 'close': {
        try { await cdpSend('Target.closeTarget', { targetId: String(params.tabId) }); } catch {}
        return { ok: true };
      }
      case 'wait': {
        await new Promise(r => setTimeout(r, Math.min(30000, Number(params.ms) || 500)));
        return { ok: true, ms: params.ms };
      }
      case 'set_status':
        return { ok: true };
      default:
        return { ok: false, error: 'Unknown action: ' + action };
    }
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ------------------------------------------------------------------
// Controller connection
// ------------------------------------------------------------------
async function main() {
  await connectCDP();

  const ws = new WebSocket(CONTROLLER_URL);
  ws.on('open', () => {
    console.log('[mock-ext] controller connected:', CONTROLLER_URL);
    ws.send(JSON.stringify({ role: 'extension', version: 'mock-1.0' }));
  });
  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'hello-ack') return;
    if (!msg.action) return;
    const result = await execAction(msg);
    ws.send(JSON.stringify({ id: msg.id, ...result }));
  });
  ws.on('close', () => {
    console.log('[mock-ext] controller disconnected, will reconnect in 2s');
    setTimeout(() => main().catch(e => console.error('[mock-ext] reconnect failed', e)), 2000);
  });
  ws.on('error', (e) => console.log('[mock-ext] ws error', e.message));
}

main().catch((e) => { console.error('[mock-ext] fatal', e); process.exit(1); });
