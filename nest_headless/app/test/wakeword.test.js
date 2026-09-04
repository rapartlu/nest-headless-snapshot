'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { keywordFrom } = require('../wakeword');

// the house's canonicaliser, with the aliases the family runs
const CANON = [['BOTBEARD', 'bot beard|bot bird|botbird|bot beer|bot bead|bought beard|bot bud'],
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
  assert.equal(keywordFrom('Eh, botbeard, ', canonical), 'HEY BOTBEARD');
  assert.equal(keywordFrom('hi Claude ', canonical), 'HEY CLAUDE');
  assert.equal(keywordFrom('Hay claude ', canonical), 'HEY CLAUDE');
  assert.equal(keywordFrom('okay bot bird ', canonical), 'HEY BOTBEARD');
});

test('a name the recogniser split or mangled is canonicalised', () => {
  assert.equal(keywordFrom('hey cloud ', canonical), 'HEY CLAUDE');
  assert.equal(keywordFrom('Hey Claude, ', canonical), 'HEY CLAUDE');
  assert.equal(keywordFrom('hey bot beard ', canonical), 'HEY BOTBEARD');
});

test('the bare name left by a cut pre-roll still names the wake', () => {
  assert.equal(keywordFrom('Clawed, ', canonical), 'HEY CLAUDE');
  assert.equal(keywordFrom('claude ', canonical), 'HEY CLAUDE');
});

test('nothing heard yields no keyword, and the caller decides', () => {
  assert.equal(keywordFrom('', canonical), '');
  assert.equal(keywordFrom('   ,,, ', canonical), '');
});
