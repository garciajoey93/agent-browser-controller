#!/usr/bin/env node
/* =============================================================
 * playwright-driver.mjs — Codex-speed direct CDP browser driver.
 *
 * The relay architecture (controller + extension + WebSocket) is
 * great for driving the USER'S existing Chrome session with their
 * logged-in state, extensions, and cookies. But for headless
 * automation where we just need a fast browser, it's a lot of
 * moving parts. This driver goes directly through Playwright +
 * the system Chrome binary via CDP — the same approach Codex uses
 * internally (see codex-chrome-bridge). No controller. No
 * extension. No WebSocket relay. One Node process, one event
 * loop, instant round-trips.
 *
 * Usage as a CLI:
 *   node playwright-driver.mjs navigate <url>
 *   node playwright-driver.mjs eval <js-file-or-inline>
 *   node playwright-driver.mjs extract <selector> [--attr <name>] [--limit N]
 *   node playwright-driver.mjs screenshot <path>
 *   node playwright-driver.mjs click <selector>
 *   node playwright-driver.mjs type <text> [--selector S] [--press-enter]
 *   node playwright-driver.mjs page-info
 *   node playwright-driver.mjs close
 *
 * Usage as a module:
 *   import * as driver from './playwright-driver.mjs';
 *   const p = await driver.navigate({ url: 'https://example.com' });
 *   const r = await driver.extract({ selector: 'h1' });
 *
 * Same action surface as the relay (click/type/extract/eval/etc.)
 * so callers can swap between the two with a one-line import change.
 * ============================================================= */

import { chromium } from '/Applications/Codex.app/Contents/Resources/cua_node/lib/node_modules/playwright/index.mjs';
import { writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const HEADLESS = process.env.HEADFUL !== '1';

let _browser = null;
let _context = null;
let _page = null;

async function ensureBrowser() {
  if (_browser && _browser.isConnected()) return;
  _browser = await chromium.launch({
    executablePath: CHROME,
    headless: HEADLESS,
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
    ],
  });
  _context = await _browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
    locale: 'en-US',
  });
  _page = await _context.newPage();
}

export async function navigate({ url } = {}) {
  await ensureBrowser();
  await _page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await _page.waitForTimeout(1500);
  return { url: _page.url(), title: await _page.title() };
}

export async function evaluate({ code } = {}) {
  await ensureBrowser();
  // The codex-chrome-bridge wraps the caller's code in an async
  // function that doesn't `return` its inner result. We fix that
  // here: if the caller's code is a single expression (no top-level
  // return, no function declaration, no semicolons at the top
  // level), wrap it in a return statement. Otherwise leave it alone.
  const looksLikeExpression = !/^\s*return\b/.test(code) &&
                               !/^\s*(?:async\s+)?function\b/.test(code) &&
                               !/^\s*(?:const|let|var|class|if|for|while|try|switch|do)\b/.test(code);
  const wrapped = looksLikeExpression
    ? `(async () => { return (${code}); })()`
    : `(async () => { ${code} })()`;
  const result = await _page.evaluate(wrapped);
  return { result };
}

export async function extract({ selector, attr = null, limit = 50 } = {}) {
  await ensureBrowser();
  const items = await _page.evaluate(({ selector, attr, limit }) => {
    const els = Array.from(document.querySelectorAll(selector)).slice(0, limit);
    return els.map(el => {
      if (attr) return el.getAttribute(attr);
      return el.textContent?.trim() || null;
    });
  }, { selector, attr, limit });
  return { count: items.length, items };
}

export async function screenshot({ path = null, fullPage = false } = {}) {
  await ensureBrowser();
  const buf = await _page.screenshot({ fullPage });
  if (path) {
    await writeFile(path, buf);
    return { path, bytes: buf.length };
  }
  return { base64: buf.toString('base64'), bytes: buf.length };
}

export async function click({ selector, x, y } = {}) {
  await ensureBrowser();
  if (selector) {
    await _page.click(selector, { timeout: 10000 });
    return { clicked: selector };
  }
  if (x != null && y != null) {
    await _page.mouse.click(x, y);
    return { clicked: `(${x},${y})` };
  }
  throw new Error('click requires selector or {x,y}');
}

export async function type({ text, selector = null, x = null, y = null, pressEnter = false } = {}) {
  await ensureBrowser();
  if (selector) {
    await _page.fill(selector, text);
  } else {
    if (x != null && y != null) await _page.mouse.click(x, y);
    await _page.keyboard.type(text);
  }
  if (pressEnter) await _page.keyboard.press('Enter');
  return { typed: text.length, target: selector || `(${x},${y})` };
}

