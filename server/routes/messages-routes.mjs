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
import {
  persistConversationModeModelPreference as persistConversationModeModelPreferenceTx,
} from '../services/conversation-preferences-service.mjs';
import { postRelayDebugLog } from '../../debugging/relay-debug-log.mjs';
import { killTmuxSession } from '../services/session-worker-launch-service.mjs';

export const SESSION_WORKER_OWNER_LEASE_MS = 120_000;
export const SESSION_WORKER_TRANSIENT_DEQUEUE_RETRIES = 2;
export const SESSION_WORKER_TRANSIENT_DEQUEUE_BACKOFF_MS = 25;
const SESSION_WORKER_IDLE_RECOVERY_GRACE_MS = 5_000;
const DUPLICATE_USER_MESSAGE_WINDOW_MS = 10 * 60 * 1000;
const OPAQUE_RESPONSE_TEXT_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPAQUE_RESPONSE_RECOVERY_WAIT_MS = 600_000;
const OPAQUE_RESPONSE_RECOVERY_POLL_MS = 250;
const STRANDED_SESSION_PRIME_COOLDOWN_MS = 10_000;
const STRANDED_SESSION_HEARTBEAT_FRESH_MS = 15_000;
// Hold finalization after a relay question is answered so the SDK has time to fire the next
// onUserInputRequest (multi-step ask_user). Without this, the transcript is used prematurely and
// the queue row is marked done while additional questions are still pending.
const RELAY_QUESTION_FINALIZATION_HOLD_MS = 5_000;

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

function isOpaqueResponseText(value) {
  const text = String(value || '').trim();
  return !!text && OPAQUE_RESPONSE_TEXT_PATTERN.test(text);
}

function findResolvedTranscriptAssistantText({
  conversation = null,
  queueTimestamp = null,
  readSessionTranscriptMessages = null,
} = {}) {
  if (typeof readSessionTranscriptMessages !== 'function') return '';
  const sdkSessionId = String(conversation?.sdk_session_id || conversation?.id || '').trim();
  if (!sdkSessionId) return '';

  const transcriptMessages = readSessionTranscriptMessages(sdkSessionId, { limit: 200 });
  if (!Array.isArray(transcriptMessages) || !transcriptMessages.length) return '';

  const queuedAt = Date.parse(String(queueTimestamp || '').trim());
  const assistantMessages = transcriptMessages
    .filter((message) => String(message?.role || '').trim().toLowerCase() === 'assistant')
    .map((message) => ({
      text: String(message?.text || '').trim(),
      timestampMs: Date.parse(String(message?.timestamp || '').trim()) || 0,
    }))
    .filter((message) => !!message.text);

  if (!assistantMessages.length) return '';

  const nonOpaqueMessages = assistantMessages.filter((message) => !isOpaqueResponseText(message.text));
  if (!Number.isFinite(queuedAt)) {
    return nonOpaqueMessages[nonOpaqueMessages.length - 1]?.text
      || assistantMessages[assistantMessages.length - 1]?.text
      || '';
  }

  const afterQueuedAt = assistantMessages.filter((message) => message.timestampMs >= queuedAt);
  if (!afterQueuedAt.length) return '';
  const nonOpaqueAfterQueuedAt = afterQueuedAt.filter((message) => !isOpaqueResponseText(message.text));
  return nonOpaqueAfterQueuedAt[nonOpaqueAfterQueuedAt.length - 1]?.text || '';
}

