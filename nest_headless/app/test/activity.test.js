'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { step } = require('../activity');

const BRIDGE = 120000;

test('a quiet spell shorter than the bridge does not end a run', () => {
  const st = { fragments: 1 };
  assert.equal(step(st, 'idle', 1000, BRIDGE).action, 'continue');      // goes quiet
  assert.equal(step(st, 'idle', 30000, BRIDGE).action, 'continue');     // 29 s later, still quiet
  assert.equal(step(st, 'running', 30500, BRIDGE).action, 'resumed');   // back
  assert.equal(st.fragments, 2);
  assert.equal(st.bridgedMs, 29500);
  assert.equal(st.quietSince, null);
});

test('a quiet spell past the bridge ends the run, dated to when it went quiet', () => {
  const st = { fragments: 1 };
  step(st, 'idle', 1000, BRIDGE);
  const r = step(st, 'idle', 1000 + BRIDGE, BRIDGE);
  assert.equal(r.action, 'ended');
  assert.equal(r.endedAt, 1000, 'the run ended when it fell quiet, not when the bridge expired');
});

test('tonight\'s real trace merges into one run of the right shape (#12)', () => {
  // 2026-09-05 19:42-20:27 UTC: run seconds and the gap that followed
  const seq = [[23,60],[65,67],[65,537],[50,215],[18,55],[91,317],[40,111],
               [94,26],[27,76],[78,66],[177,69],[291,29],[53,null]];
  const runs = [];
  let t = 0, st = { fragments: 1 }, since = 0;
  for (const [run, gap] of seq) {
    t += run * 1000;
    if (gap === null) { runs.push({ s: Math.round((t - since) / 1000), f: st.fragments }); break; }
    // the zone goes quiet, then ticks through the gap
    let r = step(st, 'idle', t, BRIDGE);
    const gapEnd = t + gap * 1000;
    for (let now = t; now <= gapEnd && r.action !== 'ended'; now += 1000) r = step(st, 'idle', now, BRIDGE);
    if (r.action === 'ended') {
      runs.push({ s: Math.round((r.endedAt - since) / 1000), f: st.fragments });
      st = { fragments: 1 }; since = gapEnd;
    } else {
      step(st, 'running', gapEnd, BRIDGE);
    }
    t = gapEnd;
  }
  const longest = runs.reduce((a, b) => (b.s > a.s ? b : a));
  assert.equal(runs.length, 4, 'four runs, not thirteen fragments');
  assert.equal(longest.s, 1137, 'the long run is 18m57s');
  assert.equal(longest.f, 7, 'built from 7 fragments');
  assert.ok(runs.filter((r) => r.s > 600).length === 1, 'exactly one run clears the ten-minute bar');
});
