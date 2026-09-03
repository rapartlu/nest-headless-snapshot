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

// a margin crop: grey worktop everywhere, a cat-coloured blob filling the detection box in the centre
function scene(w, h, cat, margin = 0.25, noise = 0, seed = 5) {
  const buf = crop(w, h, [150, 150, 150], noise, seed);
  const f = 1 / (1 + 2 * margin), bx0 = Math.round(w * (1 - f) / 2), by0 = Math.round(h * (1 - f) / 2), bw = Math.round(w * f), bh = Math.round(h * f);
  for (let y = by0; y < by0 + bh; y++) for (let x = bx0; x < bx0 + bw; x++) { const i = (y * w + x) * 3; buf[i] = cat[0]; buf[i + 1] = cat[1]; buf[i + 2] = cat[2]; }
  return buf;
}

test('the surroundings are subtracted: a small cat on a grey worktop is described by its coat', () => {
  const black = descriptor(scene(90, 75, [25, 22, 20]), 90, 75, { w: 0.05, h: 0.04 });
  const ginger = descriptor(scene(90, 75, [210, 120, 40]), 90, 75, { w: 0.05, h: 0.04 });
  const c = cosine(black.vec, ginger.vec);
  assert.ok(c < 0.6, `a black and a ginger cat on the same worktop must not look alike (${c.toFixed(3)})`);
  assert.ok(black.vec[HIST] > 0.5 && ginger.vec[HIST + 1] > 0.5, 'coat fractions come from the box, not the worktop');
  assert.strictEqual(black.v, 2);
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