export async function pressKey({ key } = {}) {
  await ensureBrowser();
  await _page.keyboard.press(key);
  return { pressed: key };
}

export async function pageInfo() {
  await ensureBrowser();
  return { url: _page.url(), title: await _page.title() };
}

export async function scroll({ direction = 'down', amount = 600 } = {}) {
  await ensureBrowser();
  const yMap = { up: -1, down: 1 };
  const xMap = { left: -1, right: 1 };
  const dy = (yMap[direction] || 0) * Number(amount || 0);
  const dx = (xMap[direction] || 0) * Number(amount || 0);
  await _page.evaluate(({ dy, dx }) => window.scrollBy(dy, dx), { dy, dx });
  return { ok: true, direction, dx, dy };
}

// Click the element matched by a Playwright text selector expression.
// Useful for "click the button that says 'Submit'".
export async function clickByText({ text, selector = 'button, a, [role=button]' } = {}) {
  await ensureBrowser();
  const handle = await _page.locator(selector).getByText(text, { exact: false }).first();
  await handle.scrollIntoViewIfNeeded();
  await handle.click();
  return { clicked: text };
}

// Visual mousing tool parity: scan the page for interactive
// elements and return a structured list. The relay-based
// `tag_elements` paints badges on the page; this version just
// returns the data, which is usually all the agent needs.
export async function tagElements({ max = 200 } = {}) {
  await ensureBrowser();
  return await _page.evaluate((max) => {
    const INTERACTIVE = 'a[href], button, input:not([type=hidden]), textarea, select, [role=button], [role=link], [role=checkbox], [role=radio], [role=tab], [role=menuitem], [role=option], [role=switch], [role=combobox], [role=searchbox], [contenteditable=true], [tabindex]:not([tabindex="-1"]), [onclick]';
    const els = Array.from(document.querySelectorAll(INTERACTIVE)).filter(el => {
      if (el.closest('[hidden],[aria-hidden="true"]')) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) return false;
      if (r.bottom < 0 || r.right < 0) return false;
      if (r.top > window.innerHeight + 200) return false;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') return false;
      return true;
    }).slice(0, max);
    // Also publish a window-level handle so setTagFilter / flashTag /
    // clickByTag can look elements up by visible number or by a
    // stable tagId (rebuilt on every tagElements call).
    if (!window.__agentTags) {
      window.__agentTags = { byNumber: new Map(), byTag: new Map(), nextId: 1 };
    } else {
      window.__agentTags.byNumber.clear();
      window.__agentTags.byTag.clear();
    }
    return els.map((el, i) => {
      const r = el.getBoundingClientRect();
      const tagId = 't' + (window.__agentTags.nextId++);
      const desc = {
        num: i + 1,
        tag: el.tagName.toLowerCase(),
        id: el.id || null,
        role: el.getAttribute('role') || null,
        type: el.getAttribute && el.getAttribute('type') || null,
        text: (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || '').toString().slice(0, 100).trim() || null,
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), cx: Math.round(r.x + r.width/2), cy: Math.round(r.y + r.height/2) },
        visible: r.bottom > 0 && r.top < window.innerHeight,
      };
      window.__agentTags.byTag.set(tagId, { el, rect: desc.rect, desc });
      window.__agentTags.byNumber.set(i + 1, tagId);
      return Object.assign({ tagId }, desc);
    });
  }, max);
}

// Click the Nth element from tagElements (1-indexed). The relay
// version uses "visible number" so it stays stable across scroll;
// here we just re-scan and pick the Nth since headless pages
// don't repaint.
export async function clickByTag({ num } = {}) {
  await ensureBrowser();
  const list = await tagElements({ max: 500 });
  const target = list.find(e => e.num === num);
  if (!target) return { ok: false, error: 'No element with tag #' + num };
  await _page.mouse.click(target.rect.cx, target.rect.cy);
  return { ok: true, num, ...target };
}

export async function typeByTag({ num, text } = {}) {
  await ensureBrowser();
  const list = await tagElements({ max: 500 });
  const target = list.find(e => e.num === num);
  if (!target) return { ok: false, error: 'No element with tag #' + num };
  await _page.mouse.click(target.rect.cx, target.rect.cy);
  await _page.keyboard.type(text || '');
  return { ok: true, num, typed: (text||'').length };
}

