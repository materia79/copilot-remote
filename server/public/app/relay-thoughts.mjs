function normalizeSeq(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return Math.max(0, Math.trunc(num));
}

function normalizeTimestampMs(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function toThoughtEntry(value, order) {
  const text = String(value?.text || '');
  if (!text.trim()) return null;
  const reasoningId = String(value?.reasoningId || '').trim() || null;
  const timestamp = String(value?.timestamp || '').trim() || null;
  const subagentRunId = String(value?.subagentRunId || '').trim() || null;
  return {
    reasoningId,
    seq: normalizeSeq(value?.seq),
    text,
    done: !!value?.done,
    timestamp,
    subagentRunId,
    _order: order,
    _timestampMs: normalizeTimestampMs(timestamp),
  };
}

function isCandidateNewer(next, prev) {
  if (!prev) return true;
  if (!next) return false;
  if (Number.isFinite(next.seq) && Number.isFinite(prev.seq) && next.seq !== prev.seq) {
    return next.seq > prev.seq;
  }
  if (Number.isFinite(next._timestampMs) && Number.isFinite(prev._timestampMs) && next._timestampMs !== prev._timestampMs) {
    return next._timestampMs > prev._timestampMs;
  }
  if (next.text.length !== prev.text.length) {
    return next.text.length > prev.text.length;
  }
  return next._order > prev._order;
}

function sortThoughtEntries(a, b) {
  if (Number.isFinite(a.seq) && Number.isFinite(b.seq) && a.seq !== b.seq) {
    return a.seq - b.seq;
  }
  if (Number.isFinite(a._timestampMs) && Number.isFinite(b._timestampMs) && a._timestampMs !== b._timestampMs) {
    return a._timestampMs - b._timestampMs;
  }
  return a._order - b._order;
}

function shouldDropAsPrefix(current, next) {
  if (!current || !next) return false;
  if (!current.reasoningId || current.reasoningId !== next.reasoningId) return false;
  const currentText = String(current.text || '');
  const nextText = String(next.text || '');
  if (!currentText || !nextText || currentText === nextText) return false;
  return nextText.startsWith(currentText);
}

function toArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (value instanceof Map) return Array.from(value.values());
  return [];
}

export function normalizeRelayThoughtList(thoughts = []) {
  const normalized = toArray(thoughts)
    .map((entry, index) => toThoughtEntry(entry, index))
    .filter(Boolean);

  const byReasoningId = new Map();
  const passthrough = [];
  for (const entry of normalized) {
    if (!entry.reasoningId) {
      passthrough.push(entry);
      continue;
    }
    const existing = byReasoningId.get(entry.reasoningId);
    if (!existing || isCandidateNewer(entry, existing)) {
      byReasoningId.set(entry.reasoningId, entry);
    }
  }

  const ordered = [...byReasoningId.values(), ...passthrough].sort(sortThoughtEntries);
  const deduped = [];
  const seenText = new Set();
  for (let index = 0; index < ordered.length; index += 1) {
    const entry = ordered[index];
    const textKey = String(entry.text || '').trim();
    if (textKey && seenText.has(textKey)) continue;
    const next = ordered[index + 1] || null;
    if (shouldDropAsPrefix(entry, next)) continue;
    if (textKey) seenText.add(textKey);
    deduped.push({
      reasoningId: entry.reasoningId,
      seq: Number.isFinite(entry.seq) ? entry.seq : null,
      text: entry.text,
      done: !!entry.done,
      timestamp: entry.timestamp || null,
      subagentRunId: entry.subagentRunId || null,
    });
  }
  return deduped;
}

export function mergeRelayThoughts(persistedThoughts = [], cachedThoughts = []) {
  return normalizeRelayThoughtList([
    ...toArray(persistedThoughts),
    ...toArray(cachedThoughts),
  ]);
}
