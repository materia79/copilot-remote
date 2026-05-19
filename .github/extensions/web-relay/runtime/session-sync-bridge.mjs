let lastSyncedKey = "";

function normalizeId(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

export async function syncSessionToServer(sdkSessionId, conversationId, apiClient) {
  const sessionId = normalizeId(sdkSessionId);
  if (!sessionId || typeof apiClient !== "function") {
    return false;
  }

  const nextConversationId = normalizeId(conversationId);
  const syncKey = `${sessionId}::${nextConversationId || ""}`;
  if (syncKey === lastSyncedKey) {
    return true;
  }

  await apiClient("POST", "/api/session-sync", {
    sdk_session_id: sessionId,
    conversation_id: nextConversationId,
  });

  lastSyncedKey = syncKey;
  return true;
}
