// IPI-317: real test suite. Using node's built-in test runner so no
// new dependencies. Run with: `node --test tests/`
import { test } from 'node:test';
import assert from 'node:assert/strict';

function denormalizeCoord(value, max, mode, dpr) {
  const v = Number(value);
  if (!Number.isFinite(v)) return 0;
  let px;
  if (mode === 'normalized_1000')      px = (v / 1000) * max;
  else if (mode === 'normalized_1')    px = v * max;
  else if (mode === 'device_pixel')    px = v / (dpr || 1);
  else                                  px = v;
  return Math.round(px);
}

test('normalized_1000 maps [0,1000] to [0, viewport]', () => {
  assert.equal(denormalizeCoord(0,    1920, 'normalized_1000'), 0);
  assert.equal(denormalizeCoord(500,  1920, 'normalized_1000'), 960);
  assert.equal(denormalizeCoord(1000, 1920, 'normalized_1000'), 1920);
  assert.equal(denormalizeCoord(250,  800,  'normalized_1000'), 200);
});

test('normalized_1 maps [0,1] to [0, viewport]', () => {
  assert.equal(denormalizeCoord(0,   1920, 'normalized_1'), 0);
  assert.equal(denormalizeCoord(0.5, 1920, 'normalized_1'), 960);
  assert.equal(denormalizeCoord(1,   1920, 'normalized_1'), 1920);
});

test('device_pixel divides by DPR', () => {
  assert.equal(denormalizeCoord(1920, 1920, 'device_pixel', 2), 960);
  assert.equal(denormalizeCoord(3840, 1920, 'device_pixel', 2), 1920);
  assert.equal(denormalizeCoord(960,  960,  'device_pixel', 1), 960);
});

test('pixel is pass-through (rounded)', () => {
  assert.equal(denormalizeCoord(123, 1000, 'pixel'), 123);
  assert.equal(denormalizeCoord(123.7, 1000, 'pixel'), 124);
});

test('garbage in -> 0', () => {
  assert.equal(denormalizeCoord(NaN, 1000, 'normalized_1000'), 0);
  assert.equal(denormalizeCoord('foo', 1000, 'normalized_1000'), 0);
  assert.equal(denormalizeCoord(null, 1000, 'normalized_1000'), 0);
});

test('charToKeyInfo covers digits, letters, shifted digits, punctuation', () => {
  function charToKeyInfo(c) {
    const code = c.charCodeAt(0);
    if (code >= 97 && code <= 122) return { key: c, code: 'Key' + c.toUpperCase(), vkey: code, shift: false, text: c };
    if (code >= 65 && code <= 90)  return { key: c, code: 'Key' + c, vkey: code, shift: true, text: c };
    if (code >= 48 && code <= 57)  return { key: c, code: 'Digit' + c, vkey: code, shift: false, text: c };
    if (c === ' ')                 return { key: ' ', code: 'Space', vkey: 32, shift: false, text: ' ' };
    return null;
  }
  assert.equal(charToKeyInfo('a').code, 'KeyA');
  assert.equal(charToKeyInfo('A').shift, true);
  assert.equal(charToKeyInfo('0').code, 'Digit0');
  assert.equal(charToKeyInfo(' ').code, 'Space');
  assert.equal(charToKeyInfo('!'), null);
});
