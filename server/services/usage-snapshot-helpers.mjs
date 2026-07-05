'use strict';

export function safeUsageNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

export function computeUsedPercent(remaining, entitlement, percentRemaining) {
  const explicitRemainingPct = safeUsageNumber(percentRemaining);
  if (explicitRemainingPct != null) return Math.max(0, Math.min(100, 100 - explicitRemainingPct));
  const rem = safeUsageNumber(remaining);
  const ent = safeUsageNumber(entitlement);
  if (rem == null || ent == null || ent <= 0) return null;
  return Math.max(0, Math.min(100, ((ent - rem) / ent) * 100));
}

export function computePercentRemaining(remaining, entitlement, percentRemaining) {
  const rem = safeUsageNumber(remaining);
  const ent = safeUsageNumber(entitlement);
  const explicit = safeUsageNumber(percentRemaining);
  if (explicit != null) {
    // Some API payloads report 0 with no denominator context; treat that as unknown.
    const hasDenominatorContext = (ent != null && ent > 0) || rem != null;
    if (!hasDenominatorContext && explicit === 0) return null;
    return Math.max(0, Math.min(100, explicit));
  }
  if (rem == null || ent == null || ent <= 0) return null;
  return Math.max(0, Math.min(100, (rem / ent) * 100));
}

export function computeDeltaMonthlyPercent(currentBucket = {}, previousBucket = {}) {
  const currentUsed = safeUsageNumber(currentBucket.usedPercent);
  const previousUsed = safeUsageNumber(previousBucket.usedPercent);
  if (currentUsed != null && previousUsed != null) {
    const delta = currentUsed - previousUsed;
    return Number.isFinite(delta) ? Math.max(0, delta) : null;
  }
  const deltaUsed = safeUsageNumber(currentBucket.deltaUsed);
  const entitlement = safeUsageNumber(currentBucket.entitlement);
  if (deltaUsed != null && entitlement != null && entitlement > 0) {
    return Math.max(0, (deltaUsed / entitlement) * 100);
  }
  return null;
}

export function normalizeUsageBucket(bucket = {}, previousBucket = {}) {
  const remaining = safeUsageNumber(bucket?.remaining);
  const entitlement = safeUsageNumber(bucket?.entitlement);
  const usedPercent = computeUsedPercent(remaining, entitlement, bucket?.percentRemaining);
  const percentRemaining = computePercentRemaining(remaining, entitlement, bucket?.percentRemaining);
  const previousRemaining = safeUsageNumber(previousBucket?.remaining);
  const deltaUsed = (remaining != null && previousRemaining != null) ? (previousRemaining - remaining) : null;
  return { remaining, entitlement, usedPercent, percentRemaining, deltaUsed };
}

export function usageSnapshotFromSummary(summary = {}, previousSnapshot = null, {
  source = 'live',
  stale = false,
  capturedAt = new Date().toISOString(),
} = {}) {
  const previous = previousSnapshot || {};
  const premiumBase = normalizeUsageBucket(summary?.premiumInteractions || {}, previous.premium || {});
  const chat = normalizeUsageBucket(summary?.chat || {}, previous.chat || {});
  const planBase = normalizeUsageBucket(summary?.planQuota || {}, previous.plan || {});
  const premium = {
    ...premiumBase,
    deltaCredits: premiumBase.deltaUsed,
  };
  const plan = {
    ...planBase,
    deltaMonthlyPercent: computeDeltaMonthlyPercent(planBase, previous.plan || {}),
  };
  return {
    source,
    stale,
    capturedAt,
    premium,
    chat,
    plan,
  };
}

export function usageSnapshotFromRow(row = null) {
  if (!row) return null;
  const premiumRemaining = safeUsageNumber(row.premium_remaining);
  const premiumEntitlement = safeUsageNumber(row.premium_entitlement);
  const chatRemaining = safeUsageNumber(row.chat_remaining);
  const chatEntitlement = safeUsageNumber(row.chat_entitlement);
  const planRemaining = safeUsageNumber(row.plan_remaining);
  const planEntitlement = safeUsageNumber(row.plan_entitlement);
  return {
    premium: {
      remaining: premiumRemaining,
      entitlement: premiumEntitlement,
      usedPercent: safeUsageNumber(row.premium_used_percent),
      percentRemaining: computePercentRemaining(premiumRemaining, premiumEntitlement, null),
    },
    chat: {
      remaining: chatRemaining,
      entitlement: chatEntitlement,
      usedPercent: safeUsageNumber(row.chat_used_percent),
      percentRemaining: computePercentRemaining(chatRemaining, chatEntitlement, null),
    },
    plan: {
      remaining: planRemaining,
      entitlement: planEntitlement,
      usedPercent: safeUsageNumber(row.plan_used_percent),
      percentRemaining: computePercentRemaining(planRemaining, planEntitlement, null),
    },
  };
}

