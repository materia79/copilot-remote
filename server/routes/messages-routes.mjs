'use strict';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { stripRelayPromptContext } from '../services/relay-prompt-sanitizer.mjs';
import {
  shouldParkForRestart,
  parkPendingQueueForRestart,
  releaseParkedQueueForReadyState,
} from '../services/relay-queue-gate-service.mjs';

export const SESSION_WORKER_OWNER_LEASE_MS = 120_000;
export const SESSION_WORKER_TRANSIENT_DEQUEUE_RETRIES = 2;
export const SESSION_WORKER_TRANSIENT_DEQUEUE_BACKOFF_MS = 25;
const DUPLICATE_USER_MESSAGE_WINDOW_MS = 10 * 60 * 1000;

function normalizeSessionWorkerId(value) {
  const text = String(value || '').trim();
  return text || null;
}

function normalizeDuplicateMessageText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function findRecentDuplicateUserMessage({
  recentUserMessages = [],
  recentQueueRows = [],
  text = '',
  now = Date.now(),
  windowMs = DUPLICATE_USER_MESSAGE_WINDOW_MS,
} = {}) {
  const fingerprint = normalizeDuplicateMessageText(text);
  if (!fingerprint) return null;
  const maxAgeMs = Math.max(60_000, Number(windowMs) || DUPLICATE_USER_MESSAGE_WINDOW_MS);

  for (const row of Array.isArray(recentUserMessages) ? recentUserMessages : []) {
    const rowText = normalizeDuplicateMessageText(row?.text || '');
    if (!rowText || rowText !== fingerprint) continue;
    const rowTime = Date.parse(row?.timestamp || '');
    if (!Number.isFinite(rowTime)) continue;
    if ((now - rowTime) <= maxAgeMs) {
      return { source: 'message', messageId: row?.id || null, timestamp: row?.timestamp || null };
    }
  }

  for (const row of Array.isArray(recentQueueRows) ? recentQueueRows : []) {
    const rowText = normalizeDuplicateMessageText(row?.text || '');
    if (!rowText || rowText !== fingerprint) continue;
    const rowTime = Date.parse(row?.timestamp || '');
    if (!Number.isFinite(rowTime)) continue;
    const status = String(row?.status || '').trim().toLowerCase();
    if (['pending', 'processing', 'parked'].includes(status) && (now - rowTime) <= maxAgeMs) {
      return { source: 'queue', messageId: row?.id || null, timestamp: row?.timestamp || null, status };
    }
  }

  return null;
}

function addMsToIso(baseIso, ms) {
  const base = Date.parse(baseIso);
  const offset = Number(ms);
  const safeBase = Number.isFinite(base) ? base : Date.now();
  const safeOffset = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
  return new Date(safeBase + safeOffset).toISOString();
}

function delay(ms) {
  const timeoutMs = Math.max(0, Number(ms) || 0);
  if (!timeoutMs) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, timeoutMs));
}

function isTransientQueueError(error) {
  const code = String(error?.code || '').trim().toUpperCase();
  if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED') return true;
  const message = String(error?.message || error || '').toLowerCase();
  return message.includes('database is locked') || message.includes('database busy');
}

function isSessionWorkerRoutingEnabled(featureFlags = null) {
  return featureFlags?.SESSION_WORKER_ROUTING_ENABLED === true;
}

function normalizeTelemetryText(value, fallback = 'none') {
  const text = String(value || '').trim();
  return text || fallback;
}

function toTelemetryRetry(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.trunc(numeric));
}

function toTelemetryPid(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  const pid = Math.trunc(numeric);
  return pid > 0 ? pid : null;
}

function toTelemetryQueueField(queue = null) {
  if (!queue || typeof queue !== 'object') return 'pending=0,processing=0,parked=0';
  const pending = toTelemetryRetry(queue.pendingCount);
  const processing = toTelemetryRetry(queue.processingCount);
  const parked = toTelemetryRetry(queue.parkedCount);
  return `pending=${pending},processing=${processing},parked=${parked}`;
}

export function buildSessionWorkerLogEnvelope({
  event = 'session-worker-event',
  worker = null,
  session = null,
  conversation = null,
  message = null,
  continuation = null,
  state = null,
  queue = null,
  retry = 0,
  pid = null,
} = {}) {
  return {
    event: normalizeTelemetryText(event, 'session-worker-event'),
    worker: normalizeTelemetryText(worker),
    session: normalizeTelemetryText(session),
    conversation: normalizeTelemetryText(conversation),
    message: normalizeTelemetryText(message),
    continuation: normalizeTelemetryText(continuation),
    state: normalizeTelemetryText(state, 'unknown'),
    queue: normalizeTelemetryText(queue, toTelemetryQueueField(null)),
    retry: toTelemetryRetry(retry),
    pid: toTelemetryPid(pid),
  };
}

function emitWorkerLoopTelemetry(telemetry, payload = {}) {
  if (typeof telemetry !== 'function') return;
  try {
    telemetry(payload);
  } catch {
    // Never break queue dequeue flow due to telemetry callback failures.
  }
}

function normalizeTerminalErrorCode(value) {
  const text = String(value || '').trim().toLowerCase().replace(/^relay\./, '');
  return text.replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || null;
}

function normalizeTerminalErrorText(value) {
  const text = String(value || '').trim();
  return text || null;
}

function looksTerminalSessionLoadError(value) {
  const text = String(value || '').toLowerCase();
  if (!text) return false;
  return text.includes('could not be loaded')
    || text.includes('corrupted or incompatible')
    || text.includes('session file is corrupted')
    || text.includes('session not found');
}

export function resolveBlockedWorkerTerminalFailure({
  blockedReason = null,
  requesterSessionId = null,
  lifecycle = null,
  worker = null,
} = {}) {
  const reason = String(blockedReason || '').trim().toLowerCase();
  if (!reason) return null;
  const sessionId = normalizeSessionWorkerId(requesterSessionId || worker?.sdkSessionId);
  const lastError = normalizeTerminalErrorText(
    lifecycle?.lastError
    || worker?.lastError
    || lifecycle?.degradedReason
    || null,
  );
  const base = {
    kind: 'terminal-worker-bootstrap',
    failedAt: new Date().toISOString(),
    blockedReason: reason,
    requesterSessionId: sessionId,
    retryCount: Math.max(0, Number(lifecycle?.retryCount || worker?.retryCount || 0)),
    detail: lastError || null,
  };
  if (reason === 'missing-session-id') {
    return {
      ...base,
      code: 'worker-missing-session-id',
      stableCode: 'relay.worker-missing-session-id',
      message: 'The relay could not route this turn because the target session id is missing.',
      guidance: 'Retry from a valid conversation. If this repeats, refresh the relay UI and try again.',
    };
  }
  if (reason === 'restart-exhausted') {
    return {
      ...base,
      code: 'worker-restart-exhausted',
      stableCode: 'relay.worker-restart-exhausted',
      message: 'The relay exhausted worker restart attempts for this session.',
      guidance: 'Avoid this session for now and create a fresh one. Delete the broken session if you no longer need it.',
    };
  }
  if (reason === 'spawn-failed' && looksTerminalSessionLoadError(lastError)) {
    return {
      ...base,
      code: 'worker-session-load-failed',
      stableCode: 'relay.worker-session-load-failed',
      message: 'The session could not be loaded by the worker runtime.',
      guidance: 'This session is likely corrupted or incompatible. Use a fresh session and delete this one if not needed.',
    };
  }
  return null;
}

export function resolvePrimedWorkerTerminalFailure({
  sessionId = null,
  primeResult = null,
} = {}) {
  const normalizedSessionId = normalizeSessionWorkerId(sessionId || primeResult?.worker?.sdkSessionId);
  if (!primeResult || typeof primeResult !== 'object') return null;

  if (primeResult.ok === false) {
    return resolveBlockedWorkerTerminalFailure({
      blockedReason: primeResult.error,
      requesterSessionId: normalizedSessionId,
      lifecycle: primeResult.lifecycle || null,
      worker: primeResult.worker || null,
    });
  }

  const lifecycle = primeResult.lifecycle && typeof primeResult.lifecycle === 'object'
    ? primeResult.lifecycle
    : null;
  const degradedReason = String(lifecycle?.degradedReason || '').trim().toLowerCase();
  if (String(lifecycle?.uiState || '').trim().toLowerCase() !== 'yellow') return null;

  if (degradedReason === 'stale-pid') {
    return {
      kind: 'terminal-worker-bootstrap',
      code: 'worker-stale-pid',
      stableCode: 'relay.worker-stale-pid',
      message: 'The worker process for this session is no longer alive.',
      guidance: 'Retry once. If this repeats, avoid this session and use a fresh one.',
      detail: normalizeTerminalErrorText(lifecycle?.lastError || degradedReason),
      failedAt: new Date().toISOString(),
      blockedReason: degradedReason,
      requesterSessionId: normalizedSessionId,
      retryCount: Math.max(0, Number(lifecycle?.retryCount || 0)),
    };
  }

  if (degradedReason === 'restart-exhausted' || degradedReason === 'spawn-failed') {
    return resolveBlockedWorkerTerminalFailure({
      blockedReason: degradedReason,
      requesterSessionId: normalizedSessionId,
      lifecycle,
      worker: primeResult.worker || null,
    });
  }

  return null;
}

function extractTerminalId(text, patterns = []) {
  const input = String(text || '');
  for (const pattern of patterns) {
    const match = input.match(pattern);
    const value = String(match?.[1] || '').trim();
    if (value) return value;
  }
  return null;
}

export function parseTerminalFailureText(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const stableCodeMatch = raw.match(/error code:\s*(relay\.[a-z0-9-]+)/i);
  if (!stableCodeMatch) return null;
  const stableCode = String(stableCodeMatch[1] || '').trim().toLowerCase();
  const code = normalizeTerminalErrorCode(stableCode);
  if (!code) return null;
  const message = normalizeTerminalErrorText(raw.slice(0, stableCodeMatch.index).trim().replace(/\s+$/, '.'));
  const detailMatch = raw.match(/details:\s*(.+)$/i);
  return {
    terminal: true,
    code,
    stableCode: `relay.${code}`,
    message,
    detail: normalizeTerminalErrorText(detailMatch?.[1]),
    functionCallId: extractTerminalId(raw, [
      /functioncallid\s*=\s*([a-z0-9_-]+)/i,
      /function call id[:=]\s*([a-z0-9_-]+)/i,
    ]),
    requestId: extractTerminalId(raw, [
      /requestid\s*=\s*([a-z0-9_-]+)/i,
      /request id[:=]\s*([a-z0-9_-]+)/i,
      /\b(req(?:uest)?[_-][a-z0-9_-]+)/i,
    ]),
  };
}

