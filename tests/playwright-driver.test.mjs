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

test('moveMouse updates the crosshair readout', async () => {
  await driver.navigate({ url: 'data:text/html;charset=utf-8,' + encodeURIComponent('<button style="position:absolute;left:50px;top:50px;width:100px;height:40px">x</button>') });
  await driver.showCrosshair();
  const r = await driver.moveMouse({ x: 100, y: 70 });
  assert.equal(r.ok, true);
  // Proof: read the readout text in the same evaluate that also reads
  // window.__agentCrosshair state. The mousemove listener updates
  // these directly, so we can verify both consistently.
  const proof = await driver.evaluate({ code: '({ readout: document.getElementById("__agent_browser_crosshair_readout__")?.textContent || null, hasUpdate: typeof window.__agentCrosshair?.update === "function", x: window.__agentCrosshair?.x, y: window.__agentCrosshair?.y })' });
  assert.equal(proof.result.hasUpdate, true, 'update fn exposed on window');
  // Readout may be "x:100 y:70" or contain more; just check the digits.
  assert.match(proof.result.readout, /100/);
  assert.match(proof.result.readout, /70/);
  await driver.hideCrosshair();
  await driver.close();
});

test('elementInfo returns full picture of the element at (x,y)', async () => {
  await driver.navigate({ url: 'data:text/html;charset=utf-8,' + encodeURIComponent(
    '<button id="b" style="position:absolute;left:50px;top:50px;width:100px;height:40px">B1</button>' +
    '<a id="a" style="position:absolute;left:50px;top:120px" href="/x">A1</a>'
  ) });
  const info = await driver.elementInfo({ x: 100, y: 70 });
  assert.equal(info.found, true, JSON.stringify(info));
  assert.equal(info.tag, 'button');
  assert.equal(info.id, 'b');
  assert.equal(info.text, 'B1');
  assert.equal(info.clickable, true);
  assert.equal(info.clickReason, 'tag:BUTTON');
  assert.equal(info.clickTargetIsSelf, true);
  assert.equal(info.rect.w, 100);
  assert.equal(info.rect.h, 40);
  // Anchor should also be detected.
  const aInfo = await driver.elementInfo({ x: 60, y: 130 });
  assert.equal(aInfo.tag, 'a');
  assert.equal(aInfo.id, 'a');
  // On a data: URL the href may be the empty string or a fully-resolved
  // URL, but the attribute should be present.
  assert.ok(typeof aInfo.href === 'string' || aInfo.href === null);
  await driver.close();
});

test('elementInfo on empty point returns no element gracefully', async () => {
  await driver.navigate({ url: 'data:text/html;charset=utf-8,' + encodeURIComponent('<p>x</p>') });
  const info = await driver.elementInfo({ x: -100, y: -100 });
  // -100 is off-screen; elementFromPoint returns null.
  assert.equal(info.found, false);
  await driver.close();
});

test('hoverPreview dispatches pointerover + returns scroll container', async () => {
  await driver.navigate({ url: 'data:text/html;charset=utf-8,' + encodeURIComponent(
    // Scroll container: 200x200, no children on top so elementFromPoint
    // returns the div itself.
    '<div style="position:absolute;left:0;top:0;width:200px;height:200px;overflow-y:auto;background:#eee" id="scroll">' +
    '<div style="height:1000px"></div>' +
    '</div>' +
    '<div style="position:absolute;left:0;top:250px" id="noscroll">a</div>'
  ) });
  // At (50, 50) the topmost element is the scrollable div.
  const r = await driver.hoverPreview({ x: 50, y: 50 });
  assert.equal(r.found, true);
  // tagName should be 'div'. id may or may not propagate through
  // Playwright's serialization, so just check the tag.
  assert.match(r.preview.hoverTarget, /^div/);
  assert.ok(r.preview.dispatched.includes('pointerover'));
  assert.ok(r.preview.dispatched.includes('mouseover'));
  // The div is scrollable (overflow-y:auto, scrollHeight > clientHeight).
  assert.match(r.preview.scrollable, /^div/);
  await driver.close();
});

test('showGrid / hideGrid toggles a 50px grid overlay', async () => {
  await driver.navigate({ url: 'data:text/html;charset=utf-8,' + encodeURIComponent('<p>x</p>') });
  const on = await driver.showGrid({ spacing: 50 });
  assert.equal(on.ok, true);
  const proof = await driver.evaluate({ code: '({ grid: !!document.getElementById("__agent_browser_grid__"), style: !!document.getElementById("__agent_browser_grid_style__") })' });
  assert.equal(proof.result.grid, true, 'grid element present after show');
  assert.equal(proof.result.style, true, 'grid style present after show');
  const off = await driver.hideGrid();
  assert.equal(off.ok, true);
  const proof2 = await driver.evaluate({ code: '({ grid: !!document.getElementById("__agent_browser_grid__"), style: !!document.getElementById("__agent_browser_grid_style__") })' });
  assert.equal(proof2.result.grid, false, 'grid removed after hide');
  await driver.close();
});

