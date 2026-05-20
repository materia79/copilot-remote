'use strict';

import { createSdkSessionSyncService } from '../services/sdk-session-sync-service.mjs';

export function registerSessionsRoutes(app, deps) {
  const {
    auth,
    io,
    db,
    stmts,
    runtimeState,
    config,
    parseAttachments,
    hydrateAttachment,
    relayActivityForResponse,
    buildContextResponseText,
    readContextFromSessionEvents,
    inFlightStateForConversation,
    createCompactedConversation,
    collectOrphanedUploadsFromConversation,
    deleteOrphanedUploads,
    queueCounts,
    getModelCatalogState,
    updateModelCatalog,
    buildRelayReadyBannerData,
    workspaceRootPayload,
    processingTimeoutMs,
    localhostOnly,
    listenHost,
    ensureSessionId,
    touchCli,
    fetchUsageSummary,
    discoverSessionStateConversations,
    readSessionTranscriptMessages,
    ensureRuntimeSessionBinding,
    bootstrapRuntimeSessionBindings,
    configuredConversationSessionMode,
    SUPPORTED_RELAY_MODES,
    DEFAULT_RELAY_MODE,
    SUPPORTED_CONVERSATION_SESSION_MODES,
    DEFAULT_CONVERSATION_SESSION_MODE,
    DEFAULT_MODEL,
    remotePath,
    computeRetryDelayMs,
  } = deps;
  const sdkSessionSyncService = createSdkSessionSyncService(db);
  const SDK_DELETE_WAIT_TIMEOUT_MS = 12_000;
  const SDK_DELETE_POLL_MS = 200;
  const SDK_DELETE_STALE_PROCESSING_MS = 60_000;
  const markConversationDeleted = db.prepare(`UPDATE conversations SET status = 'deleted', updated_at = datetime('now') WHERE id = ?`);
  const hardDeleteConversationRows = db.transaction((conversationId) => {
    db.prepare(`DELETE FROM relay_questions WHERE conversation_id = ?`).run(conversationId);
    db.prepare(`DELETE FROM queue WHERE conversation_id = ?`).run(conversationId);
    db.prepare(`DELETE FROM messages WHERE conversation_id = ?`).run(conversationId);
    db.prepare(`DELETE FROM runtime_sessions WHERE conversation_id = ?`).run(conversationId);
    db.prepare(`DELETE FROM conversations WHERE id = ?`).run(conversationId);
  });

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function enqueueSdkDeleteRequest(sdkSessionId, conversationId = null) {
    const sid = String(sdkSessionId || '').trim();
    if (!sid) return false;
    const nowIso = new Date().toISOString();
    const convId = String(conversationId || '').trim() || null;
    stmts.upsertSdkDeleteRequest.run(sid, convId, nowIso, nowIso);
    return true;
  }

  async function waitForSdkDeleteCompletion(sdkSessionId, timeoutMs = SDK_DELETE_WAIT_TIMEOUT_MS) {
    const sid = String(sdkSessionId || '').trim();
    if (!sid) return { completed: false };
    const startedAt = Date.now();
    while ((Date.now() - startedAt) < timeoutMs) {
      const row = stmts.getSdkDeleteRequestBySessionId.get(sid);
      if (!row) return { completed: true };
      await sleep(SDK_DELETE_POLL_MS);
    }
    return { completed: false };
  }

  function finalizeDeletedConversationsForSdkSession(sdkSessionId) {
    const sid = String(sdkSessionId || '').trim();
    if (!sid) return [];
    const rows = stmts.listDeletedConversationsBySdkSessionId.all(sid);
    const finalized = [];
    for (const row of rows) {
      const conversationId = String(row?.id || '').trim();
      if (!conversationId) continue;
      const orphanedUploads = collectOrphanedUploadsFromConversation(conversationId);
      hardDeleteConversationRows(conversationId);
      deleteOrphanedUploads(orphanedUploads);
      io.emit('conversation_deleted', { conversationId });
      finalized.push(conversationId);
    }
    return finalized;
  }

  // GET /api/conversations — list all conversations
  app.get('/api/conversations', auth, (req, res) => {
    const includeArchived = String(req.query.archived || '').trim().toLowerCase() === 'true';
    const rows = stmts.listConvs.all(includeArchived ? 1 : 0);
    const conversations = rows.map(r => ({
      id:           r.id,
      sdkSessionId: r.sdk_session_id || null,
      title:        r.title,
      archived:     Number(r.archived || 0) === 1,
      compactedInto: r.compacted_into || null,
      compactedFrom: r.compacted_from || null,
      runtimeSessionId: r.runtime_session_id || null,
      runtimeSessionStrategy: r.runtime_strategy || null,
      runtimeSessionStatus: r.runtime_status || null,
      runtimeSessionLastUsedAt: r.runtime_last_used_at || null,
      createdAt:    r.created_at,
      updatedAt:    r.updated_at,
      messageCount: r.message_count,
    }));

    const knownById = new Set(conversations.map((c) => String(c.id || '').trim()).filter(Boolean));
    const knownBySdkSessionId = new Set(conversations.map((c) => String(c.sdkSessionId || '').trim()).filter(Boolean));
    const deletedSdkSessions = new Set(
      stmts.listDeletedSdkSessions
        .all()
        .map((row) => String(row?.sdk_session_id || '').trim())
        .filter(Boolean),
    );
    const discovered = discoverSessionStateConversations(200);

    for (const item of discovered) {
      const sdkSessionId = String(item?.sdkSessionId || '').trim();
      if (!sdkSessionId) continue;
      if (deletedSdkSessions.has(sdkSessionId)) continue;
      if (knownBySdkSessionId.has(sdkSessionId) || knownById.has(sdkSessionId)) continue;

      const runtimeSession = stmts.getRuntimeSessionBySdkSessionId.get(sdkSessionId) || null;
      const updatedAt = String(item?.updatedAt || '').trim() || new Date().toISOString();
      const syntheticConversation = {
        id: sdkSessionId,
        sdkSessionId,
        title: `Session ${sdkSessionId.slice(0, 8)}`,
        archived: false,
        compactedInto: null,
        compactedFrom: null,
        runtimeSessionId: runtimeSession?.id || null,
        runtimeSessionStrategy: runtimeSession?.strategy || null,
        runtimeSessionStatus: runtimeSession?.status || null,
        runtimeSessionLastUsedAt: runtimeSession?.last_used_at || updatedAt,
        createdAt: updatedAt,
        updatedAt,
        messageCount: 0,
      };
      conversations.push(syntheticConversation);
      knownById.add(sdkSessionId);
      knownBySdkSessionId.add(sdkSessionId);
    }

    conversations.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
    res.json({ conversations });
  });

  app.get('/api/sessions', auth, (req, res) => {
    const sessions = stmts.listRuntimeSessions.all().map((row) => ({
      id: row.id,
      conversationId: row.conversation_id,
      conversationTitle: row.conversation_title || row.conversation_id,
      strategy: row.strategy || null,
      runtimeKey: row.runtime_key || null,
      model: row.model || null,
      status: row.status || null,
      createdAt: row.created_at || null,
      lastUsedAt: row.last_used_at || null,
      conversationUpdatedAt: row.conversation_updated_at || null,
    }));
    res.json({ sessions });
  });

  // GET /api/sdk-session-delete/pending — relay extension fetches next pending SDK delete request
  app.get('/api/sdk-session-delete/pending', auth, (req, res) => {
    touchCli();
    const nowIso = new Date().toISOString();
    const staleCutoff = new Date(Date.now() - SDK_DELETE_STALE_PROCESSING_MS).toISOString();
    stmts.resetStaleSdkDeleteProcessing.run(nowIso, staleCutoff);
    const dequeue = db.transaction(() => {
      const next = stmts.dequeueSdkDeleteRequest.get(nowIso);
      if (!next?.sdk_session_id) return null;
      const claimed = stmts.setSdkDeleteRequestProcessing.run(nowIso, nowIso, next.sdk_session_id);
      if (claimed.changes === 0) return null;
      return {
        sdkSessionId: next.sdk_session_id,
        conversationId: next.conversation_id || null,
        retryCount: Number(next.retry_count || 0),
        requestedAt: next.requested_at || nowIso,
      };
    });
    const request = dequeue();
    return res.json({ request });
  });

  // POST /api/sdk-session-delete/result — relay extension reports SDK delete result
  app.post('/api/sdk-session-delete/result', auth, (req, res) => {
    touchCli();
    const sdkSessionId = String(req.body?.sdk_session_id || '').trim();
    const ok = req.body?.ok === true;
    const errorText = String(req.body?.error || '').trim() || 'Unknown SDK delete failure';
    if (!sdkSessionId) return res.status(400).json({ error: 'Missing sdk_session_id' });

    if (ok) {
      stmts.deleteSdkDeleteRequest.run(sdkSessionId);
      const finalizedConversationIds = finalizeDeletedConversationsForSdkSession(sdkSessionId);
      if (!finalizedConversationIds.length) {
        io.emit('conversation_deleted', { conversationId: sdkSessionId });
      }
      return res.json({ ok: true, finalizedConversationIds });
    }

    const nowIso = new Date().toISOString();
    const current = stmts.getSdkDeleteRequestBySessionId.get(sdkSessionId);
    if (!current) return res.json({ ok: true, ignored: 'request_missing' });
    const nextRetryCount = Number(current.retry_count || 0) + 1;
    const nextAttemptAt = new Date(Date.now() + computeRetryDelayMs(nextRetryCount)).toISOString();
    stmts.setSdkDeleteRequestPendingWithError.run(nextAttemptAt, nowIso, errorText, sdkSessionId);
    io.emit('conversation_delete_pending', {
      sdkSessionId,
      conversationId: current.conversation_id || null,
      retryCount: nextRetryCount,
      nextAttemptAt,
      error: errorText,
    });
    return res.json({ ok: true, pending: true, retryCount: nextRetryCount, nextAttemptAt });
  });

  app.post('/api/session-sync', auth, (req, res) => {
    const body = req.body || {};
    const sdkSessionId = String(body.sdk_session_id || '').trim();
    const conversationId = String(body.conversation_id || '').trim();

    if (!sdkSessionId || !conversationId) {
      return res.status(400).json({ error: 'Missing sdk_session_id or conversation_id' });
    }

    sdkSessionSyncService.syncSession({
      sdk_session_id: sdkSessionId,
      conversation_id: conversationId,
    });
    stmts.clearDeletedSdkSession.run(sdkSessionId);

    return res.json({ ok: true });
  });

  app.get('/api/context/:conversationId', auth, (req, res) => {
    const conversationId = String(req.params.conversationId || '').trim();
    if (!conversationId) return res.status(400).json({ error: 'Missing conversationId' });
    // Prefer canonical sdk_session_id routing when available; keep conversation-id lookup for compatibility.
    const runtimeSessionBySdkSessionId = stmts.getRuntimeSessionBySdkSessionId.get(conversationId) || null;
    const runtimeSession = runtimeSessionBySdkSessionId
      || stmts.getRuntimeSessionByConversation.get(conversationId)
      || null;
    const copilotSessionId = String(runtimeSessionBySdkSessionId?.sdk_session_id || runtimeSession?.sdk_session_id || '').trim() || null;
    const parsed = readContextFromSessionEvents(
      runtimeSession?.id || null,
      copilotSessionId || runtimeSession?.runtime_key || runtimeSession?.id || null,
    );

    res.json({
      conversationId,
      runtimeSessionId: runtimeSession?.id || null,
      copilotSessionId,
      snapshot: parsed.snapshot || null,
      eventsPath: parsed.eventsPath || null,
      error: parsed.error || null,
      text: buildContextResponseText({
        snapshot: parsed.snapshot,
        runtimeSession,
        conversationId,
        eventsPath: parsed.eventsPath,
        error: parsed.error,
      }),
    });
  });

  app.get('/api/context', auth, (req, res) => {
    const explicitConversationId = String(req.query.conversationId || '').trim();
    if (explicitConversationId) {
      const runtimeSessionBySdkSessionId = stmts.getRuntimeSessionBySdkSessionId.get(explicitConversationId) || null;
      const runtimeSession = runtimeSessionBySdkSessionId
        || stmts.getRuntimeSessionByConversation.get(explicitConversationId)
        || null;
      const copilotSessionId = String(runtimeSessionBySdkSessionId?.sdk_session_id || runtimeSession?.sdk_session_id || '').trim() || null;
      const parsed = readContextFromSessionEvents(
        runtimeSession?.id || null,
        copilotSessionId || runtimeSession?.runtime_key || runtimeSession?.id || null,
      );
      return res.json({
        conversationId: explicitConversationId,
        runtimeSessionId: runtimeSession?.id || null,
        copilotSessionId,
        snapshot: parsed.snapshot || null,
        eventsPath: parsed.eventsPath || null,
        error: parsed.error || null,
        text: buildContextResponseText({
          snapshot: parsed.snapshot,
          runtimeSession,
          conversationId: explicitConversationId,
          eventsPath: parsed.eventsPath,
          error: parsed.error,
        }),
      });
    }
    return res.json({
      conversationId: null,
      runtimeSessionId: null,
      snapshot: null,
      eventsPath: null,
      error: 'Missing conversationId query parameter',
      text: 'Context is unavailable until a conversation is selected.',
    });
  });

  // GET /api/conversation/:id — get full conversation
  app.get('/api/conversation/:id', auth, (req, res) => {
    const requestedId = String(req.params.id || '').trim();
    if (stmts.getDeletedSdkSession.get(requestedId)) {
      return res.status(404).json({ error: 'Conversation not found' });
    }
    const conv = stmts.getConv.get(requestedId);
    if (!conv) {
      const discovered = discoverSessionStateConversations(400);
      const match = discovered.find((item) => String(item?.sdkSessionId || '').trim() === requestedId) || null;
      if (!match) return res.status(404).json({ error: 'Conversation not found' });
      const runtimeSession = stmts.getRuntimeSessionBySdkSessionId.get(requestedId) || null;
      const updatedAt = String(match?.updatedAt || '').trim() || new Date().toISOString();
      const messages = readSessionTranscriptMessages(requestedId, { limit: 400 });
      return res.json({
        id: requestedId,
        sdkSessionId: requestedId,
        title: `Session ${requestedId.slice(0, 8)}`,
        archived: false,
        compactedInto: null,
        compactedFrom: null,
        runtimeSession: runtimeSession ? {
          id: runtimeSession.id,
          sdkSessionId: runtimeSession.sdk_session_id || requestedId,
          strategy: runtimeSession.strategy || null,
          status: runtimeSession.status || null,
          model: runtimeSession.model || null,
          createdAt: runtimeSession.created_at || null,
          lastUsedAt: runtimeSession.last_used_at || null,
        } : null,
        createdAt: updatedAt,
        updatedAt,
        inFlight: null,
        messages,
      });
    }
    const runtimeSession = stmts.getRuntimeSessionByConversation.get(req.params.id) || null;
    const inFlight = inFlightStateForConversation(req.params.id);
    const transcriptMessages = readSessionTranscriptMessages(String(conv.sdk_session_id || req.params.id || '').trim(), { limit: 400 });
    const dbMessages = stmts.getMessages.all(req.params.id);
    const relayActivitiesByMessageId = new Map(
      dbMessages
        .filter((m) => m.role === 'assistant')
        .map((m) => [m.id, relayActivityForResponse(m.id)]),
    );
    let messages = dbMessages.map(m => ({
      activities: m.role === 'assistant' ? (relayActivitiesByMessageId.get(m.id) || []) : [],
      id:        m.id,
      role:      m.role,
      text:      m.text,
      model:     m.model || undefined,
      attachments: parseAttachments(m.attachments).map(hydrateAttachment).filter(Boolean),
      mode:      m.mode || undefined,
      timestamp: m.timestamp,
    }));
    if (transcriptMessages.length > messages.length) {
      messages = transcriptMessages.map((message) => {
        if (message.role !== 'assistant') return message;
        const relayActivities = relayActivitiesByMessageId.get(message.id) || [];
        if (!relayActivities.length) return message;
        const existingActivities = Array.isArray(message.activities) ? message.activities : [];
        const mergedActivities = [];
        const seen = new Set();
        for (const activity of existingActivities.concat(relayActivities)) {
          const text = String(activity || '').trim();
          if (!text || seen.has(text)) continue;
          seen.add(text);
          mergedActivities.push(text);
        }
        return { ...message, activities: mergedActivities };
      });
    }
    res.json({
      id: conv.id,
      sdkSessionId: conv.sdk_session_id || null,
      title: conv.title,
      archived: Number(conv.archived || 0) === 1,
      compactedInto: conv.compacted_into || null,
      compactedFrom: conv.compacted_from || null,
      runtimeSession: runtimeSession ? {
        id: runtimeSession.id,
        sdkSessionId: runtimeSession.sdk_session_id || conv.sdk_session_id || null,
        strategy: runtimeSession.strategy || null,
        status: runtimeSession.status || null,
        model: runtimeSession.model || null,
        createdAt: runtimeSession.created_at || null,
        lastUsedAt: runtimeSession.last_used_at || null,
      } : null,
      createdAt: conv.created_at,
      updatedAt: conv.updated_at,
      inFlight,
      messages,
    });
  });

  app.post('/api/conversation/:id/compact', auth, (req, res) => {
    const sourceConversationId = req.params.id;
    const compacted = createCompactedConversation(sourceConversationId);
    if (!compacted) return res.status(404).json({ error: 'Conversation not found' });
    io.emit('conversation_compacted', compacted);
    res.json({
      ok: true,
      sourceConversationId: compacted.sourceConversationId,
      compactedConversationId: compacted.targetConversationId,
      conversationId: compacted.targetConversationId,
      runtimeSessionId: compacted.runtimeSessionId,
      summarySeedPreview: compacted.summarySeed.slice(0, 240),
    });
  });

  // DELETE /api/conversation/:id — delete conversation
  app.delete('/api/conversation/:id', auth, async (req, res) => {
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ error: 'Missing conversation id' });

    const existing = stmts.getConvAnyStatus.get(id);
    if (!existing) {
      const discovered = discoverSessionStateConversations(400);
      const isSdkSessionConversation = discovered.some((item) => String(item?.sdkSessionId || '').trim() === id);
      if (!isSdkSessionConversation) return res.json({ ok: true, alreadyDeleted: true });
      stmts.markDeletedSdkSession.run(id, new Date().toISOString());
      enqueueSdkDeleteRequest(id, null);
      const awaited = await waitForSdkDeleteCompletion(id);
      if (awaited.completed) return res.json({ ok: true, deleted: true, sdkSessionOnly: true });
      io.emit('conversation_delete_pending', { conversationId: id, sdkSessionOnly: true });
      return res.json({ ok: true, pending: true, sdkSessionOnly: true });
    }

    try {
      const sdkSessionId = String(existing.sdk_session_id || '').trim() || null;
      if (!sdkSessionId) {
        const orphanedUploads = collectOrphanedUploadsFromConversation(id);
        hardDeleteConversationRows(id);
        deleteOrphanedUploads(orphanedUploads);
        io.emit('conversation_deleted', { conversationId: id });
        return res.json({ ok: true });
      }

      markConversationDeleted.run(id);
      stmts.markDeletedSdkSession.run(sdkSessionId, new Date().toISOString());
      enqueueSdkDeleteRequest(sdkSessionId, id);
      const awaited = await waitForSdkDeleteCompletion(sdkSessionId);
      if (awaited.completed) return res.json({ ok: true });

      io.emit('conversation_delete_pending', { conversationId: id });
      return res.json({ ok: true, pending: true });
    } catch (error) {
      console.warn(`[archive] Delete failed for ${id}: ${error?.message || error}`);
      return res.status(500).json({ error: 'Failed to delete conversation' });
    }
  });

  // POST /api/conversation/:id/archive — archive conversation
  app.post('/api/conversation/:id/archive', auth, async (req, res) => {
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ error: 'Missing conversation id' });
    try {
      const existing = stmts.getConvAnyStatus.get(id);
      if (!existing || String(existing.status || '').trim() === 'deleted') {
        return res.json({ ok: true, alreadyDeleted: true });
      }
      db.prepare(`UPDATE conversations SET archived = 1, updated_at = datetime('now') WHERE id = ?`).run(id);
      io.emit('conversation_archived', { conversationId: id });
      return res.json({ ok: true });
    } catch (error) {
      console.warn(`[archive] Archive failed for ${id}: ${error?.message || error}`);
      return res.status(500).json({ error: 'Failed to archive conversation' });
    }
  });

  // GET /api/status — overall status
  app.get('/api/status', auth, (req, res) => {
    ensureSessionId(req, res);
    const { pendingCount, processingCount } = queueCounts();
    const modelState = getModelCatalogState();
    const activeRuntimeSessionCount = Number(stmts.countRuntimeSessions.get()?.cnt || 0);
    const readyBanner = buildRelayReadyBannerData();
    res.json({
      cliOnline: runtimeState.cliOnline,
      relayPaused: runtimeState.relayPaused,
      pendingCount,
      processingCount,
      activeRuntimeSessionCount,
      supportedModels: modelState.models,
      defaultModel: modelState.defaultModel,
      currentModel: modelState.currentModel,
      modelsStale: modelState.stale,
      modelsRefreshedAt: modelState.refreshedAt,
      modelWarning: modelState.warning,
      supportedRelayModes: SUPPORTED_RELAY_MODES,
      defaultRelayMode: DEFAULT_RELAY_MODE,
      supportedConversationSessionModes: SUPPORTED_CONVERSATION_SESSION_MODES,
      conversationSessionMode: configuredConversationSessionMode,
      ...workspaceRootPayload(),
      processingTimeoutMs,
      localhostOnly,
      listenHost,
      readyBanner,
      remotePath,
      sshTunnel: {
        enabled: runtimeState.tunnelState?.enabled ?? false,
        connected: runtimeState.tunnelState?.connected ?? false,
        host: runtimeState.tunnelState?.host ?? null,
        remotePort: runtimeState.tunnelState?.remotePort ?? null,
        remoteBindMode: runtimeState.tunnelState?.remoteBindMode ?? null,
        reconnectAttempts: runtimeState.tunnelState?.reconnectAttempts ?? 0,
        connectedSince: runtimeState.tunnelState?.connectedSince ?? null,
      },
    });
  });

  app.get('/api/models', auth, (req, res) => {
    ensureSessionId(req, res);
    const modelState = getModelCatalogState();
    res.json({
      models: modelState.models,
      currentModel: modelState.currentModel,
      defaultModel: modelState.defaultModel,
      stale: modelState.stale,
      refreshedAt: modelState.refreshedAt,
      source: modelState.source,
      warning: modelState.warning,
    });
  });

  app.post('/api/models/snapshot', auth, (req, res) => {
    const { models, currentModel, defaultModel, source, error } = req.body || {};
    const nextState = updateModelCatalog({
      models: Array.isArray(models) ? models : [],
      currentModel,
      defaultModel,
      source: source || 'relay-extension',
      error,
    });
    io.emit('models_updated', {
      models: nextState.models,
      currentModel: nextState.currentModel,
      defaultModel: nextState.defaultModel,
      stale: nextState.stale,
      refreshedAt: nextState.refreshedAt,
      warning: nextState.warning,
    });
    res.json({
      ok: true,
      models: nextState.models,
      currentModel: nextState.currentModel,
      defaultModel: nextState.defaultModel,
      stale: nextState.stale,
      refreshedAt: nextState.refreshedAt,
      warning: nextState.warning,
    });
  });

  // GET /api/usage — Copilot quota fetched live from GitHub API
  app.get('/api/usage', auth, (req, res) => {
    fetchUsageSummary((err, summary) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(summary);
    });
  });
}
