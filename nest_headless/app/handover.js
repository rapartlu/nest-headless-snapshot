// Whether a standby instance should take over from the one currently serving.
//
// The deadline used to be the only rule: wait up to HANDOVER_MAX_WAIT_MS for
// the standby's cameras, then promote regardless. On 2026-09-10 that promoted
// an instance with no cameras at all -
//
//   handover: proceeding with 0/2 watches live after 151s
//
// - and the house was blind for three minutes. Two instances share one machine
// and one Chromium during a handover, so the standby being slow is normal; the
// standby being *blind* at the deadline is not, and it is the one case where
// going ahead is strictly worse than staying put. The supervisor already keeps
// the old instance when the standby exits ("new instance died before the
// handover; the old one stays"), so refusing is safe and needs no new
// machinery.
//
// The rule deliberately does not require the standby to match the outgoing
// instance camera for camera. A standby with one of two is degraded but can
// still serve, and blocking on parity would mean a camera the vendor app has
// switched off holds up every deploy for ever. Only zero is refused.
'use strict';

function promotionDecision({ readyCount, wantedCount, outgoingLive, allowBlind = false, waitedMs = 0 }) {
  const blind = wantedCount > 0 && readyCount === 0;
  if (!blind) return { promote: true, reason: readyCount === wantedCount ? 'all_live' : 'degraded' };
  if (allowBlind) return { promote: true, reason: 'blind_but_forced' };
  // Nothing to lose: if the outgoing instance cannot see either, a blind
  // standby is no worse, and refusing would strand the deploy for ever.
  if (!outgoingLive) return { promote: true, reason: 'both_blind' };
  return {
    promote: false,
    reason: 'blind_standby',
    message: `standby has 0/${wantedCount} watches live after ${Math.round(waitedMs / 1000)}s `
      + `and the outgoing instance still has ${outgoingLive}; keeping the old instance`,
  };
}

module.exports = { promotionDecision };
