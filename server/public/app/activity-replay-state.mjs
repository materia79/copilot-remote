const DEFAULT_ACTIVITY_LIMIT = 24;

export function normalizeRelayActivityEntry(item) {
  if (item && typeof item === 'object' && !Array.isArray(item)) {
    const text = String(item.text || '').trim();
    const subagentRunId = item.subagentRunId ? String(item.subagentRunId).trim() : null;
    if (!text) return null;
    return { text, subagentRunId };
  }
  const text = String(item || '').trim();
  if (!text) return null;
  return { text, subagentRunId: null };
}

export function relayActivityEntryText(item) {
  return normalizeRelayActivityEntry(item)?.text || '';
}

function normalizeActivityItems(items, limit = DEFAULT_ACTIVITY_LIMIT) {
  const normalized = Array.isArray(items)
    ? items.map((item) => normalizeRelayActivityEntry(item)).filter(Boolean)
    : [];
  return normalized.slice(-Math.max(1, Number(limit) || DEFAULT_ACTIVITY_LIMIT));
}

function activityEntryKey(item) {
  const entry = normalizeRelayActivityEntry(item);
  if (!entry) return '';
  return `${entry.subagentRunId || ''}::${entry.text}`;
}

function isSubsequence(subset, sequence) {
  if (!subset.length) return true;
  let cursor = 0;
  for (const item of sequence) {
    if (activityEntryKey(item) === activityEntryKey(subset[cursor])) cursor += 1;
    if (cursor >= subset.length) return true;
  }
  return false;
}

export function mergeRelayActivityTexts(existingItems, incomingItems, limit = DEFAULT_ACTIVITY_LIMIT) {
  const existing = normalizeActivityItems(existingItems, Number.POSITIVE_INFINITY);
  const incoming = normalizeActivityItems(incomingItems, Number.POSITIVE_INFINITY);
  if (!existing.length) return normalizeActivityItems(incoming, limit);
  if (!incoming.length) return normalizeActivityItems(existing, limit);
  if (isSubsequence(existing, incoming)) return normalizeActivityItems(incoming, limit);
  if (isSubsequence(incoming, existing)) return normalizeActivityItems(existing, limit);

  const primary = incoming.length > existing.length ? incoming : existing;
  const secondary = primary === incoming ? existing : incoming;
  const merged = primary.slice();
  const seen = new Set(primary.map((item) => activityEntryKey(item)));
  for (const item of secondary) {
    const key = activityEntryKey(item);
    if (!key || seen.has(key)) continue;
    merged.push(item);
    seen.add(key);
  }
  return normalizeActivityItems(merged, limit);
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