// Coordinate crosshair — a small cursor that follows the mouse
// and shows the exact viewport coordinates + the element under
// the pointer. Useful for "is this where I think it is?" preview
// before committing to a click. The visual is painted in-page via
// CSS, not via the OS cursor, so it doesn't interfere with real
// input. Toggle on/off with the showCrosshair/hideCrosshair tools.
// Coordinate crosshair — a small cursor that follows the mouse
// and shows the exact viewport coordinates + the element under
// the pointer. The crosshair state lives on `window.__agentCrosshair`
// (not in closure-captured locals) so the listener can be re-bound,
// re-invoked, and inspected from outside the original evaluate.
// Pair with moveMouse() to keep the readout in sync with the
// real pointer position.
export async function showCrosshair() {
  await ensureBrowser();
  const proof = await _page.evaluate(() => {
    if (window.__agentCrosshair && window.__agentCrosshair.injected) {
      return { status: 'already', readoutFound: !!document.getElementById('__agent_browser_crosshair_readout__') };
    }
    const css = [
      '.__agent_crosshair__ { position: fixed !important; z-index: 2147483647 !important; pointer-events: none !important; width: 0 !important; height: 0 !important; }',
      '.__agent_crosshair__::before, .__agent_crosshair__::after { content: "" !important; position: absolute !important; background: #ff3b30 !important; box-shadow: 0 0 0 0.5px #fff !important; }',
      '.__agent_crosshair__::before { left: -20px !important; top: -0.5px !important; width: 40px !important; height: 1px !important; }',
      '.__agent_crosshair__::after { top: -20px !important; left: -0.5px !important; width: 1px !important; height: 40px !important; }',
      '.__agent_crosshair_dot__ { position: fixed !important; z-index: 2147483647 !important; pointer-events: none !important; width: 4px !important; height: 4px !important; margin: -2px 0 0 -2px !important; background: #ff3b30 !important; border: 1px solid #fff !important; border-radius: 50% !important; box-sizing: border-box !important; }',
      '.__agent_crosshair_readout__ { position: fixed !important; z-index: 2147483647 !important; bottom: 8px !important; right: 8px !important; padding: 6px 10px !important; background: rgba(20,20,22,0.92) !important; color: #fff !important; font: 600 11px/1 ui-monospace, Menlo, monospace !important; border-radius: 6px !important; pointer-events: none !important; box-shadow: 0 4px 12px rgba(0,0,0,0.4) !important; white-space: nowrap !important; font-feature-settings: "tnum" 1 !important; }',
      '.__agent_crosshair_target__ { color: #aaa !important; font-weight: 400 !important; margin-left: 8px !important; }',
      '.__agent_crosshair_grid__ { position: fixed !important; left: 0 !important; top: 0 !important; width: 100vw !important; height: 100vh !important; pointer-events: none !important; z-index: 2147483646 !important; background-image: linear-gradient(to right, rgba(10,132,255,0.08) 1px, transparent 1px), linear-gradient(to bottom, rgba(10,132,255,0.08) 1px, transparent 1px) !important; background-size: 50px 50px !important; }',
    ].join('\n');
    let s = document.getElementById('__agent_browser_crosshair_style__');
    if (!s) {
      s = document.createElement('style');
      s.id = '__agent_browser_crosshair_style__';
      document.documentElement.appendChild(s);
    }
    s.textContent = css;
    function el(cls, id) {
      let n = id ? document.getElementById(id) : null;
      if (!n) {
        n = document.createElement('div');
        if (cls) n.className = cls;
        if (id) n.id = id;
        document.documentElement.appendChild(n);
      }
      return n;
    }
    const cross = el('__agent_crosshair__', '__agent_browser_crosshair__');
    const dot   = el('__agent_crosshair_dot__', '__agent_browser_crosshair_dot__');
    const r     = el('__agent_crosshair_readout__', '__agent_browser_crosshair_readout__');
    function update(x, y) {
      x = Math.round(x); y = Math.round(y);
      cross.style.left = x + 'px'; cross.style.top = y + 'px';
      dot.style.left   = x + 'px'; dot.style.top   = y + 'px';
      let target = '-'; let eid = ''; let cls = '';
      try {
        const el2 = document.elementFromPoint(x, y);
        if (el2) {
          target = el2.tagName.toLowerCase();
          if (el2.id) eid = '#' + el2.id;
          if (el2.className && typeof el2.className === 'string') {
            const c = el2.className.trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.');
            if (c) cls = '.' + c;
          }
          // Also note whether the element is interactive.
          const interactive = !!(el2.onclick || el2.tagName === 'BUTTON' || el2.tagName === 'A' || el2.tagName === 'INPUT' || el2.getAttribute && el2.getAttribute('role') === 'button' || el2.tagName === 'TEXTAREA' || el2.isContentEditable);
          if (interactive) target = '→ ' + target;
        }
      } catch (e) { /* elementFromPoint can throw on detached iframes */ }
      r.innerHTML = '<b>x</b>:' + x + ' <b>y</b>:' + y + '<span class="__agent_crosshair_target__">' + target + eid + cls + '</span>';
      window.__agentCrosshair.x = x;
      window.__agentCrosshair.y = y;
    }
    // Store on window so the driver can call it from outside the
    // evaluate boundary, and so the listener (which can't reference
    // these locals after serialization) can find them too.
    window.__agentCrosshair = {
      injected: true,
      cross, dot, r, update,
      _onMove: null,
    };
    const onMove = (ev) => update(ev.clientX, ev.clientY);
    window.__agentCrosshair._onMove = onMove;
    try { window.addEventListener('mousemove', onMove, { capture: true, passive: true }); } catch (e) {}
    return {
      status: 'injected',
      readoutFound: !!document.getElementById('__agent_browser_crosshair_readout__'),
      docChildren: document.documentElement.children.length,
      hasUpdate: typeof window.__agentCrosshair.update === 'function',
    };
  });
  return { ok: true, proof };
}

