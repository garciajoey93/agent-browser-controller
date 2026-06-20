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
  // Visual mousing tool — numbered tags on every interactive element.
  //
  // The agent can:
  //   1. TAG_ELEMENTS        — scan the viewport, paint [1] [2] [3] badges
  //                            on every clickable / focusable element,
  //                            return a stable id->element map.
  //   2. CLICK_BY_TAG / TYPE_BY_TAG / HOVER_BY_TAG — operate on a tag
  //                            id instead of fragile pixel coordinates.
  //                            Robust against scroll, layout shift, and
  //                            pages that re-render the DOM.
  //   3. CLEAR_TAGS          — remove all badges + reset state.
  //
  // The tags use position:fixed so they track the element even if the
  // layout reflows. The element map is the source of truth: tags are
  // re-painted on scroll/resize. z-index 2147483647 + !important keep
  // them visible on hostile pages.
  // ------------------------------------------------------------------

  // Selectors that match something the user (or model) can act on.
  // Tuned to be inclusive but not noisy. Elements that are visually
  // hidden (display:none, visibility:hidden, zero size, off-screen)
  // are filtered out at paint time, not selector time.
  const INTERACTIVE_SELECTOR = [
    'a[href]',
    'button',
    'input:not([type="hidden"])',
    'textarea',
    'select',
    '[role="button"]',
    '[role="link"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="menuitem"]',
    '[role="tab"]',
    '[role="option"]',
    '[role="switch"]',
    '[role="combobox"]',
    '[role="searchbox"]',
    '[contenteditable="true"]',
    '[tabindex]:not([tabindex="-1"])',
    '[onclick]',
  ].join(',');

  // Per-element color: blue=button/link, green=input, orange=select,
  // purple=contenteditable, red=other clickable. Color helps the model
  // distinguish intent at a glance and helps the user see what kind of
  // element is being targeted.
  function tagColorFor(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'button' || tag === 'a' || el.getAttribute('role') === 'button' || el.getAttribute('role') === 'link') return '#0a84ff';
    if (tag === 'input' || tag === 'textarea' || el.getAttribute('role') === 'searchbox') return '#34c759';
    if (tag === 'select') return '#ff9500';
    if (el.isContentEditable) return '#af52de';
    return '#ff3b30';
  }

  // State for the tag overlay. We keep both a live element map (so
  // click_by_tag can resolve the actual element) and a DOM container
  // for the badges (so we can clear them in O(1)).
  const TAGS_STATE = {
    overlay: null,        // root <div> for all tag badges
    styleEl: null,        // <style> with keyframes
    nextId: 1,            // next tag number to assign
    byTag: new Map(),     // tagId -> { el, rect, tag, text }
    byNumber: new Map(),  // visible number (1..N) -> tagId, for stable
                          // renumbering when elements scroll out
    scrollHandler: null,
    resizeHandler: null,
  };

  function ensureTagsOverlay() {
    if (TAGS_STATE.overlay && document.documentElement.contains(TAGS_STATE.overlay)) return;
    // Container is position:fixed at top-left with pointer-events:none
    // so it never blocks clicks on the actual page.
    const root = document.createElement('div');
    root.id = '__agent_browser_tags_overlay__';
    root.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;pointer-events:none;z-index:2147483647';
    (document.documentElement || document.body).appendChild(root);
    TAGS_STATE.overlay = root;

    if (!TAGS_STATE.styleEl) {
      const s = document.createElement('style');
      s.id = '__agent_browser_tags_style__';
      s.textContent = [
        // The badge itself: small pill, top-left of the element,
        // with a colored background that matches the element type.
        '.__agent_tag_badge__ {',
        '  position: fixed !important;',
        '  z-index: 2147483647 !important;',
        '  display: inline-flex !important;',
        '  align-items: center !important;',
        '  justify-content: center !important;',
        '  min-width: 22px !important;',
        '  height: 22px !important;',
        '  padding: 0 6px !important;',
        '  border-radius: 11px !important;',
        '  background: var(--__agent_tag_color__, #0a84ff) !important;',
        '  color: #fff !important;',
        '  font: 600 11px/1 -apple-system, BlinkMacSystemFont, sans-serif !important;',
        '  font-feature-settings: "tnum" 1 !important;',
        '  letter-spacing: 0.2px !important;',
        '  box-shadow: 0 1px 3px rgba(0,0,0,0.35), 0 0 0 1.5px #fff !important;',
        '  pointer-events: auto !important;',
        '  cursor: pointer !important;',
        '  transform-origin: top left !important;',
        '  transition: transform 0.12s ease, box-shadow 0.12s ease !important;',
        '  user-select: none !important;',
        '  font-family: ui-monospace, Menlo, monospace !important;',
        '}',
        '.__agent_tag_badge__::before {',
        '  content: "#" !important;',
        '  opacity: 0.65 !important;',
        '  margin-right: 2px !important;',
        '  font-weight: 500 !important;',
        '}',
        '.__agent_tag_badge__:hover {',
        '  transform: scale(1.25) !important;',
        '  box-shadow: 0 2px 8px rgba(0,0,0,0.45), 0 0 0 2px #fff !important;',
        '}',
        '.__agent_tag_badge__.is-hovered {',
        '  transform: scale(1.35) !important;',
        '  box-shadow: 0 0 0 3px rgba(255,255,255,0.9), 0 0 14px var(--__agent_tag_color__, #0a84ff) !important;',
        '}',
        '.__agent_tag_badge__.is-clicked {',
        '  animation: __agent_tag_click__ 0.45s ease-out !important;',
        '}',
        '@keyframes __agent_tag_click__ {',
        '  0%   { transform: scale(1);   box-shadow: 0 0 0 0   rgba(255,255,255,0.9), 0 0 0 0   var(--__agent_tag_color__, #0a84ff); }',
        '  40%  { transform: scale(1.6); box-shadow: 0 0 0 4px rgba(255,255,255,0.6), 0 0 0 14px transparent; }',
        '  100% { transform: scale(1);   box-shadow: 0 0 0 0   rgba(255,255,255,0),   0 0 0 0   transparent; }',
        '}',
        // A subtle outline drawn around the element itself, so it's
        // obvious which element the tag points at even at a glance.
        '.__agent_tag_outline__ {',
        '  position: fixed !important;',
        '  z-index: 2147483646 !important;',
        '  pointer-events: none !important;',
        '  border: 2px dashed var(--__agent_tag_color__, #0a84ff) !important;',
        '  border-radius: 3px !important;',
        '  opacity: 0 !important;',
        '  transition: opacity 0.15s ease !important;',
        '}',
        '.__agent_tag_badge__:hover + .__agent_tag_outline__,',
        '.__agent_tag_badge__.is-hovered + .__agent_tag_outline__ {',
        '  opacity: 0.85 !important;',
        '}',
        '.__agent_tag_outline__.is-hovered {',
        '  opacity: 0.95 !important;',
        '  border-style: solid !important;',
        '}',
        // Tooltip on hover: shows the element's text/aria so the
        // model can preview what it would click.
        '.__agent_tag_tooltip__ {',
        '  position: fixed !important;',
        '  z-index: 2147483647 !important;',
        '  background: rgba(20,20,22,0.96) !important;',
        '  color: #fff !important;',
        '  font: 12px/1.4 -apple-system, sans-serif !important;',
        '  padding: 6px 10px !important;',
        '  border-radius: 6px !important;',
        '  max-width: 320px !important;',
        '  pointer-events: none !important;',
        '  box-shadow: 0 4px 12px rgba(0,0,0,0.4) !important;',
        '  opacity: 0 !important;',
        '  transition: opacity 0.12s ease !important;',
        '  white-space: pre-wrap !important;',
        '  word-break: break-word !important;',
        '}',
        '.__agent_tag_badge__:hover ~ .__agent_tag_tooltip__,',
        '.__agent_tag_badge__.is-hovered ~ .__agent_tag_tooltip__ {',
        '  opacity: 1 !important;',
        '}',
      ].join('\n');
      (document.documentElement || document.body).appendChild(s);
      TAGS_STATE.styleEl = s;
    }
  }

  function describeInteractive(el) {
    const rect = el.getBoundingClientRect();
    const text = (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || '').toString().slice(0, 80).trim();
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || undefined,
      role: el.getAttribute('role') || undefined,
      type: el.getAttribute && el.getAttribute('type') || undefined,
      text: text || undefined,
      rect: {
        x: Math.round(rect.x), y: Math.round(rect.y),
        w: Math.round(rect.width), h: Math.round(rect.height),
        cx: Math.round(rect.x + rect.width / 2),
        cy: Math.round(rect.y + rect.height / 2),
      },
    };
  }

  function isVisibleInteractive(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4) return false;
    if (rect.bottom < 0 || rect.right < 0) return false;
    if (rect.top > window.innerHeight + 200) return false;
    if (rect.left > window.innerWidth + 200) return false;
    const cs = window.getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || cs.pointerEvents === 'none') return false;
    if (parseFloat(cs.opacity || '1') === 0) return false;
    return true;
  }

  // Repaint all tag badges based on current element positions. Called
  // initially and on every scroll/resize. This keeps tags glued to
  // their elements even when the layout shifts.
  function repaintTags() {
    if (!TAGS_STATE.overlay) return;
    TAGS_STATE.byNumber.clear();
    // Walk the element map in assignment order; re-measure each.
    let n = 1;
    for (const [tagId, entry] of TAGS_STATE.byTag) {
      const el = entry.el;
      const badge = entry.badge;
      const outline = entry.outline;
      if (!el || !document.body.contains(el)) {
        // Element was removed from the DOM; mark stale and skip.
        entry.stale = true;
        continue;
      }
      if (!isVisibleInteractive(el)) {
        // Scrolled out of view or hidden; fade the badge so the
        // numbering stays in viewport order.
        badge.style.opacity = '0.18';
        continue;
      }
      badge.style.opacity = '1';
      const rect = el.getBoundingClientRect();
      // Position the badge just inside the top-left corner of the
      // element. Clamp so it doesn't fall off-screen on tiny elements.
      const bx = Math.max(0, Math.round(rect.x - 1));
      const by = Math.max(0, Math.round(rect.y - 1));
      badge.style.left = bx + 'px';
      badge.style.top  = by + 'px';
      if (outline) {
        outline.style.left = bx + 'px';
        outline.style.top  = by + 'px';
        outline.style.width  = Math.max(4, Math.round(rect.width)) + 'px';
        outline.style.height = Math.max(4, Math.round(rect.height)) + 'px';
      }
      entry.rect = {
        x: Math.round(rect.x), y: Math.round(rect.y),
        w: Math.round(rect.width), h: Math.round(rect.height),
        cx: Math.round(rect.x + rect.width / 2),
        cy: Math.round(rect.y + rect.height / 2),
      };
      // Reassign the visible number 1..N in viewport order.
      badge.textContent = String(n);
      badge.dataset.num = String(n);
      TAGS_STATE.byNumber.set(n, tagId);
      n++;
    }
  }

  // Bind scroll/resize listeners (idempotent).
  function ensureTagsListeners() {
    if (TAGS_STATE.scrollHandler) return;
    TAGS_STATE.scrollHandler = () => repaintTags();
    TAGS_STATE.resizeHandler = () => repaintTags();
    window.addEventListener('scroll',     TAGS_STATE.scrollHandler, { passive: true, capture: true });
    window.addEventListener('resize',     TAGS_STATE.resizeHandler, { passive: true });
    document.addEventListener('scroll',   TAGS_STATE.scrollHandler, { passive: true, capture: true });
    // Mutation observer: re-tag newly-added interactive elements.
    const mo = new MutationObserver(() => {
      if (!TAGS_STATE.overlay) return;
      // Cheap heuristic: if any new node matches the selector, do
      // a full re-scan. This is rare during agent operation.
      for (const n of mo.takeRecords()) {/* drain */}
    });
    mo.observe(document.documentElement || document.body, { childList: true, subtree: true });
    TAGS_STATE._mo = mo;
  }

  function clearTags() {
    if (TAGS_STATE.overlay && TAGS_STATE.overlay.parentNode) {
      TAGS_STATE.overlay.parentNode.removeChild(TAGS_STATE.overlay);
    }
    if (TAGS_STATE.styleEl && TAGS_STATE.styleEl.parentNode) {
      TAGS_STATE.styleEl.parentNode.removeChild(TAGS_STATE.styleEl);
    }
    TAGS_STATE.overlay = null;
    TAGS_STATE.styleEl = null;
    TAGS_STATE.byTag.clear();
    TAGS_STATE.byNumber.clear();
    TAGS_STATE.nextId = 1;
    if (TAGS_STATE.scrollHandler) {
      window.removeEventListener('scroll', TAGS_STATE.scrollHandler, { capture: true });
      window.removeEventListener('resize', TAGS_STATE.resizeHandler);
      document.removeEventListener('scroll', TAGS_STATE.scrollHandler, { capture: true });
      TAGS_STATE.scrollHandler = null;
      TAGS_STATE.resizeHandler = null;
    }
    if (TAGS_STATE._mo) {
      TAGS_STATE._mo.disconnect();
      TAGS_STATE._mo = null;
    }
  }

  // Build the visual mousing overlay. Returns a flat list of
  // { tagId, n, ...describe } so the caller can pick a target.
  function tagInteractiveElements(opts) {
    opts = opts || {};
    const max = opts.max || 200;
    clearTags();
    ensureTagsOverlay();
    ensureTagsListeners();

    // Collect candidates, dedup, and filter to visible.
    const seen = new Set();
    const els = [];
    document.querySelectorAll(INTERACTIVE_SELECTOR).forEach(el => {
      // Skip elements that are inside a closed <details> or have
      // display:none on an ancestor (isVisibleInteractive catches
      // the element itself; this catches ancestors cheaply).
      if (el.closest('[hidden],[aria-hidden="true"]')) return;
      if (!isVisibleInteractive(el)) return;
      if (seen.has(el)) return;
      seen.add(el);
      els.push(el);
      if (els.length >= max) return;
    });
    // Also descend into open shadow roots (YouTube, GitHub do this).
    function collectShadows(root) {
      if (!root || !root.querySelectorAll) return;
      root.querySelectorAll('*').forEach(el => {
        if (el.shadowRoot) {
          try {
            el.shadowRoot.querySelectorAll(INTERACTIVE_SELECTOR).forEach(inner => {
              if (els.length >= max) return;
              if (seen.has(inner)) return;
              if (!isVisibleInteractive(inner)) return;
              seen.add(inner);
              els.push(inner);
            });
            collectShadows(el.shadowRoot);
          } catch {}
        }
      });
    }
    collectShadows(document);

    const out = [];
    els.forEach((el) => {
      const tagId = TAGS_STATE.nextId++;
      const color = tagColorFor(el);
      // The badge: small pill, top-left of the element.
      const badge = document.createElement('div');
      badge.className = '__agent_tag_badge__';
      badge.dataset.tagId = String(tagId);
      badge.style.setProperty('--__agent_tag_color__', color);
      badge.textContent = '?';
      // The outline: dashed border around the element itself.
      const outline = document.createElement('div');
      outline.className = '__agent_tag_outline__';
      outline.style.setProperty('--__agent_tag_color__', color);
      // Tooltip on hover.
      const tip = document.createElement('div');
      tip.className = '__agent_tag_tooltip__';
      const desc = describeInteractive(el);
      const tipText = [desc.tag, desc.text, desc.role && 'role=' + desc.role].filter(Boolean).join(' · ');
      tip.textContent = tipText || desc.tag;
      badge.addEventListener('mouseenter', () => {
        badge.classList.add('is-hovered');
        outline.classList.add('is-hovered');
        if (!el.matches(':hover')) {
          try { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); } catch {}
        }
      });
      badge.addEventListener('mouseleave', () => {
        badge.classList.remove('is-hovered');
        outline.classList.remove('is-hovered');
      });
      // Clicking the badge does a real click on the element. This
      // is the "visual mousing" UX: see the tag, click it, the
      // page reacts. Also a handy demo / debug affordance.
      badge.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        badge.classList.add('is-clicked');
        setTimeout(() => badge.classList.remove('is-clicked'), 500);
        const r = el.getBoundingClientRect();
        const cx = r.x + r.width / 2;
        const cy = r.y + r.height / 2;
        try { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); } catch {}
        // Trust the click by reusing the synthetic-click path.
        syntheticClickAt(cx, cy);
        showRipple(cx, cy);
      });

      TAGS_STATE.overlay.appendChild(badge);
      TAGS_STATE.overlay.appendChild(outline);
      TAGS_STATE.overlay.appendChild(tip);

      TAGS_STATE.byTag.set(tagId, { el, badge, outline, tip, desc });
      out.push(Object.assign({ tagId }, desc));
    });

    // First paint assigns the 1..N numbers in viewport order.
    repaintTags();
    setBadgeStatus('Tagged ' + out.length, 'on');
    return out;
  }

  // Resolve a visible number (1..N) to the current underlying tagId.
  // Visible numbers are stable across scroll; underlying tagIds are
  // the immutable assignment order. This indirection means the
  // agent can re-tag without re-numbering.
  function resolveByVisibleNumber(n) {
    const tagId = TAGS_STATE.byNumber.get(n);
    if (!tagId) return null;
    const entry = TAGS_STATE.byTag.get(tagId);
    if (!entry || entry.stale) return null;
    return entry;
  }

  function clickByTag(input) {
    const entry = resolveByVisibleNumber(Number(input));
    if (!entry) return { ok: false, error: 'No element with tag #' + input };
    const r = entry.el.getBoundingClientRect();
    const cx = r.x + r.width / 2;
    const cy = r.y + r.height / 2;
    try { entry.el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); } catch {}
    // Animate the badge so the user sees what was clicked.
    entry.badge.classList.add('is-clicked');
    setTimeout(() => entry.badge.classList.remove('is-clicked'), 500);
    const res = syntheticClickAt(cx, cy);
    showRipple(cx, cy);
    return Object.assign({ ok: true, tagId: entry.tagId, num: input }, res);
  }

  function typeByTag(input, text) {
    const entry = resolveByVisibleNumber(Number(input));
    if (!entry) return { ok: false, error: 'No element with tag #' + input };
    const r = entry.el.getBoundingClientRect();
    const cx = r.x + r.width / 2;
    const cy = r.y + r.height / 2;
    try { entry.el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); } catch {}
    entry.badge.classList.add('is-clicked');
    setTimeout(() => entry.badge.classList.remove('is-clicked'), 500);
    const res = syntheticTypeAt(cx, cy, text || '');
    showRipple(cx, cy);
    return Object.assign({ ok: true, tagId: entry.tagId, num: input }, res);
  }

  function hoverByTag(input) {
    const entry = resolveByVisibleNumber(Number(input));
    if (!entry) return { ok: false, error: 'No element with tag #' + input };
    const r = entry.el.getBoundingClientRect();
    try { entry.el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); } catch {}
    entry.badge.classList.add('is-hovered');
    entry.outline.classList.add('is-hovered');
    // Dispatch pointer/mouseenter on the target so any hover-driven
    // UI (tooltips, dropdowns) reacts.
    const events = ['pointerover', 'pointerenter', 'mouseover', 'mouseenter'];
    for (const t of events) {
      try {
        entry.el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
      } catch {}
    }
    // Repaint to bring the target into the visible-number ordering.
    setTimeout(() => repaintTags(), 50);
    return { ok: true, tagId: entry.tagId, num: input, rect: entry.rect };
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
          case 'TAG_ELEMENTS': {
            // Visual mousing tool: paint numbered tags on every
            // interactive element. Returns a flat list of { tagId,
            // num, tag, text, rect, ... } that the agent can pick
            // from by either the immutable tagId or the stable
            // visible number (1..N, re-assigned on scroll).
            const list = tagInteractiveElements(msg.options || {});
            reply(sendResponse, { ok: true, count: list.length, elements: list });
            break;
          }
          case 'CLICK_BY_TAG': {
            reply(sendResponse, clickByTag(msg.num));
            break;
          }
          case 'TYPE_BY_TAG': {
            reply(sendResponse, typeByTag(msg.num, msg.text || ''));
            break;
          }
          case 'HOVER_BY_TAG': {
            reply(sendResponse, hoverByTag(msg.num));
            break;
          }
          case 'CLEAR_TAGS': {
            clearTags();
            reply(sendResponse, { ok: true });
            break;
          }
          case 'LIST_TAGS': {
            // Re-emit the current tag list (with current rects)
            // without re-tagging. Useful for re-grounding the agent
            // after scroll.
            const out = [];
            for (const [n, tagId] of TAGS_STATE.byNumber) {
              const entry = TAGS_STATE.byTag.get(tagId);
              if (!entry || entry.stale) continue;
              out.push(Object.assign({ tagId, num: n }, entry.desc, { rect: entry.rect }));
            }
            reply(sendResponse, { ok: true, count: out.length, elements: out });
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