async function resolveRelayResponseText({
  text = '',
  conversation = null,
  queueTimestamp = null,
  readSessionTranscriptMessages = null,
  opaqueResponseRecoveryWaitMs = OPAQUE_RESPONSE_RECOVERY_WAIT_MS,
  opaqueResponseRecoveryPollMs = OPAQUE_RESPONSE_RECOVERY_POLL_MS,
  messageId = null,
  checkHasActiveRelayQuestion = null,
} = {}) {
  const rawText = String(text || '').trim();
  if (!isOpaqueResponseText(rawText)) return rawText;

  const maxWaitMs = Math.max(0, Number(opaqueResponseRecoveryWaitMs) || 0);
  const pollMs = Math.max(1, Number(opaqueResponseRecoveryPollMs) || OPAQUE_RESPONSE_RECOVERY_POLL_MS);
  const deadline = Date.now() + maxWaitMs;

  while (true) {
    // Don't finalize while there's a pending relay question or a recently-answered one for this
    // message. The SDK may fire another onUserInputRequest shortly after an answer is returned
    // (multi-step ask_user). Consuming transcript text before that window expires would mark the
    // queue row done and cause subsequent onUserInputRequest calls to get a 409.
    const hasActiveQuestion = messageId && typeof checkHasActiveRelayQuestion === 'function'
      ? checkHasActiveRelayQuestion(messageId)
      : false;

    if (!hasActiveQuestion) {
      const transcriptText = findResolvedTranscriptAssistantText({
        conversation,
        queueTimestamp,
        readSessionTranscriptMessages,
      });
      if (transcriptText) return transcriptText;
    }
    if (Date.now() >= deadline) return rawText;
    await delay(pollMs);
  }
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

export function resolveInitialQueueOwnerSessionId({
  routingEnabled = false,
  requesterSessionId = null,
  runtimeSession = null,
  conversationSdkSessionId = null,
  conversationId = null,
  isNewConversation = false,
} = {}) {
  if (!routingEnabled) return null;
  const runtimeSdkSessionId = normalizeSessionWorkerId(runtimeSession?.sdk_session_id);
  const boundConversationSessionId = normalizeSessionWorkerId(conversationSdkSessionId);
  const normalizedConversationId = normalizeSessionWorkerId(conversationId);
  const unboundConversation = !runtimeSdkSessionId && !boundConversationSessionId;
  if (normalizedConversationId && (isNewConversation || unboundConversation)) {
    return normalizedConversationId;
  }
  return normalizeSessionWorkerId(
    runtimeSdkSessionId
    || boundConversationSessionId
    || requesterSessionId,
  );
}

export function shouldAutoPrimeStrandedSession({
  strandedRow = null,
  requesterSessionId = null,
} = {}) {
  const ownerSessionId = normalizeSessionWorkerId(strandedRow?.owner_sdk_session_id);
  const requesterSid = normalizeSessionWorkerId(requesterSessionId);
  if (!ownerSessionId || !requesterSid) return false;
  if (ownerSessionId === requesterSid) return false;
  const rawRetryCount = Number(strandedRow?.retry_count);
  if (!Number.isFinite(rawRetryCount)) return false;
  const retryCount = Math.max(0, Math.trunc(rawRetryCount));
  if (retryCount > 0) return false;
  return true;
}

export function dequeuePendingMessage({
  db,
  stmts,
  nowIso,
  routingEnabled = false,
  requesterSessionId = null,
  ownerLeaseMs = SESSION_WORKER_OWNER_LEASE_MS,
  affinityOnly = false,
} = {}) {
  const currentIso = String(nowIso || '').trim() || new Date().toISOString();
  const requesterSid = normalizeSessionWorkerId(requesterSessionId);
  const leaseExpiresAt = requesterSid ? addMsToIso(currentIso, ownerLeaseMs) : null;
  const dequeue = db.transaction(() => {
    let next = null;
    if (routingEnabled && requesterSid && stmts.findPendingForWorker) {
      next = stmts.findPendingForWorker.get(currentIso, requesterSid, requesterSid);
      // In routed worker mode, never fall back to the global queue. If this
      // worker has no matching owned/unowned work, another worker session must
      // pick up the turn instead of letting the wrong session steal it.
      if (!next) return null;
    } else if (!routingEnabled && requesterSid && stmts.findPendingForSessionAffinity) {
      next = stmts.findPendingForSessionAffinity.get(currentIso, requesterSid);
    }
    if (!next && affinityOnly) return null;
    if (!next) {
      next = stmts.findPending.get(currentIso);
    }
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

export function shouldFailRecoveredProcessingRow({
  reason = null,
  relayActivityCount = 0,
  relayStreamCount = 0,
} = {}) {
  const normalizedReason = String(reason || '').trim().toLowerCase();
  if (normalizedReason !== 'owner-heartbeat-idle') return false;
  return Math.max(0, Number(relayActivityCount || 0)) > 0
    || Math.max(0, Number(relayStreamCount || 0)) > 0;
}

export function buildHeartbeatIdleReplayFailure({
  requesterSessionId = null,
} = {}) {
  const normalizedSessionId = normalizeSessionWorkerId(requesterSessionId);
  return {
    kind: 'turn-aborted',
    error: 'turn-replay-blocked',
    code: 'turn-replay-blocked',
    stableCode: 'relay.turn-replay-blocked',
    message: 'System note: This turn had already started before the relay lost its active worker state, so it was ended instead of being replayed.',
    guidance: 'Send the message again if you still want that work to run.',
    failedAt: new Date().toISOString(),
    requesterSessionId: normalizedSessionId,
  };
}

export async function dequeuePendingMessageForWorkerLoop({
  db,
  stmts,
  nowIso,
  routingEnabled = false,
  requesterSessionId = null,
  ownerLeaseMs = SESSION_WORKER_OWNER_LEASE_MS,
  affinityOnly = false,
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
      // #region agent log
      postRelayDebugLog({
        runId: 'baseline-1',
        hypothesisId: 'H1',
        location: 'server/routes/messages-routes.mjs:worker.ensure.blocked',
        message: 'dequeue blocked by ensureWorker',
        data: {
          requesterSessionId: requesterSid,
          blockedReason: String(ensureResult?.error || 'worker-unavailable').trim() || 'worker-unavailable',
          retryCount: Number(ensureResult?.lifecycle?.retryCount || 0),
          workerStatus: String(ensureResult?.worker?.status || ''),
          workerPid: Number(ensureResult?.worker?.pid || 0) || null,
        },
      });
      // #endregion
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
        affinityOnly,
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
      if (message) {
        const dequeuedAtMs = Date.parse(currentIso);
        const queuedAtMs = Date.parse(String(message?.timestamp || '').trim());
        const queueWaitMs = Number.isFinite(dequeuedAtMs) && Number.isFinite(queuedAtMs)
          ? Math.max(0, dequeuedAtMs - queuedAtMs)
          : null;
        // #region agent log
        postRelayDebugLog({
          runId: 'slow-turn-baseline',
          hypothesisId: 'H6-queue-wait',
          location: 'server/routes/messages-routes.mjs:queue.dequeue.success',
          message: 'message dequeued for worker loop',
          data: {
            requesterSessionId: requesterSid,
            queueMessageId: String(message?.id || ''),
            queueConversationId: String(message?.conversation_id || ''),
            ownerSessionId: String(message?.owner_sdk_session_id || ''),
            status: String(message?.status || ''),
            attempt,
            queueWaitMs,
            queuedAt: String(message?.timestamp || ''),
            dequeuedAt: currentIso,
          },
        });
        // #endregion
      }
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
      // #region agent log
      postRelayDebugLog({
        runId: 'baseline-1',
        hypothesisId: 'H1',
        location: 'server/routes/messages-routes.mjs:queue.dequeue.catch',
        message: transient && attempt < retryLimit ? 'transient dequeue retry' : 'dequeue error',
        data: {
          requesterSessionId: requesterSid,
          attempt: attempt + 1,
          transient,
          error: String(error?.message || error || 'dequeue-failed'),
        },
      });
      // #endregion
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

function serveFileWithRangeSupport(req, res, filePath, meta, { safeName, cacheDelete = null } = {}) {
  const fileSize = meta.size;
  const name = safeName || path.basename(filePath).replace(/"/g, '');
  const rangeHeader = req.headers['range'];

  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', meta.contentType);
  res.setHeader('Content-Disposition', `inline; filename="${name}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  const onStreamError = (error) => {
    if (cacheDelete) cacheDelete(filePath);
    if (res.headersSent) { res.destroy(error); return; }
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      res.status(404).json({ error: 'File not found' });
      return;
    }
    res.status(500).json({ error: 'Failed to read file' });
  };

  if (rangeHeader) {
    const match = /bytes=(\d+)-(\d*)/.exec(rangeHeader);
    if (!match) {
      res.setHeader('Content-Range', `bytes */${fileSize}`);
      res.status(416).end();
      return;
    }
    const start = parseInt(match[1], 10);
    const end = match[2] ? parseInt(match[2], 10) : fileSize - 1;
    if (start > end || start >= fileSize || end >= fileSize) {
      res.setHeader('Content-Range', `bytes */${fileSize}`);
      res.status(416).end();
      return;
    }
    const chunkSize = end - start + 1;
    res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
    res.setHeader('Content-Length', String(chunkSize));
    res.status(206);
    const stream = fs.createReadStream(filePath, { start, end });
    stream.on('error', onStreamError);
    stream.pipe(res);
  } else {
    res.setHeader('Content-Length', String(fileSize));
    const stream = fs.createReadStream(filePath);
    stream.on('error', onStreamError);
    stream.pipe(res);
  }
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
    updateConversationConfiguredWorkspaceRoot,
    getOrCreateConversation,
    ensureRuntimeSessionBinding,
    resolveConversationWorkspaceState,
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
    readSessionTranscriptMessages,
    inFlightStateForConversation,
    emitToClientsExceptSessionId,
    relayBridgeOwnerService,
    relayRestartOrchestrator,
    requestRelayShutdown,
    featureFlags,
    sessionWorkerRegistry,
    sessionWorkerSupervisor,
    sessionWorkerProcessInspector,
    opaqueResponseRecoveryWaitMs = OPAQUE_RESPONSE_RECOVERY_WAIT_MS,
    opaqueResponseRecoveryPollMs = OPAQUE_RESPONSE_RECOVERY_POLL_MS,
    relayQuestionFinalizationHoldMs = RELAY_QUESTION_FINALIZATION_HOLD_MS,
  } = deps;

  function isLoopbackAddress(value) {
    const text = String(value || '').trim().toLowerCase();
    if (!text) return false;
    return text === '127.0.0.1'
      || text === '::1'
      || text === '::ffff:127.0.0.1'
      || text === '::ffff:7f00:1';
  }

  function isLoopbackRequest(req) {
    const socketAddress = req?.socket?.remoteAddress;
    const ipAddress = req?.ip;
    return isLoopbackAddress(socketAddress) || isLoopbackAddress(ipAddress);
  }

  function readBridgeIdentity(req) {
    return relayBridgeOwnerService?.normalizeIdentity?.({
      pid: req.headers['x-relay-process-pid'],
      parentPid: req.headers['x-relay-parent-pid'],
      sessionId: req.headers['x-relay-session-id'],
      conversationId: req.headers['x-relay-conversation-id'],
    }) || null;
  }

  function resolveConversationWorkspaceScope(req) {
    const conversationId = String(
      req?.query?.conversationId
      || req?.query?.conversation_id
      || req?.headers?.['x-conversation-id']
      || '',
    ).trim();
    const sdkSessionId = String(
      req?.query?.sdkSessionId
      || req?.query?.sdk_session_id
      || req?.headers?.['x-sdk-session-id']
      || '',
    ).trim();
    if (!conversationId && !sdkSessionId) return null;
    return { conversationId, sdkSessionId };
  }

  function resolveScopedWorkspaceRootPath(req) {
    if (typeof resolveConversationWorkspaceState !== 'function') return null;
    const scope = resolveConversationWorkspaceScope(req);
    if (!scope) return null;
    const state = resolveConversationWorkspaceState(scope);
    const rootPath = String(state?.currentWorkspaceRootPath || '').trim();
    return rootPath || null;
  }

  function scopedWorkspaceQuerySuffix(req) {
    const scope = resolveConversationWorkspaceScope(req);
    if (!scope) return '';
    const params = new URLSearchParams();
    if (scope.conversationId) params.set('conversationId', scope.conversationId);
    if (scope.sdkSessionId) params.set('sdkSessionId', scope.sdkSessionId);
    const text = params.toString();
    return text ? `?${text}` : '';
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

  function persistConversationModeModelPreference(conversationId, relayMode, model, nowIso = new Date().toISOString()) {
    const convId = String(conversationId || '').trim();
    const mode = normalizeRelayMode(relayMode) || DEFAULT_RELAY_MODE;
    const modelId = String(model || '').trim();
    if (!convId || !mode || !modelId) {
      return {
        preferredRelayMode: mode || DEFAULT_RELAY_MODE,
        preferredModelsByMode: {},
      };
    }
    const persisted = persistConversationModeModelPreferenceTx({
      db,
      stmts,
      conversationId: convId,
      relayMode: mode,
      model: modelId,
      normalizeMode: (value) => normalizeRelayMode(value) || null,
      fallbackRelayMode: DEFAULT_RELAY_MODE,
      updatedAt: nowIso,
      tolerateMissingColumns: true,
    });
    return {
      preferredRelayMode: persisted.preferredRelayMode || mode,
      preferredModelsByMode: persisted.preferredModelsByMode || {},
    };
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
    const runtimeSessionBySdkSessionId = conversation?.sdk_session_id && stmts.getRuntimeSessionBySdkSessionId
      ? (stmts.getRuntimeSessionBySdkSessionId.get(String(conversation.sdk_session_id).trim()) || null)
      : null;
    const conversationSdkSessionId = normalizeBindingValue(conversation.sdk_session_id);
    const runtimeSessionSdkSessionId = normalizeBindingValue(runtimeSession?.sdk_session_id);
    return {
      ok: true,
      conversation,
      runtimeSession,
      runtimeSessionBySdkSessionId,
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
    markWorkerError = true,
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
      stmts.linkStreamEventsToResponse?.run(responseId, messageId);
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
      if (markWorkerError) {
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
      } else {
        const existingWorker = sessionWorkerRegistry?.getWorker?.(ownerSessionId) || null;
        sessionWorkerRegistry?.upsertWorker?.({
          ...existingWorker,
          sessionId: ownerSessionId,
          status: 'ready',
        });
        sessionWorkerSupervisor?.markIdle?.(ownerSessionId, queueCounts?.().pendingCount || 0);
        emitSessionWorkerTelemetry('queue.message.stopped', {
          sessionId: ownerSessionId,
          workerId: existingWorker?.workerId || null,
          conversationId,
          messageId,
          continuationId: null,
          state: 'ready',
          retry: Number(queueRow?.retry_count || 0),
          pid: existingWorker?.pid || null,
          extra: failureRecord?.code
            ? {
                failureKind: failureRecord?.kind || null,
                failureCode: failureRecord?.code || null,
              }
            : null,
        });
      }
    }
    return { responseId, now };
  }

  const strandedPrimeCooldownBySession = new Map();

  const findPendingOwnedByOtherSession = db.prepare(`
    SELECT id, conversation_id, owner_sdk_session_id, retry_count
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
  const findProcessingOwnedBySession = db.prepare(`
    SELECT *
    FROM queue
    WHERE owner_sdk_session_id = ?
      AND status = 'processing'
    ORDER BY COALESCE(processing_at, timestamp) DESC, timestamp DESC
    LIMIT 1
  `);
  const findAllProcessingOwnedBySession = db.prepare(`
    SELECT *
    FROM queue
    WHERE owner_sdk_session_id = ?
      AND status = 'processing'
    ORDER BY COALESCE(processing_at, timestamp) DESC, timestamp DESC
  `);
  const listRecoverableProcessingOwnedBySession = db.prepare(`
    SELECT *
    FROM queue
    WHERE owner_sdk_session_id = ?
      AND status = 'processing'
      AND (? = '' OR id != ?)
      AND COALESCE(owner_last_claimed_at, processing_at, timestamp) <= ?
    ORDER BY COALESCE(processing_at, timestamp) DESC, timestamp DESC
  `);
  const refreshProcessingLeaseForOwnedMessage = db.prepare(`
    UPDATE queue
    SET owner_lease_expires_at = ?,
        owner_last_claimed_at = ?
    WHERE id = ?
      AND owner_sdk_session_id = ?
      AND status = 'processing'
  `);
  const recoverOwnedProcessingMessage = db.prepare(`
    UPDATE queue
    SET status = 'pending',
        processing_at = NULL,
        next_attempt_at = ?,
        owner_lease_expires_at = NULL
    WHERE id = ?
      AND owner_sdk_session_id = ?
      AND status = 'processing'
  `);
  const findMostRecentConversationForSession = db.prepare(`
    SELECT conversation_id
    FROM queue
    WHERE owner_sdk_session_id = ?
    ORDER BY COALESCE(processing_at, timestamp) DESC, timestamp DESC
    LIMIT 1
  `);
  const findActiveRelayControlByQueueMessage = db.prepare(`
    SELECT *
    FROM relay_control_requests
    WHERE queue_message_id = ?
      AND type = ?
      AND status IN ('pending', 'processing')
    ORDER BY created_at DESC
    LIMIT 1
  `);
  const insertRelayControlRequest = db.prepare(`
    INSERT INTO relay_control_requests (
      id,
      type,
      conversation_id,
      queue_message_id,
      sdk_session_id,
      status,
      request,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)
  `);
  const findPendingRelayControlForSession = db.prepare(`
    SELECT *
    FROM relay_control_requests
    WHERE sdk_session_id = ?
      AND status = 'pending'
    ORDER BY created_at ASC
    LIMIT 1
  `);
  const findPendingRelayControlForSessionAndMessage = db.prepare(`
    SELECT *
    FROM relay_control_requests
    WHERE sdk_session_id = ?
      AND queue_message_id = ?
      AND status = 'pending'
    ORDER BY created_at ASC
    LIMIT 1
  `);
  const claimRelayControlRequest = db.prepare(`
    UPDATE relay_control_requests
    SET status = 'processing', updated_at = ?
    WHERE id = ?
      AND status = 'pending'
  `);
  const getRelayControlRequestById = db.prepare(`
    SELECT *
    FROM relay_control_requests
    WHERE id = ?
    LIMIT 1
  `);
  const completeRelayControlRequest = db.prepare(`
    UPDATE relay_control_requests
    SET status = 'done',
        result = ?,
        error = NULL,
        updated_at = ?,
        completed_at = ?
    WHERE id = ?
      AND status IN ('pending', 'processing')
  `);
  const failRelayControlRequest = db.prepare(`
    UPDATE relay_control_requests
    SET status = 'failed',
        error = ?,
        updated_at = ?,
        completed_at = ?
    WHERE id = ?
      AND status IN ('pending', 'processing')
  `);
  const settleRelayControlsForQueueMessage = db.prepare(`
    UPDATE relay_control_requests
    SET status = ?,
        result = ?,
        error = ?,
        updated_at = ?,
        completed_at = ?
    WHERE queue_message_id = ?
      AND type = 'abort_turn'
      AND status IN ('pending', 'processing')
  `);

  function insertSystemMessageForConversation({ conversationId, text, model = null, relayMode = null }) {
    const now = new Date().toISOString();
    const messageId = uuidv4();
    const tx = db.transaction(() => {
      stmts.insertMsg.run(messageId, conversationId, 'assistant', text, model || null, relayMode || null, null, now);
      stmts.updateConvTime.run(now, conversationId);
    });
    tx();
    io.emit('assistant_message', {
      conversationId,
      sourceMessageId: null,
      messageId,
      message: { role: 'assistant', text, model: model || null, mode: relayMode || null, timestamp: now },
    });
    return messageId;
  }

  function parseJsonObject(value) {
    const text = String(value || '').trim();
    if (!text) return null;
    try {
      const parsed = JSON.parse(text);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }

  function formatRelayControlResponse(row) {
    if (!row) return null;
    return {
      id: String(row.id || '').trim(),
      type: String(row.type || '').trim(),
      conversationId: String(row.conversation_id || '').trim() || null,
      queueMessageId: String(row.queue_message_id || '').trim() || null,
      sdkSessionId: String(row.sdk_session_id || '').trim() || null,
      status: String(row.status || '').trim() || null,
      request: parseJsonObject(row.request),
      result: parseJsonObject(row.result),
      error: String(row.error || '').trim() || null,
      createdAt: String(row.created_at || '').trim() || null,
      updatedAt: String(row.updated_at || '').trim() || null,
      completedAt: String(row.completed_at || '').trim() || null,
    };
  }

  function buildRelayStopFailurePayload() {
    return {
      kind: 'turn-aborted',
      error: 'turn-aborted',
      code: 'turn-aborted',
      stableCode: 'relay.turn-aborted',
      message: 'System note: This turn was stopped from the relay UI before completion.',
      guidance: 'Send a new message to continue when you are ready.',
      failedAt: new Date().toISOString(),
    };
  }

  function settleRelayAbortControlsForQueueMessage(queueMessageId, { ok = true, note = null, error = null } = {}) {
    const id = String(queueMessageId || '').trim();
    if (!id) return 0;
    const now = new Date().toISOString();
    const result = ok
      ? JSON.stringify({ source: 'relay-runtime', note: String(note || '').trim() || null })
      : null;
    const settled = settleRelayControlsForQueueMessage.run(
      ok ? 'done' : 'failed',
      result,
      ok ? null : String(error || 'stale-control').trim() || 'stale-control',
      now,
      now,
      id,
    );
    return Number(settled?.changes || 0);
  }

  function recoverOwnedProcessingRowsForSession(
    sdkSessionId,
    {
      excludeMessageId = null,
      reason = 'owner-heartbeat-idle',
      graceMs = SESSION_WORKER_IDLE_RECOVERY_GRACE_MS,
    } = {},
  ) {
    const normalizedSessionId = normalizeSessionWorkerId(sdkSessionId);
    if (!normalizedSessionId) return [];
    const excludedId = String(excludeMessageId || '').trim();
    const cutoffIso = new Date(Date.now() - Math.max(1_000, Number(graceMs) || SESSION_WORKER_IDLE_RECOVERY_GRACE_MS)).toISOString();
    const rows = listRecoverableProcessingOwnedBySession.all(
      normalizedSessionId,
      excludedId,
      excludedId,
      cutoffIso,
    ) || [];
    if (!rows.length) return [];
    const rowsToFail = [];
    const rowsToRecover = [];
    for (const row of rows) {
      const relayActivityRows = stmts.listActivityByQueueMessage?.all?.(row.id);
      const relayStreamRows = stmts.listStreamEventsByQueueMessage?.all?.(row.id);
      const fallbackRelayActivities = Array.isArray(relayActivityRows)
        ? relayActivityRows
        : relayActivityForQueueMessage?.(row.id);
      const relayActivityCount = Array.isArray(fallbackRelayActivities) ? fallbackRelayActivities.length : 0;
      const relayStreamCount = Array.isArray(relayStreamRows) ? relayStreamRows.length : 0;
      if (shouldFailRecoveredProcessingRow({
        reason,
        relayActivityCount,
        relayStreamCount,
      })) {
        rowsToFail.push(row);
        continue;
      }
      rowsToRecover.push(row);
    }
    const requeueAt = addMsIso(2_000);
    const tx = db.transaction((recoverRows) => {
      for (const row of recoverRows) {
        recoverOwnedProcessingMessage.run(requeueAt, row.id, normalizedSessionId);
      }
    });
    tx(rowsToRecover);
    for (const row of rowsToRecover) {
      settleRelayAbortControlsForQueueMessage(row.id, {
        ok: false,
        error: reason,
      });
      io.emit('message_status', { messageId: row.id, conversationId: row.conversation_id, status: 'pending' });
    }
    for (const row of rowsToFail) {
      const failureRecord = buildHeartbeatIdleReplayFailure({
        requesterSessionId: normalizedSessionId,
      });
      const failureText = buildTerminalFailureTextForChat(failureRecord);
      const failed = failQueueMessage({
        queueRow: row,
        messageId: row.id,
        conversationId: row.conversation_id,
        relayMode: normalizeRelayMode(row.relay_mode) || DEFAULT_RELAY_MODE,
        model: row.model || null,
        responseText: failureText,
        failureRecord,
        markWorkerError: false,
      });
      if (failed) {
        settleRelayAbortControlsForQueueMessage(row.id, {
          ok: false,
          error: failureRecord.code,
        });
      }
    }
    if (rowsToRecover.length || rowsToFail.length) {
      io.emit('queue_updated', {
        recovered: rowsToRecover.length,
        replayBlocked: rowsToFail.length,
        ownerSessionId: normalizedSessionId,
      });
    }
    return rows;
  }

  app.post('/api/session-worker/:sdkSessionId/kill', auth, async (req, res) => {
    const sdkSessionId = normalizeSessionWorkerId(req.params.sdkSessionId);
    if (!sdkSessionId) return res.status(400).json({ error: 'Missing session worker id' });

    const currentWorker = sessionWorkerRegistry?.getWorker?.(sdkSessionId) || null;

    // Collect ALL matching PIDs (not just first)
    const discoveredProcesses = sessionWorkerProcessInspector?.findProcessesForSession?.(sdkSessionId)
      || sessionWorkerProcessInspector?.findWindowsProcessesForSession?.(sdkSessionId)
      || [];
    const allPids = [...new Set([
      ...discoveredProcesses.map((p) => (p.processId ? Number(p.processId) : null)).filter(Boolean),
      currentWorker?.pid ? Number(currentWorker.pid) : null,
    ].filter(Boolean))];

    let processStatus = 'not-running';
    let killedPids = [];

    if (allPids.length) {
      try {
        if (process.platform === 'win32') {
          // On Windows, kill through PowerShell to avoid process-group edge-cases.
          killedPids = sessionWorkerProcessInspector.stopWindowsPids(allPids);
        } else {
          killTmuxSession(sdkSessionId);
          for (const pid of allPids) {
            try {
              process.kill(pid, 'SIGTERM');
              killedPids.push(pid);
            } catch {
              // Ignore missing/already-dead processes.
            }
          }
          await delay(150);
          for (const pid of allPids) {
            try {
              process.kill(pid, 0);
              process.kill(pid, 'SIGKILL');
            } catch {
              // Already exited or inaccessible.
            }
          }
        }
        processStatus = 'killed';
      } catch (error) {
        return res.status(500).json({ error: error?.message || 'Failed to kill session worker', pids: allPids });
      }
    }

    // Audit marker — always emitted before responding
    console.log(`[KILL] session=${sdkSessionId} pids=${allPids.join(',') || 'none'} processStatus=${processStatus}`);

    // Post-kill verification — synchronous re-scan to confirm processes are gone
    const remainingPids = allPids.length
      ? (process.platform === 'win32'
          ? (sessionWorkerProcessInspector?.findWindowsProcessesForSession?.(sdkSessionId) || []).map((p) => p.processId).filter(Boolean)
          : ((sessionWorkerProcessInspector?.findProcessesForSession?.(sdkSessionId) || []).map((p) => p.processId).filter(Boolean)))
      : [];

    sessionWorkerRegistry?.removeWorker?.(sdkSessionId);
    sessionWorkerSupervisor?.clearRestartSchedule?.(sdkSessionId);
    sessionWorkerSupervisor?.resetHealth?.(sdkSessionId, { clearFailureCount: false });

    // Drain ALL owned processing rows, not just first
    const queueRows = findAllProcessingOwnedBySession.all(sdkSessionId) || [];
    const failedMessageIds = [];

    if (queueRows.length > 0) {
      for (const queueRow of queueRows) {
        const failureRecord = {
          kind: 'manual-session-kill',
          code: 'worker-session-killed',
          stableCode: 'relay.worker-session-killed',
          message: '[System Message] This session was killed from the relay UI before the turn completed.',
          guidance: 'Retry the request or send a new message to relaunch the session if needed.',
          detail: [
            `session=${sdkSessionId}`,
            allPids.length ? `pids=${allPids.join(',')}` : 'pid=none',
            `processStatus=${processStatus}`,
          ].join(' | '),
          failedAt: new Date().toISOString(),
          requesterSessionId: sdkSessionId,
        };
        const failureText = buildTerminalFailureTextForChat(failureRecord);
        const failed = failQueueMessage({
          queueRow,
          messageId: queueRow.id,
          conversationId: queueRow.conversation_id,
          relayMode: queueRow.relay_mode || DEFAULT_RELAY_MODE,
          model: queueRow.model || DEFAULT_MODEL,
          responseText: failureText,
          failureRecord,
        });

        if (failed?.responseId) failedMessageIds.push(failed.responseId);
      }
    } else if (processStatus === 'not-running') {
      // not-running case: emit [System Message] into conversation history
      const conversationId = currentWorker?.conversationId
        || findMostRecentConversationForSession.get(sdkSessionId)?.conversation_id
        || null;
      if (conversationId) {
        insertSystemMessageForConversation({
          conversationId,
          text: '[System Message] Session kill requested — no live worker process was found.',
        });
      }
    }

    const conversationId = queueRows[0]?.conversation_id || currentWorker?.conversationId || null;

    io.emit('session_worker_killed', {
      sdkSessionId,
      conversationId,
      killedPids,
      remainingPids,
      processStatus,
      failedMessageIds,
    });

    return res.json({
      ok: true,
      sdkSessionId,
      killedPids,
      remainingPids,
      processStatus,
      failedMessageIds,
    });
  });

  app.post('/api/conversation/:conversationId/cancel-turn', auth, (req, res) => {
    const conversationId = String(req.params.conversationId || '').trim();
    const requestedMessageId = String(req.body?.messageId || req.body?.queueMessageId || '').trim();
    const sessionState = getConversationSessionState(conversationId);
    if (!sessionState.ok) {
      return rejectSessionBinding(res, sessionState.status, sessionState.error);
    }

    const queueRow = stmts.getLatestProcessingQueueByConversation.get(conversationId) || null;
    if (!queueRow) {
      return res.json({
        ok: true,
        queued: false,
        acknowledgement: 'no-active-turn',
        requestedMessageId: requestedMessageId || null,
        activeMessageId: null,
      });
    }

    const activeMessageId = String(queueRow.id || '').trim();
    if (requestedMessageId && activeMessageId && requestedMessageId !== activeMessageId) {
      const requestedRow = stmts.findQById.get(requestedMessageId) || null;
      const requestedStatus = String(requestedRow?.status || '').trim().toLowerCase();
      return res.json({
        ok: true,
        queued: false,
        acknowledgement: requestedStatus === 'processing' ? 'message-mismatch' : 'already-finished',
        requestedMessageId,
        activeMessageId,
      });
    }

    const sdkSessionId = normalizeSessionWorkerId(
      queueRow.owner_sdk_session_id
      || sessionState.runtimeSessionSdkSessionId
      || sessionState.conversationSdkSessionId,
    );
    if (!sdkSessionId) {
      return res.json({
        ok: true,
        queued: false,
        acknowledgement: 'active-turn-unbound',
        requestedMessageId: activeMessageId || requestedMessageId || null,
        activeMessageId,
      });
    }

    const existing = findActiveRelayControlByQueueMessage.get(activeMessageId, 'abort_turn') || null;
    if (existing) {
      return res.json({
        ok: true,
        queued: true,
        duplicate: true,
        acknowledgement: 'already-requested',
        requestedMessageId: activeMessageId || requestedMessageId || null,
        activeMessageId,
        control: formatRelayControlResponse(existing),
      });
    }

    const now = new Date().toISOString();
    const controlId = uuidv4();
    const requestPayload = JSON.stringify({
      source: 'relay-ui',
      requestedByClientId: String(req.body?.clientId || '').trim() || null,
    });
    insertRelayControlRequest.run(
      controlId,
      'abort_turn',
      conversationId,
      activeMessageId,
      sdkSessionId,
      requestPayload,
      now,
      now,
    );
    const control = getRelayControlRequestById.get(controlId) || null;
    return res.json({
      ok: true,
      queued: true,
      acknowledgement: 'stop-queued',
      requestedMessageId: activeMessageId || requestedMessageId || null,
      activeMessageId,
      control: formatRelayControlResponse(control),
    });
  });

  app.get('/api/control/active', auth, (req, res) => {
    const bridgeIdentity = readBridgeIdentity(req);
    const sdkSessionId = normalizeSessionWorkerId(req.query?.sdkSessionId || bridgeIdentity?.sessionId);
    const queueMessageId = String(req.query?.queueMessageId || req.query?.messageId || '').trim();
    if (!sdkSessionId) {
      return res.status(400).json({ error: 'Missing sdkSessionId' });
    }

    const pending = queueMessageId
      ? (findPendingRelayControlForSessionAndMessage.get(sdkSessionId, queueMessageId) || null)
      : (findPendingRelayControlForSession.get(sdkSessionId) || null);
    if (!pending) {
      return res.json({ ok: true, control: null });
    }
    if (String(pending.type || '').trim() === 'abort_turn') {
      const targetMessageId = String(pending.queue_message_id || '').trim();
      const targetRow = targetMessageId ? (stmts.findQById.get(targetMessageId) || null) : null;
      const targetOwnerSessionId = normalizeSessionWorkerId(targetRow?.owner_sdk_session_id);
      if (!targetRow || String(targetRow.status || '').trim().toLowerCase() !== 'processing' || targetOwnerSessionId !== sdkSessionId) {
        settleRelayAbortControlsForQueueMessage(targetMessageId || pending.queue_message_id, {
          ok: false,
          error: 'stale-control',
        });
        return res.json({ ok: true, control: null });
      }
    }

    const now = new Date().toISOString();
    const claimed = claimRelayControlRequest.run(now, pending.id);
    if (claimed.changes === 0) {
      return res.json({ ok: true, control: null });
    }

    const control = getRelayControlRequestById.get(pending.id) || pending;
    return res.json({ ok: true, control: formatRelayControlResponse(control) });
  });

  app.post('/api/control/:controlId/result', auth, (req, res) => {
    const controlId = String(req.params.controlId || '').trim();
    if (!controlId) {
      return res.status(400).json({ error: 'Missing control id' });
    }

    const control = getRelayControlRequestById.get(controlId) || null;
    if (!control) {
      return res.status(404).json({ error: 'Control request not found' });
    }

    const now = new Date().toISOString();
    const ok = req.body?.ok === true;
    if (!ok) {
      const errorText = String(req.body?.error || 'relay control failed').trim() || 'relay control failed';
      failRelayControlRequest.run(errorText, now, now, controlId);
      return res.json({ ok: true, control: formatRelayControlResponse(getRelayControlRequestById.get(controlId) || control) });
    }

    const resultPayload = JSON.stringify({
      source: 'relay-runtime',
      note: String(req.body?.note || '').trim() || null,
    });
    completeRelayControlRequest.run(resultPayload, now, now, controlId);

    if (String(control.type || '').trim() === 'abort_turn') {
      const queueMessageId = String(control.queue_message_id || '').trim();
      const queueRow = queueMessageId ? (stmts.findQById.get(queueMessageId) || null) : null;
      if (queueRow) {
        const failureRecord = buildRelayStopFailurePayload();
        failQueueMessage({
          queueRow,
          messageId: queueMessageId,
          conversationId: String(control.conversation_id || queueRow.conversation_id || '').trim(),
          relayMode: normalizeRelayMode(queueRow.relay_mode) || DEFAULT_RELAY_MODE,
          model: queueRow.model || null,
          responseText: buildTerminalFailureTextForChat(failureRecord),
          failureRecord,
          markWorkerError: false,
        });
      }
    }

    return res.json({ ok: true, control: formatRelayControlResponse(getRelayControlRequestById.get(controlId) || control) });
  });

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
    const rootOverride = resolveScopedWorkspaceRootPath(req);
    const filePath = resolveWorkspaceFilePath(requestedPath, rootOverride);
    if (!filePath) return res.status(400).json({ error: 'Invalid file path' });

    let meta = null;
    try {
      meta = readWorkspaceFileMeta(filePath);
    } catch (error) {
      return res.status(500).json({ error: error?.message || 'Failed to read file metadata' });
    }

    if (!meta || meta.kind === 'missing') return res.status(404).json({ error: 'File not found' });
    if (meta.kind !== 'file') return res.status(400).json({ error: 'Path must reference a file' });

    serveFileWithRangeSupport(req, res, filePath, meta, {
      safeName: path.basename(filePath).replace(/"/g, ''),
      cacheDelete: (p) => workspaceFileMetaCache.delete(p),
    });
  });

  app.get('/api/files-preview/*', auth, (req, res) => {
    const requestedPath = String(req.params?.[0] || '').trim();
    const normalizedPath = normalizeWorkspaceRelativePath(requestedPath);
    const rootOverride = resolveScopedWorkspaceRootPath(req);
    const filePath = resolveWorkspaceFilePath(requestedPath, rootOverride);
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
    const scopeSuffix = scopedWorkspaceQuerySuffix(req);
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
      rawUrl: `${remotePath}/api/files/${normalizedWebPath.split('/').map((part) => encodeURIComponent(part)).join('/')}${scopeSuffix}`,
    };

    if (kind !== 'binary' && kind !== 'image' && kind !== 'video') {
      payload.content = contentBuffer.toString('utf8');
    }

    res.setHeader('Cache-Control', 'no-store');
    res.json(payload);
  });

  app.get('/api/repo/tree', auth, (req, res) => {
    const includeHidden = parseBooleanQueryFlag(req.query.includeHidden, false);
    const includeHeavy = parseBooleanQueryFlag(req.query.includeHeavy, false);
    const rootOverride = resolveScopedWorkspaceRootPath(req);
    const snapshot = buildRepositoryTreeSnapshot({
      includeHidden,
      includeHeavy,
      maxNodes: MAX_REPO_TREE_NODES,
      rootPath: rootOverride,
    });
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

      serveFileWithRangeSupport(req, res, filePath, meta, {
        safeName: path.win32.basename(filePath).replace(/"/g, ''),
        cacheDelete: (p) => workspaceFileMetaCache.delete(p),
      });
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

      if (kind !== 'binary' && kind !== 'image' && kind !== 'video') {
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
    const shouldCreateConversation = !!newConversation || !conversationId;
    const conversationWorkspaceState = (!shouldCreateConversation && typeof resolveConversationWorkspaceState === 'function')
      ? resolveConversationWorkspaceState({ conversationId })
      : null;
    let workspaceRootUpdate = attachments.length === 0
      ? maybeApplyWorkspaceRootFromMessage(
          trimmedText,
          conversationWorkspaceState?.currentWorkspaceRootPath || null,
        )
      : { attempted: false, changed: false };

    if (!shouldCreateConversation) {
      const sessionState = getConversationSessionState(conversationId);
      // #region agent log
      postRelayDebugLog({
        runId: 'baseline-binding',
        hypothesisId: 'H3-server-guard',
        location: 'server/routes/messages-routes.mjs:api.message.session-state',
        message: 'api/message existing conversation session state',
        data: {
          conversationId,
          requesterSessionId: requesterSessionId || null,
          conversationSdkSessionId: sessionState?.conversationSdkSessionId || null,
          runtimeSessionSdkSessionId: sessionState?.runtimeSessionSdkSessionId || null,
          runtimeSessionId: sessionState?.runtimeSession?.id || null,
          runtimeSessionBySdkSessionId: sessionState?.runtimeSessionBySdkSessionId?.id || null,
          runtimeSessionBySdkSdkSessionId: sessionState?.runtimeSessionBySdkSessionId?.sdk_session_id || null,
        },
      });
      // #endregion
      if (!sessionState.ok) {
        return rejectSessionBinding(res, sessionState.status, sessionState.error);
      }
      conversationSdkSessionId = sessionState.conversationSdkSessionId || null;
      if (!sessionState.conversationSdkSessionId || !sessionState.runtimeSessionSdkSessionId) {
        // #region agent log
        postRelayDebugLog({
          runId: 'baseline-binding',
          hypothesisId: 'H4-server-missing-runtime',
          location: 'server/routes/messages-routes.mjs:api.message.reject.not-bound',
          message: 'api/message rejected because session binding is incomplete',
          data: {
            conversationId,
            requesterSessionId: requesterSessionId || null,
            conversationSdkSessionId: sessionState.conversationSdkSessionId || null,
            runtimeSessionSdkSessionId: sessionState.runtimeSessionSdkSessionId || null,
            runtimeSessionId: sessionState.runtimeSession?.id || null,
            runtimeSessionBySdkSessionId: sessionState.runtimeSessionBySdkSessionId?.id || null,
            runtimeSessionBySdkSdkSessionId: sessionState.runtimeSessionBySdkSessionId?.sdk_session_id || null,
          },
        });
        // #endregion
        return rejectSessionBinding(res, 409, 'Conversation is not session-bound yet');
      }
      if (sessionState.conversationSdkSessionId !== sessionState.runtimeSessionSdkSessionId) {
        // #region agent log
        postRelayDebugLog({
          runId: 'baseline-binding',
          hypothesisId: 'H5-server-mismatch',
          location: 'server/routes/messages-routes.mjs:api.message.reject.mismatch',
          message: 'api/message rejected because bound and runtime sdk sessions differ',
          data: {
            conversationId,
            requesterSessionId: requesterSessionId || null,
            conversationSdkSessionId: sessionState.conversationSdkSessionId || null,
            runtimeSessionSdkSessionId: sessionState.runtimeSessionSdkSessionId || null,
            runtimeSessionId: sessionState.runtimeSession?.id || null,
            runtimeSessionBySdkSessionId: sessionState.runtimeSessionBySdkSessionId?.id || null,
            runtimeSessionBySdkSdkSessionId: sessionState.runtimeSessionBySdkSessionId?.sdk_session_id || null,
          },
        });
        // #endregion
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
    let conversationWorkspaceRootState = null;
    if (workspaceRootUpdate.changed && workspaceRootUpdate.resolvedPath) {
      if (typeof updateConversationConfiguredWorkspaceRoot !== 'function') {
        workspaceRootUpdate = {
          ...workspaceRootUpdate,
          changed: false,
          error: 'Conversation workspace updates are unavailable',
        };
      } else {
        const updateResult = updateConversationConfiguredWorkspaceRoot({
          conversationId: convId,
          rootPath: workspaceRootUpdate.resolvedPath,
        });
        if (!updateResult?.ok) {
          workspaceRootUpdate = {
            ...workspaceRootUpdate,
            changed: false,
            error: updateResult?.error || 'Failed to update conversation workspace root',
          };
        } else {
          conversationWorkspaceRootState = updateResult?.state || null;
          workspaceRootUpdate = {
            ...workspaceRootUpdate,
            changed: true,
            rootPath: conversationWorkspaceRootState?.configuredWorkspaceRootPath || workspaceRootUpdate.resolvedPath,
            rootName: conversationWorkspaceRootState?.configuredWorkspaceRootName || workspaceRootUpdate.rootName || null,
          };
        }
      }
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
      conversationId: convId,
      isNewConversation: shouldCreateConversation,
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
    const conversationPreferences = persistConversationModeModelPreference(
      convId,
      requestedRelayMode,
      requestedModel,
      now,
    );
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
    // #region agent log
    postRelayDebugLog({
      runId: 'slow-turn-baseline',
      hypothesisId: 'H6-queue-wait',
      location: 'server/routes/messages-routes.mjs:api.message.enqueued',
      message: 'message enqueued for relay processing',
      data: {
        queueMessageId: msgId,
        conversationId: convId,
        requesterSessionId: requesterSessionId || null,
        ownerSessionId: ownerSessionId || null,
        runtimeSessionId: runtimeSession?.id || null,
        relayMode: requestedRelayMode,
        model: requestedModel,
        seededCarryOver: shouldApplySeed,
        queuedTextChars: String(queueText || '').length,
      },
    });
    // #endregion
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
    if (conversationWorkspaceRootState?.conversationId) {
      const workspaceHints = workspaceRootPayload();
      io.emit('conversation_workspace_root_updated', {
        conversationId: conversationWorkspaceRootState.conversationId,
        sdkSessionId: conversationWorkspaceRootState.sdkSessionId || null,
        configuredWorkspaceRootPath: conversationWorkspaceRootState.configuredWorkspaceRootPath || null,
        configuredWorkspaceRootName: conversationWorkspaceRootState.configuredWorkspaceRootName || null,
        runtimeWorkspaceRootPath: conversationWorkspaceRootState.runtimeWorkspaceRootPath || null,
        runtimeWorkspaceRootName: conversationWorkspaceRootState.runtimeWorkspaceRootName || null,
        currentWorkspaceRootPath: conversationWorkspaceRootState.currentWorkspaceRootPath || null,
        currentWorkspaceRootName: conversationWorkspaceRootState.currentWorkspaceRootName || null,
        recentWorkspaceRoots: Array.isArray(workspaceHints?.recentWorkspaceRoots) ? workspaceHints.recentWorkspaceRoots : [],
      });
    }
    res.json({
      ok: true,
      messageId: msgId,
      conversationId: convId,
      runtimeSessionId: runtimeSession?.id || null,
      ownerSessionId: ownerSessionId || null,
      preferredRelayMode: conversationPreferences.preferredRelayMode,
      preferredModelsByMode: conversationPreferences.preferredModelsByMode,
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
    const activeQueueMessageId = String(req.body?.activeQueueMessageId || '').trim();
    if (requesterSessionId) {
      const existingRequesterWorker = sessionWorkerRegistry?.getWorker?.(requesterSessionId) || null;
      const requesterPid = Number(requester?.pid);
      const normalizedRequesterPid = Number.isInteger(requesterPid) && requesterPid > 0 ? requesterPid : null;
      const requesterConversationId = String(requester?.conversationId || '').trim() || null;
      const shouldPromoteReady = !existingRequesterWorker
        || existingRequesterWorker.status === 'new'
        || (!existingRequesterWorker.workerId && !existingRequesterWorker.pid);
      if (shouldPromoteReady) {
        sessionWorkerRegistry?.upsertWorker?.({
          ...(existingRequesterWorker || {}),
          sdkSessionId: requesterSessionId,
          status: 'ready',
          conversationId: requesterConversationId || existingRequesterWorker?.conversationId || null,
          pid: normalizedRequesterPid || existingRequesterWorker?.pid || null,
          queueDepth: Math.max(0, Number(queueCounts?.().pendingCount || 0)),
        });
      } else if (normalizedRequesterPid && existingRequesterWorker?.pid !== normalizedRequesterPid) {
        sessionWorkerRegistry?.upsertWorker?.({
          ...existingRequesterWorker,
          sdkSessionId: requesterSessionId,
          pid: normalizedRequesterPid,
        });
      }
      sessionWorkerSupervisor?.noteSessionHeartbeat?.(requesterSessionId);
      if (activeQueueMessageId) {
        const now = new Date().toISOString();
        const leaseExpiresAt = addMsToIso(now, SESSION_WORKER_OWNER_LEASE_MS);
        refreshProcessingLeaseForOwnedMessage.run(leaseExpiresAt, now, activeQueueMessageId, requesterSessionId);
        recoverOwnedProcessingRowsForSession(requesterSessionId, {
          excludeMessageId: activeQueueMessageId,
          reason: 'owner-heartbeat-mismatch',
        });
      } else {
        recoverOwnedProcessingRowsForSession(requesterSessionId, {
          reason: 'owner-heartbeat-idle',
        });
      }
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
    const now = new Date().toISOString();
    let affinityOnlyDequeue = !sessionWorkerRoutingEnabled && Boolean(requesterSessionId);
    let enforceOwnerMismatch = requester && ownerObservation?.accepted === false && !sessionWorkerRoutingEnabled;
    if (enforceOwnerMismatch && requesterSessionId && stmts.countQueueWorkForSessionAffinity) {
      const scopedWork = stmts.countQueueWorkForSessionAffinity.get(now, requesterSessionId);
      if (Number(scopedWork?.cnt || 0) > 0) {
        enforceOwnerMismatch = false;
        affinityOnlyDequeue = true;
      }
    }
    if (enforceOwnerMismatch) {
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

    let dequeueResult = null;
    try {
      dequeueResult = await dequeuePendingMessageForWorkerLoop({
        db,
        stmts,
        nowIso: now,
        routingEnabled: sessionWorkerRoutingEnabled,
        requesterSessionId,
        ownerLeaseMs: SESSION_WORKER_OWNER_LEASE_MS,
        affinityOnly: affinityOnlyDequeue,
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
      const strandedWorker = strandedSessionId
        ? (sessionWorkerRegistry?.getWorker?.(strandedSessionId) || sessionWorkerSupervisor?.getWorkerState?.(strandedSessionId) || null)
        : null;
      const strandedLifecycle = strandedSessionId
        ? (sessionWorkerSupervisor?.getLifecycleState?.(strandedSessionId) || null)
        : null;
      const strandedStatus = String(strandedWorker?.status || '').trim().toLowerCase();
      const lastPrimeAtMs = strandedSessionId ? Number(strandedPrimeCooldownBySession.get(strandedSessionId) || 0) : 0;
      const nowMs = Date.now();
      const cooldownActive = lastPrimeAtMs > 0 && (nowMs - lastPrimeAtMs) < STRANDED_SESSION_PRIME_COOLDOWN_MS;
      const heartbeatMs = Date.parse(String(strandedLifecycle?.lastHeartbeatAt || '').trim());
      const heartbeatFresh = Number.isFinite(heartbeatMs) && (nowMs - heartbeatMs) < STRANDED_SESSION_HEARTBEAT_FRESH_MS;
      const shouldSkipPrime = cooldownActive
        || strandedStatus === 'processing'
        || strandedStatus === 'starting'
        || (strandedStatus === 'ready' && heartbeatFresh);
      if (
        shouldAutoPrimeStrandedSession({
          strandedRow: strandedOwner,
          requesterSessionId,
        })
        && !shouldSkipPrime
        && typeof sessionWorkerSupervisor?.ensureWorker === 'function'
      ) {
        strandedPrimeCooldownBySession.set(strandedSessionId, nowMs);
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
      } else if (strandedSessionId && shouldSkipPrime) {
        // #region agent log
        postRelayDebugLog({
          runId: 'baseline-1',
          hypothesisId: 'H4',
          location: 'server/routes/messages-routes.mjs:worker.prime.skipped',
          message: 'stranded owner prime skipped by cooldown/health gate',
          data: {
            requesterSessionId,
            strandedSessionId,
            strandedStatus,
            cooldownActive,
            heartbeatFresh,
            heartbeatAt: String(strandedLifecycle?.lastHeartbeatAt || ''),
          },
        });
        // #endregion
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

  app.post('/api/queue/empty', auth, (req, res) => {
    if (!isLoopbackRequest(req)) {
      return res.status(403).json({ error: 'Queue empty endpoint is localhost-only' });
    }
    const rows = stmts.listQueueForPauseDrop.all();
    const droppedCount = rows.length;
    if (!droppedCount) {
      return res.json({ ok: true, droppedCount: 0, queue: queueCounts() });
    }
    const beforeQueue = queueCounts();
    const dropQueue = db.transaction(() => {
      for (const row of rows) {
        stmts.deleteQueueById.run(row.id);
      }
    });
    dropQueue();
    for (const row of rows) {
      io.emit('message_status', { messageId: row.id, conversationId: row.conversation_id, status: 'dropped' });
    }
    const afterQueue = queueCounts();
    io.emit('queue_updated', { droppedCount, reason: 'manual-empty-queue' });
    console.log(`[${ts()}] RELAY     queue emptied dropped=${droppedCount}`);
    return res.json({
      ok: true,
      droppedCount,
      queueBefore: beforeQueue,
      queue: afterQueue,
    });
  });

  app.post('/api/relay/shutdown', auth, (req, res) => {
    if (!isLoopbackRequest(req)) {
      return res.status(403).json({ error: 'Relay shutdown endpoint is localhost-only' });
    }
    if (typeof requestRelayShutdown !== 'function') {
      return res.status(501).json({ error: 'Relay shutdown orchestration is unavailable' });
    }
    const reason = String(req.body?.reason || 'manual-request').trim().slice(0, 140) || 'manual-request';
    const requestedBy = String(req.body?.requestedBy || 'localhost-api').trim().slice(0, 80) || 'localhost-api';
    const rawRestart = req.body?.restart;
    const restart = rawRestart === true
      || rawRestart === 1
      || String(rawRestart || '').trim().toLowerCase() === 'true'
      || String(rawRestart || '').trim() === '1';
    const result = requestRelayShutdown({ reason, requestedBy, restart });
    return res.json({ ok: true, ...result });
  });

  // POST /api/response — CLI submits response
  app.post('/api/response', auth, async (req, res) => {
    touchCli();
    const { messageId, conversationId, text, model, mode } = req.body;
    const trimmedText = String(text || '').trim();
    const terminalFailure = resolveTerminalFailurePayload(req.body, { fallbackText: trimmedText });

    if (!trimmedText && !terminalFailure) return res.status(400).json({ error: 'Empty response' });
    if (!messageId) return res.status(400).json({ error: 'Missing messageId' });

    const q = stmts.findQById.get(messageId);
    const targetConversationId = q?.conversation_id || conversationId;
    if (!targetConversationId) return res.status(400).json({ error: 'Missing conversationId' });
    const responseBridgeIdentity = readBridgeIdentity(req);
    // #region agent log
    postRelayDebugLog({
      runId: 'baseline-1',
      hypothesisId: 'H2',
      location: 'server/routes/messages-routes.mjs:api.response.entry',
      message: 'response received for queue message',
      data: {
        queueMessageId: String(messageId || ''),
        queueStatus: String(q?.status || ''),
        ownerSessionId: String(q?.owner_sdk_session_id || ''),
        requesterSessionId: String(responseBridgeIdentity?.sessionId || ''),
        requesterPid: Number(responseBridgeIdentity?.pid || 0) || null,
        conversationId: String(targetConversationId || ''),
      },
    });
    // #endregion

    if (q && q.status === 'done') {
      console.log(`[${ts()}] RESPONSE  ${messageId?.slice(0,8)} ignored=already_done`);
      return res.json({ ok: true, ignored: 'already_done' });
    }
    if (q && q.status === 'failed') {
      console.log(`[${ts()}] RESPONSE  ${messageId?.slice(0,8)} ignored=already_failed`);
      return res.json({ ok: true, ignored: 'already_failed' });
    }

    const relayMode = normalizeRelayMode(mode || q?.relay_mode) || DEFAULT_RELAY_MODE;
    if (terminalFailure) {
      const failureText = buildTerminalFailureTextForChat(terminalFailure, trimmedText);
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
      settleRelayAbortControlsForQueueMessage(messageId, {
        ok: false,
        error: 'queue-terminal-failure',
      });
      console.warn(
        `[${ts()}] FAILED    ${messageId?.slice(0,8)} conv=${targetConversationId?.slice(0,8)} code=${terminalFailure.stableCode}`
        + `${terminalFailure.functionCallId ? ` call=${terminalFailure.functionCallId}` : ''}`
        + `${terminalFailure.requestId ? ` req=${terminalFailure.requestId}` : ''}`,
      );
      return res.json({ ok: true, terminal: true, code: terminalFailure.stableCode });
    }

    const conversation = stmts.getConvAnyStatus?.get?.(targetConversationId) || null;
    const resolvedText = await resolveRelayResponseText({
      text: trimmedText,
      conversation,
      queueTimestamp: q?.timestamp || null,
      readSessionTranscriptMessages,
      opaqueResponseRecoveryWaitMs,
      opaqueResponseRecoveryPollMs,
      messageId,
      checkHasActiveRelayQuestion: (msgId) => {
        // Block finalization if there's a pending relay question for this turn.
        if (stmts.findPendingQuestionByMessage?.get(msgId)) return true;
        // Also hold for a short window after a question was answered. The SDK may fire another
        // onUserInputRequest (next ask_user call) within a few seconds of the previous answer.
        const holdCutoff = new Date(Date.now() - relayQuestionFinalizationHoldMs).toISOString();
        return !!(stmts.findRecentlyAnsweredQuestionByMessage?.get(msgId, holdCutoff));
      },
    });
    if (!resolvedText) return res.status(400).json({ error: 'Empty response' });

    const responseId = uuidv4();
    const now = new Date().toISOString();
    const finalize = db.transaction(() => {
      const result = stmts.setDone.run(resolvedText, messageId);
      if (result.changes === 0) return false;
      stmts.setQueueResponseMessageId?.run(responseId, messageId);
      stmts.insertMsg.run(responseId, targetConversationId, 'assistant', resolvedText, model || null, relayMode, null, now);
      stmts.linkActivityToResponse.run(responseId, messageId);
      stmts.linkStreamEventsToResponse?.run(responseId, messageId);
      stmts.updateConvTime.run(now, targetConversationId);
      stmts.pruneQueue.run();
      return true;
    });

    const finalized = finalize();
    if (!finalized) {
      // #region agent log
      postRelayDebugLog({
        runId: 'baseline-1',
        hypothesisId: 'H2',
        location: 'server/routes/messages-routes.mjs:api.response.finalize.false',
        message: 'response ignored because queue row not pending/processing',
        data: {
          queueMessageId: String(messageId || ''),
          queueStatus: String(q?.status || ''),
          ownerSessionId: String(q?.owner_sdk_session_id || ''),
          requesterSessionId: String(responseBridgeIdentity?.sessionId || ''),
        },
      });
      // #endregion
      console.log(`[${ts()}] RESPONSE  ${messageId?.slice(0,8)} ignored=not_pending_or_processing`);
      return res.json({ ok: true, ignored: 'not_pending_or_processing' });
    }
    // #region agent log
    const queuedAtMs = Date.parse(String(q?.timestamp || '').trim());
    const processingAtMs = Date.parse(String(q?.processing_at || '').trim());
    const finalizedAtMs = Date.parse(now);
    const queueToDoneMs = Number.isFinite(queuedAtMs) && Number.isFinite(finalizedAtMs)
      ? Math.max(0, finalizedAtMs - queuedAtMs)
      : null;
    const processingToDoneMs = Number.isFinite(processingAtMs) && Number.isFinite(finalizedAtMs)
      ? Math.max(0, finalizedAtMs - processingAtMs)
      : null;
    const queueToProcessingMs = Number.isFinite(queuedAtMs) && Number.isFinite(processingAtMs)
      ? Math.max(0, processingAtMs - queuedAtMs)
      : null;
    postRelayDebugLog({
      runId: 'slow-turn-baseline',
      hypothesisId: 'H7-turn-duration',
      location: 'server/routes/messages-routes.mjs:api.response.finalize.true',
      message: 'response finalized queue message',
      data: {
        queueMessageId: String(messageId || ''),
        priorQueueStatus: String(q?.status || ''),
        ownerSessionId: String(q?.owner_sdk_session_id || ''),
        requesterSessionId: String(responseBridgeIdentity?.sessionId || ''),
        requesterPid: Number(responseBridgeIdentity?.pid || 0) || null,
        queueToDoneMs,
        processingToDoneMs,
        queueToProcessingMs,
        queuedAt: String(q?.timestamp || ''),
        processingAt: String(q?.processing_at || ''),
        finalizedAt: now,
      },
    });
    // #endregion
    settleRelayAbortControlsForQueueMessage(messageId, {
      ok: true,
      note: 'queue message completed before stop control was applied',
    });
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
      message: { role: 'assistant', text: resolvedText, model: model || null, mode: relayMode, timestamp: now, activities },
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

    const now = new Date().toISOString();
    const requestedConversationId = String(conversationId || '').trim();
    const queueRow = stmts.findQById.get(messageId);
    if (!queueRow) {
      return res.status(404).json({ error: 'Queue message not found' });
    }
    const queueConversationId = String(queueRow.conversation_id || '').trim();
    if (!queueConversationId || queueConversationId !== requestedConversationId) {
      return res.status(409).json({ error: 'Stream conversationId does not match queue conversation' });
    }

    const isStreamSeqConstraintError = (error) => {
      const message = String(error?.message || '').toLowerCase();
      return message.includes('unique constraint failed')
        && message.includes('relay_stream_events')
        && message.includes('queue_message_id')
        && message.includes('seq');
    };

    let seq = null;
    try {
      const insertStreamEventTx = db.transaction(() => {
        const q = stmts.findQById.get(messageId) || queueRow;
        const currentConversationId = String(q?.conversation_id || '').trim();
        if (!currentConversationId || currentConversationId !== requestedConversationId) {
          const error = new Error('Stream conversationId does not match queue conversation');
          error.code = 'STREAM_CONVERSATION_MISMATCH';
          throw error;
        }
        const responseMessageId = q?.response_message_id || null;
        const row = stmts.getLastStreamSeqByQueueMessage?.get(messageId);
        const maxSeq = Math.max(0, Number(row?.max_seq || 0));
        const nextSeq = maxSeq + 1;
        stmts.insertStreamEvent?.run(
          messageId,
          responseMessageId,
          conversationId,
          normalizeRelayMode(mode) || DEFAULT_RELAY_MODE,
          nextSeq,
          streamText,
          done ? 1 : 0,
          now,
        );
        return nextSeq;
      });
      const runInsertStreamEvent = typeof insertStreamEventTx?.immediate === 'function'
        ? insertStreamEventTx.immediate.bind(insertStreamEventTx)
        : insertStreamEventTx;
      const maxRetries = 4;
      for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
        try {
          seq = runInsertStreamEvent();
          break;
        } catch (error) {
          if (error?.code === 'STREAM_CONVERSATION_MISMATCH') {
            return res.status(409).json({ error: error.message });
          }
          const shouldRetry = isStreamSeqConstraintError(error) && attempt < maxRetries;
          if (shouldRetry) {
            // #region agent log
            postRelayDebugLog({
              runId: 'baseline-1',
              hypothesisId: 'H5',
              location: 'server/routes/messages-routes.mjs:api.stream.retry',
              message: 'stream sequence constraint retry',
              data: {
                queueMessageId: String(messageId || ''),
                attempt,
                error: String(error?.message || error || 'stream-seq-insert-failed'),
              },
            });
            // #endregion
          }
          if (!shouldRetry) throw error;
        }
      }
    } catch (error) {
      return res.status(500).json({ error: error?.message || 'Failed to persist stream event' });
    }

    io.emit('relay_stream', {
      messageId,
      conversationId,
      mode: normalizeRelayMode(mode) || DEFAULT_RELAY_MODE,
      text: streamText,
      done: !!done,
      seq,
      timestamp: now,
    });
    res.json({ ok: true, seq });
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
        settleRelayAbortControlsForQueueMessage(messageId, {
          ok: false,
          error: 'queue-terminal-failure',
        });
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
          settleRelayAbortControlsForQueueMessage(messageId, {
            ok: false,
            error: parkForRestart ? 'queue-parked' : 'queue-requeued',
          });
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