function buildTerminalFailureTextForChat(terminalFailure, fallbackMessage = null) {
  const failure = terminalFailure && typeof terminalFailure === 'object' ? terminalFailure : {};
  const code = normalizeTerminalErrorCode(failure.code || failure.stableCode) || 'unknown-terminal';
  const stableCode = `relay.${code}`;
  const message = normalizeTerminalErrorText(failure.message)
    || normalizeTerminalErrorText(fallbackMessage)
    || 'The relay runtime hit a terminal error and could not complete this turn.';
  const guidance = normalizeTerminalErrorText(failure.guidance)
    || 'Retry the message. If this keeps failing, restart the relay and include the error code.';
  const detail = normalizeTerminalErrorText(failure.detail);
  const ids = [
    normalizeTerminalErrorText(failure.functionCallId) ? `functionCallId=${failure.functionCallId}` : null,
    normalizeTerminalErrorText(failure.requestId) ? `requestId=${failure.requestId}` : null,
  ].filter(Boolean);
  return [
    message,
    `Error code: ${stableCode}.`,
    ids.length ? `IDs: ${ids.join(', ')}.` : null,
    guidance,
    detail ? `Details: ${detail}` : null,
  ].filter(Boolean).join(' ');
}

export function resolveTerminalFailurePayload(payload = {}, { fallbackText = null } = {}) {
  const body = payload && typeof payload === 'object' ? payload : {};
  const parsedTextFailure = parseTerminalFailureText(body.text);
  const direct = body.terminalError && typeof body.terminalError === 'object'
    ? body.terminalError
    : null;
  const explicitCode = normalizeTerminalErrorCode(
    direct?.stableCode
    || direct?.code
    || body.terminalErrorCode
    || body.errorCode,
  );
  const explicitMessage = normalizeTerminalErrorText(
    direct?.message
    || body.terminalErrorMessage
    || body.errorMessage,
  );
  const explicitDetail = normalizeTerminalErrorText(
    direct?.detail
    || body.terminalErrorDetail
    || body.errorDetail,
  );
  const explicitGuidance = normalizeTerminalErrorText(
    direct?.guidance
    || body.terminalErrorGuidance
    || body.errorGuidance,
  );
  const functionCallId = normalizeTerminalErrorText(
    direct?.functionCallId
    || body.functionCallId,
  );
  const requestId = normalizeTerminalErrorText(
    direct?.requestId
    || body.requestId,
  );

  const terminalRequested = body.terminal === true
    || body.isTerminal === true
    || body.terminalError === true
    || body.errorKind === 'terminal'
    || !!direct
    || !!parsedTextFailure;
  if (!terminalRequested) return null;

  const code = explicitCode
    || normalizeTerminalErrorCode(parsedTextFailure?.code)
    || 'unknown-terminal';
  return {
    terminal: true,
    code,
    stableCode: `relay.${code}`,
    message: explicitMessage || parsedTextFailure?.message || normalizeTerminalErrorText(fallbackText),
    detail: explicitDetail || parsedTextFailure?.detail || null,
    guidance: explicitGuidance || null,
    functionCallId: functionCallId || parsedTextFailure?.functionCallId || null,
    requestId: requestId || parsedTextFailure?.requestId || null,
  };
}

export function extractRestartTerminalOutcome(orchestratorState = null) {
  const state = orchestratorState && typeof orchestratorState === 'object' ? orchestratorState : null;
  if (!state) return null;
  const code = String(state.terminalOutcomeCode || state.terminalOutcome || '').trim();
  if (!code) return null;
  return {
    phase: String(state.terminalOutcomePhase || '').trim() || null,
    code,
    message: String(state.terminalOutcomeMessage || '').trim() || null,
    attempts: Math.max(0, Number(state.terminalOutcomeAttempts || 0)),
    at: String(state.terminalOutcomeAt || '').trim() || null,
  };
}

export function maybeTriggerWorkerFallbackRestart({
  enabled = false,
  failureClass = null,
  requesterSessionId = null,
  relayRestartOrchestrator = null,
  inFlightProcessingCount = 0,
  fallbackFailureReasons = [],
} = {}) {
  const currentState = relayRestartOrchestrator?.getState?.() || null;
  const fallback = {
    enabled: false,
    considered: false,
    requested: false,
    skipped: 'removed-single-runtime-fallback',
    failureClass: String(failureClass || '').trim().toLowerCase() || null,
    targetSessionId: normalizeSessionWorkerId(requesterSessionId),
    inFlightProcessingCount: Math.max(0, Number(inFlightProcessingCount || 0)),
    terminalOutcome: extractRestartTerminalOutcome(currentState),
    orchestratorState: currentState,
    restartRequest: null,
  };
  return fallback;
}

function resolveInitialQueueOwnerSessionId({
  routingEnabled = false,
  requesterSessionId = null,
  runtimeSession = null,
  conversationSdkSessionId = null,
} = {}) {
  if (!routingEnabled) return null;
  return normalizeSessionWorkerId(
    runtimeSession?.sdk_session_id
    || conversationSdkSessionId
    || requesterSessionId,
  );
}

export function dequeuePendingMessage({
  db,
  stmts,
  nowIso,
  routingEnabled = false,
  requesterSessionId = null,
  ownerLeaseMs = SESSION_WORKER_OWNER_LEASE_MS,
} = {}) {
  const currentIso = String(nowIso || '').trim() || new Date().toISOString();
  const requesterSid = normalizeSessionWorkerId(requesterSessionId);
  const leaseExpiresAt = requesterSid ? addMsToIso(currentIso, ownerLeaseMs) : null;
  const dequeue = db.transaction(() => {
    const next = routingEnabled && requesterSid && stmts.findPendingForWorker
      ? stmts.findPendingForWorker.get(currentIso, requesterSid, requesterSid)
      : stmts.findPending.get(currentIso);
    if (!next) return null;
    if (routingEnabled && requesterSid && stmts.setProcessingWithWorkerLease) {
      stmts.setProcessingWithWorkerLease.run(currentIso, requesterSid, currentIso, leaseExpiresAt, currentIso, next.id);
      return {
        ...next,
        status: 'processing',
        processing_at: currentIso,
        owner_sdk_session_id: String(next.owner_sdk_session_id || '').trim() || requesterSid,
        owner_assigned_at: String(next.owner_assigned_at || '').trim() || currentIso,
        owner_lease_expires_at: leaseExpiresAt,
        owner_last_claimed_at: currentIso,
      };
    }
    stmts.setProcessing.run(currentIso, next.id);
    return {
      ...next,
      status: 'processing',
      processing_at: currentIso,
    };
  });
  return dequeue();
}

export async function dequeuePendingMessageForWorkerLoop({
  db,
  stmts,
  nowIso,
  routingEnabled = false,
  requesterSessionId = null,
  ownerLeaseMs = SESSION_WORKER_OWNER_LEASE_MS,
  sessionWorkerSupervisor = null,
  transientRetryLimit = SESSION_WORKER_TRANSIENT_DEQUEUE_RETRIES,
  transientRetryBackoffMs = SESSION_WORKER_TRANSIENT_DEQUEUE_BACKOFF_MS,
  relayRestartOrchestrator = null,
  inFlightProcessingCount = 0,
  telemetry = null,
} = {}) {
  const requesterSid = normalizeSessionWorkerId(requesterSessionId);
  const routingWithWorker = routingEnabled && requesterSid;
  const retryLimit = Math.max(0, Number(transientRetryLimit) || 0);
  const backoffBaseMs = Math.max(1, Number(transientRetryBackoffMs) || 1);
  const supervisor = sessionWorkerSupervisor || null;

  if (routingWithWorker && typeof supervisor?.ensureWorker === 'function') {
    const ensureResult = await supervisor.ensureWorker(requesterSid);
    if (!ensureResult?.ok) {
      const fallbackRestart = maybeTriggerWorkerFallbackRestart({
        enabled: false,
        failureClass: ensureResult?.error || null,
        requesterSessionId: requesterSid,
        relayRestartOrchestrator,
        inFlightProcessingCount,
      });
      emitWorkerLoopTelemetry(telemetry, {
        event: 'worker.ensure.blocked',
        sessionId: requesterSid,
        workerId: ensureResult?.worker?.workerId || null,
        conversationId: ensureResult?.worker?.conversationId || null,
        messageId: null,
        continuationId: null,
        state: ensureResult?.worker?.status || 'error',
        retry: ensureResult?.lifecycle?.retryCount || 0,
        pid: ensureResult?.worker?.pid || null,
        blockedReason: String(ensureResult?.error || 'worker-unavailable').trim() || 'worker-unavailable',
        queue: null,
      });
      return {
        message: null,
        blockedReason: String(ensureResult?.error || 'worker-unavailable').trim() || 'worker-unavailable',
        worker: ensureResult?.worker || null,
        lifecycle: ensureResult?.lifecycle || null,
        fallbackRestart,
        attempts: 0,
      };
    }
  }

  let attempt = 0;
  while (attempt <= retryLimit) {
    const currentIso = String(nowIso || '').trim() || new Date().toISOString();
    try {
      const message = dequeuePendingMessage({
        db,
        stmts,
        nowIso: currentIso,
        routingEnabled,
        requesterSessionId: requesterSid,
        ownerLeaseMs,
      });
      emitWorkerLoopTelemetry(telemetry, {
        event: message ? 'queue.dequeue.success' : 'queue.dequeue.empty',
        sessionId: requesterSid,
        workerId: routingWithWorker ? (supervisor?.getWorkerState?.(requesterSid)?.workerId || null) : null,
        conversationId: message?.conversation_id || null,
        messageId: message?.id || null,
        continuationId: null,
        state: message ? 'processing' : 'ready',
        retry: attempt,
        pid: routingWithWorker ? (supervisor?.getWorkerState?.(requesterSid)?.pid || null) : null,
        queue: null,
      });
      return {
        message,
        blockedReason: null,
        worker: routingWithWorker ? (supervisor?.getWorkerState?.(requesterSid) || null) : null,
        lifecycle: routingWithWorker ? (supervisor?.getLifecycleState?.(requesterSid) || null) : null,
        attempts: attempt + 1,
      };
    } catch (error) {
      const transient = isTransientQueueError(error);
      emitWorkerLoopTelemetry(telemetry, {
        event: transient && attempt < retryLimit ? 'queue.dequeue.retry' : 'queue.dequeue.error',
        sessionId: requesterSid,
        workerId: routingWithWorker ? (supervisor?.getWorkerState?.(requesterSid)?.workerId || null) : null,
        conversationId: null,
        messageId: null,
        continuationId: null,
        state: 'error',
        retry: attempt + 1,
        pid: routingWithWorker ? (supervisor?.getWorkerState?.(requesterSid)?.pid || null) : null,
        queue: null,
        error: String(error?.message || error || 'dequeue-failed'),
      });
      if (!routingWithWorker || !transient || attempt >= retryLimit) {
        if (routingWithWorker && typeof supervisor?.markError === 'function') {
          supervisor.markError(requesterSid, error);
        }
        throw error;
      }
      const backoffMs = Math.min(500, backoffBaseMs * (2 ** attempt));
      await delay(backoffMs);
      attempt += 1;
    }
  }

  return {
    message: null,
    blockedReason: 'dequeue-retry-exhausted',
    worker: routingWithWorker ? (supervisor?.getWorkerState?.(requesterSid) || null) : null,
    lifecycle: routingWithWorker ? (supervisor?.getLifecycleState?.(requesterSid) || null) : null,
    attempts: retryLimit + 1,
  };
}

