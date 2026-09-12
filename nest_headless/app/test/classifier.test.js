'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const jpeg = require('jpeg-js');

// the classifier resolves its models dir from HA_CONFIG_DIR at load time
const cfgDir = fs.mkdtempSync(path.join((() => { try { fs.mkdirSync(os.tmpdir(), { recursive: true }); return os.tmpdir(); } catch (e) { const d = path.join(__dirname, '.tmp'); fs.mkdirSync(d, { recursive: true }); return d; } })(), 'cls-'));
process.env.HA_CONFIG_DIR = cfgDir;
fs.mkdirSync(path.join(cfgDir, 'nest_models'), { recursive: true });
const { classify } = require('../classifier');

const W = 4, H = 4, D = W * H;
function greyJpeg(level) {
  const data = Buffer.alloc(32 * 32 * 4);
  for (let i = 0; i < 32 * 32; i++) { data[i * 4] = level; data[i * 4 + 1] = level; data[i * 4 + 2] = level; data[i * 4 + 3] = 255; }
  return jpeg.encode({ data, width: 32, height: 32 }, 95).data;
}
const base = { width: W, height: H, subcrop: [0, 0, 1, 1], per_image_norm: false, mean: new Array(D).fill(0), std: new Array(D).fill(1), trained: '2026-09-03', loo_acc: 0.93 };

test('a multi-class model answers with one score per label that sums to one', () => {
  fs.writeFileSync(path.join(cfgDir, 'nest_models', 'cam__dishwasher_door.json'), JSON.stringify({
    ...base, labels: ['open', 'vent', 'closed'], weights: [new Array(D).fill(0), new Array(D).fill(0), new Array(D).fill(0)], bias: [0.1, 2.0, 0.3], samples: { open: 5, vent: 5, closed: 8 },
  }));
  const r = classify('camera.cam__dishwasher_door', greyJpeg(128));
  assert.ok(r, 'model loads');
  assert.strictEqual(r.label, 'vent');
  assert.deepStrictEqual(r.labels, ['open', 'vent', 'closed']);
  const sum = Object.values(r.scores).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 0.01, `scores should sum to 1 (${sum})`);
  assert.ok(r.scores.vent > 0.7 && r.positive === true);
  assert.strictEqual(r.loo_acc, 0.93);
});

test('a binary model keeps its shape', () => {
  fs.writeFileSync(path.join(cfgDir, 'nest_models', 'cam__door.json'), JSON.stringify({ ...base, label: 'door', weights: new Array(D).fill(0), bias: 1.5, threshold: 0.5 }));
  const r = classify('camera.cam__door', greyJpeg(200));
  assert.strictEqual(r.label, 'door');
  assert.ok(r.positive && r.score > 0.8 && !r.labels);
});

test.after(() => fs.rmSync(cfgDir, { recursive: true, force: true }));
