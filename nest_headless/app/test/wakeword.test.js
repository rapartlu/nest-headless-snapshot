'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { keywordFrom } = require('../wakeword');

// the house's canonicaliser, with the aliases the family runs
const CANON = [['OAKBEARD', 'oak beard|oak bird|oakbird|oak beer|oak bead|ought beard|oak bud'],
               ['CLAUDE', 'claud|clawed|claws|clause|cloud|cloudy|clod|clawd|klaud|klaus|clyde|cord|god']]
  .map(([name, a]) => ({ name, re: new RegExp('\\b(?:' + a.split('|').join('|') + ')\\b', 'gi') }));
const canonical = (t) => {
  let s = String(t || '').toUpperCase().replace(/\s+/g, ' ').trim();
  for (const c of CANON) s = s.replace(c.re, c.name);
  return s;
};

test('a misheard wake word still reports the canonical keyword', () => {
  // a quiet "hey" comes back as "a": this reached the brain as "A CLAUDE" and was dropped
  assert.equal(keywordFrom('A Claude, ', canonical), 'HEY CLAUDE');
  assert.equal(keywordFrom('Eh, oakbeard, ', canonical), 'HEY OAKBEARD');
  assert.equal(keywordFrom('hi Claude ', canonical), 'HEY CLAUDE');
  assert.equal(keywordFrom('Hay claude ', canonical), 'HEY CLAUDE');
  assert.equal(keywordFrom('okay oak bird ', canonical), 'HEY OAKBEARD');
});

test('a name the recogniser split or mangled is canonicalised', () => {
  assert.equal(keywordFrom('hey cloud ', canonical), 'HEY CLAUDE');
  assert.equal(keywordFrom('Hey Claude, ', canonical), 'HEY CLAUDE');
  assert.equal(keywordFrom('hey oak beard ', canonical), 'HEY OAKBEARD');
});

test('the bare name left by a cut pre-roll still names the wake', () => {
  assert.equal(keywordFrom('Clawed, ', canonical), 'HEY CLAUDE');
  assert.equal(keywordFrom('claude ', canonical), 'HEY CLAUDE');
});

test('nothing heard yields no keyword, and the caller decides', () => {
  assert.equal(keywordFrom('', canonical), '');
  assert.equal(keywordFrom('   ,,, ', canonical), '');
});