export function staleUsageSnapshotFromRow(row = null, {
  source = 'stale-cache',
  capturedAt = new Date().toISOString(),
} = {}) {
  const previous = usageSnapshotFromRow(row);
  if (!previous) return null;
  return {
    source,
    stale: true,
    capturedAt,
    premium: {
      remaining: previous.premium.remaining,
      entitlement: previous.premium.entitlement,
      usedPercent: computeUsedPercent(previous.premium.remaining, previous.premium.entitlement, null),
      percentRemaining: computePercentRemaining(previous.premium.remaining, previous.premium.entitlement, null),
      deltaUsed: null,
      deltaCredits: null,
    },
    chat: {
      remaining: previous.chat.remaining,
      entitlement: previous.chat.entitlement,
      usedPercent: computeUsedPercent(previous.chat.remaining, previous.chat.entitlement, null),
      percentRemaining: computePercentRemaining(previous.chat.remaining, previous.chat.entitlement, null),
      deltaUsed: null,
    },
    plan: {
      remaining: previous.plan.remaining,
      entitlement: previous.plan.entitlement,
      usedPercent: computeUsedPercent(previous.plan.remaining, previous.plan.entitlement, null),
      percentRemaining: computePercentRemaining(previous.plan.remaining, previous.plan.entitlement, null),
      deltaUsed: null,
      deltaMonthlyPercent: null,
    },
  };
}

export function mapUsageSnapshotRow(row) {
  if (!row) return null;
  const premiumRemaining = safeUsageMetric(row.premium_remaining);
  const premiumEntitlement = safeUsageMetric(row.premium_entitlement);
  const planRemaining = safeUsageMetric(row.plan_remaining);
  const planEntitlement = safeUsageMetric(row.plan_entitlement);
  const planDeltaUsed = safeUsageMetric(row.plan_delta_used);
  const premiumDeltaUsed = safeUsageMetric(row.premium_delta_used);
  const planDeltaMonthlyPercent = planDeltaUsed != null && planEntitlement != null && planEntitlement > 0
    ? Math.max(0, (planDeltaUsed / planEntitlement) * 100)
    : null;
  return {
    source: row.source || 'live',
    stale: !!row.stale,
    capturedAt: row.captured_at || null,
    premium: {
      remaining: premiumRemaining,
      entitlement: premiumEntitlement,
      usedPercent: safeUsageMetric(row.premium_used_percent),
      percentRemaining: computePercentRemaining(premiumRemaining, premiumEntitlement, null),
      deltaUsed: premiumDeltaUsed,
      deltaCredits: premiumDeltaUsed,
    },
    chat: {
      remaining: safeUsageMetric(row.chat_remaining),
      entitlement: safeUsageMetric(row.chat_entitlement),
      usedPercent: safeUsageMetric(row.chat_used_percent),
      percentRemaining: computePercentRemaining(
        safeUsageMetric(row.chat_remaining),
        safeUsageMetric(row.chat_entitlement),
        null,
      ),
      deltaUsed: safeUsageMetric(row.chat_delta_used),
    },
    plan: {
      remaining: planRemaining,
      entitlement: planEntitlement,
      usedPercent: safeUsageMetric(row.plan_used_percent),
      percentRemaining: computePercentRemaining(planRemaining, planEntitlement, null),
      deltaUsed: planDeltaUsed,
      deltaMonthlyPercent: planDeltaMonthlyPercent,
    },
  };
}

function safeUsageMetric(value) {
  return safeUsageNumber(value);
}

export function fetchUsageSummaryPromise(fetchUsageSummary) {
  return new Promise((resolve, reject) => {
    fetchUsageSummary((error, summary) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(summary || {});
    });
  });
}
