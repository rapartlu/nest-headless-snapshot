'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { SegmentTracker } = require('../segments');

const chunk = (rms) => { const a = new Float32Array(4000); a.fill(rms); return a; };   // constant-level chunk: RMS == value
function feedMany(tr, levels, t0 = 1000000) {
  const out = [];
  levels.forEach((r, i) => { const s = tr.feed(chunk(r), r, t0 + i * 250); if (s) out.push(s); });
  return out;
}

test('silence never produces a segment', () => {
  const tr = new SegmentTracker();
  assert.deepStrictEqual(feedMany(tr, new Array(80).fill(0.003)), []);
});

test('a sentence becomes one segment with a pre-roll and voiced time', () => {
  const tr = new SegmentTracker();
  const levels = [...new Array(20).fill(0.003), ...new Array(8).fill(0.08), ...new Array(6).fill(0.003)];
  const segs = feedMany(tr, levels);
  assert.strictEqual(segs.length, 1);
  const s = segs[0];
  assert.strictEqual(s.voicedMs, 8 * 250);
  // 2 pre-roll + 8 voiced + 3 closing quiet chunks
  assert.strictEqual(s.chunks.length, 2 + 8 + 3);
  // detected on the chunk at index 21 (its arrival time marks its end), four chunks in the segment
  assert.strictEqual(s.startedMs, 1000000 + 21 * 250 - 4 * 250);
  assert.ok(s.floor >= 0.006 && s.floor <= 0.015);
});

test('a single loud chunk (a clank) and a two-chunk blip are dropped', () => {
  const tr = new SegmentTracker();
  const levels = [...new Array(10).fill(0.003), 0.3, ...new Array(6).fill(0.003), 0.2, 0.2, ...new Array(6).fill(0.003)];
  assert.deepStrictEqual(feedMany(tr, levels), []);
});

test('quiet is judged relative to the speech peak once speaking', () => {
  const tr = new SegmentTracker();
  // speech at 0.2, then a 0.02 hum: above the absolute floor but under 18% of the peak, so it closes
  const levels = [...new Array(10).fill(0.003), ...new Array(6).fill(0.2), ...new Array(4).fill(0.02)];
  const segs = feedMany(tr, levels);
  assert.strictEqual(segs.length, 1);
  assert.strictEqual(segs[0].voicedMs, 6 * 250);
});

test('a room that is never quiet raises the floor above the ambient', () => {
  const tr = new SegmentTracker({ noiseWindow: 40 });
  // a dishwasher: 0.03 RMS, steady, well above the clamped floor (0.015)
  const hum = new Array(60).fill(0.03).map((v, i) => v + (i % 3) * 0.001);
  const segs = feedMany(tr, hum);
  const f = tr.floor();   // the flag is set when the floor is computed
  assert.ok(f > 0.04, `floor should rise above the hum (got ${f})`);
  assert.ok(tr.noisy, 'should recognise continuous sound as noise');
  // only the first, pre-adaptation window may have produced a segment; nothing after it adapts
  assert.ok(segs.length <= 1, `segments during steady noise: ${segs.length}`);
  // speech that stands clear of the hum still starts a segment
  const speech = feedMany(tr, [...new Array(8).fill(0.2), ...new Array(6).fill(0.03)], 2000000);
  assert.strictEqual(speech.length, 1);
});

test('long speech ends at the cap and reset() drops an open segment', () => {
  const tr = new SegmentTracker({ maxChunks: 12 });
  const segs = feedMany(tr, [...new Array(10).fill(0.003), ...new Array(30).fill(0.1)]);
  assert.strictEqual(segs.length, 2);   // 12-chunk cap hit twice inside 30 voiced chunks (a third is still open)
  assert.strictEqual(segs[0].chunks.length, 12);
  tr.reset();
  assert.deepStrictEqual(feedMany(tr, new Array(5).fill(0.003)), []);
});
