let activeSession = null;

function normalizeId(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

export function registerSession(sdkSessionId, conversationId) {
  const nextSessionId = normalizeId(sdkSessionId);
  if (!nextSessionId) {
    activeSession = null;
    return null;
  }

  activeSession = {
    sdkSessionId: nextSessionId,
    conversationId: normalizeId(conversationId),
  };

  return { ...activeSession };
}

export function getActiveSession() {
  return activeSession ? { ...activeSession } : null;
}

export function clearSession() {
  activeSession = null;
}
