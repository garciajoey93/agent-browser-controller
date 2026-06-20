/* =============================================================
 * content.js — Page-side companion to background.js
 *
 * Responsibilities:
 *   1. Render an unobtrusive status badge so the user can see
 *      when the agent is in control of the page.
 *   2. Visualize agent clicks (ripple) and predicted targets
 *      (dashed dot) so the user understands what the model
 *      is doing.
 *   3. Extract a compact set of DOM text landmarks (used as
 *      additional grounding context alongside the screenshot).
 *   4. Provide a synthetic-event fallback for click/type/scroll
 *      when the popup has "trusted events" disabled. The
 *      primary path uses chrome.debugger (Input.dispatch*).
 *   5. Resize oversized screenshots before they are uploaded
 *      to the MiniMax M3 endpoint.
 *
 * The page-side script never holds long-lived state and is
 * safe to re-inject: it is guarded by a window flag.
 * ============================================================= */

(() => {
  'use strict';

  if (window.__agentBrowserInjected) return;
  window.__agentBrowserInjected = true;

  // ------------------------------------------------------------------
  // State
  // ------------------------------------------------------------------
  const STATE = {
    badge: null,
    rippleStyleEl: null,
  };

  // ------------------------------------------------------------------
  // Status badge
  // ------------------------------------------------------------------
  function ensureBadge() {
    if (STATE.badge && document.documentElement.contains(STATE.badge)) return STATE.badge;

    const badge = document.createElement('div');
    badge.id = '__agent_browser_badge__';
    badge.innerHTML =
      '<span class="__agent_browser_badge_dot__"></span>' +
      '<span class="__agent_browser_badge_text__">Agent</span>';
    (document.documentElement || document.body).appendChild(badge);
    STATE.badge = badge;
    return badge;
  }

  function setStatus(text, mode) {
    const badge = ensureBadge();
    const textEl = badge.querySelector('.__agent_browser_badge_text__');
    if (text != null) textEl.textContent = text;

    badge.classList.remove('is-error', 'is-done');
    if (mode === 'error') badge.classList.add('is-error');
    if (mode === 'done') badge.classList.add('is-done');
    if (mode === 'off') {
      badge.classList.remove('is-visible');
    } else {
      badge.classList.add('is-visible');
    }
  }

  // ------------------------------------------------------------------
  // Click ripple + target preview dot
  // ------------------------------------------------------------------
  function ensureRippleStyle() {
    if (STATE.rippleStyleEl && document.documentElement.contains(STATE.rippleStyleEl)) return;
    // content.css already defines the keyframes; nothing to add.
  }

  function showRipple(x, y) {
    ensureRippleStyle();
    const el = document.createElement('div');
    el.className = '__agent_browser_ripple__';
    el.style.left = x + 'px';
    el.style.top  = y + 'px';
    (document.documentElement || document.body).appendChild(el);
    setTimeout(() => el.remove(), 800);
  }

  function showTarget(x, y, ms) {
    const el = document.createElement('div');
    el.className = '__agent_browser_target_dot__';
    el.style.left = x + 'px';
    el.style.top  = y + 'px';
    (document.documentElement || document.body).appendChild(el);
    setTimeout(() => el.remove(), ms || 1500);
  }

  // Red anchor dot — fires on every click action. High-contrast,
  // z-index 2147483647, !important, so it survives on hostile
  // pages. This is the "where the agent clicked" indicator
  // required by the validation matrix (Step 3).
  function showAnchor(x, y, ms) {
    const el = document.createElement('div');
    el.className = '__agent_browser_anchor__';
    el.style.left = x + 'px';
    el.style.top  = y + 'px';
    (document.documentElement || document.body).appendChild(el);
    setTimeout(() => el.remove(), ms || 700);
  }

  // ------------------------------------------------------------------
  // DOM landmark extraction
  //
  // Walk the visible DOM and produce a compact list of text-bearing
  // elements. The vision model anchors on the screenshot; landmarks
  // give it a textual "you-are-here" pointer for ambiguous pixels.
  // ------------------------------------------------------------------
  const SKIP_TAGS = new Set([
    'script', 'style', 'noscript', 'meta', 'link', 'svg', 'path',
    'br', 'hr', 'wbr', 'source', 'track', 'area', 'base', 'col',
    'embed', 'object', 'param', 'input', // inputs handled separately
  ]);
  const SKIP_ROLES = new Set(['presentation', 'none']);

  function describeNode(n) {
    const rect = n.getBoundingClientRect();
    const cs = window.getComputedStyle(n);
    const ownText = Array.from(n.childNodes)
      .filter(c => c.nodeType === Node.TEXT_NODE)
      .map(c => c.nodeValue)
      .join('')
      .trim();

    return {
      tag: n.tagName.toLowerCase(),
      id: n.id || undefined,
      cls: typeof n.className === 'string' ? n.className.slice(0, 80) : undefined,
      role: n.getAttribute('role') || undefined,
      aria: n.getAttribute('aria-label') || undefined,
      text: (ownText || n.getAttribute('aria-label') || '').slice(0, 140).trim(),
      rect: {
        x: Math.round(rect.x), y: Math.round(rect.y),
        w: Math.round(rect.width), h: Math.round(rect.height),
      },
      visible:
        rect.width > 0 && rect.height > 0 &&
        cs.visibility !== 'hidden' && cs.display !== 'none',
      fs: parseFloat(cs.fontSize) || 0,
    };
  }

  function extractLandmarks(maxNodes) {
    maxNodes = maxNodes || 200;
    const root = document.body || document.documentElement;
    if (!root) return [];

    const out = [];
    const stack = [root];
    let safety = 5000; // hard ceiling on traversal

    while (stack.length && out.length < maxNodes && safety-- > 0) {
      const node = stack.shift();
      if (!node || node.nodeType !== Node.ELEMENT_NODE) continue;
      const tag = node.tagName.toLowerCase();
      if (SKIP_TAGS.has(tag)) continue;
      const role = node.getAttribute && node.getAttribute('role');
      if (role && SKIP_ROLES.has(role)) continue;

      const rect = node.getBoundingClientRect();
      const cs = window.getComputedStyle(node);
      const inViewport =
        rect.bottom > 0 && rect.right > 0 &&
        rect.top  < (window.innerHeight + 200) &&
        rect.left < (window.innerWidth  + 200);

      if (inViewport && rect.width > 0 && rect.height > 0 &&
          cs.visibility !== 'hidden' && cs.display !== 'none') {
        const ownText = Array.from(node.childNodes)
          .filter(c => c.nodeType === Node.TEXT_NODE)
          .map(c => c.nodeValue).join('').trim();
        const aria = node.getAttribute('aria-label') || '';
        // IPI-309: also pick up inputs by placeholder/value, not
        // just text. YouTube's custom search input has neither text
        // nor aria-label, so without this we miss it.
        const placeholder = node.getAttribute('placeholder') || '';
        const val = (node.value != null ? node.value : '');
        if (ownText || aria || placeholder || val || node.id) {
          out.push(describeNode(node));
        }
      }
      // IPI-309: also traverse into open shadow roots. Many modern
      // sites (YouTube, GitHub, Twitter) put their interactive UI
      // inside custom elements whose DOM lives in a #shadow-root.
      if (node.shadowRoot) stack.push(node.shadowRoot);
      // recurse
      const children = node.children;
      for (let i = 0; i < children.length; i++) stack.push(children[i]);
    }
    return out;
  }

  // ------------------------------------------------------------------
  // Image resize (canvas-based; runs on-page before the dataUrl is
  // shipped to the model endpoint, keeping token costs manageable).
  // ------------------------------------------------------------------
  async function resizeDataUrl(dataUrl, maxDim, quality) {
    if (!dataUrl) return dataUrl;
    maxDim = maxDim || 1280;
    quality = (quality == null) ? 0.85 : quality;

    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload  = () => resolve();
      img.onerror = () => reject(new Error('image load failed'));
      img.src = dataUrl;
    });

    const longest = Math.max(img.width, img.height);
    if (longest <= maxDim) {
      // No resize needed; optionally re-encode as JPEG to shrink.
      return reencodeJpeg(dataUrl, quality);
    }
    const ratio = maxDim / longest;
    const w = Math.max(1, Math.round(img.width * ratio));
    const h = Math.max(1, Math.round(img.height * ratio));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);
    return canvas.toDataURL('image/jpeg', quality);
  }

  function reencodeJpeg(dataUrl, quality) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    });
  }

  // ------------------------------------------------------------------
  // Synthetic event fallback (used when useDebugger=false in popup)
  // ------------------------------------------------------------------
  function elementAtPoint(x, y) {
    return document.elementFromPoint(x, y);
  }

  function syntheticClickAt(x, y) {
    const el = elementAtPoint(x, y);
    if (!el) return { ok: false, error: 'No element at point' };
    try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
    try { el.focus({ preventScroll: true }); } catch {}
    const events = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
    for (let i = 0; i < events.length; i++) {
      const t = events[i];
      const Ctor = (t.indexOf('pointer') === 0) ? PointerEvent : MouseEvent;
      el.dispatchEvent(new Ctor(t, {
        bubbles: true, cancelable: true, composed: true, view: window,
        button: 0, buttons: 1, clientX: x, clientY: y,
      }));
    }
    return {
      ok: true, x, y, tag: el.tagName.toLowerCase(),
      text: (el.innerText || el.value || '').toString().slice(0, 120),
    };
  }

  function syntheticTypeAt(x, y, text) {
    const el = elementAtPoint(x, y);
    if (!el) return { ok: false, error: 'No element at point' };
    try { el.scrollIntoView({ block: 'center' }); } catch {}
    try { el.focus({ preventScroll: true }); } catch {}

    if (el.isContentEditable) {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
      try { document.execCommand('insertText', false, text); }
      catch { el.textContent = (el.textContent || '') + text; }
    } else if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      const proto = el.tagName === 'TEXTAREA'
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) desc.set.call(el, text);
      else el.value = text;
      el.dispatchEvent(new Event('input',  { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      el.textContent = text;
    }
    return { ok: true, x, y, value: text, tag: el.tagName.toLowerCase() };
  }

  function syntheticScroll(direction, amount) {
    const yMap = { up: -1, down: 1 };
    const xMap = { left: -1, right: 1 };
    const dy = (yMap[direction] || 0) * Number(amount || 0);
    const dx = (xMap[direction] || 0) * Number(amount || 0);
    window.scrollBy({ top: dy, left: dx, behavior: 'auto' });
    return {
      ok: true, direction, dy, dx,
      scrollX: window.scrollX, scrollY: window.scrollY,
    };
  }

  // ------------------------------------------------------------------
  // Message handling
  // ------------------------------------------------------------------
  function reply(sendResponse, value) {
    try { sendResponse(value); } catch {}
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      try {
        switch (msg.type) {
          case 'SET_STATUS': {
            setStatus(msg.text, msg.mode || 'on');
            reply(sendResponse, { ok: true });
            break;
          }
          case 'SHOW_RIPPLE': {
            showRipple(msg.x, msg.y);
            reply(sendResponse, { ok: true });
            break;
          }
          case 'SHOW_ANCHOR': {
            showAnchor(msg.x, msg.y, msg.ms);
            reply(sendResponse, { ok: true });
            break;
          }
          case 'SHOW_TARGET': {
            showTarget(msg.x, msg.y, msg.ms);
            reply(sendResponse, { ok: true });
            break;
          }
          case 'SYNTHETIC_CLICK': {
            const r = syntheticClickAt(msg.x, msg.y);
            if (r.ok) showRipple(msg.x, msg.y);
            reply(sendResponse, r);
            break;
          }
          case 'SYNTHETIC_TYPE': {
            const r = syntheticTypeAt(msg.x, msg.y, msg.text || '');
            if (r.ok) showRipple(msg.x, msg.y);
            reply(sendResponse, r);
            break;
          }
          case 'SYNTHETIC_SCROLL': {
            reply(sendResponse, syntheticScroll(msg.direction, msg.amount));
            break;
          }
          case 'EXTRACT_LANDMARKS': {
            reply(sendResponse, { ok: true, landmarks: extractLandmarks(msg.maxNodes) });
            break;
          }
          case 'GET_VIEWPORT': {
            reply(sendResponse, {
              ok: true,
              width:  window.innerWidth,
              height: window.innerHeight,
              dpr:    window.devicePixelRatio || 1,
              scrollX: window.scrollX,
              scrollY: window.scrollY,
              url:    location.href,
              title:  document.title,
            });
            break;
          }
          case 'RESIZE_IMAGE': {
            const out = await resizeDataUrl(msg.dataUrl, msg.maxDim, msg.quality);
            reply(sendResponse, { ok: true, dataUrl: out });
            break;
          }
          case 'PING': {
            reply(sendResponse, { ok: true, ready: true, url: location.href });
            break;
          }
          default:
            reply(sendResponse, { ok: false, error: 'Unknown type: ' + msg.type });
        }
      } catch (e) {
        reply(sendResponse, { ok: false, error: String(e && e.message || e) });
      }
    })();
    return true; // keep channel open for async response
  });

  // Initialize badge so it's ready immediately.
  ensureBadge();
})();
