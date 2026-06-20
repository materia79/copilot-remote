'use strict';

function normalizeId(value) {
  return String(value || '').trim();
}

function normalizeMessageRole(value) {
  const role = String(value || '').trim().toLowerCase();
  if (role === 'assistant' || role === 'user') return role;
  return '';
}

function normalizeMessageTimestamp(value, fallbackIso) {
  const text = String(value || '').trim();
  if (!text) return fallbackIso;
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) return fallbackIso;
  return new Date(parsed).toISOString();
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeActivityEntry(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const text = String(value.text || '').trim();
    if (!text) return null;
    const subagentRunId = value.subagentRunId ? String(value.subagentRunId).trim() : null;
    return { text, subagentRunId };
  }
  const text = String(value || '').trim();
  if (!text) return null;
  return { text, subagentRunId: null };
}

export function createSessionHistoryRefreshService({
  db,
  stmts,
  parseSessionEventsToMessages = null,
  discoverSessionStateConversations = null,
  inFlightStateForConversation = null,
} = {}) {
  const countBusyQueueByConversation = db.prepare(`
    SELECT COUNT(*) AS cnt
    FROM queue
    WHERE conversation_id = ?
      AND status IN ('pending', 'processing', 'parked')
  `);
  const countMessagesByConversation = db.prepare(`
    SELECT COUNT(*) AS cnt
    FROM messages
    WHERE conversation_id = ?
  `);

  const deleteConversationMessages = typeof stmts?.deleteConvMsg?.run === 'function'
    ? stmts.deleteConvMsg
    : db.prepare(`DELETE FROM messages WHERE conversation_id = ?`);
  const deleteConversationActivity = typeof stmts?.deleteConvActivity?.run === 'function'
    ? stmts.deleteConvActivity
    : db.prepare(`DELETE FROM relay_activity WHERE conversation_id = ?`);
  const deleteConversationThoughts = typeof stmts?.deleteConvThoughts?.run === 'function'
    ? stmts.deleteConvThoughts
    : db.prepare(`DELETE FROM relay_thought WHERE conversation_id = ?`);
  const deleteConversationStreamEvents = typeof stmts?.deleteConvStreamEvents?.run === 'function'
    ? stmts.deleteConvStreamEvents
    : db.prepare(`DELETE FROM relay_stream_events WHERE conversation_id = ?`);
  const deleteConversationSubagentRuns = typeof stmts?.deleteConvSubagentRuns?.run === 'function'
    ? stmts.deleteConvSubagentRuns
    : db.prepare(`DELETE FROM subagent_runs WHERE conversation_id = ?`);

  function insertRebuiltMessages(conversationId, messages = []) {
    const nowIso = new Date().toISOString();
    for (const message of ensureArray(messages)) {
      const role = normalizeMessageRole(message?.role);
      if (!role) continue;
      const messageId = normalizeId(message?.id);
      if (!messageId) continue;
      const timestamp = normalizeMessageTimestamp(message?.timestamp, nowIso);
      stmts.insertMsg.run(
        messageId,
        conversationId,
        role,
        String(message?.text || ''),
        role === 'assistant' ? (String(message?.model || '').trim() || null) : null,
        String(message?.mode || '').trim() || null,
        null,
        timestamp,
      );
      if (role !== 'assistant') continue;
      const activities = ensureArray(message?.activities)
        .map((value) => normalizeActivityEntry(value))
        .filter(Boolean);
      for (const activity of activities) {
        stmts.insertActivity.run(
          String(message?.sourceMessageId || messageId),
          messageId,
          conversationId,
          String(message?.mode || 'agent').trim() || 'agent',
          activity.text,
          timestamp,
          activity.subagentRunId,
        );
      }
    }
  }

  const clearRetrievableHistoryTx = db.transaction((conversationId) => {
    deleteConversationMessages.run(conversationId);
    deleteConversationActivity.run(conversationId);
    deleteConversationThoughts.run(conversationId);
    deleteConversationStreamEvents.run(conversationId);
    deleteConversationSubagentRuns.run(conversationId);
  });

  const persistRebuiltHistoryTx = db.transaction((conversationId, messages = []) => {
    insertRebuiltMessages(conversationId, messages);
  });

  const replaceRetrievableHistoryTx = db.transaction((conversationId, messages = []) => {
    deleteConversationMessages.run(conversationId);
    deleteConversationActivity.run(conversationId);
    deleteConversationThoughts.run(conversationId);
    deleteConversationStreamEvents.run(conversationId);
    deleteConversationSubagentRuns.run(conversationId);
    insertRebuiltMessages(conversationId, messages);
  });

  function ensureConversationForRefresh(conversationId) {
    const requestedId = normalizeId(conversationId);
    if (!requestedId) {
      return { ok: false, statusCode: 400, error: 'Missing conversation id' };
    }
    const existing = stmts.getConv.get(requestedId);
    if (existing) return { ok: true, created: false, conversation: existing };

    const discovered = typeof discoverSessionStateConversations === 'function'
      ? discoverSessionStateConversations(400)
      : [];
    const discoveredMatch = ensureArray(discovered)
      .find((item) => normalizeId(item?.sdkSessionId) === requestedId) || null;
    if (!discoveredMatch) {
      return { ok: false, statusCode: 404, error: 'Conversation not found' };
    }

    const nowIso = new Date().toISOString();
    const discoveredTitle = String(discoveredMatch?.title || '').trim() || 'Session';
    stmts.insertConv.run(requestedId, discoveredTitle, nowIso, nowIso);
    if (typeof stmts.setConvSdkSessionIdIfMissing?.run === 'function') {
      stmts.setConvSdkSessionIdIfMissing.run(requestedId, nowIso, requestedId);
    }
    const created = stmts.getConv.get(requestedId);
    return {
      ok: true,
      created: true,
      conversation: created || {
        id: requestedId,
        title: discoveredTitle,
        sdk_session_id: requestedId,
      },
      discoveredMatch,
    };
  }

  function evaluateRefreshIdleState(conversationId) {
    const sid = normalizeId(conversationId);
    if (!sid) return { idle: false, reason: 'missing-conversation-id' };
    const queueBusyCount = Number(countBusyQueueByConversation.get(sid)?.cnt || 0);
    if (queueBusyCount > 0) return { idle: false, reason: 'queue-busy' };
    if (typeof inFlightStateForConversation === 'function') {
      const inFlight = inFlightStateForConversation(sid);
      const status = String(inFlight?.status || '').trim().toLowerCase();
      if (status === 'processing' || status === 'pending' || status === 'parked') {
        return { idle: false, reason: 'turn-processing' };
      }
    }
    return { idle: true };
  }

  function mapSdkEventsToMessages(events = []) {
    if (typeof parseSessionEventsToMessages !== 'function') return [];
    return parseSessionEventsToMessages(ensureArray(events));
  }

  function countRetrievableMessages(conversationId) {
    const sid = normalizeId(conversationId);
    if (!sid) return 0;
    return Number(countMessagesByConversation.get(sid)?.cnt || 0);
  }

  function clearRetrievableHistory(conversationId) {
    const sid = normalizeId(conversationId);
    if (!sid) return false;
    clearRetrievableHistoryTx(sid);
    return true;
  }

  function persistRebuiltHistory(conversationId, messages = []) {
    const sid = normalizeId(conversationId);
    if (!sid) return { insertedCount: 0 };
    persistRebuiltHistoryTx(sid, messages);
    return { insertedCount: ensureArray(messages).length };
  }

  function replaceRetrievableHistory(conversationId, messages = []) {
    const sid = normalizeId(conversationId);
    if (!sid) return { insertedCount: 0 };
    replaceRetrievableHistoryTx(sid, messages);
    return { insertedCount: ensureArray(messages).length };
  }

  return {
    ensureConversationForRefresh,
    evaluateRefreshIdleState,
    mapSdkEventsToMessages,
    countRetrievableMessages,
    clearRetrievableHistory,
    persistRebuiltHistory,
    replaceRetrievableHistory,
  };
}
