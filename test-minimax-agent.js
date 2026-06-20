#!/usr/bin/env node
/* =============================================================
 * test-minimax-agent.js — A mock MiniMax driving script.
 *
 * Demonstrates the canonical MiniMax → Agent Browser Controller
 * integration: a 3-step action chain
 *
 *     1. navigate  — point the browser at a URL
 *     2. click     — dispatch a trusted, OS-level mouse click
 *                    (draws a red anchor dot on the page first)
 *     3. type      — clear the field, then type text
 *
 * Each action is sent to the controller over the same JSON
 * protocol an LLM agent would emit. The controller routes the
 * action to the extension, which executes it via chrome.debugger.
 * Side effects are then verified in the page.
 *
 * Usage:
 *   node test-minimax-agent.js [url] [clickX] [clickY] [typeText]
 *   defaults: http://127.0.0.1:9333/  500  300  "hello minimax"
 * ============================================================= */

import WebSocket from 'ws';

const CONTROLLER = process.env.CONTROLLER_URL || 'ws://127.0.0.1:9223/ws';
const TEST_PAGE  = process.argv[2] || 'http://127.0.0.1:9333/';
const CLICK_X    = parseInt(process.argv[3] || '500', 10);
const CLICK_Y    = parseInt(process.argv[4] || '300', 10);
const TYPE_TEXT  = process.argv[5] || 'hello minimax';

let nextId = 1;
const pending = new Map();
let ws;

function call(action, params = {}) {
  return new Promise((resolve, reject) => {
    const id = String(nextId++);
    const t = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout on ${action}`));
    }, 20000);
    pending.set(id, { resolve, reject, t, action });
    ws.send(JSON.stringify({ id, action, params }));
  });
}

function step(n, title) {
  console.log(`\n\x1b[1m── Step ${n}: ${title} ──\x1b[0m`);
}

function ok(label, cond, detail) {
  const tag = cond ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
  console.log(`  ${tag} ${label}${detail ? '  — ' + detail : ''}`);
  return !!cond;
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log(' MiniMax autonomous driving — 3-step action chain');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(` controller : ${CONTROLLER}`);
  console.log(` navigate   : ${TEST_PAGE}`);
  console.log(` click      : (${CLICK_X}, ${CLICK_Y})  (normalized 0-1000)`);
  console.log(` type       : "${TYPE_TEXT}"`);

  ws = new WebSocket(CONTROLLER);
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

  // Verify extension is connected (Step 1)
  step(1, 'Handshake');
  const status = await new Promise((res) => {
    // Use the HTTP API for a quick /status check
    import('node:http').then(({ get }) => {
      get('http://127.0.0.1:9223/status', (r) => {
        let body = '';
        r.on('data', (c) => body += c);
        r.on('end', () => res(JSON.parse(body)));
      });
    });
  });
  ok('extension connected to controller', !!status.extensionConnected,
     status.extensionConnected ? 'WebSocket alive' : 'rejected — extension not linked');

  // Step 2 — Navigate (the action chain begins)
  step(2, 'Navigate');
  const t0 = Date.now();
  const nav = await call('navigate', { url: TEST_PAGE });
  ok('navigate ok', nav.ok, `url=${nav.url} (${Date.now() - t0}ms)`);
  await new Promise((r) => setTimeout(r, 400));

  // Step 3 — Inspect (verify state)
  step(3, 'Inspect (state feedback loop)');
  const insp = await call('inspect');
  ok('inspect ok', insp.ok);
  ok('  url reached', (insp.url || '').startsWith(TEST_PAGE.replace(/\/$/, '')), insp.url);
  ok('  title set',  /Agent Controller Test Page/.test(insp.title || ''), insp.title);
  ok('  viewport',   insp.width > 0 && insp.height > 0, `${insp.width}x${insp.height}`);
  ok('  screenshot', !!insp.dataUrl && insp.dataUrl.startsWith('data:image/'),
     `len=${(insp.dataUrl||'').length}`);
  ok('  landmarks',  Array.isArray(insp.landmarks) && insp.landmarks.length > 0,
     `${(insp.landmarks||[]).length} elements`);

  // Step 4 — Click at the simulated MiniMax coordinate (500, 500).
  // Per the validation matrix: a red anchor dot must be drawn on
  // the page AND an authentic click must fire. The exact element
  // the click lands on depends on the page, so we don't assert on
  // a specific handler — we assert on the action's response and
  // a DOM probe of the anchor overlay.
  step(4, 'Click @ (500, 500) — red anchor + trusted click');
  // Snapshot the page for the anchor check.
  const preAnchor = await call('evaluate', { script: 'document.querySelectorAll(".__agent_browser_anchor__").length' });
  const click = await call('click', { x: CLICK_X, y: CLICK_Y });
  ok('click ok', click.ok, `trusted=${click.trusted} tag=${click.tag || ''}`);
  await new Promise((r) => setTimeout(r, 100));
  const postAnchor = await call('evaluate', { script: 'document.querySelectorAll(".__agent_browser_anchor__").length' });
  ok('  red anchor dot appeared',
     (postAnchor.result || 0) >= 1,
     `count ${preAnchor.result || 0} → ${postAnchor.result || 0}`);

  // Step 5 — Type at the text input landmark. First click on the
  // input so it's focused, then send the type action. This mirrors
  // real-world usage: an agent always clicks before it types.
  step(5, 'Type — click #text-input, then clear + char-by-char');
  const ti = (insp.landmarks || []).find((l) => l.id === 'text-input');
  if (!ti) {
    ok('  text-input landmark found', false, 'missing');
  } else {
    const tx = Math.round((ti.rect.x + ti.rect.w / 2) / insp.width  * 1000);
    const ty = Math.round((ti.rect.y + ti.rect.h / 2) / insp.height * 1000);
    // Focus the input first
    const focus = await call('click', { x: tx, y: ty });
    ok('  focus click on #text-input', focus.ok);
    await new Promise((r) => setTimeout(r, 200));
    const typeRes = await call('type', { x: tx, y: ty, text: TYPE_TEXT });
    ok('type ok', typeRes.ok, `cleared=${typeRes.cleared} chars=${typeRes.charCount}`);
    await new Promise((r) => setTimeout(r, 400));
    const v = await call('evaluate', { script: 'window.__test.getInputValue()' });
    ok('  value matches', v.result === TYPE_TEXT, `value="${v.result}"`);
  }

  // Summary
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(' 3-step MiniMax action chain complete');
  console.log('═══════════════════════════════════════════════════════════');
  ws.close();
}

main().catch((e) => { console.error('fatal:', e); process.exit(1); });
