'use strict';

import fs from 'fs';
import path from 'path';
import { createSdkSessionSyncService } from '../services/sdk-session-sync-service.mjs';

const SESSION_WORKER_STATUS_QUEUE_STATES = Object.freeze(['pending', 'processing', 'parked']);

function normalizeWorkerStatusText(value, fallback = null) {
  const text = String(value || '').trim();
  return text || fallback;
}

function toSafeNonNegativeInt(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.trunc(numeric));
}

const MAX_CONVERSATION_TITLE_LENGTH = 120;

export function normalizeConversationTitle(value) {
  const title = String(value || '').replace(/[\r\n]+/g, ' ').trim();
  if (!title) return '';
  return title.slice(0, MAX_CONVERSATION_TITLE_LENGTH);
}

export function resolveConversationTitle({ title = '', titleSource = '', discoveredTitle = '' } = {}) {
  const storedTitle = String(title || '').trim();
  const source = String(titleSource || '').trim().toLowerCase();
  const discovered = String(discoveredTitle || '').trim();
  if (source === 'manual') return storedTitle || discovered;
  return discovered || storedTitle;
}

export function persistConversationTitle({
  db,
  stmts,
  io = null,
  conversationId = '',
  title = '',
} = {}) {
  const id = String(conversationId || '').trim();
  const nextTitle = normalizeConversationTitle(title);
  if (!id) {
    return { ok: false, statusCode: 400, error: 'Missing conversation id' };
  }
  if (!nextTitle) {
    return { ok: false, statusCode: 400, error: 'Missing title' };
  }

  const existing = stmts?.getConvAnyStatus?.get?.(id) || null;
  if (existing && String(existing.status || '').trim() === 'deleted') {
    return { ok: false, statusCode: 404, error: 'Conversation not found' };
  }

  const updatedAt = new Date().toISOString();

  if (!existing) {
    if (typeof stmts?.insertConv?.run === 'function') {
      stmts.insertConv.run(id, nextTitle, updatedAt, updatedAt);
    } else if (db && typeof db.prepare === 'function') {
      db.prepare(`INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`).run(id, nextTitle, updatedAt, updatedAt);
    }
    if (typeof stmts?.setConvSdkSessionIdIfMissing?.run === 'function') {
      stmts.setConvSdkSessionIdIfMissing.run(id, updatedAt, id);
    }
  }

  if (typeof stmts?.updateConvTitle?.run === 'function') {
    stmts.updateConvTitle.run(nextTitle, updatedAt, id);
  } else if (db && typeof db.prepare === 'function') {
    db.prepare(`UPDATE conversations SET title = ?, title_source = 'manual', updated_at = ? WHERE id = ?`).run(nextTitle, updatedAt, id);
  }

  const payload = {
    conversationId: id,
    title: nextTitle,
    updatedAt,
  };
  io?.emit?.('conversation_title_updated', payload);
  return { ok: true, ...payload, created: !existing };
}

