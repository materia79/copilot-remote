function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function normalizeId(value) {
  const text = String(value || '').trim();
  return text || '';
}

function normalizeRole(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeTimestampMs(value) {
  const parsed = Date.parse(String(value || '').trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

export function buildLiveMessageFingerprint(message = {}) {
  return {
    id: normalizeId(message?.id),
    role: normalizeRole(message?.role),
    text: normalizeText(message?.text),
    timestampMs: normalizeTimestampMs(message?.timestamp),
    sourceMessageId: normalizeId(message?.sourceMessageId),
  };
}

export function isLikelyLiveDuplicateMessage({
  incomingMessageId = '',
  incomingMessage = null,
  existingMessages = [],
  timestampWindowMs = 15_000,
  hasPendingTextMatch = false,
} = {}) {
  const incoming = buildLiveMessageFingerprint({
    ...(incomingMessage && typeof incomingMessage === 'object' ? incomingMessage : {}),
    id: incomingMessageId || incomingMessage?.id || '',
  });
  if (!incoming.role || !incoming.text) return false;
  if (incoming.role === 'user' && hasPendingTextMatch) return true;
  const timeWindowMs = Math.max(1_000, Number(timestampWindowMs) || 15_000);
  for (const candidate of Array.isArray(existingMessages) ? existingMessages : []) {
    const existing = buildLiveMessageFingerprint(candidate);
    if (incoming.id && existing.id && incoming.id === existing.id) return true;
    if (incoming.role !== existing.role || incoming.text !== existing.text) continue;
    if (incoming.sourceMessageId && existing.sourceMessageId && incoming.sourceMessageId === existing.sourceMessageId) {
      return true;
    }
    if (!incoming.timestampMs || !existing.timestampMs) continue;
    if (Math.abs(incoming.timestampMs - existing.timestampMs) <= timeWindowMs) return true;
  }
  return false;
}
