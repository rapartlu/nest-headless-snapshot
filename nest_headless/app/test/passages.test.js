// node --test app/test/passages.test.js
const test = require('node:test');
const assert = require('node:assert');
const { parseWatchPassages, PassageTracker } = require('../passages');

const SPEC = 'hall:toilet@0.60,0.55:0.72,0.55:0.72,0.70:0.60,0.70|in=0.66,0.30;line@0.10,0.50:0.30,0.50:0.30,0.60:0.10,0.60';
const box = (fx, fy, h = 0.4) => ({ box: { x: fx - 0.05, y: fy - h, w: 0.10, h }, conf: 0.9 });

test('parses polygons, inside points and centroids', () => {
  const p = parseWatchPassages(SPEC)['camera.hall'];
  assert.strictEqual(p.length, 2);
  assert.deepStrictEqual(p[0].inside, [0.66, 0.30]);
  assert.strictEqual(p[1].inside, null);
  assert.ok(Math.abs(p[0].centroid[0] - 0.66) < 1e-9);
});

test('walking into the doorway and vanishing is "in"', () => {
  const tr = new PassageTracker('camera.hall', parseWatchPassages(SPEC)['camera.hall']);
  let t = 1000, ev = [];
  for (const fy of [0.85, 0.78, 0.66, 0.62]) { ev.push(...tr.update([box(0.66, fy)], [], t)); t += 1000; }
  for (let i = 0; i < 6; i++) { ev.push(...tr.update([], [], t)); t += 1000; }
  assert.deepStrictEqual(ev.map((e) => e.direction + ' ' + e.passage), ['in toilet']);
  assert.match(ev[0].track_id, /^hall-\d{8}-\d{6}$/);
});

test('emerging from the doorway with a bag is "out", carrying=bag', () => {
  const tr = new PassageTracker('camera.hall', parseWatchPassages(SPEC)['camera.hall']);
  let t = 1000, ev = [];
  const bag = { box: { x: 0.63, y: 0.5, w: 0.05, h: 0.1 } };
  for (const fy of [0.64, 0.68, 0.76, 0.86]) { ev.push(...tr.update([box(0.66, fy)], [bag], t)); t += 1000; }
  assert.strictEqual(ev.length, 1);
  assert.strictEqual(ev[0].direction, 'out');
  assert.strictEqual(ev[0].attributes.carrying, 'bag');
});

test('stepping in and turning back posts nothing', () => {
  const tr = new PassageTracker('camera.hall', parseWatchPassages(SPEC)['camera.hall']);
  let t = 1000, ev = [];
  for (const fy of [0.85, 0.66, 0.85, 0.90]) { ev.push(...tr.update([box(0.66, fy)], [], t)); t += 1000; }
  assert.strictEqual(ev.length, 0);
});

test('a line zone without an inside point reports "across"', () => {
  const tr = new PassageTracker('camera.hall', parseWatchPassages(SPEC)['camera.hall']);
  let t = 1000, ev = [];
  for (const fy of [0.45, 0.55, 0.66]) { ev.push(...tr.update([box(0.20, fy, 0.3)], [], t)); t += 1000; }
  assert.deepStrictEqual(ev.map((e) => e.direction + ' ' + e.passage), ['across line']);
});
