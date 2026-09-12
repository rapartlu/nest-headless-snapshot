'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { peopleForState } = require('../visitfaces');

const box = (x, y) => ({ x, y, w: 0.06, h: 0.30 });
const AT_DOOR = box(0.42, 0.26);

test('the dishwasher case: bent over at the flip, seen earlier in the visit', () => {
  // one person box at the instant of the flip, face to the floor, nobody named
  const fresh = [{ box: AT_DOOR, name: null, score: null, matches: [] }];
  // the hold saw them stand up 40 s earlier
  const held = [{ box: box(0.425, 0.25), name: 'alice', score: 0.62, matches: [{ name: 'alice', score: 0.62 }] }];
  const r = peopleForState(fresh, { held });
  assert.equal(r.length, 1, 'one person, not two');
  assert.equal(r[0].name, 'alice', 'the visit names them');
  assert.equal(r[0].from_visit, true, 'and says the evidence came from the visit');
});

test('a visit that has just ended still counts inside the window', () => {
  const fresh = [{ box: AT_DOOR, name: null, score: null, matches: [] }];
  const recent = [{ box: box(0.425, 0.25), name: 'alice', score: 0.6, matches: [] }];
  const now = 1_000_000;
  assert.equal(peopleForState(fresh, { recent, recentAtMs: now - 30000, now })[0].name, 'alice');
  assert.equal(peopleForState(fresh, { recent, recentAtMs: now - 200000, now })[0].name, null,
    'but not once it is stale');
});

test('a better view at the flip is not overwritten by a worse one from the visit', () => {
  const fresh = [{ box: AT_DOOR, name: 'alice', score: 0.71, matches: [] }];
  const held = [{ box: box(0.425, 0.25), name: 'bob', score: 0.44, matches: [] }];
  const r = peopleForState(fresh, { held });
  assert.equal(r[0].name, 'alice');
  assert.equal(r[0].score, 0.71);
  assert.ok(!r[0].from_visit, 'this frame was the better evidence');
});

test('a second person from the visit is added, not merged', () => {
  const fresh = [{ box: AT_DOOR, name: 'alice', score: 0.7, matches: [] }];
  const held = [{ box: box(0.62, 0.30), name: 'bob', score: 0.65, matches: [] }];   // no overlap
  const r = peopleForState(fresh, { held });
  assert.equal(r.length, 2);
  assert.deepEqual(r.map((p) => p.name).sort(), ['alice', 'bob']);
});

test('nobody anywhere stays nobody', () => {
  const r = peopleForState([{ box: AT_DOOR, name: null, score: null, matches: [] }], {});
  assert.equal(r.length, 1);
  assert.equal(r[0].name, null);
  assert.deepEqual(r[0].matches, [], 'still an honest "somebody is here and I cannot see who"');
});

test('no fresh boxes at all: the visit still reports who was there', () => {
  const held = [{ box: AT_DOOR, name: 'alice', score: 0.6, matches: [] }];
  const r = peopleForState([], { held });
  assert.equal(r.length, 1);
  assert.equal(r[0].name, 'alice');
  assert.equal(r[0].from_visit, true);
});

test('one visit\'s people share a visit_id, so they read as alternatives not a crowd', () => {
  // a long visit: the same person stepped aside and came back, so the hold has
  // two non-overlapping boxes for what may be one or two people
  const held = [
    { box: box(0.42, 0.26), name: 'alice', score: 0.55, matches: [] },
    { box: box(0.62, 0.30), name: 'bob', score: 0.51, matches: [] },
  ];
  const r = peopleForState([], { held, visitId: 'kitchen-dishwasher_door-123' });
  assert.equal(r.length, 2);
  assert.ok(r.every((p) => p.visit_id === 'kitchen-dishwasher_door-123'), 'both carry the same visit');
  assert.ok(r.every((p) => p.from_visit), 'and both are marked as visit evidence');
});

test('a face seen at the flip carries no visit_id: it is this frame, not the visit', () => {
  const fresh = [{ box: AT_DOOR, name: 'alice', score: 0.8, matches: [] }];
  const r = peopleForState(fresh, { held: [], visitId: 'v1' });
  assert.equal(r[0].visit_id, undefined);
  assert.ok(!r[0].from_visit);
});
