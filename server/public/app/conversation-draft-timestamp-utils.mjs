export function normalizeDraftTimestampMs(value) {
  const parsed = Date.parse(String(value || '').trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

export function isIncomingDraftTimestampStale({
  existingMs = 0,
  incomingMs = 0,
} = {}) {
  return !!(incomingMs && existingMs && incomingMs < existingMs);
}
