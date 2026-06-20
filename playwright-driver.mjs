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
    return els.map((el, i) => {
      const r = el.getBoundingClientRect();
      return {
        num: i + 1,
        tag: el.tagName.toLowerCase(),
        id: el.id || null,
        role: el.getAttribute('role') || null,
        type: el.getAttribute && el.getAttribute('type') || null,
        text: (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || '').toString().slice(0, 100).trim() || null,
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), cx: Math.round(r.x + r.width/2), cy: Math.round(r.y + r.height/2) },
        visible: r.bottom > 0 && r.top < window.innerHeight,
      };
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
