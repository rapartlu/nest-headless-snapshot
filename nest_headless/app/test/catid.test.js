'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { descriptor, cosine, DIMS, HIST } = require('../catid');

// a w x h RGB crop filled with one colour, optional per-pixel noise for texture
function crop(w, h, [r, g, b], noise = 0, seed = 1) {
  const buf = Buffer.alloc(w * h * 3);
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff - 0.5; };
  for (let i = 0; i < w * h; i++) {
    const k = noise ? rnd() * noise : 0;
    buf[i * 3] = Math.max(0, Math.min(255, r + k)); buf[i * 3 + 1] = Math.max(0, Math.min(255, g + k)); buf[i * 3 + 2] = Math.max(0, Math.min(255, b + k));
  }
  return buf;
}

test('descriptor has the documented layout and separates a black cat from a ginger one', () => {
  const black = descriptor(crop(120, 100, [25, 22, 20]), 120, 100, { w: 0.2, h: 0.15 });
  const ginger = descriptor(crop(120, 100, [210, 120, 40]), 120, 100, { w: 0.2, h: 0.15 });
  assert.strictEqual(black.vec.length, DIMS);
  assert.ok(black.sized && ginger.sized);
  assert.ok(black.vec[HIST] > 0.4, 'dark fraction high for a black crop');
  assert.ok(ginger.vec[HIST + 1] > 0.4, 'ginger fraction high for an orange crop');
  assert.ok(cosine(black.vec, ginger.vec) < 0.5, `black vs ginger should be far apart (${cosine(black.vec, ginger.vec).toFixed(2)})`);
  assert.ok(cosine(black.vec, black.vec) > 0.999);
});

test('size and fluff tell two ginger cats apart; an unsized sample compares on colour only', () => {
  const big = descriptor(crop(200, 160, [210, 120, 40], 10, 3), 200, 160, { w: 0.30, h: 0.25 });
  const small = descriptor(crop(200, 160, [210, 120, 40], 10, 3), 200, 160, { w: 0.10, h: 0.08 });
  const fluffy = descriptor(crop(200, 160, [210, 120, 40], 90, 7), 200, 160, { w: 0.10, h: 0.08 });
  const same = descriptor(crop(200, 160, [210, 120, 40], 10, 3), 200, 160, { w: 0.10, h: 0.08 });
  assert.ok(cosine(small.vec, same.vec) > cosine(small.vec, big.vec), 'same size should match better than a much bigger cat');
  assert.ok(cosine(small.vec, same.vec) > cosine(small.vec, fluffy.vec), 'same texture should match better than a fluffier coat');
  const photo = descriptor(crop(300, 300, [210, 120, 40], 10, 3), 300, 300, null);
  assert.strictEqual(photo.sized, false);
  const c = cosine(small.vec, photo.vec, true, photo.sized);
  assert.ok(c > 0.95, `colour-only comparison should be close (${c.toFixed(3)})`);
});
