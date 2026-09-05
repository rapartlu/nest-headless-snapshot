// Run bridging for activity zones (#12).
//
// A turning drum only disturbs its porthole intermittently, so one cycle
// reaches us as a scatter of short runs. On 2026-09-05 a single 45-minute
// session arrived as 13 pieces, ten of the gaps under two minutes and one
// of them 29 s. A quiet spell shorter than the bridge does not end a run.
//
// Pure decision, so it can be tested: given the run state, what the window
// says now, and the clock, say whether the run continues, resumes after a
// gap, or is over (and when it actually ended).
'use strict';

// state: { quietSince, fragments, bridgedMs }
// verdict: 'running' | 'idle' from the hysteresis window
// returns { action: 'continue' | 'resumed' | 'ended', endedAt? }
function step(state, verdict, now, bridgeMs) {
  if (verdict === 'running') {
    if (!state.quietSince) return { action: 'continue' };
    state.bridgedMs = (state.bridgedMs || 0) + (now - state.quietSince);
    state.fragments = (state.fragments || 1) + 1;
    state.quietSince = null;
    return { action: 'resumed' };
  }
  if (!state.quietSince) state.quietSince = now;
  if (now - state.quietSince < bridgeMs) return { action: 'continue' };
  return { action: 'ended', endedAt: state.quietSince };
}

module.exports = { step };
