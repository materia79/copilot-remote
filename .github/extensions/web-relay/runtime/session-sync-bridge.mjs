let lastSyncedKey = "";

function normalizeId(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

export async function syncSessionToServer(
  sdkSessionId,
  conversationId,
  apiClient,
  forceSync = false,
  options = {},
) {
  const sessionId = normalizeId(sdkSessionId);
  const nextConversationId = normalizeId(conversationId);
  if (!sessionId || !nextConversationId || typeof apiClient !== "function") {
    return false;
  }

  const syncKey = `${sessionId}::${nextConversationId || ""}`;
  if (!forceSync && syncKey === lastSyncedKey) {
    return true;
  }

  const orchestrator = options?.orchestrator && typeof options.orchestrator === "object"
    ? options.orchestrator
    : null;
  const payload = {
    sdk_session_id: sessionId,
    conversation_id: nextConversationId,
  };
  if (orchestrator) {
    const correlationId = normalizeId(
      orchestrator.correlationId
      || orchestrator.transactionId
      || orchestrator.orchestratorCorrelationId,
    );
    const targetSessionId = normalizeId(
      orchestrator.targetSessionId
      || orchestrator.orchestratorTargetSessionId,
    );
    if (correlationId) payload.orchestrator_correlation_id = correlationId;
    if (targetSessionId) payload.orchestrator_target_session_id = targetSessionId;
    if (orchestrator.rebindCompleted === true) payload.rebind_completed = true;
    if (orchestrator.rebindState) payload.rebind_state = String(orchestrator.rebindState);
    if (orchestrator.rebindSignal) payload.rebind_signal = String(orchestrator.rebindSignal);
  }

  await apiClient("POST", "/api/session-sync", payload);

  lastSyncedKey = syncKey;
  return true;
}