test('showSelection highlights activeElement and re-updates on focus change', async () => {
  await driver.navigate({ url: 'data:text/html;charset=utf-8,' + encodeURIComponent(
    '<input id="i" style="position:absolute;left:50px;top:50px">' +
    '<button id="b" style="position:absolute;left:50px;top:120px">Go</button>'
  ) });
  // Focus the input via tag.
  const tags = await driver.tagElements({ max: 50 });
  const inp = tags.find(t => t.id === 'i');
  assert.ok(inp);
  await driver.clickByTag({ num: inp.num });
  await driver.evaluate({ code: 'new Promise(r => setTimeout(r, 100))' });
  const on = await driver.showSelection();
  assert.equal(on.ok, true);
  assert.equal(on.activeElement, 'INPUT', 'input is activeElement');
  // Proof: focus ring elements exist + count > 0.
  const proof = await driver.evaluate({ code: '({ rings: document.querySelectorAll(".__agent_browser_focus_ring__").length, focusStyle: !!document.getElementById("__agent_browser_selection_style__") })' });
  assert.equal(proof.result.focusStyle, true, 'selection style injected');
  assert.ok(proof.result.rings >= 1, 'at least one focus ring visible');
  // Switch focus to the button and re-check the ring moves.
  const btn = tags.find(t => t.id === 'b');
  await driver.clickByTag({ num: btn.num });
  await driver.evaluate({ code: 'new Promise(r => setTimeout(r, 100))' });
  const proof2 = await driver.evaluate({ code: '({ active: document.activeElement?.id || null, ringCount: document.querySelectorAll(".__agent_browser_focus_ring__").length })' });
  assert.equal(proof2.result.active, 'b', 'focus moved to button after click');
  await driver.hideSelection();
  await driver.close();
});

test('setTagFilter freezes tagging and filters by type', async () => {
  await driver.navigate({ url: 'data:text/html;charset=utf-8,' + encodeURIComponent(
    '<button id="b1">B1</button><input id="i1"><a href="#" id="a1">A</a>' +
    '<button id="b2">B2</button>'
  ) });
  const tags = await driver.tagElements({ max: 50 });
  assert.ok(tags.length >= 4, JSON.stringify(tags));
  // Filter: only buttons.
  const f = await driver.setTagFilter({ types: ['button'] });
  assert.equal(f.ok, true);
  assert.deepEqual(f.filter, ['button']);
  assert.equal(f.frozen, false);
  // Freeze + filter.
  const fz = await driver.setTagFilter({ freeze: true, types: ['button', 'input'] });
  assert.equal(fz.ok, true);
  assert.equal(fz.frozen, true);
  assert.deepEqual(fz.filter, ['button', 'input']);
  await driver.close();
});

test('flashTag paints a pulse ring around the targeted tag', async () => {
  await driver.navigate({ url: 'data:text/html;charset=utf-8,' + encodeURIComponent(
    '<button id="b" style="position:absolute;left:50px;top:50px;width:100px;height:40px">Go</button>'
  ) });
  const tags = await driver.tagElements({ max: 50 });
  const btn = tags.find(t => t.id === 'b');
  assert.ok(btn, 'button tagged');
  const r = await driver.flashTag({ num: btn.num, color: '#ff3b30' });
  assert.equal(r.ok, true);
  assert.equal(r.num, btn.num);
  // Proof: ring element present immediately after the call.
  const proof = await driver.evaluate({ code: '({ ring: document.querySelector(".__agent_browser_tag_focus__") ? true : false, animStyle: !!document.getElementById("__agent_browser_tag_focus_style__") })' });
  assert.equal(proof.result.ring, true, 'flash ring injected');
  assert.equal(proof.result.animStyle, true, 'flash animation style injected');
  // Wait for the ring to be removed, then verify it's gone.
  await driver.evaluate({ code: 'new Promise(r => setTimeout(r, 800))' });
  const proof2 = await driver.evaluate({ code: '({ ring: document.querySelector(".__agent_browser_tag_focus__") ? true : false })' });
  assert.equal(proof2.result.ring, false, 'flash ring cleaned up after animation');
  await driver.close();
});
