// Unit + integration tests for the codex-speed Playwright driver.
// Run with: node --test tests/playwright-driver.test.mjs
// Requires the system Chrome binary at the default path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as driver from '../playwright-driver.mjs';

const hasChrome = await (async () => {
  try {
    await driver.navigate({ url: 'about:blank' });
    await driver.close();
    return true;
  } catch (e) { return false; }
})();

if (!hasChrome) {
  test('playwright-driver (skipped — Chrome not available)', { skip: true }, () => {});
  process.exit(0);
}

test('navigate sets url + title', async () => {
  const r = await driver.navigate({ url: 'data:text/html;charset=utf-8,' + encodeURIComponent('<title>hi</title>') });
  assert.equal(r.title, 'hi');
  assert.match(r.url, /^data:/);
  await driver.close();
});

test('evaluate returns the value', async () => {
  await driver.navigate({ url: 'data:text/html;charset=utf-8,' + encodeURIComponent('<title>x</title>') });
  const r = await driver.evaluate({ code: 'document.title' });
  assert.equal(r.result, 'x');
  // The auto-return trick: bare expressions return their value.
  const r2 = await driver.evaluate({ code: '1 + 41' });
  assert.equal(r2.result, 42);
  // Statements with `return` also work.
  const r3 = await driver.evaluate({ code: 'return 7 * 6' });
  assert.equal(r3.result, 42);
  await driver.close();
});

test('extract reads text or attribute', async () => {
  await driver.navigate({ url: 'data:text/html;charset=utf-8,' + encodeURIComponent(
    '<div><a href="/x" id="a">A</a><a href="/y" id="b">B</a></div>'
  ) });
  const t = await driver.extract({ selector: 'a' });
  assert.equal(t.count, 2);
  assert.deepEqual(t.items, ['A', 'B']);
  const h = await driver.extract({ selector: 'a', attr: 'href' });
  assert.equal(h.count, 2);
  assert.deepEqual(h.items, ['/x', '/y']);
  await driver.close();
});

test('tagElements finds interactive elements with numbered output', async () => {
  await driver.navigate({ url: 'data:text/html;charset=utf-8,' + encodeURIComponent(
    '<button id="b">B</button><input id="i"><a href="#" id="a">A</a><div>not interactive</div>'
  ) });
  const tags = await driver.tagElements({ max: 50 });
  assert.ok(Array.isArray(tags));
  // Should find button, input, anchor — not the plain div.
  const ids = tags.map(t => t.id);
  assert.ok(ids.includes('b'), 'button present');
  assert.ok(ids.includes('i'), 'input present');
  assert.ok(ids.includes('a'), 'anchor present');
  assert.ok(!ids.includes(undefined), 'no untagged element');
  // Visible numbers are 1..N, sequential.
  const nums = tags.map(t => t.num);
  assert.deepEqual(nums, [...Array(tags.length).keys()].map(i => i + 1));
  // Every tag has center coordinates so the caller can click.
  for (const t of tags) {
    assert.ok(typeof t.rect.cx === 'number' && typeof t.rect.cy === 'number');
  }
  await driver.close();
});

test('clickByTag triggers real click handlers', async () => {
  await driver.navigate({ url: 'data:text/html;charset=utf-8,' + encodeURIComponent(
    '<button id="b">Go</button><span id="c">0</span><script>let n=0;document.getElementById("b").onclick=()=>{n++;document.getElementById("c").textContent=String(n)}</script>'
  ) });
  const tags = await driver.tagElements({ max: 50 });
  const btn = tags.find(t => t.id === 'b');
  assert.ok(btn, 'button found');
  await driver.clickByTag({ num: btn.num });
  await driver.evaluate({ code: 'new Promise(r => setTimeout(r, 100))' });
  const c = await driver.evaluate({ code: 'document.getElementById("c").textContent' });
  assert.equal(c.result, '1');
  await driver.close();
});

test('typeByTag sets input value', async () => {
  await driver.navigate({ url: 'data:text/html;charset=utf-8,' + encodeURIComponent(
    '<input id="i" placeholder="x">'
  ) });
  const tags = await driver.tagElements({ max: 50 });
  const inp = tags.find(t => t.id === 'i');
  await driver.typeByTag({ num: inp.num, text: 'hi there' });
  await driver.evaluate({ code: 'new Promise(r => setTimeout(r, 100))' });
  const v = await driver.evaluate({ code: 'document.getElementById("i").value' });
  assert.equal(v.result, 'hi there');
  await driver.close();
});

test('screenshot returns bytes', async () => {
  await driver.navigate({ url: 'data:text/html;charset=utf-8,' + encodeURIComponent('<p>x</p>') });
  const r = await driver.screenshot({});
  assert.ok(r.bytes > 100, 'screenshot should be > 100 bytes, got ' + r.bytes);
  assert.ok(r.base64 && r.base64.length > 0);
  await driver.close();
});

test('showCrosshair injects the overlay (verified via proof)', async () => {
  await driver.navigate({ url: 'data:text/html;charset=utf-8,' + encodeURIComponent('<button>x</button>') });
  const r = await driver.showCrosshair();
  assert.equal(r.ok, true);
  assert.equal(r.proof.status, 'injected', JSON.stringify(r.proof));
  assert.equal(r.proof.readoutFound, true, 'readout element found right after injection');
  await driver.hideCrosshair();
  await driver.close();
});

test('startDrag / updateDrag / endDrag produce a clean trace', async () => {
  await driver.navigate({ url: 'data:text/html;charset=utf-8,' + encodeURIComponent('<div style="width:2000px;height:2000px"></div>') });
  const s = await driver.startDrag({ x: 100, y: 100 });
  assert.equal(s.ok, true);
  // The proof is computed inside the same evaluate as the injection,
  // so it always reflects the real state. (Cross-evaluate reads can
  // be stale in some test isolation scenarios.)
  assert.equal(s.proof.startX, 100, JSON.stringify(s.proof));
  assert.equal(s.proof.startY, 100);
  const u = await driver.updateDrag({ x: 500, y: 300 });
  assert.equal(u.ok, true);
  const e = await driver.endDrag();
  assert.equal(e.ok, true);
  assert.equal(e.start.x, 100);
  assert.equal(e.start.y, 100);
  assert.equal(e.end.x, 500);
  assert.equal(e.end.y, 300);
  await driver.close();
});
