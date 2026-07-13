export function latestModelCatalogRefresh(...timestamps) {
  let latestMs = Number.NEGATIVE_INFINITY;
  let latestValue = null;
  for (const timestamp of timestamps) {
    const parsed = Date.parse(timestamp || '');
    if (!Number.isFinite(parsed) || parsed <= latestMs) continue;
    latestMs = parsed;
    latestValue = new Date(parsed).toISOString();
  }
  return latestValue;
}

export function isModelCatalogRefreshStale(refreshedAt, {
  now = Date.now(),
  staleAfterMs,
} = {}) {
  const refreshedAtMs = Date.parse(refreshedAt || '');
  if (!Number.isFinite(refreshedAtMs)) return true;
  return now - refreshedAtMs > staleAfterMs;
}