// Move the mouse to (x, y) AND update the crosshair readout. Use
// this instead of page.mouse.move() so the visual mousing tool
// stays in sync with the actual pointer position. The driver's
// own page is used, so the crosshair (on the same page) is
// guaranteed to see the new coordinates.
export async function moveMouse({ x, y } = {}) {
  await ensureBrowser();
  await _page.mouse.move(x, y);
  // The mousemove event updates the readout via the listener, but
  // headless Chrome sometimes drops the event if the mouse is moved
  // before the page is fully ready. Belt-and-suspenders: also call
  // the update function directly via a fresh evaluate.
  await _page.evaluate((xy) => {
    if (window.__agentCrosshair && window.__agentCrosshair.update) {
      window.__agentCrosshair.update(xy.x, xy.y);
    }
  }, { x, y });
  return { ok: true, x, y };
}


export async function hideCrosshair() {
  await ensureBrowser();
  await _page.evaluate(`(() => {
    ['__agent_browser_crosshair_style__','__agent_crosshair__','__agent_crosshair_dot__','__agent_crosshair_readout__'].forEach(id => document.getElementById(id)?.remove());
    if (window.__agentCrosshair && window.__agentCrosshair._move) window.removeEventListener('mousemove', window.__agentCrosshair._move, { capture: true });
  })()`);
  return { ok: true };
}

// Drag-and-drop visualization: paints a start dot, an end dot, and
// a dashed line between them. Useful for sortable lists, kanban
// boards, file uploads. Pairs with the new crosshair to show the
// model the exact drag path before it commits.
export async function startDrag({ x, y } = {}) {
  await ensureBrowser();
  // Two-phase: first create the layer + state, then set the
  // coordinates. Return a proof so the caller can verify the
  // state was actually set.
  const proof = await _page.evaluate((xy) => {
    if (!document.getElementById('__agent_browser_drag_style__')) {
      const css = [
        '.__agent_drag_start__, .__agent_drag_end__ { position: fixed !important; z-index: 2147483647 !important; pointer-events: none !important; width: 12px !important; height: 12px !important; margin: -6px 0 0 -6px !important; border: 2px solid #fff !important; border-radius: 50% !important; box-shadow: 0 0 0 2px #0a84ff, 0 2px 6px rgba(0,0,0,0.4) !important; }',
        '.__agent_drag_end__ { box-shadow: 0 0 0 2px #ff3b30, 0 2px 6px rgba(0,0,0,0.4) !important; }',
        '.__agent_drag_line__ { position: fixed !important; z-index: 2147483647 !important; pointer-events: none !important; background: repeating-linear-gradient(90deg, #0a84ff 0 6px, transparent 6px 10px) !important; height: 2px !important; transform-origin: 0 50% !important; }',
      ].join('\n');
      const s = document.createElement('style');
      s.id = '__agent_browser_drag_style__';
      s.textContent = css;
      document.documentElement.appendChild(s);
      const r = document.createElement('div');
      r.id = '__agent_browser_drag_layer__';
      r.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;pointer-events:none;z-index:2147483647';
      document.documentElement.appendChild(r);
      window.__agentDrag = { layer: r, startX: 0, startY: 0, endX: 0, endY: 0 };
    }
    window.__agentDrag.startX = window.__agentDrag.endX = xy.x;
    window.__agentDrag.startY = window.__agentDrag.endY = xy.y;
    window.__agentDrag.layer.innerHTML = '';
    return {
      startX: window.__agentDrag.startX,
      startY: window.__agentDrag.startY,
      endX:   window.__agentDrag.endX,
      endY:   window.__agentDrag.endY,
    };
  }, { x, y });
  return { ok: true, x, y, proof };
}


