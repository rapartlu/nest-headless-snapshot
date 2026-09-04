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
