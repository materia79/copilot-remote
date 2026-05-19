'use strict';

import { FEATURES } from '../features.mjs';
import { createSdkSessionSyncService } from '../services/sdk-session-sync-service.mjs';
import { createDeleteArchiveService } from '../services/delete-archive-service.mjs';

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
    buildContextResponseText,
    readContextFromSessionEvents,
    inFlightStateForConversation,
    createCompactedConversation,
    collectOrphanedUploadsFromConversation,
    deleteOrphanedUploads,
    queueCounts,
    getModelCatalogState,
    buildRelayReadyBannerData,
    workspaceRootPayload,
    processingTimeoutMs,
    localhostOnly,
    listenHost,
    ensureSessionId,
    touchCli,
    fetchUsageSummary,
    ensureRuntimeSessionBinding,
    bootstrapRuntimeSessionBindings,
    configuredConversationSessionMode,
    SUPPORTED_RELAY_MODES,
    DEFAULT_RELAY_MODE,
    SUPPORTED_CONVERSATION_SESSION_MODES,
    DEFAULT_CONVERSATION_SESSION_MODE,
    DEFAULT_MODEL,
    remotePath,
  } = deps;
  const sdkSessionSyncService = createSdkSessionSyncService(db, FEATURES);
  const deleteArchiveService = createDeleteArchiveService(db, FEATURES, null);

  // GET /api/conversations — list all conversations
  app.get('/api/conversations', auth, (req, res) => {
    const includeArchived = String(req.query.archived || '').trim().toLowerCase() === 'true';
    const rows = stmts.listConvs.all(includeArchived ? 1 : 0);
    const conversations = rows.map(r => ({
      id:           r.id,
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

  app.post('/api/session-sync', auth, (req, res) => {
    if (!FEATURES.sdkSessionSourceOfTruth) {
      return res.status(204).end();
    }

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

    return res.json({ ok: true });
  });

  app.get('/api/context/:conversationId', auth, (req, res) => {
    const conversationId = String(req.params.conversationId || '').trim();
    if (!conversationId) return res.status(400).json({ error: 'Missing conversationId' });
    const runtimeSession = stmts.getRuntimeSessionByConversation.get(conversationId) || null;
    const parsed = readContextFromSessionEvents(runtimeSession?.id || null, runtimeSession?.runtime_key || runtimeSession?.id || null);

    res.json({
      conversationId,
      runtimeSessionId: runtimeSession?.id || null,
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
      const runtimeSession = stmts.getRuntimeSessionByConversation.get(explicitConversationId) || null;
      const parsed = readContextFromSessionEvents(runtimeSession?.id || null, runtimeSession?.runtime_key || runtimeSession?.id || null);
      return res.json({
        conversationId: explicitConversationId,
        runtimeSessionId: runtimeSession?.id || null,
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

    const runtimeSessions = stmts.listRuntimeSessions.all();
    const latest = runtimeSessions.length ? runtimeSessions[0] : null;
    const runtimeSession = latest?.id ? (stmts.getRuntimeSessionById.get(latest.id) || latest) : null;
    const parsed = readContextFromSessionEvents(runtimeSession?.id || null, runtimeSession?.runtime_key || runtimeSession?.id || null);
    const conversationId = String(runtimeSession?.conversation_id || '').trim() || null;
    return res.json({
      conversationId,
      runtimeSessionId: runtimeSession?.id || null,
      snapshot: parsed.snapshot || null,
      eventsPath: parsed.eventsPath || null,
      error: parsed.error || null,
      text: buildContextResponseText({
        snapshot: parsed.snapshot,
        runtimeSession,
        conversationId: conversationId || 'unavailable',
        eventsPath: parsed.eventsPath,
        error: parsed.error,
      }),
    });
  });

  // GET /api/conversation/:id — get full conversation
  app.get('/api/conversation/:id', auth, (req, res) => {
    const conv = stmts.getConv.get(req.params.id);
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });
    const runtimeSession = stmts.getRuntimeSessionByConversation.get(req.params.id) || null;
    const inFlight = inFlightStateForConversation(req.params.id);
    const messages = stmts.getMessages.all(req.params.id).map(m => ({
      activities: m.role === 'assistant' ? relayActivityForResponse(m.id) : [],
      id:        m.id,
      role:      m.role,
      text:      m.text,
      model:     m.model || undefined,
      attachments: parseAttachments(m.attachments).map(hydrateAttachment).filter(Boolean),
      mode:      m.mode || undefined,
      timestamp: m.timestamp,
    }));
    res.json({
      id: conv.id,
      title: conv.title,
      archived: Number(conv.archived || 0) === 1,
      compactedInto: conv.compacted_into || null,
      compactedFrom: conv.compacted_from || null,
      runtimeSession: runtimeSession ? {
        id: runtimeSession.id,
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
    if (!existing) return res.json({ ok: true, alreadyDeleted: true });

    try {
      const orphanedUploads = collectOrphanedUploadsFromConversation(id);
      const result = await deleteArchiveService.deleteConversation(id);
      if (result?.ok && result.deleted) {
        deleteOrphanedUploads(orphanedUploads);
        io.emit('conversation_deleted', { conversationId: id });
        return res.json({ ok: true });
      }
      if (result?.ok && result.tombstoned) {
        io.emit('conversation_delete_pending', { conversationId: id });
        return res.json({ ok: true, pending: true });
      }
      return res.status(400).json({ error: result?.error || 'Delete failed' });
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
      const result = await deleteArchiveService.archiveConversation(id);
      if (result?.ok) {
        io.emit('conversation_archived', { conversationId: id });
        return res.json({ ok: true });
      }
      return res.status(400).json({ error: result?.error || 'Archive failed' });
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