export async function updateDrag({ x, y } = {}) {
  await ensureBrowser();
  await _page.evaluate((arg) => {
    window.__agentDrag.endX = arg.x; window.__agentDrag.endY = arg.y;
    const s = window.__agentDrag.startX, sy = window.__agentDrag.startY, e = window.__agentDrag.endX, ey = window.__agentDrag.endY;
    window.__agentDrag.layer.innerHTML = '';
    const start = document.createElement('div'); start.className = '__agent_drag_start__'; start.style.left = s+'px'; start.style.top = sy+'px';
    const end = document.createElement('div'); end.className = '__agent_drag_end__'; end.style.left = e+'px'; end.style.top = ey+'px';
    const dx = e-s, dy = ey-sy, len = Math.hypot(dx,dy), ang = Math.atan2(dy,dx)*180/Math.PI;
    const line = document.createElement('div'); line.className = '__agent_drag_line__'; line.style.left = s+'px'; line.style.top = sy+'px'; line.style.width = len+'px'; line.style.transform = 'rotate('+ang+'deg)';
    window.__agentDrag.layer.append(start, end, line);
  }, { x, y });
  return { ok: true, x, y };
}

export async function endDrag() {
  await ensureBrowser();
  const r = await _page.evaluate(`(() => {
    if (!window.__agentDrag) return { ok: false, error: 'no drag' };
    const out = { ok: true, start: { x: window.__agentDrag.startX, y: window.__agentDrag.startY }, end: { x: window.__agentDrag.endX, y: window.__agentDrag.endY } };
    window.__agentDrag.layer.innerHTML = '';
    return out;
  })()`);
  return r;
}

// ------------------------------------------------------------------
// Visual mousing tool: element info + hover preview + selection
// visualization + coordinate grid. These round out the toolset:
// the model can now (a) inspect any pixel, (b) preview what a
// click would do, (c) see text-selection state on the page, and
// (d) overlay a faint grid for pixel-precise alignment.
// ------------------------------------------------------------------

// Return everything the model could want to know about the
// element at a given viewport point: tag, id, classes, text,
// rect, visibility, z-index, computed role, and whether it's
// interactive (button/link/input/etc). Plus a "would click do
// anything?" check that walks up the tree to find the nearest
// clickable ancestor.
export async function elementInfo({ x, y } = {}) {
  await ensureBrowser();
  return await _page.evaluate((xy) => {
    const r = { x: xy.x, y: xy.y, found: false };
    let el;
    try { el = document.elementFromPoint(xy.x, xy.y); } catch (e) { r.error = String(e); return r; }
    if (!el) { r.reason = 'no element at point'; return r; }
    r.found = true;
    const rect = el.getBoundingClientRect();
    r.tag = el.tagName.toLowerCase();
    r.id = el.id || null;
    r.className = (typeof el.className === 'string' ? el.className : '') || null;
    r.text = (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('title') || '').toString().slice(0, 200).trim() || null;
    r.placeholder = el.getAttribute('placeholder') || null;
    r.role = el.getAttribute('role') || null;
    r.href = el.href || null;
    r.type = (el.getAttribute && el.getAttribute('type')) || null;
    r.value = (el.value != null ? String(el.value) : null);
    r.rect = { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height), cx: Math.round(rect.x + rect.width/2), cy: Math.round(rect.y + rect.height/2) };
    const cs = getComputedStyle(el);
    r.style = { zIndex: cs.zIndex, position: cs.position, pointerEvents: cs.pointerEvents, visibility: cs.visibility, display: cs.display, opacity: cs.opacity };
    r.contentEditable = !!el.isContentEditable;
    r.focused = document.activeElement === el;
    // Walk up to find the nearest clickable ancestor.
    let target = el, interactiveReason = null, depth = 0;
    const isClickable = (n) => {
      if (!n) return false;
      const t = n.tagName;
      if (t === 'BUTTON' || t === 'A' || t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT') return 'tag:' + t;
      if (n.getAttribute && n.getAttribute('role') === 'button') return 'role:button';
      if (n.onclick) return 'onclick';
      if (n.style && n.style.cursor === 'pointer') return 'cursor:pointer';
      return null;
    };
    while (target && depth < 8) {
      const why = isClickable(target);
      if (why) { interactiveReason = why; break; }
      target = target.parentElement;
      depth++;
    }
    r.clickable = !!interactiveReason;
    r.clickReason = interactiveReason;
    r.clickTarget = target && target !== el ? { tag: target.tagName.toLowerCase(), id: target.id || null, text: (target.innerText || target.value || '').toString().slice(0, 100).trim() || null } : null;
    r.clickTargetIsSelf = target === el;
    // Path from (x,y) element up to the click target.
    r.depth = depth;
    return r;
  }, { x, y });
}