export function buildSessionWorkerStatusPayload({
  featureFlags = null,
  supervisorSnapshot = null,
  queueRows = [],
} = {}) {
  const snapshot = supervisorSnapshot && typeof supervisorSnapshot === 'object'
    ? supervisorSnapshot
    : {};
  const workers = Array.isArray(snapshot.workers) ? snapshot.workers : [];
  const normalizedRows = Array.isArray(queueRows) ? queueRows : [];
  const workerBySession = new Map();
  for (const worker of workers) {
    const sid = normalizeWorkerStatusText(worker?.sdkSessionId);
    if (!sid) continue;
    workerBySession.set(sid, worker);
  }

  const integrity = {
    scannedQueueRowCount: normalizedRows.length,
    workerRegistryCount: workers.length,
    queueOwnerOrphanCount: 0,
    queueConversationMismatchCount: 0,
    queueRuntimeMismatchCount: 0,
    queueProcessingStateMismatchCount: 0,
    queueOwnerOrphanSamples: [],
    queueConversationMismatchSamples: [],
    queueRuntimeMismatchSamples: [],
    queueProcessingStateMismatchSamples: [],
  };

  for (const row of normalizedRows) {
    const messageId = normalizeWorkerStatusText(row?.id);
    const ownerSessionId = normalizeWorkerStatusText(row?.owner_sdk_session_id);
    const conversationId = normalizeWorkerStatusText(row?.conversation_id);
    const runtimeSessionId = normalizeWorkerStatusText(row?.runtime_session_id);
    const queueStatus = normalizeWorkerStatusText(row?.status, 'pending');
    if (!ownerSessionId) continue;

    const worker = workerBySession.get(ownerSessionId);
    if (!worker) {
      integrity.queueOwnerOrphanCount += 1;
      integrity.queueOwnerOrphanSamples.push({
        messageId,
        ownerSessionId,
        queueStatus,
      });
      continue;
    }

    if (conversationId && worker.conversationId && conversationId !== worker.conversationId) {
      integrity.queueConversationMismatchCount += 1;
      integrity.queueConversationMismatchSamples.push({
        messageId,
        ownerSessionId,
        queueConversationId: conversationId,
        workerConversationId: worker.conversationId,
      });
    }

    if (runtimeSessionId && worker.runtimeSessionId && runtimeSessionId !== worker.runtimeSessionId) {
      integrity.queueRuntimeMismatchCount += 1;
      integrity.queueRuntimeMismatchSamples.push({
        messageId,
        ownerSessionId,
        queueRuntimeSessionId: runtimeSessionId,
        workerRuntimeSessionId: worker.runtimeSessionId,
      });
    }

    if (queueStatus === 'processing' && normalizeWorkerStatusText(worker.status) !== 'processing') {
      integrity.queueProcessingStateMismatchCount += 1;
      integrity.queueProcessingStateMismatchSamples.push({
        messageId,
        ownerSessionId,
        queueStatus,
        workerStatus: normalizeWorkerStatusText(worker.status, 'unknown'),
      });
    }
  }

  return {
    enabled: featureFlags?.SESSION_WORKER_ROUTING_ENABLED === true,
    continuationRoutingEnabled: featureFlags?.SESSION_WORKER_CONTINUATION_ROUTING_ENABLED === true,
    fallbackRestartEnabled: false,
    uiState: normalizeWorkerStatusText(snapshot?.health?.uiState, 'white'),
    degradedReason: normalizeWorkerStatusText(snapshot?.health?.degradedReason, null),
    health: snapshot?.health && typeof snapshot.health === 'object' ? snapshot.health : null,
    workerCount: toSafeNonNegativeInt(snapshot.workerCount, workers.length),
    counts: snapshot.counts && typeof snapshot.counts === 'object' ? snapshot.counts : {},
    workers,
    pendingStarts: toSafeNonNegativeInt(snapshot.pendingStarts, 0),
    lifecycle: Array.isArray(snapshot.lifecycle) ? snapshot.lifecycle : [],
    integrity,
  };
}

export function buildConversationSessionRootPayload({
  conversationId = '',
  sdkSessionId = '',
  title = '',
  resolveSessionStateRoot = null,
} = {}) {
  const sid = String(sdkSessionId || '').trim() || String(conversationId || '').trim();
  if (!sid || typeof resolveSessionStateRoot !== 'function') return null;
  const root = String(resolveSessionStateRoot() || '').trim();
  if (!root) return null;
  const rootPath = path.join(root, sid);
  if (!fs.existsSync(rootPath)) return null;
  let stat = null;
  try {
    stat = fs.statSync(rootPath);
  } catch {
    return null;
  }
  if (!stat.isDirectory()) return null;
  return {
    sdkSessionId: sid,
    sessionRootPath: rootPath,
    sessionRootName: String(title || '').trim() || `Session ${sid.slice(0, 8)}`,
  };
}

function mergeUniqueActivityTexts(primary = [], secondary = []) {
  const merged = [];
  const seen = new Set();
  for (const value of [...(Array.isArray(primary) ? primary : []), ...(Array.isArray(secondary) ? secondary : [])]) {
    const text = String(value || '').trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    merged.push(text);
  }
  return merged;
}

