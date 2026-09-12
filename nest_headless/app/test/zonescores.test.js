'use strict';
// A two-label zone's confidence fields reported the OTHER label's probability
// whenever it read closed (#52):
//
//   state closed, verdict closed, settled true, verdict_score 0,
//   scores {"open": 1, "closed": 0}
//
// A binary model's `score` is already P(open) - `positive` is derived from it -
// so branching on `positive` inverted the pair on the closed side. On an open
// reading the conditional gave the right answer by coincidence, which is why
// only closed ever showed it and why every model-accuracy check passed.
//
// The cost was not cosmetic: a consumer gating certainty on scores[state] read
// every closed transition as "0.00 sure of closed" and could never be certain
// the fridge was shut.
const assert = require('node:assert');
const { test } = require('node:test');

// the mapping as it now stands in server.js
const scoresFor = (score) => ({
  open: Math.round(score * 1000) / 1000,
  closed: Math.round((1 - score) * 1000) / 1000,
});
// what it used to be, kept so the regression is visible rather than described
const oldScoresFor = (score, positive) => ({
  open: Math.round((positive ? score : 1 - score) * 1000) / 1000,
  closed: Math.round((positive ? 1 - score : score) * 1000) / 1000,
});

test('a closed reading reports closed confidently', () => {
  const s = scoresFor(0);           // the model says P(open) = 0
  assert.deepStrictEqual(s, { open: 0, closed: 1 });
  assert.strictEqual(s.closed, 1, 'scores[state] for state "closed" must be the confidence in closed');
});

test('an open reading reports open confidently', () => {
  const s = scoresFor(1);
  assert.deepStrictEqual(s, { open: 1, closed: 0 });
});

test('the two labels sum to one at any score', () => {
  for (const v of [0, 0.001, 0.25, 0.5, 0.732, 0.999, 1]) {
    const s = scoresFor(v);
    assert.ok(Math.abs(s.open + s.closed - 1) < 0.002, `sums to one at ${v}`);
  }
});

test('the reported row from #52 is what the old mapping produced', () => {
  // score 0, positive false - the live rows were exactly this
  assert.deepStrictEqual(oldScoresFor(0, false), { open: 1, closed: 0 }, 'the bug, reproduced');
  assert.deepStrictEqual(scoresFor(0), { open: 0, closed: 1 }, 'and corrected');
});

test('the old mapping was right on open, which is why it hid', () => {
  assert.deepStrictEqual(oldScoresFor(1, true), scoresFor(1));
  assert.deepStrictEqual(oldScoresFor(0.9, true), scoresFor(0.9));
});

test('a near-tie is not flipped by the fix either', () => {
  // 0.536/0.464 is the dishwasher tie-break in #45; it must read as itself
  const s = scoresFor(0.464);
  assert.strictEqual(s.open, 0.464);
  assert.strictEqual(s.closed, 0.536);
});

// --- verdict_score names the verdict's own confidence (#52, second pass) ---
// It carried the raw positive-class score, which on a two-label zone is P(open)
// whatever the verdict is. So a closed verdict reported the open probability:
//
//   state=closed  score=0.998  scores={open 0.002, closed 0.998}  verdict_score=0.002
//
// state agreeing with the argmax, score correct, verdict_score still the other
// label. score and scores needed no change - only this one.
const pick = (scores, verdict, fallback) =>
  (scores && verdict && scores[verdict] != null) ? scores[verdict] : fallback;

test('verdict_score is the confidence in the label verdict names', () => {
  const scores = { open: 0.002, closed: 0.998 };
  assert.strictEqual(pick(scores, 'closed', 0.002), 0.998, 'a closed verdict reports its own 0.998');
  assert.strictEqual(pick(scores, 'open', 0.002), 0.002, 'an open verdict reports its own 0.002');
});

test('the reported row from the second pass is corrected', () => {
  const scores = { open: 0.002, closed: 0.998 };
  const wasReported = 0.002;                       // the raw positive-class score
  assert.notStrictEqual(pick(scores, 'closed', wasReported), wasReported);
  assert.strictEqual(pick(scores, 'closed', wasReported), 0.998);
});

test('a three-label zone is unaffected - it already named its own label', () => {
  const scores = { closed: 0.02, open: 0.11, vent: 0.87 };
  assert.strictEqual(pick(scores, 'vent', 0.87), 0.87);
  assert.strictEqual(pick(scores, 'closed', 0.87), 0.02);
});

test('it falls back to the raw score when there are no per-label scores', () => {
  assert.strictEqual(pick(null, 'closed', 0.42), 0.42);
  assert.strictEqual(pick({ open: 1, closed: 0 }, null, 0.42), 0.42);
});