// Preview what a click would do at (x, y) without actually
// clicking. Returns:
//   - elementInfo at the point
//   - whether the element has an onclick handler
//   - whether the element is the topmost at the point
//   - what a 'click' event would propagate to
//   - whether the page is currently scrollable at the point
// This is the "is this where I want to click?" check.
export async function hoverPreview({ x, y } = {}) {
  await ensureBrowser();
  const info = await elementInfo({ x, y });
  // Dispatch a pointerover + mouseover to trigger any hover-driven UI
  // (tooltips, dropdowns, etc) without actually clicking.
  const preview = await _page.evaluate((xy) => {
    const events = ['pointerover', 'pointerenter', 'mouseover', 'mouseenter'];
    const dispatched = [];
    let hoverTarget = null;
    try {
      const el = document.elementFromPoint(xy.x, xy.y);
      if (el) {
        hoverTarget = el.tagName.toLowerCase() + (el.id ? '#' + el.id : '');
        for (const t of events) {
          try { el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window, clientX: xy.x, clientY: xy.y })); dispatched.push(t); } catch (e) {}
        }
      }
    } catch (e) {}
    // Check if anything is scrollable under the point
    let scrollable = null;
    try {
      const el = document.elementFromPoint(xy.x, xy.y);
      let n = el;
      while (n) {
        const cs = getComputedStyle(n);
        if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll') && n.scrollHeight > n.clientHeight) {
          scrollable = n.tagName.toLowerCase() + (n.id ? '#' + n.id : '');
          break;
        }
        n = n.parentElement;
      }
    } catch (e) {}
    return { dispatched, hoverTarget, scrollable };
  }, { x, y });
  return { ...info, preview };
}

// Show a coordinate grid overlay (50px spacing) for pixel-precise
// alignment. Toggle on/off. Combined with the crosshair, this lets
// the model reason about exact coordinates on screenshots.
export async function showGrid({ spacing = 50 } = {}) {
  await ensureBrowser();
  return await _page.evaluate((sp) => {
    if (document.getElementById('__agent_browser_grid__')) {
      return { ok: true, already: true };
    }
    const css = `.__agent_browser_grid__ { position: fixed !important; left: 0 !important; top: 0 !important; width: 100vw !important; height: 100vh !important; pointer-events: none !important; z-index: 2147483646 !important; background-image: linear-gradient(to right, rgba(10,132,255,0.10) 1px, transparent 1px), linear-gradient(to bottom, rgba(10,132,255,0.10) 1px, transparent 1px) !important; background-size: ${sp}px ${sp}px !important; }`;
    let s = document.getElementById('__agent_browser_grid_style__');
    if (!s) { s = document.createElement('style'); s.id = '__agent_browser_grid_style__'; document.documentElement.appendChild(s); }
    s.textContent = css;
    const g = document.createElement('div');
    g.id = '__agent_browser_grid__';
    g.className = '__agent_browser_grid__';
    document.documentElement.appendChild(g);
    return { ok: true };
  }, spacing);
}

export async function hideGrid() {
  await ensureBrowser();
  await _page.evaluate(() => {
    ['__agent_browser_grid__','__agent_browser_grid_style__'].forEach(id => document.getElementById(id)?.remove());
  });
  return { ok: true };
}