export function buildConversationMessages({
  dbMessages = [],
  transcriptMessages = [],
  relayActivitiesByMessageId = new Map(),
  responseMessageToSourceId = new Map(),
} = {}) {
  const normalizedDbMessages = Array.isArray(dbMessages)
    ? dbMessages.map((message) => {
        const id = String(message?.id || '').trim();
        return {
          activities: message?.role === 'assistant' ? (relayActivitiesByMessageId.get(id) || []) : [],
          id,
          role: message?.role,
          text: message?.text,
          model: message?.model || undefined,
          attachments: message?.attachments || [],
          mode: message?.mode || undefined,
          timestamp: message?.timestamp,
          sourceMessageId: message?.role === 'assistant'
            ? (responseMessageToSourceId.get(id) || undefined)
            : undefined,
        };
      })
    : [];

  if (normalizedDbMessages.length === 0) {
    return Array.isArray(transcriptMessages)
      ? transcriptMessages.map((message) => {
          const id = String(message?.id || '').trim();
          return {
            ...message,
            activities: mergeUniqueActivityTexts(
              Array.isArray(message?.activities) ? message.activities : [],
              id ? (relayActivitiesByMessageId.get(id) || []) : [],
            ),
            sourceMessageId: message?.role === 'assistant'
              ? (responseMessageToSourceId.get(id) || message?.sourceMessageId || undefined)
              : message?.sourceMessageId,
          };
        })
      : [];
  }

  const transcriptById = new Map(
    Array.isArray(transcriptMessages)
      ? transcriptMessages
          .map((message) => [String(message?.id || '').trim(), message])
          .filter(([id]) => !!id)
      : [],
  );

  return normalizedDbMessages.map((message) => {
    if (message.role !== 'assistant') return message;
    const transcriptMessage = transcriptById.get(String(message.id || '').trim());
    if (!transcriptMessage) return message;
    return {
      ...message,
      activities: mergeUniqueActivityTexts(
        Array.isArray(message.activities) ? message.activities : [],
        Array.isArray(transcriptMessage.activities) ? transcriptMessage.activities : [],
      ),
    };
  });
}

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
    markCliOffline,
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
    relayRestartOrchestrator,
    relayBridgeOwnerService,
    featureFlags,
    sessionWorkerSupervisor,
    sessionWorkerRegistry,
    resolveSessionStateRoot,
  } = deps;
  const sdkSessionSyncService = createSdkSessionSyncService(db);
  const SDK_DELETE_WAIT_TIMEOUT_MS = 12_000;
  const SDK_DELETE_POLL_MS = 200;
  const SDK_DELETE_STALE_PROCESSING_MS = 60_000;
  const markConversationDeleted = db.prepare(`UPDATE conversations SET status = 'deleted', updated_at = datetime('now') WHERE id = ?`);
  const listSessionWorkerQueueRows = db.prepare(`
    SELECT id, conversation_id, runtime_session_id, owner_sdk_session_id, status
    FROM queue
    WHERE status IN (${SESSION_WORKER_STATUS_QUEUE_STATES.map(() => '?').join(', ')})
    ORDER BY timestamp ASC
  `);
  const listPendingQuestionSessionRows = db.prepare(`
    SELECT DISTINCT TRIM(sdk_session_id) AS sdk_session_id
    FROM relay_questions
    WHERE status = 'pending'
      AND sdk_session_id IS NOT NULL
      AND TRIM(sdk_session_id) <> ''
  `);
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

  function readBridgeIdentity(req) {
    return relayBridgeOwnerService?.normalizeIdentity?.({
      pid: req.headers['x-relay-process-pid'],
      parentPid: req.headers['x-relay-parent-pid'],
      sessionId: req.headers['x-relay-session-id'],
      conversationId: req.headers['x-relay-conversation-id'],
    }) || null;
  }

  function shortId(value) {
    const text = String(value || '').trim();
    if (!text) return 'none';
    return `${text.slice(0, 8)}…`;
  }

  function markWorkerSessionSeen({ sdkSessionId, conversationId, runtimeSessionId } = {}) {
    const sid = String(sdkSessionId || '').trim();
    if (!sid) return null;
    const existing = sessionWorkerRegistry?.getWorker?.(sid) || null;
    return sessionWorkerRegistry?.upsertWorker?.({
      ...(existing || {}),
      sdkSessionId: sid,
      conversationId: String(conversationId || '').trim() || existing?.conversationId || null,
      runtimeSessionId: String(runtimeSessionId || '').trim() || existing?.runtimeSessionId || null,
      status: existing?.status || 'new',
    }) || null;
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
    const resolveMessageCount = (sdkSessionId, currentCount) => {
      const numeric = Number(currentCount || 0);
      if (numeric > 0) return numeric;
      const sid = String(sdkSessionId || '').trim();
      if (!sid) return 0;
      const transcript = readSessionTranscriptMessages(sid, { limit: 2000 });
      return Array.isArray(transcript) ? transcript.length : 0;
    };

    const includeArchived = String(req.query.archived || '').trim().toLowerCase() === 'true';
    const rows = stmts.listConvs.all(includeArchived ? 1 : 0);
    const discovered = discoverSessionStateConversations(200);
    const discoveredBySdkSessionId = new Map(
      discovered
        .map((item) => [String(item?.sdkSessionId || '').trim(), item])
        .filter(([sid]) => !!sid),
    );
    const conversations = rows.map((r) => {
      const sid = String(r.sdk_session_id || '').trim();
      const discoveredItem = sid ? discoveredBySdkSessionId.get(sid) : null;
      const discoveredUpdatedAt = String(discoveredItem?.updatedAt || '').trim();
      const discoveredTitle = String(discoveredItem?.title || '').trim();
      return {
        id:           r.id,
        sdkSessionId: sid || null,
        title:        resolveConversationTitle({
          title: r.title,
          titleSource: r.title_source,
          discoveredTitle,
        }),
        archived:     Number(r.archived || 0) === 1,
        compactedInto: r.compacted_into || null,
        compactedFrom: r.compacted_from || null,
        runtimeSessionId: r.runtime_session_id || null,
        runtimeSessionStrategy: r.runtime_strategy || null,
        runtimeSessionStatus: r.runtime_status || null,
        runtimeSessionLastUsedAt: r.runtime_last_used_at || null,
        createdAt:    r.created_at,
        updatedAt:    discoveredUpdatedAt || r.updated_at,
        messageCount: resolveMessageCount(r.sdk_session_id, r.message_count),
      };
    });

    const knownById = new Set(conversations.map((c) => String(c.id || '').trim()).filter(Boolean));
    const knownBySdkSessionId = new Set(conversations.map((c) => String(c.sdkSessionId || '').trim()).filter(Boolean));
    const deletedSdkSessions = new Set(
      stmts.listDeletedSdkSessions
        .all()
        .map((row) => String(row?.sdk_session_id || '').trim())
        .filter(Boolean),
    );
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
        title: String(item?.title || '').trim() || `Session ${sdkSessionId.slice(0, 8)}`,
        archived: false,
        compactedInto: null,
        compactedFrom: null,
        runtimeSessionId: runtimeSession?.id || null,
        runtimeSessionStrategy: runtimeSession?.strategy || null,
        runtimeSessionStatus: runtimeSession?.status || null,
        runtimeSessionLastUsedAt: runtimeSession?.last_used_at || updatedAt,
        createdAt: updatedAt,
        updatedAt,
        messageCount: resolveMessageCount(sdkSessionId, 0),
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
      sessionWorkerRegistry?.removeWorker?.(sdkSessionId);
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
    relayBridgeOwnerService?.observe?.(readBridgeIdentity(req));
    const sdkSessionId = String(body.sdk_session_id || '').trim();
    const conversationId = String(body.conversation_id || '').trim();
    const orchestratorCorrelationId = String(
      body.orchestrator_correlation_id
      || body.orchestrator_transaction_id
      || body.restart_transaction_id
      || body.transaction_id
      || body.correlation_id
      || '',
    ).trim();
    const orchestratorTargetSessionId = String(
      body.orchestrator_target_session_id
      || body.restart_target_session_id
      || body.target_session_id
      || body.targetSessionId
      || '',
    ).trim();
    const rebindCompleted = body.rebind_completed === true
      || body.rebind_complete === true
      || body.rebindConfirmed === true
      || String(body.rebind_state || body.rebind_signal || '').trim().toLowerCase() === 'completed';
    if (rebindCompleted) {
      console.log(
        `[session-sync] rebind signal sid=${shortId(sdkSessionId)} conv=${shortId(conversationId)} tx=${shortId(orchestratorCorrelationId)} target=${shortId(orchestratorTargetSessionId)}`,
      );
    }

    if (!sdkSessionId || !conversationId) {
      return res.status(400).json({ error: 'Missing sdk_session_id or conversation_id' });
    }

    try {
      const sync = sdkSessionSyncService.syncSession({
        sdk_session_id: sdkSessionId,
        conversation_id: conversationId,
      });
      const rebind = relayRestartOrchestrator?.applySessionSync?.({
        sdkSessionId,
        conversationId,
        correlationId: orchestratorCorrelationId || null,
        targetSessionId: orchestratorTargetSessionId || null,
        rebindCompleted,
        signalSource: 'api-session-sync',
      }) || null;
      if (rebindCompleted) {
        console.log(
          `[session-sync] rebind outcome sid=${shortId(sdkSessionId)} tx=${shortId(orchestratorCorrelationId)} code=${String(rebind?.code || 'none')} completed=${rebind?.completed === true ? 'yes' : 'no'} state=${String(rebind?.state?.state || 'unknown')}`,
        );
      }
      if (rebindCompleted && rebind?.ok === false && rebind?.conflict) {
        const statusCode = rebind.retryable ? 409 : 409;
        return res.status(statusCode).json({
          error: rebind.message || 'Rebind confirmation conflict',
          code: rebind.code || 'rebind-conflict',
          retryable: rebind.retryable === true,
          terminal: rebind.terminal === true,
          rebind,
          restartOrchestrator: rebind.state || relayRestartOrchestrator?.getState?.() || null,
        });
      }
      stmts.clearDeletedSdkSession.run(sdkSessionId);
      markWorkerSessionSeen({
        sdkSessionId: sync?.sdkSessionId || sdkSessionId,
        conversationId: sync?.conversationId || conversationId,
        runtimeSessionId: sync?.runtimeSessionId || null,
      });
      return res.json({
        ok: true,
        session: {
          conversationId: sync?.conversationId || conversationId,
          sdkSessionId: sync?.sdkSessionId || sdkSessionId,
          runtimeSessionId: sync?.runtimeSessionId || null,
          createdRuntimeSession: sync?.createdRuntimeSession === true,
        },
        rebind: rebind ? {
          considered: rebind.considered === true,
          completed: rebind.completed === true,
          awaitingRebind: rebind.awaitingRebind === true,
          code: rebind.code || null,
          retryable: rebind.retryable === true,
          terminal: rebind.terminal === true,
          expected: rebind.expected || null,
        } : null,
        restartOrchestrator: rebind?.state || relayRestartOrchestrator?.getState?.() || null,
        activeBridgeOwner: relayBridgeOwnerService?.getOwner?.() || null,
      });
    } catch (error) {
      const statusCode = Number(error?.statusCode || 500);
      const retryable = statusCode >= 500;
      const payload = {
        error: error?.message || 'Failed to sync session',
        code: statusCode === 409 ? 'binding-conflict' : 'session-sync-failed',
        retryable,
        terminal: !retryable,
      };
      return res.status(Number.isInteger(statusCode) ? statusCode : 500).json(payload);
    }
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
      const discoveredTitle = String(match?.title || '').trim() || `Session ${requestedId.slice(0, 8)}`;
      const messages = readSessionTranscriptMessages(requestedId, { limit: 400 });
      const sessionRoot = buildConversationSessionRootPayload({
        conversationId: requestedId,
        sdkSessionId: requestedId,
        title: discoveredTitle,
        resolveSessionStateRoot,
      });
      return res.json({
        id: requestedId,
        sdkSessionId: requestedId,
        title: discoveredTitle,
        sessionRootPath: sessionRoot?.sessionRootPath || null,
        sessionRootName: sessionRoot?.sessionRootName || discoveredTitle,
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
    const discoveredTitle = (() => {
      const sdkSessionId = String(conv.sdk_session_id || '').trim();
      if (!sdkSessionId) return null;
      const discovered = discoverSessionStateConversations(400);
      const match = discovered.find((item) => String(item?.sdkSessionId || '').trim() === sdkSessionId) || null;
      const title = String(match?.title || '').trim();
      return title || null;
    })();
    const resolvedTitle = resolveConversationTitle({
      title: conv.title,
      titleSource: conv.title_source,
      discoveredTitle,
    });
    const inFlight = inFlightStateForConversation(req.params.id);
    const transcriptMessages = readSessionTranscriptMessages(String(conv.sdk_session_id || req.params.id || '').trim(), { limit: 400 });
    const sessionRoot = buildConversationSessionRootPayload({
      conversationId: req.params.id,
      sdkSessionId: conv.sdk_session_id || req.params.id,
      title: resolvedTitle,
      resolveSessionStateRoot,
    });
    const dbMessages = stmts.getMessages.all(req.params.id);
    const queueRows = db.prepare(`
      SELECT id, response_message_id
      FROM queue
      WHERE conversation_id = ?
    `).all(req.params.id);
    const responseMessageToSourceId = new Map(
      queueRows
        .map((row) => [String(row?.response_message_id || '').trim(), String(row?.id || '').trim()])
        .filter(([responseMessageId, sourceMessageId]) => !!responseMessageId && !!sourceMessageId),
    );
    const relayActivitiesByMessageId = new Map(
      dbMessages
        .filter((m) => m.role === 'assistant')
        .map((m) => [m.id, relayActivityForResponse(m.id)]),
    );
    let messages = buildConversationMessages({
      dbMessages: dbMessages.map((message) => ({
        ...message,
        attachments: parseAttachments(message.attachments).map(hydrateAttachment).filter(Boolean),
      })),
      transcriptMessages,
      relayActivitiesByMessageId,
      responseMessageToSourceId,
    });
    messages = messages.map((message) => {
      if (message.role !== 'assistant') return message;
      const sourceMessageId = responseMessageToSourceId.get(String(message.id || '').trim()) || message.sourceMessageId || undefined;
      return sourceMessageId ? { ...message, sourceMessageId } : message;
    });
    res.json({
      id: conv.id,
      sdkSessionId: conv.sdk_session_id || null,
      title: resolvedTitle,
      sessionRootPath: sessionRoot?.sessionRootPath || null,
      sessionRootName: sessionRoot?.sessionRootName || resolvedTitle || 'Session',
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

  app.patch('/api/conversation/:id', auth, (req, res) => {
    const conversationId = String(req.params.id || '').trim();
    const result = persistConversationTitle({
      db,
      stmts,
      io,
      conversationId,
      title: req.body?.title,
    });
    if (!result.ok) {
      return res.status(result.statusCode || 500).json({ error: result.error || 'Failed to update conversation title' });
    }
    return res.json({
      ok: true,
      conversationId: result.conversationId,
      title: result.title,
      updatedAt: result.updatedAt,
      created: result.created === true,
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
    const { pendingCount, processingCount, parkedCount } = queueCounts();
    const modelState = getModelCatalogState();
    const activeRuntimeSessionCount = Number(stmts.countRuntimeSessions.get()?.cnt || 0);
    const readyBanner = buildRelayReadyBannerData();
    const pendingQuestionSessionIds = listPendingQuestionSessionRows.all()
      .map((row) => normalizeWorkerStatusText(row?.sdk_session_id))
      .filter(Boolean);
    res.json({
      cliOnline: runtimeState.cliOnline,
      relayPaused: runtimeState.relayPaused,
      pendingCount,
      processingCount,
      parkedCount,
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
      activeBridgeOwner: runtimeState.activeBridgeOwner || null,
      restartOrchestrator: relayRestartOrchestrator?.getState?.() || null,
      features: featureFlags || {},
      sessionWorker: buildSessionWorkerStatusPayload({
        featureFlags,
        supervisorSnapshot: sessionWorkerSupervisor?.snapshot?.({ pendingQuestionSessionIds }) || null,
        queueRows: listSessionWorkerQueueRows.all(...SESSION_WORKER_STATUS_QUEUE_STATES),
      }),
    });
  });

  app.get('/api/restart-orchestrator', auth, (req, res) => {
    ensureSessionId(req, res);
    return res.json({ orchestrator: relayRestartOrchestrator?.getState?.() || null });
  });

  app.post('/api/restart-orchestrator/request', auth, (req, res) => {
    const targetSessionId = String(req.body?.targetSessionId || req.body?.target_session_id || '').trim();
    if (!targetSessionId) return res.status(400).json({ error: 'Missing targetSessionId' });
    const result = relayRestartOrchestrator?.requestRestart({
      targetSessionId,
      reason: String(req.body?.reason || 'manual-request').trim() || 'manual-request',
    });
    if (!result?.ok) return res.status(400).json({ error: result?.error || 'request rejected', orchestrator: result?.state || null });
    return res.json({ ok: true, ...result });
  });

  app.post('/api/restart-orchestrator/rebind', auth, (req, res) => {
    touchCli();
    relayBridgeOwnerService?.observe?.(readBridgeIdentity(req));
    const body = req.body || {};
    const sdkSessionId = String(body.sdk_session_id || body.sdkSessionId || '').trim();
    const conversationId = String(body.conversation_id || body.conversationId || '').trim() || null;
    const orchestratorCorrelationId = String(
      body.orchestrator_correlation_id
      || body.orchestrator_transaction_id
      || body.restart_transaction_id
      || body.transaction_id
      || body.correlation_id
      || '',
    ).trim();
    const orchestratorTargetSessionId = String(
      body.orchestrator_target_session_id
      || body.restart_target_session_id
      || body.target_session_id
      || body.targetSessionId
      || '',
    ).trim();
    if (!sdkSessionId) {
      return res.status(400).json({ error: 'Missing sdk_session_id' });
    }
    console.log(
      `[relay-rebind] request sid=${shortId(sdkSessionId)} conv=${shortId(conversationId)} tx=${shortId(orchestratorCorrelationId)} target=${shortId(orchestratorTargetSessionId)}`,
    );
    const rebind = relayRestartOrchestrator?.applySessionSync?.({
      sdkSessionId,
      conversationId,
      correlationId: orchestratorCorrelationId || null,
      targetSessionId: orchestratorTargetSessionId || null,
      rebindCompleted: true,
      signalSource: 'api-restart-orchestrator-rebind',
    }) || null;
    if (!rebind) {
      return res.status(503).json({
        error: 'Restart orchestrator unavailable',
        code: 'restart-orchestrator-unavailable',
      });
    }
    if (rebind.ok === false && rebind.conflict) {
      console.warn(
        `[relay-rebind] conflict sid=${shortId(sdkSessionId)} tx=${shortId(orchestratorCorrelationId)} code=${String(rebind.code || 'none')} retryable=${rebind.retryable === true ? 'yes' : 'no'} terminal=${rebind.terminal === true ? 'yes' : 'no'} state=${String(rebind?.state?.state || 'unknown')}`,
      );
      return res.status(409).json({
        error: rebind.message || 'Rebind confirmation conflict',
        code: rebind.code || 'rebind-conflict',
        retryable: rebind.retryable === true,
        terminal: rebind.terminal === true,
        rebind,
        restartOrchestrator: rebind.state || relayRestartOrchestrator?.getState?.() || null,
      });
    }
    console.log(
      `[relay-rebind] outcome sid=${shortId(sdkSessionId)} tx=${shortId(orchestratorCorrelationId)} completed=${rebind.completed === true ? 'yes' : 'no'} state=${String(rebind?.state?.state || 'unknown')}`,
    );
    return res.json({
      ok: rebind.ok === true,
      rebind: {
        considered: rebind.considered === true,
        completed: rebind.completed === true,
        awaitingRebind: rebind.awaitingRebind === true,
        code: rebind.code || null,
        retryable: rebind.retryable === true,
        terminal: rebind.terminal === true,
        expected: rebind.expected || null,
      },
      restartOrchestrator: rebind.state || relayRestartOrchestrator?.getState?.() || null,
      activeBridgeOwner: relayBridgeOwnerService?.getOwner?.() || null,
    });
  });

  app.post('/api/restart-orchestrator/bridge-exit', auth, (req, res) => {
    const requester = readBridgeIdentity(req);
    const activeOwner = relayBridgeOwnerService?.getOwner?.() || null;
    console.log(
      `[bridge-exit] request ownerSid=${shortId(requester?.sessionId)} ownerPid=${String(requester?.pid || 'none')} tx=${shortId(req.body?.transactionId)} target=${shortId(req.body?.targetSessionId)}`,
    );
    if (activeOwner && requester && !relayBridgeOwnerService?.isOwner?.(requester)) {
      return res.status(409).json({
        error: 'Bridge exit rejected for non-owner requester',
        code: 'bridge-owner-mismatch',
        activeBridgeOwner: activeOwner,
        restartOrchestrator: relayRestartOrchestrator?.getState?.() || null,
      });
    }

    const orchestratorState = relayRestartOrchestrator?.getState?.() || null;
    console.log(
      `[bridge-exit] outcome tx=${shortId(orchestratorState?.transactionId)} target=${shortId(orchestratorState?.targetSessionId)} state=${String(orchestratorState?.state || 'unknown')} launcher=skipped`,
    );
    return res.json({
      ok: true,
      activeBridgeOwner: relayBridgeOwnerService?.getOwner?.() || null,
      restartOrchestrator: relayRestartOrchestrator?.getState?.() || null,
      launcher: null,
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
