// The cat descriptor stamps its own version, and that stamp has to survive the
// trip through the pending backlog. It did not: `pending.add` kept the
// embedding but not `v`, `sized` or `box`, the record written at labelling time
// therefore had no version, and `loadEnrolled` reads a missing version as v1.
// 36 samples - two thirds of one cat's gallery and five eighths of another's -
// were current v2 descriptors retired for a missing field.
const assert = require('node:assert');
const { test, after } = require('node:test');
const catid = require('../catid.js');

// a tiny synthetic frame: interleaved RGB, one flat colour
const solid = (w, h, [r, g, b]) => {
  const buf = Buffer.alloc(w * h * 3);
  for (let i = 0; i < w * h; i++) { buf[i * 3] = r; buf[i * 3 + 1] = g; buf[i * 3 + 2] = b; }
  return buf;
};

test('descriptor stamps the current version', () => {
  const d = catid.descriptor(solid(32, 32, [120, 80, 40]), 32, 32, { w: 0.1, h: 0.1 });
  assert.strictEqual(d.v, catid.VERSION, 'descriptor must carry its own version');
  assert.strictEqual(typeof d.v, 'number');
});

test('sized says whether the frame gave the descriptor a box', () => {
  const raw = solid(32, 32, [120, 80, 40]);
  assert.strictEqual(catid.descriptor(raw, 32, 32, { w: 0.1, h: 0.1 }).sized, true);
  assert.strictEqual(catid.descriptor(raw, 32, 32, null).sized, false, 'no frame context -> unsized');
  assert.strictEqual(catid.descriptor(raw, 32, 32, { w: 0, h: 0 }).sized, false, 'a zero box is not a box');
});

test('the vector is the declared width whether sized or not', () => {
  const raw = solid(32, 32, [200, 200, 200]);
  for (const box of [{ w: 0.2, h: 0.3 }, null]) {
    const d = catid.descriptor(raw, 32, 32, box);
    assert.strictEqual(d.vec.length, catid.DIMS);
  }
});

test('an unstamped record is indistinguishable from a v1 one, which is the trap', () => {
  // This is the semantics of loadEnrolled's `v: j.v || 1`. It is correct as a
  // default - a record written before versioning really is v1 - which is
  // exactly why the writer must stamp rather than the reader guess.
  const asLoaded = (j) => ({ v: j.v || 1, sized: j.sized !== false });
  assert.strictEqual(asLoaded({ embedding: [] }).v, 1, 'no version reads as v1');
  assert.strictEqual(asLoaded({ embedding: [], v: catid.VERSION }).v, catid.VERSION);
  // and a missing `sized` reads as sized, so dropping it silently flips meaning
  assert.strictEqual(asLoaded({ embedding: [] }).sized, true);
  assert.strictEqual(asLoaded({ embedding: [], sized: false }).sized, false);
});

// --- the store in the middle, which is where 1.30.1's fix went missing ---
// `pending.add` builds its metadata from an explicit whitelist rather than a
// spread, so a field a caller adds is dropped unless it is named there. In
// 1.30.1 the call site was updated and the consumer was updated and this was
// not, so the change was a no-op: a cat candidate written that evening still
// had no box, no sized and no v. Verified against a real backlog entry.
const fs = require('node:fs');
const path = require('node:path');
const { PendingStore } = require('../pending.js');
fs.mkdirSync(path.join(__dirname, '.tmp'), { recursive: true });
// each file removes only its own directories - see the note in diskq.test.js
const made = [];
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

test('the pending store carries box, sized and v for a cat', async () => {
  const dir = fs.mkdtempSync(path.join(__dirname, '.tmp', 'pending-')); made.push(dir);
  const store = new PendingStore(dir);
  const meta = store.add({
    kind: 'cat', camera: 'kitchen_camera', t: new Date().toISOString(),
    quality: { size_px: 90 }, matches: [], size_px: 90,
    embedding: [1, 2, 3], box: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 }, sized: true, v: catid.VERSION,
    media: { buf: Buffer.from('x'), ext: 'jpg' },
  });
  assert.deepStrictEqual(meta.box, { x: 0.1, y: 0.2, w: 0.3, h: 0.4 }, 'box must survive the store');
  assert.strictEqual(meta.sized, true);
  assert.strictEqual(meta.v, catid.VERSION);
});

test('a face entry keeps its old shape - the new fields are only added when given', () => {
  const dir = fs.mkdtempSync(path.join(__dirname, '.tmp', 'pending-')); made.push(dir);
  const store = new PendingStore(dir);
  const meta = store.add({
    kind: 'face', camera: 'kitchen_camera', t: new Date().toISOString(),
    quality: {}, matches: [], size_px: 40, embedding: [1],
    media: { buf: Buffer.from('x'), ext: 'jpg' },
  });
  assert.ok(!('box' in meta), 'no box key when the caller gave none');
  assert.ok(!('sized' in meta), 'no sized key when the caller gave none');
  assert.ok(!('v' in meta), 'no v key when the caller gave none');
});

// --- the in-memory index must carry the version too (#23, third pass) ---
// The disk record was correct and the index dropped a field. currentCats()
// filters on `v`, so a cat labelled from the backlog entered the gallery with
// v undefined and was retired on arrival - invisible to matching until the next
// restart, when loadEnrolled re-read the file and supplied the field itself.
// Masked in practice because deploys restart the process often.
test('an item built for the in-memory index carries v and sized', () => {
  // mirrors sampleItem's contract without reaching into server.js
  const sampleItem = (file, j) => ({
    embedding: j.embedding, file, at: j.at, pose: j.pose || null, auto: !!j.auto,
    sized: j.sized !== false, v: j.v || 1,
    source: j.source || (String(j.camera || '').startsWith('camera.') ? 'room' : 'upload'),
  });
  const fresh = sampleItem('cat-x.json', { embedding: [1], at: 'now', v: catid.VERSION, sized: true, camera: 'camera.kitchen' });
  assert.strictEqual(fresh.v, catid.VERSION, 'a current sample must survive the currentCats filter');
  assert.strictEqual(fresh.sized, true);
  assert.strictEqual(fresh.source, 'room');

  // a legacy record with no version still defaults to 1, as loadEnrolled did
  const legacy = sampleItem('cat-y.json', { embedding: [1], at: 'then', camera: 'upload' });
  assert.strictEqual(legacy.v, 1);
  assert.strictEqual(legacy.sized, true, 'absent sized means sized, matching the loader');
  assert.strictEqual(legacy.source, 'upload');
});

test('currentCats-style filtering keeps a fresh sample and drops a v1 one', () => {
  const items = [{ v: catid.VERSION }, { v: 1 }, { v: undefined }];
  const current = items.filter((it) => it.v === catid.VERSION);
  assert.strictEqual(current.length, 1, 'only the current-version sample survives');
  // the bug: an item with v undefined is indistinguishable from a v1 one
  assert.ok(!items[2].v, 'and an item that never carried v looks exactly like the old ones');
});