// Highlight the currently focused element and any current text
// selection with a visible bracket. Helps the model see where the
// keyboard caret is and what's been selected.
export async function showSelection() {
  await ensureBrowser();
  return await _page.evaluate(() => {
    if (document.getElementById('__agent_browser_selection_style__')) {
      // already on
    } else {
      const s = document.createElement('style');
      s.id = '__agent_browser_selection_style__';
      s.textContent = [
        '.__agent_browser_focus_ring__ {',
        '  position: fixed !important;',
        '  z-index: 2147483646 !important;',
        '  pointer-events: none !important;',
        '  border: 2px solid #ff9500 !important;',
        '  border-radius: 4px !important;',
        '  box-shadow: 0 0 0 2px rgba(255,149,0,0.3) !important;',
        '  transition: all 0.12s ease !important;',
        '}',
        '.__agent_browser_caret__ {',
        '  position: fixed !important;',
        '  z-index: 2147483646 !important;',
        '  pointer-events: none !important;',
        '  width: 2px !important;',
        '  background: #ff9500 !important;',
        '  box-shadow: 0 0 0 1px #fff !important;',
        '}',
      ].join('\n');
      document.documentElement.appendChild(s);
    }
    function update() {
      // Remove old markers
      document.querySelectorAll('.__agent_browser_focus_ring__, .__agent_browser_caret__').forEach(n => n.remove());
      const ae = document.activeElement;
      if (ae && ae !== document.body) {
        const r = ae.getBoundingClientRect();
        if (r.width > 0 || r.height > 0) {
          const ring = document.createElement('div');
          ring.className = '__agent_browser_focus_ring__';
          ring.style.left = (r.left - 2) + 'px';
          ring.style.top  = (r.top - 2) + 'px';
          ring.style.width  = (r.width + 4) + 'px';
          ring.style.height = (r.height + 4) + 'px';
          document.documentElement.appendChild(ring);
        }
        // For inputs/textareas/contenteditable, draw a caret at the
        // current selection end so the model can see where typing would go.
        try {
          let caretRange = null;
          if (ae.isContentEditable) {
            const sel = window.getSelection();
            if (sel && sel.rangeCount > 0) caretRange = sel.getRangeAt(0).cloneRange();
          } else if (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA') {
            // For inputs, position the caret at the end of the current value.
            const r2 = ae.getBoundingClientRect();
            const caret = document.createElement('div');
            caret.className = '__agent_browser_caret__';
            caret.style.left = (r2.right - 1) + 'px';
            caret.style.top  = r2.top + 'px';
            caret.style.height = r2.height + 'px';
            document.documentElement.appendChild(caret);
          }
          if (caretRange) {
            const rects = caretRange.getClientRects();
            for (let i = 0; i < rects.length; i++) {
              const rr = rects[i];
              if (rr.width === 0 && rr.height === 0) continue;
              const caret = document.createElement('div');
              caret.className = '__agent_browser_caret__';
              caret.style.left = rr.left + 'px';
              caret.style.top  = rr.top + 'px';
              caret.style.height = rr.height + 'px';
              document.documentElement.appendChild(caret);
            }
          }
        } catch (e) {}
      }
      // Also highlight the current text selection (if any).
      try {
        const sel = window.getSelection();
        if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {
          const range = sel.getRangeAt(0);
          const rects = range.getClientRects();
          for (let i = 0; i < rects.length; i++) {
            const r2 = rects[i];
            const hl = document.createElement('div');
            hl.className = '__agent_browser_focus_ring__';
            hl.style.left = r2.left + 'px';
            hl.style.top  = r2.top + 'px';
            hl.style.width  = r2.width + 'px';
            hl.style.height = r2.height + 'px';
            hl.style.borderColor = '#0a84ff';
            hl.style.boxShadow = '0 0 0 2px rgba(10,132,255,0.3) !important';
            document.documentElement.appendChild(hl);
          }
        }
      } catch (e) {}
    }
    update();
    // Re-update on focus changes and selection changes so the
    // highlight always matches reality.
    if (!window.__agentSelHandlers) {
      window.__agentSelHandlers = true;
      window.addEventListener('focusin', update, true);
      window.addEventListener('focusout', update, true);
      window.addEventListener('selectionchange', update);
    }
    return { ok: true, activeElement: document.activeElement && document.activeElement.tagName };
  });
}

export async function hideSelection() {
  await ensureBrowser();
  await _page.evaluate(() => {
    document.querySelectorAll('.__agent_browser_focus_ring__, .__agent_browser_caret__').forEach(n => n.remove());
    document.getElementById('__agent_browser_selection_style__')?.remove();
    if (window.__agentSelHandlers) {
      window.removeEventListener('focusin', () => {}, true);
      window.removeEventListener('focusout', () => {}, true);
      window.removeEventListener('selectionchange', () => {});
      window.__agentSelHandlers = false;
    }
  });
  return { ok: true };
}

// Polish the tag system: "freeze" mode (pause re-tagging on
// scroll), "filter" mode (only show certain element types), and
// a focus ring that follows the last-clicked tag so the model
// can see what it just hit.
export async function setTagFilter({ types = null, freeze = false } = {}) {
  await ensureBrowser();
  return await _page.evaluate((opts) => {
    if (!window.__agentTags) return { ok: false, error: 'tags not active; call tagElements first' };
    if (opts.freeze) window.__agentTags.frozen = true;
    else delete window.__agentTags.frozen;
    if (opts.types && Array.isArray(opts.types)) {
      window.__agentTags.filter = new Set(opts.types);
    } else {
      delete window.__agentTags.filter;
    }
    return { ok: true, frozen: !!window.__agentTags.frozen, filter: window.__agentTags.filter ? Array.from(window.__agentTags.filter) : null };
  }, { types, freeze });
}

