#!/usr/bin/env node
/* =============================================================
 * test-runner.js — End-to-end "dog food" test for the Agent
 * Controller system. Acts as an external client (the role Codex
 * would play) and drives the controller-server, which routes
 * actions to the mock-extension, which executes them in a real
 * Chrome via CDP. Verifies side-effects in the browser.
 *
 * Usage:
 *   node test-runner.js [--port 9223] [--keep-open]
 * ============================================================= */

import WebSocket from 'ws';
import { writeFileSync, mkdirSync } from 'node:fs';

const CONTROLLER_URL = process.env.CONTROLLER_URL || 'ws://127.0.0.1:9223/ws';
const TEST_PAGE      = process.env.TEST_PAGE      || 'http://127.0.0.1:9333/';
const SCREENSHOT_DIR = '/tmp/agent-controller-test';
mkdirSync(SCREENSHOT_DIR, { recursive: true });

let nextId = 1;
const pending = new Map();
let ws;
const results = [];

function send(action, params = {}, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const id = String(nextId++);
    const t = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout waiting for ${action}`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, action, t });
    ws.send(JSON.stringify({ id, action, params }));
  });
}

function ok(label, cond, detail) {
  const passed = !!cond;
  results.push({ label, passed, detail });
  const tag = passed ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
  console.log(`  ${tag}  ${label}${detail ? '  — ' + detail : ''}`);
  return passed;
}

function section(name) {
  console.log(`\n\x1b[1m${name}\x1b[0m`);
}

async function saveScreenshot(prefix, dataUrl) {
  if (!dataUrl) return;
  const b64 = dataUrl.replace(/^data:image\/[a-z]+;base64,/, '');
  const path = `${SCREENSHOT_DIR}/${prefix}.png`;
  writeFileSync(path, Buffer.from(b64, 'base64'));
  return path;
}

async function getClickCount() {
  const r = await send('evaluate', { script: 'window.__test.getClickCount()' });
  return r.result;
}

async function getInputValue() {
  const r = await send('evaluate', { script: 'window.__test.getInputValue()' });
  return r.result;
}

async function getTitle() {
  const r = await send('evaluate', { script: 'document.title' });
  return r.result;
}

async function getUrl() {
  const r = await send('evaluate', { script: 'location.href' });
  return r.result;
}

async function getScrollY() {
  const r = await send('evaluate', { script: 'window.scrollY' });
  return r.result;
}

async function main() {
  ws = new WebSocket(CONTROLLER_URL);
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
  ws.send(JSON.stringify({ role: 'client' }));
  await new Promise((r) => ws.once('message', (m) => {
    const j = JSON.parse(m.toString());
    if (j.type === 'hello-ack') r();
  }));

  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      clearTimeout(p.t);
      pending.delete(m.id);
      p.resolve(m);
    }
  });

  console.log('test-runner connected, exercising every action type...\n');

  // ---- 1. navigate ----
  section('1. navigate to test page');
  const nav = await send('navigate', { url: TEST_PAGE });
  ok('navigate ok', nav.ok, 'url=' + nav.url);
  // Wait for page to settle
  await new Promise(r => setTimeout(r, 400));

  // ---- 2. inspect ----
  section('2. inspect (full state)');
  const insp = await send('inspect');
  ok('inspect ok', insp.ok);
  const st = insp;
  ok('  url is test page', st.url && st.url.startsWith(TEST_PAGE.replace(/\/$/, '')), st.url);
  ok('  title set', st.title && /Agent Controller Test Page/.test(st.title), st.title);
  ok('  viewport > 0', st.width > 0 && st.height > 0, `${st.width}x${st.height}`);
  ok('  screenshot present', !!st.dataUrl && st.dataUrl.startsWith('data:image/'), `len=${(st.dataUrl||'').length}`);
  ok('  landmarks present', Array.isArray(st.landmarks) && st.landmarks.length > 0, `${(st.landmarks||[]).length} landmarks`);
  await saveScreenshot('01-initial', st.dataUrl);

  // Helper: denormalize 0-1000 to pixels (matches extension)
  const VP = { width: st.width, height: st.height };
  const toPx = (nx, ny) => ({ x: Math.round(nx / 1000 * VP.width), y: Math.round(ny / 1000 * VP.height) });

  // Find button landmark
  const btnLandmark = st.landmarks.find(l => l.id === 'btn-click');
  ok('  found #btn-click landmark', !!btnLandmark, btnLandmark ? `at (${btnLandmark.rect.x},${btnLandmark.rect.y})` : 'missing');

  // ---- 3. click (trusted) ----
  section('3. click the test button');
  const beforeCount = await getClickCount();
  const bc = btnLandmark ? btnLandmark.rect : { x: 0, y: 0, w: 0, h: 0 };
  const tClick = toPx(
    ((bc.x + bc.w / 2) / VP.width)  * 1000,
    ((bc.y + bc.h / 2) / VP.height) * 1000,
  );
  const click = await send('click', tClick);
  ok('click ok', click.ok, `(${tClick.x},${tClick.y}) → tag=${click.tag || click.text || ''}`);
  await new Promise(r => setTimeout(r, 250));
  const afterCount = await getClickCount();
  ok('  click count incremented', afterCount === beforeCount + 1, `was ${beforeCount}, now ${afterCount}`);

  // ---- 4. type (clear + char-by-char) ----
  section('4. type into #text-input (with clear)');
  const tiLandmark = st.landmarks.find(l => l.id === 'text-input');
  if (tiLandmark) {
    const ti = toPx(
      ((tiLandmark.rect.x + tiLandmark.rect.w / 2) / VP.width)  * 1000,
      ((tiLandmark.rect.y + tiLandmark.rect.h / 2) / VP.height) * 1000,
    );
    // Pre-seed the input with something so the clear step has to do work
    await send('type', { x: ti.x, y: ti.y, text: 'stale' });
    await new Promise(r => setTimeout(r, 400));
    const seeded = await getInputValue();
    ok('  pre-seeded value', seeded === 'stale', `value=${seeded}`);
    // Now type the real value (should clear stale first)
    const typeRes = await send('type', { x: ti.x, y: ti.y, text: 'hello world' });
    ok('type ok', typeRes.ok, `cleared=${typeRes.cleared} chars=${typeRes.charCount}`);
    await new Promise(r => setTimeout(r, 400));
    const final = await getInputValue();
    ok('  value is exactly "hello world"', final === 'hello world', `value="${final}"`);
  } else {
    ok('  type skipped', false, 'no #text-input landmark');
  }

  // ---- 5. scroll ----
  section('5. scroll down');
  const scrollBefore = await getScrollY();
  const sc = await send('scroll', { direction: 'down', amount: 600 });
  ok('scroll ok', sc.ok, `dy=${sc.dy}`);
  await new Promise(r => setTimeout(r, 300));
  const scrollAfter = await getScrollY();
  ok('  scrollY increased', scrollAfter > scrollBefore, `was ${scrollBefore}, now ${scrollAfter}`);

  // ---- 6. screenshot ----
  section('6. screenshot');
  const shot = await send('screenshot');
  ok('screenshot ok', shot.ok && shot.dataUrl, `len=${(shot.dataUrl||'').length}`);
  await saveScreenshot('02-after-scroll', shot.dataUrl);

  // ---- 7. evaluate ----
  section('7. evaluate (Runtime.evaluate in the page)');
  const ping = await send('evaluate', { script: 'window.__test.ping()' });
  ok('  ping → "pong"', ping.result === 'pong', `got=${ping.result}`);
  const add  = await send('evaluate', { script: 'window.__test.add(7, 35)' });
  ok('  add(7, 35) → 42', add.result === 42, `got=${add.result}`);

  // ---- 8. tabs list ----
  section('8. tabs');
  const tabs = await send('tabs');
  ok('  at least one tab', Array.isArray(tabs.tabs) && tabs.tabs.length > 0,
     `${tabs.tabs.length} tabs`);

  // ---- 9. open new tab + switch_tab + close ----
  section('9. open / switch_tab / close');
  const opened = await send('open', { url: 'data:text/html,<title>new-tab</title>hi' });
  ok('open ok', opened.ok, `tabId=${opened.tabId}`);
  const tabs2 = await send('tabs');
  ok('  tab count grew by 1', tabs2.tabs.length === tabs.tabs.length + 1,
     `${tabs.tabs.length} → ${tabs2.tabs.length}`);
  const switched = await send('switch_tab', { tabId: opened.tabId });
  ok('switch_tab ok', switched.ok);
  // Switch back to the test page so we can screenshot the final state
  const pageTab = tabs.tabs[0];
  await send('switch_tab', { tabId: pageTab.id });
  await new Promise(r => setTimeout(r, 200));
  await send('close', { tabId: opened.tabId });
  const tabs3 = await send('tabs');
  ok('  tab count back down', tabs3.tabs.length === tabs.tabs.length,
     `after close: ${tabs3.tabs.length}`);

  // ---- 10. final screenshot ----
  section('10. final state');
  const final = await send('inspect');
  await saveScreenshot('03-final', final.dataUrl);
  const finalUrl = await getUrl();
  ok('  still on test page', finalUrl && finalUrl.startsWith(TEST_PAGE.replace(/\/$/, '')), finalUrl);

  // ---- summary ----
  const passed = results.filter(r => r.passed).length;
  const failed = results.length - passed;
  console.log(`\n\x1b[1m──── SUMMARY ────\x1b[0m`);
  console.log(`${passed} passed, ${failed} failed (out of ${results.length})`);
  console.log(`screenshots in ${SCREENSHOT_DIR}/`);

  ws.close();
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('test-runner fatal', e); process.exit(2); });
