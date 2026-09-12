'use strict';
const test = require('node:test');
const assert = require('node:assert');

// The exclusion rule, as it runs. A person who has asked not to be recognised
// must not be named AND must not be parked for review - a face that cannot be
// matched would otherwise be queued as a stranger, which is recognition by
// another route (#38).
function makeApply(excludedNames, suppressAt = 0.3) {
  const EX = new Set(excludedNames.map((n) => n.toLowerCase()));
  return function applyExclusions(all) {
    if (!EX.size) return all;
    const top = all[0];
    const out = all.filter((m) => !EX.has(String(m.name).toLowerCase()));
    if (top && EX.has(String(top.name).toLowerCase()) && top.score >= suppressAt) {
      const empty = []; empty.excluded = top.name; return empty;
    }
    return out;
  };
}

test('an excluded person is dropped, and the drop is flagged so nothing is parked', () => {
  const apply = makeApply(['alice']);
  const r = apply([{ name: 'alice', score: 0.52 }, { name: 'beth', score: 0.41 }]);
  assert.equal(r.length, 0, 'no matches survive');
  assert.equal(r.excluded, 'alice', 'the caller can tell this was an exclusion, not an unknown face');
});

test('a weak stray hit on an excluded name does not suppress a real person', () => {
  const apply = makeApply(['alice']);
  const r = apply([{ name: 'beth', score: 0.61 }, { name: 'alice', score: 0.22 }]);
  assert.equal(r[0].name, 'beth');
  assert.equal(r.length, 1, 'the excluded name is still removed from the list');
  assert.equal(r.excluded, undefined, 'but nothing is suppressed - beth was the answer');
});

test('below the suppression floor the excluded name is removed but not treated as present', () => {
  const apply = makeApply(['alice']);
  const r = apply([{ name: 'alice', score: 0.18 }, { name: 'cass', score: 0.12 }]);
  assert.equal(r.excluded, undefined, 'a 0.18 hit is noise, not a sighting');
  assert.ok(!r.some((m) => m.name === 'alice'), 'still never named');
});

test('with nobody excluded the list is untouched', () => {
  const apply = makeApply([]);
  const all = [{ name: 'paul', score: 0.7 }, { name: 'cass', score: 0.3 }];
  assert.deepEqual(apply(all), all);
});