// Highlight the last-clicked tag with a pulse ring. Pair with
// clickByTag so the model gets immediate visual confirmation.
export async function flashTag({ num, color = '#34c759' } = {}) {
  await ensureBrowser();
  return await _page.evaluate((opts) => {
    if (!window.__agentTags) return { ok: false, error: 'tags not active' };
    const tagId = window.__agentTags.byNumber.get(opts.num);
    if (!tagId) return { ok: false, error: 'no tag #' + opts.num };
    const entry = window.__agentTags.byTag.get(tagId);
    if (!entry) return { ok: false, error: 'tag entry missing' };
    const rect = entry.el.getBoundingClientRect();
    const ring = document.createElement('div');
    ring.className = '__agent_browser_tag_focus__';
    ring.style.cssText = 'position:fixed !important;z-index:2147483646 !important;pointer-events:none !important;border:3px solid ' + opts.color + ' !important;border-radius:4px !important;left:' + (rect.left-3) + 'px !important;top:' + (rect.top-3) + 'px !important;width:' + (rect.width+6) + 'px !important;height:' + (rect.height+6) + 'px !important;animation:agentTagFlash 0.6s ease-out forwards !important;';
    if (!document.getElementById('__agent_browser_tag_focus_style__')) {
      const s = document.createElement('style');
      s.id = '__agent_browser_tag_focus_style__';
      s.textContent = '@keyframes agentTagFlash { 0% { transform: scale(0.8); opacity: 0.8; } 50% { transform: scale(1.05); opacity: 1; } 100% { transform: scale(1); opacity: 0; } }';
      document.documentElement.appendChild(s);
    }
    document.documentElement.appendChild(ring);
    setTimeout(() => ring.remove(), 700);
    return { ok: true, num: opts.num, tagId, rect: { x: rect.left, y: rect.top, w: rect.width, h: rect.height } };
  }, { num, color });
}

export async function close() {
  if (_browser) {
    await _browser.close();
    _browser = null;
    _context = null;
    _page = null;
  }
  return { closed: true };
}

// =============================================================
// CLI shim — `node playwright-driver.mjs <action> [args...]`
// =============================================================
const ACTIONS = {
  navigate: ({ url }) => navigate({ url }),
  eval: async ({ file, code }) => {
    const c = file ? await readFile(resolve(file), 'utf8') : code;
    return evaluate({ code: c });
  },
  extract: ({ selector, attr, limit }) => extract({ selector, attr, limit: limit ? Number(limit) : 50 }),
  screenshot: ({ path, full }) => screenshot({ path, fullPage: full === '1' || full === 'true' }),
  click: ({ selector, x, y }) => click({ selector, x: x ? Number(x) : null, y: y ? Number(y) : null }),
  type: ({ text, selector, x, y, pressEnter }) => type({ text, selector, x: x ? Number(x) : null, y: y ? Number(y) : null, pressEnter: pressEnter === '1' }),
  'press-key': ({ key }) => pressKey({ key }),
  'page-info': () => pageInfo(),
  scroll: ({ direction, amount }) => scroll({ direction, amount: amount ? Number(amount) : 600 }),
  'tag-elements': ({ max }) => tagElements({ max: max ? Number(max) : 200 }),
  'click-by-tag': ({ num }) => clickByTag({ num: Number(num) }),
  'type-by-tag': ({ num, text }) => typeByTag({ num: Number(num), text }),
  close: () => close(),
};

async function main() {
  const [action, ...rest] = process.argv.slice(2);
  if (!action || action === 'help' || action === '--help' || action === '-h') {
    console.log('Usage: node playwright-driver.mjs <action> [args]');
    console.log('Actions:', Object.keys(ACTIONS).join(', '));
    console.log('Example: node playwright-driver.mjs navigate https://example.com');
    process.exit(0);
  }
  const fn = ACTIONS[action];
  if (!fn) { console.error('Unknown action:', action); process.exit(2); }
  // Positional args: parse based on action. For simplicity we
  // expect k=v pairs after the action.
  const args = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : '1';
      args[key] = val;
    } else if (a.includes('=')) {
      const [k, v] = a.split('=', 2);
      args[k] = v;
    } else if (args._positional === undefined) {
      args._positional = a;
    } else {
      args._positional2 = a;
    }
  }
  // For navigate, the first positional is the url.
  if (action === 'navigate' && args._positional && !args.url) args.url = args._positional;
  if (action === 'eval' && args._positional && !args.code && !args.file) args.file = args._positional;
  if (action === 'extract' && args._positional && !args.selector) args.selector = args._positional;
  if (action === 'click' && args._positional && !args.selector) args.selector = args._positional;
  if (action === 'type' && args._positional && !args.text) args.text = args._positional;
  if (action === 'screenshot' && args._positional && !args.path) args.path = args._positional;

  const result = await fn(args);
  console.log(JSON.stringify(result, null, 2));
  await close();
}

// Run CLI if invoked directly. When imported as a module the
// auto-runner is skipped.
const isMain = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]}`;
  } catch { return false; }
})();
if (isMain) {
  main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
}
