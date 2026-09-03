'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { FrameRing, stampOf, parseStamp, parseTime, nearestName } = require('../evidence');

test('FrameRing keeps the newest frames and finds the nearest by time', () => {
  const r = new FrameRing(3);
  for (let i = 1; i <= 5; i++) r.push(i * 1000, Buffer.from('f' + i));
  assert.strictEqual(r.items.length, 3);
  assert.strictEqual(r.latest().t, 5000);
  const n = r.nearest(3900);
  assert.strictEqual(n.t, 4000); assert.strictEqual(n.dt, 100); assert.strictEqual(n.jpg.toString(), 'f4');
  r.push(5000, Buffer.from('dup'));   // same time: ignored
  assert.strictEqual(r.items.length, 3);
});

test('stamps round-trip and times parse in every accepted form', () => {
  const t = Date.parse('2026-09-03T16:24:52.317Z');
  assert.strictEqual(stampOf(t), '2026-09-03T16-24-52-317Z');
  assert.strictEqual(parseStamp(stampOf(t) + '.jpg'), t);
  assert.strictEqual(parseStamp('timeline.json'), null);
  assert.strictEqual(parseTime('2026-09-03T16:24:52.317Z.jpg'), t);
  assert.strictEqual(parseTime('2026-09-03T16-24-52-317Z'), t);
  assert.strictEqual(parseTime(String(t)), t);
  assert.strictEqual(parseTime(String(Math.floor(t / 1000))), Math.floor(t / 1000) * 1000);
  assert.strictEqual(parseTime('yesterday'), null);
});

test('nearestName skips annotated copies and non-stamped files', () => {
  const names = ['2026-09-03T16-24-50-000Z.jpg', '2026-09-03T16-24-50-000Z_a.jpg', '2026-09-03T16-24-53-000Z_f.jpg', '2026-09-03T16-24-56-000Z.jpg', 'timeline.json'];
  const t = Date.parse('2026-09-03T16:24:54.000Z');
  assert.strictEqual(nearestName(names, t).name, '2026-09-03T16-24-56-000Z.jpg');
  assert.strictEqual(nearestName(names, t, { raw: false }).name, '2026-09-03T16-24-53-000Z_f.jpg');
  assert.strictEqual(nearestName(['timeline.json'], t), null);
});
