'use strict';
const test = require('node:test');
const assert = require('node:assert');

// the house's lists, as they run
const NAMES = 'botbeard|bot beard|claude|clawed|cloud|cord|god|hearth|harth|hath|hart|heart';
const WORDS = 'hey|hi|ok|okay|a|eh|hay';
const SOFT = new Set(['a', 'eh']);
const STRONG = WORDS.split('|').filter((w) => !SOFT.has(w)).join('|');
const HEAD = new RegExp(`^[\\s\\S]{0,40}?\\b(?:${WORDS})[,.!?]?\\s+(?:${NAMES})\\b[,.!?]*\\s*`, 'i');
const ANY = new RegExp(`[\\s\\S]*?\\b(?:${STRONG})[,.!?]?\\s+(?:${NAMES})\\b[,.!?]*\\s*`, 'i');
const wakes = (t) => HEAD.test(t) || ANY.test(t);

test('a wake phrase deep in a busy segment now wakes (the kitchen case)', () => {
  const t = 'basically there are zombies in our house that are trying to eat us hey botbeard take a photo';
  assert.ok(!HEAD.test(t), 'the old head-only rule dropped it');
  assert.ok(wakes(t), 'it wakes now');
  assert.equal(t.replace(ANY, ''), 'take a photo', 'the request is what follows the phrase');
});

test('the soft wake words stay pinned to the head, so ordinary speech is safe', () => {
  for (const t of ['i think she had a heart attack last year',
                   'there was not a cloud in the sky all afternoon',
                   'he pulled the cord and eh god knows what happened']) {
    assert.ok(!ANY.test(t), `must not wake mid-sentence: ${t}`);
  }
  // ...but a quiet "hey" heard as "a" still wakes at the head, as before
  assert.ok(HEAD.test('a claude what is the time'));
});

test('a strong wake word mid-sentence does wake, which is the point', () => {
  assert.ok(wakes('no we are not eating yet hey botbeard take a photo'));
  assert.ok(wakes('mum said no ok hearth turn the light off'));
});
