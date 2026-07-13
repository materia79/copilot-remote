import assert from 'node:assert/strict';
import test from 'node:test';

import {
  computePercentRemaining,
  usageSnapshotFromSummary,
  mapUsageSnapshotRow,
  staleUsageSnapshotFromRow,
} from './usage-snapshot-helpers.mjs';

test('usageSnapshotFromSummary exposes turn delta credits and monthly-fraction delta', () => {
  const snapshot = usageSnapshotFromSummary(
    {
      premiumInteractions: { remaining: 980, entitlement: 1000, percentRemaining: 98 },
      planQuota: { remaining: 90, entitlement: 100, percentRemaining: 90 },
    },
    {
      premium: { remaining: 1000, entitlement: 1000, usedPercent: 0 },
      plan: { remaining: 95, entitlement: 100, usedPercent: 5 },
    },
    { source: 'live', capturedAt: '2026-07-05T12:00:00.000Z' },
  );

  assert.equal(snapshot.premium.deltaCredits, 20);
  assert.equal(snapshot.premium.deltaUsed, 20);
  assert.equal(snapshot.plan.deltaUsed, 5);
  assert.equal(snapshot.plan.deltaMonthlyPercent, 5);
  assert.equal(snapshot.plan.percentRemaining, 90);
});

test('mapUsageSnapshotRow derives monthly delta percent from stored row fields', () => {
  const mapped = mapUsageSnapshotRow({
    source: 'live',
    stale: 0,
    captured_at: '2026-07-05T12:00:00.000Z',
    premium_remaining: 980,
    premium_entitlement: 1000,
    premium_used_percent: 2,
    premium_delta_used: 20,
    chat_remaining: null,
    chat_entitlement: null,
    chat_used_percent: null,
    chat_delta_used: null,
    plan_remaining: 90,
    plan_entitlement: 100,
    plan_used_percent: 10,
    plan_delta_used: 5,
  });

  assert.equal(mapped.premium.deltaCredits, 20);
  assert.equal(mapped.plan.deltaMonthlyPercent, 5);
  assert.equal(mapped.plan.percentRemaining, 90);
});

test('mapUsageSnapshotRow derives monthly delta percent even without used percent', () => {
  const mapped = mapUsageSnapshotRow({
    source: 'live',
    stale: 0,
    captured_at: '2026-07-05T12:00:00.000Z',
    premium_remaining: 980,
    premium_entitlement: 1000,
    premium_used_percent: 2,
    premium_delta_used: 20,
    plan_remaining: null,
    plan_entitlement: 100000,
    plan_used_percent: null,
    plan_delta_used: 1,
  });

  assert.equal(mapped.plan.deltaMonthlyPercent, 0.001);
});

test('staleUsageSnapshotFromRow clears turn deltas but keeps remaining context', () => {
  const stale = staleUsageSnapshotFromRow({
    premium_remaining: 980,
    premium_entitlement: 1000,
    premium_used_percent: 2,
    premium_delta_used: 20,
    plan_remaining: 90,
    plan_entitlement: 100,
    plan_used_percent: 10,
    plan_delta_used: 5,
  });

  assert.equal(stale.stale, true);
  assert.equal(stale.premium.deltaCredits, null);
  assert.equal(stale.plan.deltaMonthlyPercent, null);
  assert.equal(stale.plan.percentRemaining, 90);
});

test('computePercentRemaining treats explicit zero without denominator as unknown', () => {
  const value = computePercentRemaining(null, null, 0);
  assert.equal(value, null);
});
