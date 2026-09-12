// The keyword the brain is told about, from the wake phrase actually heard.
//
// A quiet "hey" comes back from the recognisers as "a", "eh", "hi" or "hay",
// and the pre-roll can cut the wake word off entirely, leaving the bare name.
// All of those are accepted as a wake, but the brain matches the keyword text
// against the names it knows and drops the rest, so "A CLAUDE" reached it as
// an unknown keyword and the person got no answer (2026-09-04 20:53). The
// keyword is therefore always "HEY <canonical name>", whatever was heard.
'use strict';

function keywordFrom(matchText, canonicalKeyword) {
  const c = canonicalKeyword(String(matchText || '').replace(/[^A-Za-z ]/g, ' '));
  const name = c.split(' ').filter(Boolean).pop();
  return name ? `HEY ${name}` : '';
}

module.exports = { keywordFrom };

// The recogniser spells a coined name its own way, and the confirmation test
// looked for an exact one (#49). A nine-year-old said both live wake phrases in
// one breath and both were dropped: "hey Claude" came back "Hey Claw", "hey
// Oakbeard" came back "Hey Oabbe".
//
// This is deliberately NOT a similarity score over the whole phrase - measured
// over the house's transcripts, those do not separate ("hey claw" vs "clawed"
// scores 0.800, "hey half" vs "heart" scores 0.444, and the second is an
// ordinary sentence). It is narrower: the spotter has already fired on the
// sound, so the only question is whether the word after the wake word is the
// recogniser's rendering of the name the spotter matched. A shared opening of
// PREFIX_MIN characters answers that.
//
// Validated over every spotter fire in the log (51, of which 20 already
// confirmed): it adds two, both real - "a kitchen, send a note to my dad" and
// the child's "Hey Claw, can you hear me?" - and no false ones. The ordinary
// words that share three letters with a name ("class", "bother", "bottle")
// never co-occur with a spotter fire, which is why this is safe here and would
// not be safe as a transcript-path rule.
//
// Strong wake words only. A soft 'a' standing in for a quiet 'hey' is
// ordinary English in front of an ordinary word - 'a bottle of this' shares
// three letters with Oakbeard - and that is the combination plainEnglishWake
// exists to refuse. It costs one real confirmation in the whole log ('a
// kitchen, send a note to my dad'), against a class of false ones.
const PREFIX_MIN = 3;
function sharedPrefix(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}
// keyword: what the spotter matched, e.g. "HEY OAKBEARD". text: the transcript.
// wakeWords: the alternation used by the head rule. Returns true when the word
// after the wake word is a near-spelling of the spotter's own name.
// withinChars: how far into the transcript the wake phrase may sit. The camera
// path keeps the spotter's own rule (a short preamble, 40 chars) because the
// segment starts at the fire. A clip uploaded from a device carries its whole
// start, so the phrase can be anywhere in it - the same distinction the route
// already makes between WAKE_RE and WAKE_ANYWHERE_RE.
function spotterSpelledDifferently(keyword, text, wakeWords, { withinChars = 40 } = {}) {
  if (!keyword || !text) return false;
  const name = String(keyword).replace(/^HEY\s+/i, '').toLowerCase().replace(/[^a-z]/g, '');
  if (name.length < PREFIX_MIN) return false;
  const window = withinChars === Infinity ? '[\\s\\S]*?' : `[\\s\\S]{0,${Math.max(0, withinChars)}}?`;
  const m = new RegExp(`^${window}\\b(?:${wakeWords})[,.!?]?\\s+([a-z]+)`, 'i').exec(text);
  if (!m) return false;
  return sharedPrefix(m[1].toLowerCase(), name) >= PREFIX_MIN;
}
module.exports.spotterSpelledDifferently = spotterSpelledDifferently;
module.exports.sharedPrefix = sharedPrefix;
