'use strict';
const test = require('node:test');
const assert = require('node:assert');

// Some spellings in wake_names are ordinary English: "heart"/"hath" cover
// Hearth, "cloud"/"cord"/"god" cover Claude. Paired with a soft wake word
// ("a", "eh" - a quietly spoken "hey") they turn everyday speech into a wake.
const NAMES = 'botbeard|bot beard|claude|clawed|cloud|cord|god|hearth|harth|hath|hart|heart';
const SOFT = ['a', 'eh'];
const STRONG = 'hey|hi|ok|okay|hay';
const PLAIN = new Set(['heart', 'hart', 'hath', 'cord', 'god', 'cloud', 'cloudy', 'clause', 'claws', 'clod']);
const DISTINCT = NAMES.split('|').filter((n) => !PLAIN.has(n)).join('|');
const softAny = new RegExp(`^[\\s\\S]{0,40}?\\b(?:${SOFT.join('|')})[,.!?]?\\s+(?:${NAMES})\\b`, 'i');
const softOk = new RegExp(`^[\\s\\S]{0,40}?\\b(?:${SOFT.join('|')})[,.!?]?\\s+(?:${DISTINCT})\\b`, 'i');
const strong = new RegExp(`\\b(?:${STRONG})[,.!?]?\\s+(?:${NAMES})\\b`, 'i');
const plainEnglishWake = (t) => softAny.test(t) && !softOk.test(t) && !strong.test(t);

test('everyday speech does not wake the house', () => {
  // this one really happened: it reached the brain as a request to "attack"
  assert.ok(plainEnglishWake('she had a heart attack last year'));
  assert.ok(plainEnglishWake('there was not a cloud in the sky'));
  assert.ok(plainEnglishWake('he pulled a cord by the door'));
});

test('a quietly spoken "hey" still wakes before a real name', () => {
  assert.ok(!plainEnglishWake('a claude what time is it'));
  assert.ok(!plainEnglishWake('eh botbeard hello'));
  assert.ok(!plainEnglishWake('a hearth turn the lights off'));
});

test('a clearly spoken wake word is always honoured', () => {
  for (const t of ['ok hearth lights off', 'hey cloud what is the time', 'hi god are you there'])
    assert.ok(!plainEnglishWake(t), t);
});
