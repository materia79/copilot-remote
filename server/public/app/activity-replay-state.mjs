const DEFAULT_ACTIVITY_LIMIT = 24;

function normalizeActivityTexts(items, limit = DEFAULT_ACTIVITY_LIMIT) {
  const normalized = Array.isArray(items)
    ? items.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  return normalized.slice(-Math.max(1, Number(limit) || DEFAULT_ACTIVITY_LIMIT));
}

function isSubsequence(subset, sequence) {
  if (!subset.length) return true;
  let cursor = 0;
  for (const item of sequence) {
    if (item === subset[cursor]) cursor += 1;
    if (cursor >= subset.length) return true;
  }
  return false;
}

export function mergeRelayActivityTexts(existingItems, incomingItems, limit = DEFAULT_ACTIVITY_LIMIT) {
  const existing = normalizeActivityTexts(existingItems, Number.POSITIVE_INFINITY);
  const incoming = normalizeActivityTexts(incomingItems, Number.POSITIVE_INFINITY);
  if (!existing.length) return normalizeActivityTexts(incoming, limit);
  if (!incoming.length) return normalizeActivityTexts(existing, limit);
  if (isSubsequence(existing, incoming)) return normalizeActivityTexts(incoming, limit);
  if (isSubsequence(incoming, existing)) return normalizeActivityTexts(existing, limit);

  const primary = incoming.length > existing.length ? incoming : existing;
  const secondary = primary === incoming ? existing : incoming;
  const merged = primary.slice();
  const seen = new Set(primary);
  for (const item of secondary) {
    if (seen.has(item)) continue;
    merged.push(item);
    seen.add(item);
  }
  return normalizeActivityTexts(merged, limit);
}

export function shouldApplyConversationLoad({
  requestedConversationId,
  activeConversationId,
  capturedVersion,
  currentVersion,
} = {}) {
  const requestedId = String(requestedConversationId || '').trim();
  const activeId = String(activeConversationId || '').trim();
  return !!requestedId
    && requestedId === activeId
    && Number(capturedVersion) === Number(currentVersion);
}
