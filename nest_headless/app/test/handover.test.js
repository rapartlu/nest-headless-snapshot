'use strict';
const assert = require('node:assert');
const { test } = require('node:test');
const { promotionDecision } = require('../handover.js');

const d = (o) => promotionDecision({ waitedMs: 151000, ...o });

test('a standby with every camera live is promoted', () => {
  const r = d({ readyCount: 2, wantedCount: 2, outgoingLive: 2 });
  assert.strictEqual(r.promote, true);
  assert.strictEqual(r.reason, 'all_live');
});

test('a degraded standby is still promoted - one camera is not zero', () => {
  // a camera the vendor app has switched off must not hold up every deploy,
  // so parity with the outgoing instance is deliberately NOT required
  const r = d({ readyCount: 1, wantedCount: 2, outgoingLive: 2 });
  assert.strictEqual(r.promote, true);
  assert.strictEqual(r.reason, 'degraded');
});

test('a blind standby is refused while the outgoing instance can still see', () => {
  // this is the 2026-09-10 outage: 0/2 live, promoted anyway, house blind 3 min
  const r = d({ readyCount: 0, wantedCount: 2, outgoingLive: 2 });
  assert.strictEqual(r.promote, false);
  assert.strictEqual(r.reason, 'blind_standby');
  assert.match(r.message, /0\/2/);
  assert.match(r.message, /keeping the old instance/);
});

test('a blind standby IS promoted when the outgoing instance is blind too', () => {
  // nothing to lose, and refusing would strand the deploy for ever
  const r = d({ readyCount: 0, wantedCount: 2, outgoingLive: 0 });
  assert.strictEqual(r.promote, true);
  assert.strictEqual(r.reason, 'both_blind');
});

test('a blind standby is promoted when the outgoing instance has gone', () => {
  const r = d({ readyCount: 0, wantedCount: 2, outgoingLive: null });
  assert.strictEqual(r.promote, true);
});

test('the override forces promotion of a blind standby', () => {
  const r = d({ readyCount: 0, wantedCount: 2, outgoingLive: 2, allowBlind: true });
  assert.strictEqual(r.promote, true);
  assert.strictEqual(r.reason, 'blind_but_forced');
});

test('a deployment with no watches configured at all is promoted', () => {
  // snapshot-only installs have no watches; zero of zero is not blindness
  const r = d({ readyCount: 0, wantedCount: 0, outgoingLive: 0 });
  assert.strictEqual(r.promote, true);
});

test('the message names how long it waited', () => {
  const r = promotionDecision({ readyCount: 0, wantedCount: 2, outgoingLive: 1, waitedMs: 151000 });
  assert.match(r.message, /151s/);
});
