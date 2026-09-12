'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { spotterSpelledDifferently, sharedPrefix } = require('../wakeword');
const WORDS = 'hey|hi|ok|okay|hay';   // strong only, as server.js passes
const ok = (kw, t) => spotterSpelledDifferently(kw, t, WORDS);

test('the recogniser spelling the name its own way still confirms', () => {
  assert.ok(ok('HEY CLAUDE', 'Hey Claw, can you hear me?'), 'Claude heard as Claw');
  assert.ok(ok('HEY OAKBEARD', 'Hey Oakbird, take a photo.'), 'Oakbeard heard as Oakbird');
  assert.ok(ok('HEY OAKBEARD', 'Hey Oakbeers. What is the weather today?'));
});

test('an exact spelling still confirms', () => {
  assert.ok(ok('HEY CLAUDE', 'Hey Claude, is the cupboard door open?'));
});

test('a different word after the wake word does not confirm', () => {
  assert.ok(!ok('HEY CLAUDE', 'Hey Google, set a twenty-five minute timer.'));
  assert.ok(!ok('HEY LANTERN', 'Hey, what are you doing later'));
});

test('a soft wake word never confirms, however close the word', () => {
  assert.ok(!ok('HEY OAKBEARD', 'I think it is a bottle of this or'), 'a bottle is not a wake');
  assert.ok(!ok('HEY KITCHEN', 'a kitchen, send a note to my dad'), 'and the cost: one real one, refused');
});

test('no wake word at the head means no confirmation, however close the word', () => {
  assert.ok(!ok('HEY LANTERN', "Yeah, it's hat yeah, and then uh hat."));
  assert.ok(!ok('HEY OAKBEARD', 'I think it is a bottle of this or'));
  assert.ok(!ok('HEY CLAUDE', 'You are a classical teacher.'));
});

test('an empty or missing transcript never confirms', () => {
  assert.ok(!ok('HEY CLAUDE', ''));
  assert.ok(!ok('', 'Hey Claude'));
});

// --- the window is configurable, for the uploaded-clip path (#38) ---
// A camera segment starts at the spotter fire, so the phrase sits at the front
// and the 40-char default is right. A clip uploaded from a device carries its
// whole start, so the phrase can be well into it - and refusing on position
// alone would recreate, on the device path, the bug 1.29.0 fixed on the camera.
test('the default window still refuses a phrase buried deep in a segment', () => {
  const deep = 'so anyway that was the whole afternoon and then somebody said hey clawed what is the weather';
  assert.strictEqual(
    spotterSpelledDifferently('HEY CLAUDE', deep, 'hey'),
    false,
    'the camera path keeps the spotter rule: a short preamble only',
  );
});

test('an unbounded window accepts the same phrase from an uploaded clip', () => {
  const deep = 'so anyway that was the whole afternoon and then somebody said hey clawed what is the weather';
  assert.strictEqual(
    spotterSpelledDifferently('HEY CLAUDE', deep, 'hey', { withinChars: Infinity }),
    true,
  );
});

test('a wider window does not lower the near-spelling bar itself', () => {
  // still needs PREFIX_MIN shared characters with the spotter's own name
  assert.strictEqual(
    spotterSpelledDifferently('HEY CLAUDE', 'and then hey bottle of water please', 'hey', { withinChars: Infinity }),
    false,
    'an ordinary word after the wake word is not a near-spelling',
  );
  assert.strictEqual(
    spotterSpelledDifferently('HEY CLAUDE', 'a long preamble goes here and there hey clawed what time is it', 'hey', { withinChars: Infinity }),
    true,
  );
});

test('withinChars 0 means the phrase must start the transcript', () => {
  assert.strictEqual(spotterSpelledDifferently('HEY CLAUDE', 'hey clawed hello', 'hey', { withinChars: 0 }), true);
  assert.strictEqual(spotterSpelledDifferently('HEY CLAUDE', 'um hey clawed hello', 'hey', { withinChars: 0 }), false);
});

// --- the spelling the house actually produces, and why it is NOT admitted ---
// Observed live on 2026-09-10: the spotter fired three times on the strong wake
// word and the recogniser wrote the name as "cloud" every time. "cloud" shares
// only "cl" with "claude" - two characters, below PREFIX_MIN - so the rescue
// added in 1.29.0 does not fire for it.
//
// That is deliberate and it should stay. All three of those fires were a child
// reciting times tables, and admitting "cloud" would have woken the house for
// every one. The prefix bar is refusing the commonest mis-spelling of the wake
// word precisely because that spelling is also what the spotter mishears
// arithmetic as. Lowering PREFIX_MIN to 2 would additionally admit "clod",
// "close", "club" - "hey, close the door" would wake the house.
//
// The cost is real and worth stating rather than hiding: a genuine "Hey Claude"
// transcribed as "Hey Cloud" is dropped, silently, which is #40's exact
// complaint. This test exists so that whoever tries to fix that meets the
// reason it was left alone.
test('"cloud" is refused, and that is the intended behaviour', () => {
  assert.strictEqual(spotterSpelledDifferently('HEY CLAUDE', 'hey cloud what is the weather', 'hey'), false);
  assert.strictEqual(sharedPrefix('cloud', 'claude'), 2, 'two shared characters, below PREFIX_MIN');
  // the near-misses that DO qualify, for contrast
  assert.strictEqual(sharedPrefix('claw', 'claude'), 3);
  assert.strictEqual(sharedPrefix('clause', 'claude'), 4);
  // and the ordinary words a lower bar would let in
  for (const w of ['clod', 'close', 'club', 'clip']) {
    assert.ok(sharedPrefix(w, 'claude') < 3, `${w} must stay below the bar`);
  }
});
