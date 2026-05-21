function normalizeId(value) {
  const text = String(value || '').trim();
  return text || '';
}

export function getMessageThreadAnchor(message, messageById = null) {
  const sourceId = normalizeId(message?.sourceMessageId || message?.parentMessageId || message?.threadId);
  if (sourceId && messageById instanceof Map && messageById.has(sourceId)) return sourceId;
  return normalizeId(message?.id);
}

export function sortConversationMessages(messages) {
  const list = Array.isArray(messages) ? messages.filter((message) => !!message) : [];
  const messageById = new Map(
    list
      .map((message) => [normalizeId(message?.id), message])
      .filter(([id]) => !!id),
  );

  const anchorTimestampCache = new Map();
  function anchorTimestamp(message) {
    const anchorId = getMessageThreadAnchor(message, messageById);
    if (anchorTimestampCache.has(anchorId)) return anchorTimestampCache.get(anchorId);
    const anchorMessage = messageById.get(anchorId) || message;
    const ts = Date.parse(anchorMessage?.timestamp || message?.timestamp || 0);
    const value = Number.isFinite(ts) ? ts : 0;
    anchorTimestampCache.set(anchorId, value);
    return value;
  }

  function roleRank(message) {
    return String(message?.role || '').trim().toLowerCase() === 'user' ? 0 : 1;
  }

  return list.slice().sort((a, b) => {
    const aAnchorTs = anchorTimestamp(a);
    const bAnchorTs = anchorTimestamp(b);
    if (aAnchorTs !== bAnchorTs) return aAnchorTs - bAnchorTs;

    const aAnchorId = getMessageThreadAnchor(a, messageById);
    const bAnchorId = getMessageThreadAnchor(b, messageById);
    if (aAnchorId !== bAnchorId) return aAnchorId.localeCompare(bAnchorId);

    const aRoleRank = roleRank(a);
    const bRoleRank = roleRank(b);
    if (aRoleRank !== bRoleRank) return aRoleRank - bRoleRank;

    const aTs = Date.parse(a?.timestamp || 0);
    const bTs = Date.parse(b?.timestamp || 0);
    if (Number.isFinite(aTs) && Number.isFinite(bTs) && aTs !== bTs) return aTs - bTs;

    return normalizeId(a?.id).localeCompare(normalizeId(b?.id));
  });
}
