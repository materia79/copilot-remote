function normalizeId(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

export function extractTargetSessionId(details, conversationId = null) {
  return normalizeId(
    details?.sdkSessionId
    || details?.runtimeSession?.sdkSessionId
    || details?.runtimeSession?.sdk_session_id
    || details?.id
    || conversationId
    || "",
  );
}

export function resolveSessionBinding({
  conversationId,
  details,
  activeSessionId,
} = {}) {
  const convId = normalizeId(conversationId);
  const targetSessionId = extractTargetSessionId(details, convId);
  const active = normalizeId(activeSessionId);

  if (!convId) {
    return {
      ok: false,
      reason: "conversation-id-missing",
      retryable: false,
      message: "Missing conversation id for session binding check",
      activeSessionId: active,
      targetSessionId: null,
    };
  }

  if (!targetSessionId) {
    return {
      ok: false,
      reason: "target-session-missing",
      retryable: true,
      message: "Conversation has no bound SDK session id",
      activeSessionId: active,
      targetSessionId: null,
    };
  }

  if (!active) {
    return {
      ok: false,
      reason: "active-session-missing",
      retryable: true,
      message: "No active SDK runtime session available",
      activeSessionId: null,
      targetSessionId,
    };
  }

  return {
    ok: true,
    switched: false,
    via: "session-liveness",
    activeSessionId: active,
    targetSessionId,
  };
}

