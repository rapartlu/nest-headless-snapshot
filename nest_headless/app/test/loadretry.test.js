'use strict';
// A model that fails to LOAD is not a model that is absent. Both used to be
// remembered for the life of the process, so one bad moment on the network
// share the models live on disabled face recognition until the next restart -
// silently, because a failure resolves to a falsy value rather than throwing.
// Same shape as the browser-launch bug in 1.31.1.
//
// faces.js caches its sessions in ONE module-level variable, not per directory,
// so each case here needs a fresh copy of the module. Without that the first
// test's answer is returned to the second and the second proves nothing - which
// is exactly what the first draft of this file did.
const assert = require('node:assert');
const { test, after } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const tmp = path.join(__dirname, '.tmp');
fs.mkdirSync(tmp, { recursive: true });
// each file removes only its own directories - see the note in diskq.test.js
const made = [];
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const mk = (p) => { const d = fs.mkdtempSync(p); made.push(d); return d; };
const freshFaces = () => { delete require.cache[require.resolve('../faces.js')]; return require('../faces.js'); };

test('absent models are answered false, and stay that way', async () => {
  const faces = freshFaces();
  const dir = mk(path.join(tmp, 'noface-'));
  assert.strictEqual(faces.hasModels(dir), false);
  assert.strictEqual(await faces.getSessions(dir), false);
  assert.strictEqual(await faces.getSessions(dir), false, 'absence is sticky - no point re-checking');
});

test('a model that fails to load is falsy, not a throw', async () => {
  const faces = freshFaces();
  const dir = mk(path.join(tmp, 'badface-'));
  fs.writeFileSync(path.join(dir, 'scrfd_10g.onnx'), 'not an onnx graph');
  fs.writeFileSync(path.join(dir, 'arcface_w600k_r50.onnx'), 'not an onnx graph');
  assert.strictEqual(faces.hasModels(dir), true, 'files present, so this is a load failure not an absence');
  const r = await faces.getSessions(dir);
  assert.ok(!r, 'every call site is `if (!s) return null` - a throw here would crash a capture');
});

test('a failed load is NOT remembered as a permanent absence', async () => {
  const faces = freshFaces();
  const dir = mk(path.join(tmp, 'recover-'));
  const det = path.join(dir, 'scrfd_10g.onnx'), rec = path.join(dir, 'arcface_w600k_r50.onnx');
  fs.writeFileSync(det, 'not an onnx graph');
  fs.writeFileSync(rec, 'not an onnx graph');
  await faces.getSessions(dir);
  // Before the fix this was `false` for ever. It must not be: `false` means
  // "there is no model here", which is a different and permanent claim.
  const second = await faces.getSessions(dir);
  assert.notStrictEqual(second, false, 'a transient load failure must not be recorded as absence');
});

test('facesInJpeg tolerates a falsy session rather than crashing a capture', async () => {
  const faces = freshFaces();
  const dir = mk(path.join(tmp, 'noface2-'));
  const r = await faces.facesInJpeg(dir, Buffer.from('not a jpeg'), { minPx: 40 });
  assert.strictEqual(r, null);
});

// --- the per-camera ONNX classifier honours its documented contract ---
// classifyDoor says "Returns { label, score, positive } or null when no model /
// failure", and every caller is written to that. getCls threw instead, so a
// corrupt or half-written model file rejected the zone tick rather than
// returning null. Retrained models are written to a share while the add-on is
// running, so a half-written file is a real state.
test('a corrupt classifier model gives null rather than throwing', async () => {
  delete require.cache[require.resolve('../infer.js')];
  const dir = mk(path.join(tmp, 'cls-'));
  fs.mkdirSync(path.join(dir, 'nest_models'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'nest_models', 'testcam.onnx'), 'not an onnx graph');
  const prev = process.env.HA_CONFIG_DIR;
  process.env.HA_CONFIG_DIR = dir;
  delete require.cache[require.resolve('../infer.js')];
  const infer = require('../infer.js');
  assert.strictEqual(infer.hasDoorModel('testcam'), true, 'the file is there, so this is a load failure');
  const r = await infer.classifyDoor('testcam', Buffer.from('not a jpeg'));
  assert.strictEqual(r, null, 'a failed load must be null, not a rejection into the zone tick');
  if (prev === undefined) delete process.env.HA_CONFIG_DIR; else process.env.HA_CONFIG_DIR = prev;
});