export function registerMessagesRoutes(app, deps) {
  const {
    auth,
    io,
    db,
    stmts,
    runtimeState,
    config,
    uuidv4,
    ts,
    MAX_UPLOAD_BYTES,
    MAX_UPLOAD_ATTACHMENTS,
    MAX_REPO_TREE_NODES,
    MAX_REQUEUE_RETRIES,
    MAX_IMAGE_DATA_URL_LENGTH,
    MAX_WORKSPACE_PREVIEW_BYTES,
    MAX_REFERENCE_IMAGE_ATTACHMENT_BYTES,
    remotePath,
    parseBooleanQueryFlag,
    buildRepositoryTreeSnapshot,
    fetchBrowsableDrives,
    fetchDriveDirectoryEntries,
    mapDriveDirectoryEntry,
    driveDisplayName,
    normalizeDriveAbsolutePath,
    driveRootFromAbsolutePath,
    toDriveWebPath,
    readWorkspaceFileMeta,
    resolveWorkspaceFilePath,
    normalizeWorkspaceRelativePath,
    previewLanguageForWorkspaceFile,
    readWorkspaceFilePreviewBuffer,
    isLikelyBinaryPreviewBuffer,
    isLikelyTextContentType,
    workspacePreviewKindForMeta,
    workspaceContentType,
    persistUploadBuffer,
    isSha256,
    uploadPathForSha,
    uploadContentUrlForSha,
    maybeApplyWorkspaceRootFromMessage,
    getOrCreateConversation,
    ensureRuntimeSessionBinding,
    linkUploadReferences,
    normalizeAttachments,
    collectReferenceAttachmentsFromText,
    mergeMessageAttachments,
    attachmentSummary,
    createCompactedConversation,
    workspaceRootPayload,
    queueCounts,
    getModelCatalogState,
    buildRelayReadyBannerData,
    ensureSessionId,
    touchCli,
    recoverProcessingOlderThan,
    addMsIso,
    computeRetryDelayMs,
    resolveRequestedModel,
    normalizeRelayMode,
    DEFAULT_RELAY_MODE,
    DEFAULT_MODEL,
    configuredConversationSessionMode,
    parseAttachments,
    hydrateAttachment,
    relayActivityForResponse,
    relayActivityForQueueMessage,
    sanitizeActivityText,
    inFlightStateForConversation,
    emitToClientsExceptSessionId,
    relayBridgeOwnerService,
    relayRestartOrchestrator,
    featureFlags,
    sessionWorkerRegistry,
    sessionWorkerSupervisor,
  } = deps;

  function readBridgeIdentity(req) {
    return relayBridgeOwnerService?.normalizeIdentity?.({
      pid: req.headers['x-relay-process-pid'],
      parentPid: req.headers['x-relay-parent-pid'],
      sessionId: req.headers['x-relay-session-id'],
      conversationId: req.headers['x-relay-conversation-id'],
    }) || null;
  }

  function emitSessionWorkerTelemetry(event, {
    sessionId = null,
    workerId = null,
    conversationId = null,
    messageId = null,
    continuationId = null,
    state = null,
    retry = 0,
    pid = null,
    queue = null,
    level = 'log',
    extra = null,
  } = {}) {
    const envelope = buildSessionWorkerLogEnvelope({
      event,
      worker: workerId,
      session: sessionId,
      conversation: conversationId,
      message: messageId,
      continuation: continuationId,
      state,
      queue: queue ? toTelemetryQueueField(queue) : toTelemetryQueueField(queueCounts?.() || null),
      retry,
      pid,
    });
    const payload = extra && typeof extra === 'object'
      ? { ...envelope, ...extra }
      : envelope;
    const method = typeof console[level] === 'function' ? level : 'log';
    console[method](`[${ts()}] WORKER    ${JSON.stringify(payload)}`);
  }

  function normalizeBindingValue(value) {
    const text = String(value || '').trim();
    return text || null;
  }

  function getConversationSessionState(conversationId) {
    const normalizedConversationId = String(conversationId || '').trim();
    if (!normalizedConversationId) {
      return { ok: false, status: 400, error: 'Missing conversationId' };
    }
    const conversation = stmts.getConvAnyStatus.get(normalizedConversationId) || null;
    if (!conversation || String(conversation.status || '').trim() === 'deleted') {
      return { ok: false, status: 404, error: 'Conversation not found' };
    }
    const runtimeSession = stmts.getRuntimeSessionByConversation.get(normalizedConversationId) || null;
    const conversationSdkSessionId = normalizeBindingValue(conversation.sdk_session_id);
    const runtimeSessionSdkSessionId = normalizeBindingValue(runtimeSession?.sdk_session_id);
    return {
      ok: true,
      conversation,
      runtimeSession,
      conversationSdkSessionId,
      runtimeSessionSdkSessionId,
    };
  }

  function rejectSessionBinding(res, status, error, extra = {}) {
    return res.status(status).json({ error, ...extra });
  }

  function failQueueMessage({
    queueRow,
    messageId,
    conversationId,
    relayMode,
    model,
    responseText,
    failureRecord,
  }) {
    const now = new Date().toISOString();
    const responseId = uuidv4();
    const tx = db.transaction(() => {
      const result = stmts.setFailed.run(JSON.stringify(failureRecord), messageId);
      if (result.changes === 0) return false;
      stmts.setQueueResponseMessageId?.run(responseId, messageId);
      stmts.insertMsg.run(
        responseId,
        conversationId,
        'assistant',
        responseText,
        model || null,
        relayMode,
        null,
        now,
      );
      stmts.linkActivityToResponse?.run(responseId, messageId);
      stmts.updateConvTime.run(now, conversationId);
      stmts.pruneQueue?.run();
      return true;
    });
    const failed = tx();
    if (!failed) return null;
    io.emit('assistant_message', {
      conversationId,
      sourceMessageId: messageId,
      messageId: responseId,
      message: {
        role: 'assistant',
        text: responseText,
        model: model || null,
        mode: relayMode,
        timestamp: now,
      },
    });
    io.emit('message_status', { messageId, conversationId, status: 'failed' });
    const ownerSessionId = isSessionWorkerRoutingEnabled(featureFlags)
      ? normalizeSessionWorkerId(queueRow?.owner_sdk_session_id)
      : null;
    if (ownerSessionId) {
      sessionWorkerSupervisor?.markError?.(ownerSessionId, `queue-failed:${failureRecord?.code || failureRecord?.error || 'unknown'}`);
      emitSessionWorkerTelemetry('queue.message.failed', {
        sessionId: ownerSessionId,
        workerId: sessionWorkerRegistry?.getWorker?.(ownerSessionId)?.workerId || null,
        conversationId,
        messageId,
        continuationId: null,
        state: 'error',
        retry: Number(queueRow?.retry_count || 0),
        pid: null,
        extra: failureRecord?.code
          ? {
              failureKind: failureRecord?.kind || null,
              failureCode: failureRecord?.code || null,
              functionCallId: failureRecord?.functionCallId || null,
              requestId: failureRecord?.requestId || null,
            }
          : null,
      });
    }
    return { responseId, now };
  }

  const findPendingOwnedByOtherSession = db.prepare(`
    SELECT id, conversation_id, owner_sdk_session_id
    FROM queue
    WHERE status = 'pending'
      AND owner_sdk_session_id IS NOT NULL
      AND owner_sdk_session_id != ''
      AND owner_sdk_session_id != ?
      AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
    ORDER BY retry_count ASC, CASE WHEN next_attempt_at IS NULL THEN 0 ELSE 1 END ASC, COALESCE(next_attempt_at, timestamp) ASC, timestamp ASC
    LIMIT 1
  `);
  const findActiveOwnedBySession = db.prepare(`
    SELECT *
    FROM queue
    WHERE owner_sdk_session_id = ?
      AND status IN ('processing', 'pending', 'parked')
    ORDER BY
      CASE status WHEN 'processing' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END ASC,
      timestamp ASC
    LIMIT 1
  `);

  app.post('/api/upload', auth, express.raw({ type: () => true, limit: `${MAX_UPLOAD_BYTES}b` }), (req, res) => {
    const payload = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!payload.length) return res.status(400).json({ error: 'Empty upload payload' });
    if (payload.length > MAX_UPLOAD_BYTES) return res.status(400).json({ error: 'Uploaded file too large' });

    const rawNameHeader = String(req.headers['x-file-name'] || req.query.name || '').trim();
    let decodedName = '';
    try { decodedName = decodeURIComponent(rawNameHeader); } catch { decodedName = rawNameHeader; }
    const fileName = decodedName || `upload-${Date.now()}`;
    const fileType = String(req.headers['x-file-type'] || req.headers['content-type'] || req.query.type || 'application/octet-stream').trim().toLowerCase();

    try {
      const attachment = persistUploadBuffer(payload, { name: fileName, type: fileType });
      if (!attachment) return res.status(500).json({ error: 'Upload persistence failed' });
      res.json({ ok: true, attachment });
    } catch (e) {
      res.status(400).json({ error: e?.message || 'Upload failed' });
    }
  });

  app.get('/api/upload/:sha256/content', auth, (req, res) => {
    const sha256 = String(req.params.sha256 || '').trim().toLowerCase();
    if (!isSha256(sha256)) return res.status(400).json({ error: 'Invalid file id' });
    const file = stmts.getUploadFile.get(sha256);
    if (!file) return res.status(404).json({ error: 'Not found' });
    const filePath = uploadPathForSha(sha256);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Missing file on disk' });
    res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    fs.createReadStream(filePath).pipe(res);
  });

  app.get('/api/files/*', auth, (req, res) => {
    const requestedPath = String(req.params?.[0] || '').trim();
    const filePath = resolveWorkspaceFilePath(requestedPath);
    if (!filePath) return res.status(400).json({ error: 'Invalid file path' });

    let meta = null;
    try {
      meta = readWorkspaceFileMeta(filePath);
    } catch (error) {
      return res.status(500).json({ error: error?.message || 'Failed to read file metadata' });
    }

    if (!meta || meta.kind === 'missing') return res.status(404).json({ error: 'File not found' });
    if (meta.kind !== 'file') return res.status(400).json({ error: 'Path must reference a file' });

    const safeName = path.basename(filePath).replace(/"/g, '');
    res.setHeader('Content-Type', meta.contentType);
    res.setHeader('Content-Length', String(meta.size));
    res.setHeader('Content-Disposition', `inline; filename="${safeName}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    const stream = fs.createReadStream(filePath);
    stream.on('error', (error) => {
      workspaceFileMetaCache.delete(filePath);
      if (res.headersSent) {
        res.destroy(error);
        return;
      }
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
        res.status(404).json({ error: 'File not found' });
        return;
      }
      res.status(500).json({ error: 'Failed to read file' });
    });
    stream.pipe(res);
  });

  app.get('/api/files-preview/*', auth, (req, res) => {
    const requestedPath = String(req.params?.[0] || '').trim();
    const normalizedPath = normalizeWorkspaceRelativePath(requestedPath);
    const filePath = resolveWorkspaceFilePath(requestedPath);
    if (!filePath || !normalizedPath) return res.status(400).json({ error: 'Invalid file path' });

    let meta = null;
    try {
      meta = readWorkspaceFileMeta(filePath);
    } catch (error) {
      return res.status(500).json({ error: error?.message || 'Failed to read file metadata' });
    }

    if (!meta || meta.kind === 'missing') return res.status(404).json({ error: 'File not found' });
    if (meta.kind !== 'file') return res.status(400).json({ error: 'Path must reference a file' });

    const ext = path.extname(filePath).toLowerCase();
    const size = Number(meta.size || 0);
    const contentType = meta.contentType || workspaceContentType(filePath);
    const language = previewLanguageForWorkspaceFile(filePath);

    let previewBuffer = Buffer.alloc(0);
    try {
      previewBuffer = readWorkspaceFilePreviewBuffer(filePath, size);
    } catch (error) {
      workspaceFileMetaCache.delete(filePath);
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
        return res.status(404).json({ error: 'File not found' });
      }
      return res.status(500).json({ error: 'Failed to read file' });
    }

    const truncated = size > MAX_WORKSPACE_PREVIEW_BYTES;
    const contentBuffer = truncated
      ? previewBuffer.subarray(0, Math.min(previewBuffer.length, MAX_WORKSPACE_PREVIEW_BYTES))
      : previewBuffer;

    const likelyBinaryType = contentType === 'application/pdf'
      || contentType === 'application/octet-stream';
    const likelyBinaryBytes = isLikelyBinaryPreviewBuffer(contentBuffer);
    const likelyTextType = isLikelyTextContentType(contentType);

    let kind = workspacePreviewKindForMeta(ext, contentType);
    if ((kind === 'markdown' || kind === 'code' || kind === 'text') && likelyBinaryType) {
      kind = 'binary';
    } else if ((kind === 'markdown' || kind === 'code' || kind === 'text') && (!likelyTextType && likelyBinaryBytes)) {
      kind = 'binary';
    }

    const normalizedWebPath = normalizedPath.replace(/\\/g, '/');
    const payload = {
      ok: true,
      path: normalizedWebPath,
      name: path.basename(filePath),
      kind,
      language,
      contentType,
      size,
      truncated,
      previewBytes: contentBuffer.length,
      rawUrl: `${remotePath}/api/files/${normalizedWebPath.split('/').map((part) => encodeURIComponent(part)).join('/')}`,
    };

    if (kind !== 'binary' && kind !== 'image') {
      payload.content = contentBuffer.toString('utf8');
    }

    res.setHeader('Cache-Control', 'no-store');
    res.json(payload);
  });

  app.get('/api/repo/tree', auth, (req, res) => {
    const includeHidden = parseBooleanQueryFlag(req.query.includeHidden, false);
    const includeHeavy = parseBooleanQueryFlag(req.query.includeHeavy, false);
    const snapshot = buildRepositoryTreeSnapshot({ includeHidden, includeHeavy, maxNodes: MAX_REPO_TREE_NODES });
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      ok: true,
      ...snapshot,
    });
  });

  app.get('/api/drives/roots', auth, (req, res) => {
    fetchBrowsableDrives((err, drives) => {
      if (err) return res.status(500).json({ error: err.message || 'Failed to enumerate drives' });
      const root = {
        path: '',
        name: 'Drives',
        type: 'dir',
        children: drives.map((drive) => ({
          path: drive.webPath,
          name: driveDisplayName(drive),
          type: 'dir',
          driveType: drive.driveType,
          label: drive.label || '',
          sizeBytes: drive.sizeBytes,
          freeBytes: drive.freeBytes,
          children: [],
          lazy: true,
          childrenLoaded: false,
        })),
        childrenLoaded: true,
      };
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        ok: true,
        root,
        nodeCount: root.children.length + 1,
        truncated: false,
        maxNodes: root.children.length + 1,
        includeHidden: false,
        includeHeavy: false,
        rootName: 'Drives',
        driveTypes: ['fixed', 'removable'],
      });
    });
  });

  app.get('/api/drives/list', auth, (req, res) => {
    const includeHidden = parseBooleanQueryFlag(req.query.includeHidden, false);
    const requestedPath = String(req.query.path || '').trim();

    fetchBrowsableDrives((drivesErr, drives) => {
      if (drivesErr) return res.status(500).json({ error: drivesErr.message || 'Failed to enumerate drives' });
      const allowedRoots = new Set(drives.map((drive) => drive.rootAbsolute.toUpperCase()));
      const absolutePath = normalizeDriveAbsolutePath(requestedPath);
      const rootAbsolute = driveRootFromAbsolutePath(absolutePath).toUpperCase();
      if (!absolutePath || !rootAbsolute || !allowedRoots.has(rootAbsolute)) {
        return res.status(400).json({ error: 'Invalid drive path' });
      }

      let stat = null;
      try {
        stat = fs.statSync(absolutePath);
      } catch (error) {
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return res.status(404).json({ error: 'Path not found' });
        return res.status(500).json({ error: error?.message || 'Failed to read path metadata' });
      }
      if (!stat.isDirectory()) return res.status(400).json({ error: 'Path must reference a directory' });

      fetchDriveDirectoryEntries(absolutePath, { includeHidden }, (listErr, entries) => {
        if (listErr) return res.status(500).json({ error: listErr.message || 'Failed to list directory' });
        const children = entries
          .map(mapDriveDirectoryEntry)
          .filter((entry) => {
            if (!entry?.path) return false;
            const entryRoot = driveRootFromAbsolutePath(entry.path).toUpperCase();
            return allowedRoots.has(entryRoot);
          });
        const driveMeta = drives.find((drive) => drive.rootAbsolute.toUpperCase() === rootAbsolute);
        const nodePath = toDriveWebPath(absolutePath);
        const node = {
          path: nodePath,
          name: absolutePath.length <= 3 ? driveDisplayName(driveMeta) : (path.win32.basename(absolutePath) || nodePath),
          type: 'dir',
          driveType: driveMeta?.driveType || null,
          label: driveMeta?.label || '',
          children,
          childrenLoaded: true,
        };
        res.setHeader('Cache-Control', 'no-store');
        res.json({
          ok: true,
          node,
          includeHidden,
        });
      });
    });
  });

  app.get('/api/drives/file', auth, (req, res) => {
    const requestedPath = String(req.query.path || '').trim();
    fetchBrowsableDrives((drivesErr, drives) => {
      if (drivesErr) return res.status(500).json({ error: drivesErr.message || 'Failed to enumerate drives' });
      const allowedRoots = new Set(drives.map((drive) => drive.rootAbsolute.toUpperCase()));
      const filePath = normalizeDriveAbsolutePath(requestedPath);
      const rootAbsolute = driveRootFromAbsolutePath(filePath).toUpperCase();
      if (!filePath || !rootAbsolute || !allowedRoots.has(rootAbsolute)) {
        return res.status(400).json({ error: 'Invalid drive file path' });
      }

      let meta = null;
      try {
        meta = readWorkspaceFileMeta(filePath);
      } catch (error) {
        return res.status(500).json({ error: error?.message || 'Failed to read file metadata' });
      }

      if (!meta || meta.kind === 'missing') return res.status(404).json({ error: 'File not found' });
      if (meta.kind !== 'file') return res.status(400).json({ error: 'Path must reference a file' });

      const safeName = path.win32.basename(filePath).replace(/"/g, '');
      res.setHeader('Content-Type', meta.contentType);
      res.setHeader('Content-Length', String(meta.size));
      res.setHeader('Content-Disposition', `inline; filename="${safeName}"`);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');

      const stream = fs.createReadStream(filePath);
      stream.on('error', (error) => {
        workspaceFileMetaCache.delete(filePath);
        if (res.headersSent) {
          res.destroy(error);
          return;
        }
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
          res.status(404).json({ error: 'File not found' });
          return;
        }
        res.status(500).json({ error: 'Failed to read file' });
      });
      stream.pipe(res);
    });
  });

  app.get('/api/drives/files-preview', auth, (req, res) => {
    const requestedPath = String(req.query.path || '').trim();
    fetchBrowsableDrives((drivesErr, drives) => {
      if (drivesErr) return res.status(500).json({ error: drivesErr.message || 'Failed to enumerate drives' });
      const allowedRoots = new Set(drives.map((drive) => drive.rootAbsolute.toUpperCase()));
      const filePath = normalizeDriveAbsolutePath(requestedPath);
      const rootAbsolute = driveRootFromAbsolutePath(filePath).toUpperCase();
      if (!filePath || !rootAbsolute || !allowedRoots.has(rootAbsolute)) {
        return res.status(400).json({ error: 'Invalid drive file path' });
      }

      let meta = null;
      try {
        meta = readWorkspaceFileMeta(filePath);
      } catch (error) {
        return res.status(500).json({ error: error?.message || 'Failed to read file metadata' });
      }

      if (!meta || meta.kind === 'missing') return res.status(404).json({ error: 'File not found' });
      if (meta.kind !== 'file') return res.status(400).json({ error: 'Path must reference a file' });

      const ext = path.extname(filePath).toLowerCase();
      const size = Number(meta.size || 0);
      const contentType = meta.contentType || workspaceContentType(filePath);
      const language = previewLanguageForWorkspaceFile(filePath);

      let previewBuffer = Buffer.alloc(0);
      try {
        previewBuffer = readWorkspaceFilePreviewBuffer(filePath, size);
      } catch (error) {
        workspaceFileMetaCache.delete(filePath);
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
          return res.status(404).json({ error: 'File not found' });
        }
        return res.status(500).json({ error: 'Failed to read file' });
      }

      const truncated = size > MAX_WORKSPACE_PREVIEW_BYTES;
      const contentBuffer = truncated
        ? previewBuffer.subarray(0, Math.min(previewBuffer.length, MAX_WORKSPACE_PREVIEW_BYTES))
        : previewBuffer;

      const likelyBinaryType = contentType === 'application/pdf'
        || contentType === 'application/octet-stream';
      const likelyBinaryBytes = isLikelyBinaryPreviewBuffer(contentBuffer);
      const likelyTextType = isLikelyTextContentType(contentType);

      let kind = workspacePreviewKindForMeta(ext, contentType);
      if ((kind === 'markdown' || kind === 'code' || kind === 'text') && likelyBinaryType) {
        kind = 'binary';
      } else if ((kind === 'markdown' || kind === 'code' || kind === 'text') && (!likelyTextType && likelyBinaryBytes)) {
        kind = 'binary';
      }

      const normalizedWebPath = toDriveWebPath(filePath);
      const payload = {
        ok: true,
        path: normalizedWebPath,
        name: path.win32.basename(filePath),
        kind,
        language,
        contentType,
        size,
        truncated,
        previewBytes: contentBuffer.length,
        rawUrl: `${remotePath}/api/drives/file?path=${encodeURIComponent(normalizedWebPath)}`,
      };

      if (kind !== 'binary' && kind !== 'image') {
        payload.content = contentBuffer.toString('utf8');
      }

      res.setHeader('Cache-Control', 'no-store');
      res.json(payload);
    });
  });

  // POST /api/message — browser sends a message
  app.post('/api/message', auth, (req, res) => {
    const { messageId: clientMessageId, clientId, conversationId, text, newConversation, model, relayMode, mode, attachments: rawAttachments } = req.body;
    const sessionId = clientId || ensureSessionId(req, res);
    const requesterIdentity = readBridgeIdentity(req);
    const requesterSessionId = normalizeSessionWorkerId(requesterIdentity?.sessionId);
    const sessionWorkerRoutingEnabled = isSessionWorkerRoutingEnabled(featureFlags);
    let conversationSdkSessionId = null;
    const requestedRelayMode = normalizeRelayMode(relayMode || mode);
    const trimmedText = stripRelayPromptContext(text, requestedRelayMode || relayMode || mode);
    const normalizedAttachments = normalizeAttachments(rawAttachments);
    const referenceResolution = collectReferenceAttachmentsFromText(trimmedText);
    const attachments = mergeMessageAttachments(normalizedAttachments, referenceResolution.attachments);

    if (trimmedText.toLowerCase() === '/compact') {
      if (attachments.length) return res.status(400).json({ error: 'Compact command does not accept attachments' });
      if (!conversationId) return res.status(400).json({ error: 'Compact command requires an existing conversation' });
      const compacted = createCompactedConversation(conversationId);
      if (!compacted) return res.status(404).json({ error: 'Conversation not found' });
      io.emit('conversation_compacted', compacted);
      return res.json({
        ok: true,
        command: 'compact',
        compacted: true,
        sourceConversationId: compacted.sourceConversationId,
        conversationId: compacted.targetConversationId,
        compactedConversationId: compacted.targetConversationId,
        runtimeSessionId: compacted.runtimeSessionId,
        summarySeedPreview: compacted.summarySeed.slice(0, 240),
      });
    }

    if (!trimmedText && attachments.length === 0) return res.status(400).json({ error: 'Empty message' });
    const modelResolution = resolveRequestedModel(model);
    if (!modelResolution.ok) return res.status(400).json({ error: modelResolution.error, supportedModels: modelResolution.available || [] });
    const requestedModel = modelResolution.model;
    if (!requestedRelayMode) return res.status(400).json({ error: 'Unsupported relay mode' });
    const workspaceRootUpdate = attachments.length === 0
      ? maybeApplyWorkspaceRootFromMessage(trimmedText)
      : { attempted: false, changed: false };
    const shouldCreateConversation = !!newConversation || !conversationId;

    if (!shouldCreateConversation) {
      const sessionState = getConversationSessionState(conversationId);
      if (!sessionState.ok) {
        return rejectSessionBinding(res, sessionState.status, sessionState.error);
      }
      conversationSdkSessionId = sessionState.conversationSdkSessionId || null;
      if (!sessionState.conversationSdkSessionId || !sessionState.runtimeSessionSdkSessionId) {
        return rejectSessionBinding(res, 409, 'Conversation is not session-bound yet');
      }
      if (sessionState.conversationSdkSessionId !== sessionState.runtimeSessionSdkSessionId) {
        return rejectSessionBinding(res, 409, 'Conversation session binding mismatch');
      }
    }

    if (!shouldCreateConversation) {
      const recentUserMessages = stmts.getRecentMessagesDesc.all(conversationId, 20);
      const recentQueueRows = db.prepare(`
        SELECT id, text, status, timestamp
        FROM queue
        WHERE conversation_id = ?
        ORDER BY timestamp DESC
        LIMIT 20
      `).all(conversationId);
      const duplicateMessage = findRecentDuplicateUserMessage({
        recentUserMessages,
        recentQueueRows,
        text: trimmedText,
      });
      if (duplicateMessage) {
        return res.json({
          ok: true,
          duplicate: true,
          duplicateWindowMs: DUPLICATE_USER_MESSAGE_WINDOW_MS,
          duplicateSource: duplicateMessage.source,
          duplicateOfMessageId: duplicateMessage.messageId,
          duplicateOfTimestamp: duplicateMessage.timestamp,
          conversationId,
        });
      }
    }

    const convId = shouldCreateConversation ? uuidv4() : conversationId;
    if (shouldCreateConversation) {
      getOrCreateConversation(convId, trimmedText || attachmentSummary(attachments) || 'Image');
    }
    const convSeed = stmts.getConvSeed.get(convId);
    const shouldApplySeed = Number(convSeed?.seed_pending || 0) > 0 && String(convSeed?.summary_seed || '').trim().length > 0;

    const now   = new Date().toISOString();
    const runtimeSession = ensureRuntimeSessionBinding(convId, requestedModel, now);
    const ownerSessionId = resolveInitialQueueOwnerSessionId({
      routingEnabled: sessionWorkerRoutingEnabled,
      requesterSessionId,
      runtimeSession,
      conversationSdkSessionId,
    });
    const msgId = clientMessageId || uuidv4();
    const queueText = shouldApplySeed
      ? [
          '[Carry-over context from previous compacted conversation]',
          String(convSeed.summary_seed).trim(),
          '',
          '[New user request]',
          trimmedText || '(User sent image attachments only.)',
        ].join('\n')
      : trimmedText;

    stmts.insertMsg.run(msgId, convId, 'user', trimmedText, requestedModel, requestedRelayMode, attachments.length ? JSON.stringify(attachments) : null, now);
    linkUploadReferences(convId, msgId, attachments);
    stmts.updateConvTime.run(now, convId);
    stmts.insertQ.run(
      msgId,
      convId,
      runtimeSession?.id || null,
      (!conversationId || !!newConversation) ? 1 : 0,
      requestedModel,
      requestedRelayMode,
      queueText,
      attachments.length ? JSON.stringify(attachments) : null,
      now,
      ownerSessionId,
      ownerSessionId ? now : null,
      null,
      null,
    );
    if (ownerSessionId) {
      const existingWorker = sessionWorkerRegistry?.getWorker?.(ownerSessionId) || null;
      sessionWorkerRegistry?.upsertWorker?.({
        ...(existingWorker || {}),
        sdkSessionId: ownerSessionId,
        conversationId: convId,
        runtimeSessionId: runtimeSession?.id || null,
        status: existingWorker?.status || 'new',
      });
      const pendingDepth = Number(queueCounts?.().pendingCount || 0);
      sessionWorkerSupervisor?.markIdle?.(ownerSessionId, pendingDepth);
      if (sessionWorkerRoutingEnabled) {
        emitSessionWorkerTelemetry('queue.message.queued', {
          sessionId: ownerSessionId,
          workerId: existingWorker?.workerId || null,
          conversationId: convId,
          messageId: msgId,
          continuationId: null,
          state: existingWorker?.status || 'new',
          retry: 0,
          pid: existingWorker?.pid || null,
        });
        const activeOwnerSessionId = normalizeSessionWorkerId(relayBridgeOwnerService?.getOwner?.()?.sessionId);
        const shouldPrimeWorker = ownerSessionId !== activeOwnerSessionId;
        if (shouldPrimeWorker && typeof sessionWorkerSupervisor?.ensureWorker === 'function') {
          void sessionWorkerSupervisor.ensureWorker(ownerSessionId).then((result) => {
            if (!result?.ok) {
              emitSessionWorkerTelemetry('worker.prime.failed', {
                sessionId: ownerSessionId,
                workerId: result?.worker?.workerId || null,
                conversationId: convId,
                messageId: msgId,
                continuationId: null,
                state: result?.worker?.status || 'error',
                retry: result?.lifecycle?.retryCount || 0,
                pid: result?.worker?.pid || null,
                level: 'warn',
                extra: { blockedReason: String(result?.error || 'worker-prime-failed') },
              });
            }
          }).catch((error) => {
            emitSessionWorkerTelemetry('worker.prime.failed', {
              sessionId: ownerSessionId,
              workerId: null,
              conversationId: convId,
              messageId: msgId,
              continuationId: null,
              state: 'error',
              retry: 0,
              pid: null,
              level: 'warn',
              extra: { error: String(error?.message || error || 'worker-prime-failed') },
            });
          });
        }
      }
    }
    if (shouldApplySeed) {
      stmts.clearConvSeed.run(now, convId);
    }

    console.log(`[${ts()}] QUEUED    ${msgId.slice(0,8)} conv=${convId.slice(0,8)} rs=${String(runtimeSession?.id || 'none').slice(0,8)} owner=${String(ownerSessionId || 'none').slice(0,8)} new=${!conversationId || !!newConversation} model=${requestedModel} mode=${requestedRelayMode} text="${trimmedText.slice(0,60)}"${shouldApplySeed ? ' seeded=1' : ''}${attachments.length ? ` attachments=${attachments.length}` : ''}`);

    emitToClientsExceptSessionId(
      'user_message',
      { conversationId: convId, messageId: msgId, senderClientId: sessionId, message: { role: 'user', text: trimmedText, model: requestedModel, mode: requestedRelayMode, timestamp: now, attachments } },
      sessionId,
    );
    io.emit('message_status', { messageId: msgId, conversationId: convId, status: 'pending' });
    if (workspaceRootUpdate.changed) {
      io.emit('workspace_root_changed', {
        source: 'chat-cd-command',
        commandTarget: workspaceRootUpdate.target || null,
        ...workspaceRootPayload(),
      });
    }
    res.json({
      ok: true,
      messageId: msgId,
      conversationId: convId,
      runtimeSessionId: runtimeSession?.id || null,
      ownerSessionId: ownerSessionId || null,
      warning: modelResolution.warning || null,
      workspaceRootWarning: workspaceRootUpdate.error || null,
      workspaceRootChanged: !!workspaceRootUpdate.changed,
      ...workspaceRootPayload(),
      referenceAttachmentCount: referenceResolution.attachments.length,
      skippedReferenceAttachments: referenceResolution.skipped,
    });
  });

  app.post('/api/heartbeat', auth, (req, res) => {
    touchCli();
    const requester = readBridgeIdentity(req);
    const requesterSessionId = normalizeSessionWorkerId(requester?.sessionId);
    if (requesterSessionId) {
      sessionWorkerSupervisor?.noteSessionHeartbeat?.(requesterSessionId);
    }
    relayBridgeOwnerService?.observe?.(requester);
    const { pendingCount } = queueCounts();
    res.json({ ok: true, pendingCount });
  });

  // GET /api/pending — CLI fetches next pending message
  app.get('/api/pending', auth, async (req, res) => {
    touchCli();
    const requester = readBridgeIdentity(req);
    const requesterSessionId = normalizeSessionWorkerId(requester?.sessionId);
    const sessionWorkerRoutingEnabled = isSessionWorkerRoutingEnabled(featureFlags);
    const ownerObservation = relayBridgeOwnerService?.observe?.(requester) || null;
    if (requester && ownerObservation?.accepted === false && !sessionWorkerRoutingEnabled) {
      return res.json({
        message: null,
        ownerMismatch: true,
        activeBridgeOwner: relayBridgeOwnerService?.getOwner?.() || null,
        restartOrchestrator: relayRestartOrchestrator?.getState?.() || null,
      });
    }
    if (runtimeState.relayPaused) return res.json({ message: null, paused: true });
    const counts = queueCounts();
    if (sessionWorkerRoutingEnabled && requesterSessionId) {
      const existingRequesterWorker = sessionWorkerRegistry?.getWorker?.(requesterSessionId) || null;
      if (!existingRequesterWorker) {
        sessionWorkerRegistry?.upsertWorker?.({
          sdkSessionId: requesterSessionId,
          workerId: `worker-${requesterSessionId.slice(0, 8)}`,
          conversationId: requester?.conversationId || null,
          status: 'ready',
          pid: requester?.pid || null,
          queueDepth: Math.max(0, Number(counts.pendingCount || 0)),
        });
      } else if (requester?.pid && existingRequesterWorker.pid !== requester.pid) {
        sessionWorkerRegistry?.upsertWorker?.({
          ...existingRequesterWorker,
          sdkSessionId: requesterSessionId,
          conversationId: requester?.conversationId || existingRequesterWorker.conversationId || null,
          pid: requester.pid,
          status: existingRequesterWorker.status || 'ready',
          queueDepth: Math.max(0, Number(counts.pendingCount || 0)),
        });
      }
      sessionWorkerSupervisor?.noteSessionHeartbeat?.(requesterSessionId);
    }
    const restartProbe = relayRestartOrchestrator?.onDequeueProbe({
      processingCount: counts.processingCount,
      cliOnline: runtimeState.cliOnline,
    }) || null;
    const shouldUseRestartQueueGate = !sessionWorkerRoutingEnabled;
    const parkedCount = shouldUseRestartQueueGate ? parkPendingQueueForRestart({ stmts, state: restartProbe?.state }) : 0;
    const releasedRows = shouldUseRestartQueueGate ? releaseParkedQueueForReadyState({ db, stmts, state: restartProbe?.state }) : [];
    for (const row of releasedRows) {
      io.emit('message_status', { messageId: row.id, conversationId: row.conversation_id, status: 'pending' });
    }
    if (shouldUseRestartQueueGate && restartProbe?.blockDequeue) {
      return res.json({
        message: null,
        restartOrchestrator: restartProbe.state || relayRestartOrchestrator?.getState?.() || null,
        control: restartProbe.control || null,
        parkedCount,
        releasedCount: releasedRows.length,
      });
    }

    const now = new Date().toISOString();
    let dequeueResult = null;
    try {
      dequeueResult = await dequeuePendingMessageForWorkerLoop({
        db,
        stmts,
        nowIso: now,
        routingEnabled: sessionWorkerRoutingEnabled,
        requesterSessionId,
        ownerLeaseMs: SESSION_WORKER_OWNER_LEASE_MS,
        sessionWorkerSupervisor,
        relayRestartOrchestrator,
        inFlightProcessingCount: Number(counts.processingCount || 0),
        telemetry: (payload = {}) => {
          if (!sessionWorkerRoutingEnabled) return;
          emitSessionWorkerTelemetry(payload.event, {
            sessionId: payload.sessionId || requesterSessionId,
            workerId: payload.workerId || null,
            conversationId: payload.conversationId || null,
            messageId: payload.messageId || null,
            continuationId: payload.continuationId || null,
            state: payload.state || null,
            retry: payload.retry || 0,
            pid: payload.pid || requester?.pid || null,
            queue: counts,
            level: payload.event === 'queue.dequeue.error' ? 'warn' : 'log',
            extra: payload.error ? { error: payload.error, blockedReason: payload.blockedReason || null } : (payload.blockedReason ? { blockedReason: payload.blockedReason } : null),
          });
        },
      });
    } catch (error) {
      console.warn(`[${ts()}] DEQUEUE   failed requester=${String(requesterSessionId || 'none').slice(0, 8)} err=${String(error?.message || error || 'unknown dequeue failure')}`);
      if (sessionWorkerRoutingEnabled) {
        emitSessionWorkerTelemetry('queue.dequeue.failure', {
          sessionId: requesterSessionId,
          workerId: sessionWorkerRegistry?.getWorker?.(requesterSessionId)?.workerId || null,
          conversationId: null,
          messageId: null,
          continuationId: null,
          state: 'error',
          retry: 0,
          pid: requester?.pid || null,
          queue: counts,
          level: 'warn',
          extra: { error: String(error?.message || error || 'unknown dequeue failure') },
        });
      }
      return res.status(500).json({
        error: 'Failed to dequeue pending message',
        restartOrchestrator: relayRestartOrchestrator?.getState?.() || null,
        parkedCount,
        releasedCount: releasedRows.length,
      });
    }
    const msg = dequeueResult?.message || null;
    const dequeueBlockedReason = String(dequeueResult?.blockedReason || '').trim() || null;
    const fallbackRestart = dequeueResult?.fallbackRestart || null;
    let primedSessionId = null;
    if (!msg && sessionWorkerRoutingEnabled && requesterSessionId && dequeueBlockedReason) {
      const blockedTerminalFailure = resolveBlockedWorkerTerminalFailure({
        blockedReason: dequeueBlockedReason,
        requesterSessionId,
        lifecycle: dequeueResult?.lifecycle || null,
        worker: dequeueResult?.worker || null,
      });
      if (blockedTerminalFailure) {
        const blockedRow = findActiveOwnedBySession.get(requesterSessionId);
        if (blockedRow) {
          const failureText = buildTerminalFailureTextForChat({
            code: blockedTerminalFailure.code,
            stableCode: blockedTerminalFailure.stableCode,
            message: blockedTerminalFailure.message,
            detail: blockedTerminalFailure.detail,
            guidance: blockedTerminalFailure.guidance,
            requestId: blockedRow?.id || null,
          });
          failQueueMessage({
            queueRow: blockedRow,
            messageId: blockedRow.id,
            conversationId: blockedRow.conversation_id,
            relayMode: normalizeRelayMode(blockedRow.relay_mode) || DEFAULT_RELAY_MODE,
            model: blockedRow.model || null,
            responseText: failureText,
            failureRecord: blockedTerminalFailure,
          });
        }
      }
      emitSessionWorkerTelemetry('queue.dequeue.blocked', {
        sessionId: requesterSessionId,
        workerId: dequeueResult?.worker?.workerId || null,
        conversationId: dequeueResult?.worker?.conversationId || null,
        messageId: null,
        continuationId: null,
        state: dequeueResult?.worker?.status || 'error',
        retry: dequeueResult?.lifecycle?.retryCount || 0,
        pid: requester?.pid || dequeueResult?.worker?.pid || null,
        queue: counts,
        extra: {
          blockedReason: dequeueBlockedReason,
          fallbackRestartRequested: fallbackRestart?.requested === true,
        },
      });
      return res.json({
        message: null,
        routing: {
          enabled: true,
          requesterSessionId,
          blockedReason: dequeueBlockedReason,
          lifecycle: dequeueResult?.lifecycle || null,
          fallbackRestart,
          terminalOutcome: fallbackRestart?.terminalOutcome || null,
        },
        restartOrchestrator: relayRestartOrchestrator?.getState?.() || null,
        parkedCount,
        releasedCount: releasedRows.length,
      });
    }
    if (!msg && sessionWorkerRoutingEnabled && requesterSessionId && !dequeueBlockedReason) {
      const strandedOwner = findPendingOwnedByOtherSession.get(requesterSessionId, now);
      const strandedSessionId = normalizeSessionWorkerId(strandedOwner?.owner_sdk_session_id);
      if (strandedSessionId && strandedSessionId !== requesterSessionId && typeof sessionWorkerSupervisor?.ensureWorker === 'function') {
        try {
          const primeResult = await sessionWorkerSupervisor.ensureWorker(strandedSessionId);
          const primedTerminalFailure = resolvePrimedWorkerTerminalFailure({
            sessionId: strandedSessionId,
            primeResult,
          });
          if (primedTerminalFailure && strandedOwner?.id && strandedOwner?.conversation_id) {
            const strandedRow = stmts.findQById.get(strandedOwner.id);
            if (strandedRow && ['processing', 'pending', 'parked'].includes(String(strandedRow.status || '').trim().toLowerCase())) {
              const failureText = buildTerminalFailureTextForChat({
                code: primedTerminalFailure.code,
                stableCode: primedTerminalFailure.stableCode,
                message: primedTerminalFailure.message,
                detail: primedTerminalFailure.detail,
                guidance: primedTerminalFailure.guidance,
                requestId: strandedRow.id,
              });
              failQueueMessage({
                queueRow: strandedRow,
                messageId: strandedRow.id,
                conversationId: strandedRow.conversation_id,
                relayMode: normalizeRelayMode(strandedRow.relay_mode) || DEFAULT_RELAY_MODE,
                model: strandedRow.model || null,
                responseText: failureText,
                failureRecord: primedTerminalFailure,
              });
            }
          }
          primedSessionId = strandedSessionId;
          emitSessionWorkerTelemetry('worker.prime.requested', {
            sessionId: strandedSessionId,
            workerId: primeResult?.worker?.workerId || null,
            conversationId: strandedOwner?.conversation_id || null,
            messageId: strandedOwner?.id || null,
            continuationId: null,
            state: primeResult?.worker?.status || (primeResult?.ok ? 'ready' : 'error'),
            retry: primeResult?.lifecycle?.retryCount || 0,
            pid: primeResult?.worker?.pid || null,
            queue: counts,
            level: primeResult?.ok ? 'log' : 'warn',
            extra: primeResult?.ok ? null : { blockedReason: String(primeResult?.error || 'worker-prime-failed') },
          });
        } catch (error) {
          emitSessionWorkerTelemetry('worker.prime.failed', {
            sessionId: strandedSessionId,
            workerId: null,
            conversationId: strandedOwner?.conversation_id || null,
            messageId: strandedOwner?.id || null,
            continuationId: null,
            state: 'error',
            retry: 0,
            pid: null,
            queue: counts,
            level: 'warn',
            extra: { error: String(error?.message || error || 'worker-prime-failed') },
          });
        }
      }
    }
    if (msg) {
      const attachments = parseAttachments(msg.attachments).map(hydrateAttachment).filter(Boolean);
      let runtimeSession = msg.runtime_session_id
        ? stmts.getRuntimeSessionById.get(msg.runtime_session_id)
        : null;
      if (!runtimeSession) {
        const now = new Date().toISOString();
        runtimeSession = ensureRuntimeSessionBinding(
          msg.conversation_id,
          String(msg.model || '').trim() || null,
          now,
        );
        if (runtimeSession?.id && runtimeSession.id !== msg.runtime_session_id) {
          stmts.setQueueRuntimeSession.run(runtimeSession.id, msg.id);
        }
      }
      // Normalise snake_case → camelCase for the relay
      const out = {
        id:                msg.id,
        conversationId:    msg.conversation_id,
        runtimeSessionId:  runtimeSession?.id || null,
        isNewConversation: msg.is_new_conversation === 1,
        model:             String(msg.model || '').trim() || getModelCatalogState().currentModel || DEFAULT_MODEL,
        relayMode:         normalizeRelayMode(msg.relay_mode) || DEFAULT_RELAY_MODE,
        text:              msg.text,
        attachments,
        conversationSessionMode: configuredConversationSessionMode,
        status:            msg.status,
        timestamp:         msg.timestamp,
        processingAt:      msg.processing_at,
        ownerSessionId:    String(msg.owner_sdk_session_id || '').trim() || null,
        ownerAssignedAt:   msg.owner_assigned_at || null,
        ownerLeaseExpiresAt: msg.owner_lease_expires_at || null,
      };
      if (sessionWorkerRoutingEnabled && out.ownerSessionId) {
        const existingWorker = sessionWorkerRegistry?.getWorker?.(out.ownerSessionId) || null;
        sessionWorkerRegistry?.upsertWorker?.({
          ...(existingWorker || {}),
          sdkSessionId: out.ownerSessionId,
          conversationId: out.conversationId,
          runtimeSessionId: out.runtimeSessionId,
          status: 'processing',
        });
        const processingDepth = Number(counts.processingCount || 0);
        sessionWorkerSupervisor?.markProcessing?.(out.ownerSessionId, processingDepth);
      }
      if (sessionWorkerRoutingEnabled) {
        emitSessionWorkerTelemetry('queue.message.dequeued', {
          sessionId: out.ownerSessionId || requesterSessionId,
          workerId: sessionWorkerRegistry?.getWorker?.(out.ownerSessionId || requesterSessionId)?.workerId || null,
          conversationId: out.conversationId,
          messageId: out.id,
          continuationId: null,
          state: 'processing',
          retry: Number(msg.retry_count || 0),
          pid: requester?.pid || null,
          queue: counts,
        });
      }
      console.log(`[${ts()}] DEQUEUED  ${out.id.slice(0,8)} conv=${out.conversationId.slice(0,8)} rs=${String(out.runtimeSessionId || 'none').slice(0,8)} owner=${String(out.ownerSessionId || 'none').slice(0,8)} model=${out.model} mode=${out.relayMode} text="${out.text.slice(0,60)}"${attachments.length ? ` attachments=${attachments.length}` : ''}`);
      io.emit('message_status', { messageId: out.id, conversationId: out.conversationId, status: 'processing' });
      res.json({
        message: out,
        routing: sessionWorkerRoutingEnabled ? {
          enabled: true,
          requesterSessionId,
        } : { enabled: false },
        restartOrchestrator: relayRestartOrchestrator?.getState?.() || null,
        parkedCount,
        releasedCount: releasedRows.length,
      });
    } else {
      if (sessionWorkerRoutingEnabled && requesterSessionId) {
        const pendingDepth = Number(queueCounts?.().pendingCount || 0);
        sessionWorkerSupervisor?.markIdle?.(requesterSessionId, pendingDepth);
        emitSessionWorkerTelemetry('queue.dequeue.idle', {
          sessionId: requesterSessionId,
          workerId: sessionWorkerRegistry?.getWorker?.(requesterSessionId)?.workerId || null,
          conversationId: null,
          messageId: null,
          continuationId: null,
          state: 'ready',
          retry: 0,
          pid: requester?.pid || null,
          queue: counts,
        });
      }
      res.json({
        message: null,
        routing: sessionWorkerRoutingEnabled ? {
          enabled: true,
          requesterSessionId,
          primedSessionId,
          terminalOutcome: null,
        } : { enabled: false },
        restartOrchestrator: relayRestartOrchestrator?.getState?.() || null,
        parkedCount,
        releasedCount: releasedRows.length,
      });
    }
  });

  app.post('/api/relay/pause', auth, (req, res) => {
    runtimeState.relayPaused = true;
    const rows = stmts.listQueueForPauseDrop.all();
    const dropQueue = db.transaction(() => {
      for (const row of rows) {
        stmts.deleteQueueById.run(row.id);
      }
    });
    dropQueue();

    for (const row of rows) {
      io.emit('message_status', { messageId: row.id, conversationId: row.conversation_id, status: 'dropped' });
    }

    io.emit('relay_pause_state', { paused: true, droppedCount: rows.length });
    console.log(`[${ts()}] RELAY     paused dropped=${rows.length}`);
    res.json({ ok: true, paused: true, droppedCount: rows.length });
  });

  app.post('/api/relay/resume', auth, (req, res) => {
    runtimeState.relayPaused = false;
    io.emit('relay_pause_state', { paused: false });
    console.log(`[${ts()}] RELAY     resumed`);
    res.json({ ok: true, paused: false });
  });

  app.post('/api/relay/recover-processing', auth, (req, res) => {
    const rawMaxAge = Number(req.body?.maxAgeMs);
    const maxAgeMs = Number.isFinite(rawMaxAge)
      ? Math.max(5_000, Math.min(300_000, rawMaxAge))
      : 15_000;
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    const requeueAt = addMsIso(5_000);
    const rows = recoverProcessingOlderThan(cutoff, requeueAt);
    if (!rows.length) return res.json({ ok: true, recovered: 0, maxAgeMs });
    console.log(`[${ts()}] RELAY     recovered processing=${rows.length} maxAgeMs=${maxAgeMs}`);
    return res.json({ ok: true, recovered: rows.length, maxAgeMs });
  });

  // POST /api/response — CLI submits response
  app.post('/api/response', auth, (req, res) => {
    touchCli();
    const { messageId, conversationId, text, model, mode } = req.body;

    if (!text?.trim()) return res.status(400).json({ error: 'Empty response' });
    if (!messageId) return res.status(400).json({ error: 'Missing messageId' });

    const q = stmts.findQById.get(messageId);
    const targetConversationId = q?.conversation_id || conversationId;
    if (!targetConversationId) return res.status(400).json({ error: 'Missing conversationId' });

    if (q && q.status === 'done') {
      console.log(`[${ts()}] RESPONSE  ${messageId?.slice(0,8)} ignored=already_done`);
      return res.json({ ok: true, ignored: 'already_done' });
    }
    if (q && q.status === 'failed') {
      console.log(`[${ts()}] RESPONSE  ${messageId?.slice(0,8)} ignored=already_failed`);
      return res.json({ ok: true, ignored: 'already_failed' });
    }

    const relayMode = normalizeRelayMode(mode || q?.relay_mode) || DEFAULT_RELAY_MODE;
    const terminalFailure = resolveTerminalFailurePayload(req.body, { fallbackText: text });
    if (terminalFailure) {
      const failureText = buildTerminalFailureTextForChat(terminalFailure, text);
      const failed = failQueueMessage({
        queueRow: q,
        messageId,
        conversationId: targetConversationId,
        relayMode,
        model: model || q?.model || null,
        responseText: failureText,
        failureRecord: {
          kind: 'terminal',
          code: terminalFailure.code,
          stableCode: terminalFailure.stableCode,
          message: terminalFailure.message || null,
          detail: terminalFailure.detail || null,
          guidance: terminalFailure.guidance || null,
          functionCallId: terminalFailure.functionCallId || null,
          requestId: terminalFailure.requestId || null,
          failedAt: new Date().toISOString(),
        },
      });
      if (!failed) {
        console.log(`[${ts()}] RESPONSE  ${messageId?.slice(0,8)} ignored=not_pending_or_processing`);
        return res.json({ ok: true, ignored: 'not_pending_or_processing' });
      }
      console.warn(
        `[${ts()}] FAILED    ${messageId?.slice(0,8)} conv=${targetConversationId?.slice(0,8)} code=${terminalFailure.stableCode}`
        + `${terminalFailure.functionCallId ? ` call=${terminalFailure.functionCallId}` : ''}`
        + `${terminalFailure.requestId ? ` req=${terminalFailure.requestId}` : ''}`,
      );
      return res.json({ ok: true, terminal: true, code: terminalFailure.stableCode });
    }

    const responseId = uuidv4();
    const now = new Date().toISOString();
    const finalize = db.transaction(() => {
      const result = stmts.setDone.run(text, messageId);
      if (result.changes === 0) return false;
      stmts.setQueueResponseMessageId?.run(responseId, messageId);
      stmts.insertMsg.run(responseId, targetConversationId, 'assistant', text, model || null, relayMode, null, now);
      stmts.linkActivityToResponse.run(responseId, messageId);
      stmts.updateConvTime.run(now, targetConversationId);
      stmts.pruneQueue.run();
      return true;
    });

    const finalized = finalize();
    if (!finalized) {
      console.log(`[${ts()}] RESPONSE  ${messageId?.slice(0,8)} ignored=not_pending_or_processing`);
      return res.json({ ok: true, ignored: 'not_pending_or_processing' });
    }
    if (q?.runtime_session_id) {
      const nowIso = new Date().toISOString();
      const existing = stmts.getRuntimeSessionById.get(q.runtime_session_id);
      if (existing?.id) {
        stmts.touchRuntimeSession.run(
          String(model || existing.model || '').trim() || null,
          nowIso,
          existing.id,
        );
      }
    }
    if (isSessionWorkerRoutingEnabled(featureFlags) && q?.owner_sdk_session_id) {
      const ownerSessionId = normalizeSessionWorkerId(q.owner_sdk_session_id);
      if (ownerSessionId) {
        const existingWorker = sessionWorkerRegistry?.getWorker?.(ownerSessionId) || null;
        sessionWorkerRegistry?.upsertWorker?.({
          ...(existingWorker || {}),
          sdkSessionId: ownerSessionId,
          conversationId: q?.conversation_id || targetConversationId,
          runtimeSessionId: q?.runtime_session_id || null,
          status: 'ready',
        });
        const pendingDepth = Number(queueCounts?.().pendingCount || 0);
        sessionWorkerSupervisor?.markIdle?.(ownerSessionId, pendingDepth);
        emitSessionWorkerTelemetry('queue.message.completed', {
          sessionId: ownerSessionId,
          workerId: sessionWorkerRegistry?.getWorker?.(ownerSessionId)?.workerId || null,
          conversationId: q?.conversation_id || targetConversationId,
          messageId,
          continuationId: null,
          state: 'ready',
          retry: Number(q?.retry_count || 0),
          pid: null,
        });
      }
    }
    const activities = relayActivityForResponse(responseId);

    console.log(`[${ts()}] RESPONSE  ${messageId?.slice(0,8)} conv=${targetConversationId?.slice(0,8)} mode=${relayMode} len=${text.length} preview="${text.slice(0,60)}"`);

    io.emit('assistant_message', {
      conversationId: targetConversationId,
      sourceMessageId: messageId,
      messageId: responseId,
      message: { role: 'assistant', text, model: model || null, mode: relayMode, timestamp: now, activities },
    });
    io.emit('message_status', { messageId, conversationId: targetConversationId, status: 'done' });
    res.json({ ok: true });
  });

  // POST /api/activity — relay sends in-flight activity updates (tool/search sections)
  app.post('/api/activity', auth, (req, res) => {
    touchCli();
    const { messageId, conversationId, text, mode } = req.body || {};
    const activityText = sanitizeActivityText(text);
    if (!messageId || !conversationId || !activityText) {
      return res.status(400).json({ error: 'Missing activity payload' });
    }

    const q = stmts.findQById.get(messageId);
    const responseMessageId = q?.response_message_id || null;
    stmts.insertActivity.run(
      messageId,
      responseMessageId,
      conversationId,
      normalizeRelayMode(mode) || DEFAULT_RELAY_MODE,
      activityText,
      new Date().toISOString(),
    );

    io.emit('relay_activity', {
      messageId,
      conversationId,
      mode: normalizeRelayMode(mode) || DEFAULT_RELAY_MODE,
      text: activityText,
      timestamp: new Date().toISOString(),
    });
    res.json({ ok: true });
  });

  // POST /api/stream — relay sends in-flight assistant text stream updates
  app.post('/api/stream', auth, (req, res) => {
    touchCli();
    const { messageId, conversationId, text, mode, done } = req.body || {};
    const streamText = String(text || '');
    if (!messageId || !conversationId) {
      return res.status(400).json({ error: 'Missing stream payload' });
    }

    io.emit('relay_stream', {
      messageId,
      conversationId,
      mode: normalizeRelayMode(mode) || DEFAULT_RELAY_MODE,
      text: streamText,
      done: !!done,
      timestamp: new Date().toISOString(),
    });
    res.json({ ok: true });
  });

  // POST /api/requeue — relay re-queues a message it failed to process
  app.post('/api/requeue', auth, (req, res) => {
    const { messageId } = req.body;
    const q = stmts.findQById.get(messageId);
    const terminalFailure = resolveTerminalFailurePayload(req.body);
    const ownerSessionId = isSessionWorkerRoutingEnabled(featureFlags)
      ? normalizeSessionWorkerId(q?.owner_sdk_session_id)
      : null;
    const currentStatus = String(q?.status || '').trim().toLowerCase();
    const canTerminalFail = q && ['processing', 'pending', 'parked'].includes(currentStatus);
    if (terminalFailure && canTerminalFail) {
      const failureText = buildTerminalFailureTextForChat(terminalFailure);
      const failed = failQueueMessage({
        queueRow: q,
        messageId,
        conversationId: q?.conversation_id,
        relayMode: normalizeRelayMode(q?.relay_mode) || DEFAULT_RELAY_MODE,
        model: q?.model || null,
        responseText: failureText,
        failureRecord: {
          kind: 'terminal',
          error: 'terminal-error',
          code: terminalFailure.code,
          stableCode: terminalFailure.stableCode,
          message: terminalFailure.message || null,
          detail: terminalFailure.detail || null,
          guidance: terminalFailure.guidance || null,
          functionCallId: terminalFailure.functionCallId || null,
          requestId: terminalFailure.requestId || null,
          retryCount: Number(q?.retry_count || 0),
          failedAt: new Date().toISOString(),
        },
      });
      if (failed) {
        console.warn(
          `[${ts()}] FAILED    ${messageId?.slice(0,8)} retry=${Number(q?.retry_count || 0)} reason=terminal code=${terminalFailure.stableCode}`,
        );
      }
      return res.json({ ok: true, terminal: true, code: terminalFailure.stableCode });
    }
    if (q && q.status === 'processing') {
      const retryCount = Number(q.retry_count || 0) + 1;
      if (retryCount >= MAX_REQUEUE_RETRIES) {
        const now = new Date().toISOString();
        const failText = `Relay timeout after ${retryCount} attempts. Message was skipped to keep the queue moving. Retry the message.`;
        failQueueMessage({
          queueRow: { ...q, retry_count: retryCount },
          messageId,
          conversationId: q.conversation_id,
          relayMode: normalizeRelayMode(q.relay_mode) || DEFAULT_RELAY_MODE,
          model: q.model || null,
          responseText: failText,
          failureRecord: {
            kind: 'requeue-timeout',
            error: 'timeout',
            code: 'retry-timeout',
            stableCode: 'relay.retry-timeout',
            retryCount,
            failedAt: now,
          },
        });
        console.log(`[${ts()}] FAILED    ${messageId?.slice(0,8)} retry=${retryCount} reason=timeout`);
      } else {
        const restartState = relayRestartOrchestrator?.getState?.() || null;
        const parkForRestart = shouldParkForRestart(restartState);
        const nextAttemptAt = parkForRestart ? null : addMsIso(computeRetryDelayMs(retryCount));
        const result = db.prepare(`
          UPDATE queue
          SET
            status = ?,
            processing_at = NULL,
            retry_count = ?,
            next_attempt_at = ?,
            owner_lease_expires_at = NULL,
            parked_at = ?,
            parked_target_session_id = ?,
            parked_transaction_id = ?,
            parked_reason = ?
          WHERE id = ? AND status = 'processing'
        `).run(
          parkForRestart ? 'parked' : 'pending',
          retryCount,
          nextAttemptAt,
          parkForRestart ? new Date().toISOString() : null,
          parkForRestart ? (restartState?.targetSessionId || null) : null,
          parkForRestart ? (restartState?.transactionId || null) : null,
          parkForRestart ? (restartState?.lastError || 'session-rebind-pending') : null,
          messageId,
        );
        if (result.changes > 0) {
          if (ownerSessionId) {
            sessionWorkerSupervisor?.markError?.(ownerSessionId, `requeue-retry:${retryCount}`);
            emitSessionWorkerTelemetry('queue.message.requeued', {
              sessionId: ownerSessionId,
              workerId: sessionWorkerRegistry?.getWorker?.(ownerSessionId)?.workerId || null,
              conversationId: q?.conversation_id || null,
              messageId,
              continuationId: null,
              state: parkForRestart ? 'parked' : 'pending',
              retry: retryCount,
              pid: null,
              extra: parkForRestart ? { parkedForRestart: true } : null,
            });
          }
          console.log(`[${ts()}] REQUEUED  ${messageId?.slice(0,8)} retry=${retryCount} status=${parkForRestart ? 'parked' : 'pending'}${nextAttemptAt ? ` next=${nextAttemptAt}` : ''}`);
          io.emit('message_status', { messageId, conversationId: q?.conversation_id, status: parkForRestart ? 'parked' : 'pending' });
        }
      }
    }
    res.json({ ok: true });
  });
}
