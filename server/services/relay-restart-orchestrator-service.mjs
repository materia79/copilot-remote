'use strict';

import crypto from 'crypto';

const STATES = Object.freeze({
  IDLE: 'idle',
  DRAINING: 'draining',
  RESTARTING: 'restarting',
  AWAITING_REBIND: 'awaiting_rebind',
  READY: 'ready',
});
const DEFAULT_RETRY_BACKOFF_MS = Object.freeze([1_000, 3_000, 7_000]);

function normalizeState(value) {
  const state = String(value || '').trim().toLowerCase();
  if (Object.values(STATES).includes(state)) return state;
  return STATES.IDLE;
}

function isoNow(nowFn) {
  return new Date(nowFn()).toISOString();
}

function addMs(iso, ms) {
  const base = new Date(iso).getTime();
  return new Date(base + ms).toISOString();
}

function parsePositiveInt(value, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return Math.round(num);
}

function parseBackoffSchedule(value, fallback = DEFAULT_RETRY_BACKOFF_MS) {
  if (!Array.isArray(value)) return [...fallback];
  const out = value
    .map((entry) => Number(entry))
    .filter((num) => Number.isFinite(num) && num > 0)
    .map((num) => Math.round(num));
  return out.length ? out : [...fallback];
}

function normalizeId(value) {
  return String(value || '').trim() || null;
}

function parseBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1') return true;
  if (value === 0 || value === '0') return false;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return fallback;
}

function classifyRebindConflict(code) {
  const normalized = String(code || '').trim();
  if (normalized === 'transaction-mismatch' || normalized === 'target-mismatch') {
    return { retryable: false, terminal: true };
  }
  if (normalized === 'active-session-mismatch' || normalized === 'not-awaiting-rebind') {
    return { retryable: true, terminal: false };
  }
  return { retryable: true, terminal: false };
}

export function createRelayRestartOrchestrator({
  db,
  gracefulTimeoutMs = 8_000,
  readyCooldownMs = 1_000,
  shutdownTimeoutMs = 45_000,
  spawnTimeoutMs = 18_000,
  rebindTimeoutMs = 20_000,
  maxAttempts = 3,
  retryBackoffMs = DEFAULT_RETRY_BACKOFF_MS,
  now = () => Date.now(),
} = {}) {
  if (!db) throw new Error('createRelayRestartOrchestrator requires db');
  const safeGracefulTimeoutMs = parsePositiveInt(gracefulTimeoutMs, 8_000);
  const safeReadyCooldownMs = parsePositiveInt(readyCooldownMs, 1_000);
  const safeShutdownTimeoutMs = parsePositiveInt(shutdownTimeoutMs, 45_000);
  const safeSpawnTimeoutMs = parsePositiveInt(spawnTimeoutMs, 18_000);
  const safeRebindTimeoutMs = parsePositiveInt(rebindTimeoutMs, 20_000);
  const safeMaxAttempts = parsePositiveInt(maxAttempts, 3);
  const safeRetryBackoffMs = parseBackoffSchedule(retryBackoffMs);

  db.exec(`
    CREATE TABLE IF NOT EXISTS relay_restart_orchestrator (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      state TEXT NOT NULL DEFAULT 'idle',
      transaction_id TEXT,
      target_session_id TEXT,
      queued_target_session_id TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      requested_count INTEGER NOT NULL DEFAULT 0,
      requested_at TEXT,
      draining_started_at TEXT,
      restart_requested_at TEXT,
      force_after_at TEXT,
      force_requested_at TEXT,
      spawn_deadline_at TEXT,
      awaiting_rebind_at TEXT,
      rebind_deadline_at TEXT,
      retry_at TEXT,
      retry_backoff_ms INTEGER,
      retry_phase TEXT,
      rebind_confirmed_at TEXT,
      last_rebind_signal_at TEXT,
      last_rebind_signal_session_id TEXT,
      last_rebind_signal_conversation_id TEXT,
      last_rebind_signal_transaction_id TEXT,
      last_rebind_outcome TEXT,
      last_rebind_error_code TEXT,
      last_rebind_error_retryable INTEGER NOT NULL DEFAULT 0,
      last_rebind_error_terminal INTEGER NOT NULL DEFAULT 0,
      ready_at TEXT,
      completed_at TEXT,
      last_failure_phase TEXT,
      last_failure_code TEXT,
      last_failure_retryable INTEGER NOT NULL DEFAULT 0,
      last_failure_terminal INTEGER NOT NULL DEFAULT 0,
      last_failure_at TEXT,
      terminal_outcome_phase TEXT,
      terminal_outcome_code TEXT,
      terminal_outcome_message TEXT,
      terminal_outcome_attempts INTEGER NOT NULL DEFAULT 0,
      terminal_outcome_at TEXT,
      last_error TEXT,
      updated_at TEXT NOT NULL
    );
  `);
  const existingColumns = new Set(
    db.prepare(`PRAGMA table_info(relay_restart_orchestrator)`).all().map((row) => String(row?.name || '').trim()),
  );
  const ensureColumn = (name, definition) => {
    if (existingColumns.has(name)) return;
    db.exec(`ALTER TABLE relay_restart_orchestrator ADD COLUMN ${definition}`);
    existingColumns.add(name);
  };
  ensureColumn('rebind_confirmed_at', 'rebind_confirmed_at TEXT');
  ensureColumn('last_rebind_signal_at', 'last_rebind_signal_at TEXT');
  ensureColumn('last_rebind_signal_session_id', 'last_rebind_signal_session_id TEXT');
  ensureColumn('last_rebind_signal_conversation_id', 'last_rebind_signal_conversation_id TEXT');
  ensureColumn('last_rebind_signal_transaction_id', 'last_rebind_signal_transaction_id TEXT');
  ensureColumn('last_rebind_outcome', 'last_rebind_outcome TEXT');
  ensureColumn('last_rebind_error_code', 'last_rebind_error_code TEXT');
  ensureColumn('last_rebind_error_retryable', 'last_rebind_error_retryable INTEGER NOT NULL DEFAULT 0');
  ensureColumn('last_rebind_error_terminal', 'last_rebind_error_terminal INTEGER NOT NULL DEFAULT 0');
  ensureColumn('spawn_deadline_at', 'spawn_deadline_at TEXT');
  ensureColumn('rebind_deadline_at', 'rebind_deadline_at TEXT');
  ensureColumn('retry_at', 'retry_at TEXT');
  ensureColumn('retry_backoff_ms', 'retry_backoff_ms INTEGER');
  ensureColumn('retry_phase', 'retry_phase TEXT');
  ensureColumn('last_failure_phase', 'last_failure_phase TEXT');
  ensureColumn('last_failure_code', 'last_failure_code TEXT');
  ensureColumn('last_failure_retryable', 'last_failure_retryable INTEGER NOT NULL DEFAULT 0');
  ensureColumn('last_failure_terminal', 'last_failure_terminal INTEGER NOT NULL DEFAULT 0');
  ensureColumn('last_failure_at', 'last_failure_at TEXT');
  ensureColumn('terminal_outcome_phase', 'terminal_outcome_phase TEXT');
  ensureColumn('terminal_outcome_code', 'terminal_outcome_code TEXT');
  ensureColumn('terminal_outcome_message', 'terminal_outcome_message TEXT');
  ensureColumn('terminal_outcome_attempts', 'terminal_outcome_attempts INTEGER NOT NULL DEFAULT 0');
  ensureColumn('terminal_outcome_at', 'terminal_outcome_at TEXT');

  const ensureRow = db.prepare(`
    INSERT INTO relay_restart_orchestrator (id, state, attempts, requested_count, updated_at)
    VALUES (1, 'idle', 0, 0, ?)
    ON CONFLICT(id) DO NOTHING
  `);
  const getRow = db.prepare(`SELECT * FROM relay_restart_orchestrator WHERE id = 1`);
  const updateRow = db.prepare(`
    UPDATE relay_restart_orchestrator
    SET
      state = @state,
      transaction_id = @transaction_id,
      target_session_id = @target_session_id,
      queued_target_session_id = @queued_target_session_id,
      attempts = @attempts,
      requested_count = @requested_count,
      requested_at = @requested_at,
      draining_started_at = @draining_started_at,
      restart_requested_at = @restart_requested_at,
      force_after_at = @force_after_at,
      force_requested_at = @force_requested_at,
      spawn_deadline_at = @spawn_deadline_at,
      awaiting_rebind_at = @awaiting_rebind_at,
      rebind_deadline_at = @rebind_deadline_at,
      retry_at = @retry_at,
      retry_backoff_ms = @retry_backoff_ms,
      retry_phase = @retry_phase,
      rebind_confirmed_at = @rebind_confirmed_at,
      last_rebind_signal_at = @last_rebind_signal_at,
      last_rebind_signal_session_id = @last_rebind_signal_session_id,
      last_rebind_signal_conversation_id = @last_rebind_signal_conversation_id,
      last_rebind_signal_transaction_id = @last_rebind_signal_transaction_id,
      last_rebind_outcome = @last_rebind_outcome,
      last_rebind_error_code = @last_rebind_error_code,
      last_rebind_error_retryable = @last_rebind_error_retryable,
      last_rebind_error_terminal = @last_rebind_error_terminal,
      ready_at = @ready_at,
      completed_at = @completed_at,
      last_failure_phase = @last_failure_phase,
      last_failure_code = @last_failure_code,
      last_failure_retryable = @last_failure_retryable,
      last_failure_terminal = @last_failure_terminal,
      last_failure_at = @last_failure_at,
      terminal_outcome_phase = @terminal_outcome_phase,
      terminal_outcome_code = @terminal_outcome_code,
      terminal_outcome_message = @terminal_outcome_message,
      terminal_outcome_attempts = @terminal_outcome_attempts,
      terminal_outcome_at = @terminal_outcome_at,
      last_error = @last_error,
      updated_at = @updated_at
    WHERE id = 1
  `);

  function readState() {
    ensureRow.run(isoNow(now));
    const row = getRow.get() || {};
    const state = normalizeState(row.state);
    const transactionId = normalizeId(row.transaction_id);
    const targetSessionId = normalizeId(row.target_session_id);
    const terminalOutcome = normalizeId(row.terminal_outcome_code)
      ? {
          phase: normalizeId(row.terminal_outcome_phase),
          code: normalizeId(row.terminal_outcome_code),
          message: String(row.terminal_outcome_message || '').trim() || null,
          attempts: Number(row.terminal_outcome_attempts || 0),
          at: row.terminal_outcome_at || null,
        }
      : null;
    return {
      state,
      transactionId,
      targetSessionId,
      queuedTargetSessionId: normalizeId(row.queued_target_session_id),
      attempts: Number(row.attempts || 0),
      requestedCount: Number(row.requested_count || 0),
      requestedAt: row.requested_at || null,
      drainingStartedAt: row.draining_started_at || null,
      restartRequestedAt: row.restart_requested_at || null,
      forceAfterAt: row.force_after_at || null,
      forceRequestedAt: row.force_requested_at || null,
      spawnDeadlineAt: row.spawn_deadline_at || null,
      awaitingRebindAt: row.awaiting_rebind_at || null,
      rebindDeadlineAt: row.rebind_deadline_at || null,
      retryAt: row.retry_at || null,
      retryBackoffMs: Number(row.retry_backoff_ms || 0) || null,
      retryPhase: normalizeId(row.retry_phase),
      rebindConfirmedAt: row.rebind_confirmed_at || null,
      lastRebindSignalAt: row.last_rebind_signal_at || null,
      lastRebindSignalSessionId: normalizeId(row.last_rebind_signal_session_id),
      lastRebindSignalConversationId: normalizeId(row.last_rebind_signal_conversation_id),
      lastRebindSignalTransactionId: normalizeId(row.last_rebind_signal_transaction_id),
      lastRebindOutcome: normalizeId(row.last_rebind_outcome),
      lastRebindErrorCode: normalizeId(row.last_rebind_error_code),
      lastRebindErrorRetryable: parseBoolean(row.last_rebind_error_retryable, false),
      lastRebindErrorTerminal: parseBoolean(row.last_rebind_error_terminal, false),
      readyAt: row.ready_at || null,
      completedAt: row.completed_at || null,
      lastFailurePhase: normalizeId(row.last_failure_phase),
      lastFailureCode: normalizeId(row.last_failure_code),
      lastFailureRetryable: parseBoolean(row.last_failure_retryable, false),
      lastFailureTerminal: parseBoolean(row.last_failure_terminal, false),
      lastFailureAt: row.last_failure_at || null,
      terminalOutcomePhase: normalizeId(row.terminal_outcome_phase),
      terminalOutcomeCode: normalizeId(row.terminal_outcome_code),
      terminalOutcomeMessage: String(row.terminal_outcome_message || '').trim() || null,
      terminalOutcomeAttempts: Number(row.terminal_outcome_attempts || 0),
      terminalOutcomeAt: row.terminal_outcome_at || null,
      terminalOutcome,
      lastError: String(row.last_error || '').trim() || null,
      gracefulTimeoutMs: safeGracefulTimeoutMs,
      readyCooldownMs: safeReadyCooldownMs,
      shutdownTimeoutMs: safeShutdownTimeoutMs,
      spawnTimeoutMs: safeSpawnTimeoutMs,
      rebindTimeoutMs: safeRebindTimeoutMs,
      maxAttempts: safeMaxAttempts,
      retryBackoffMsSchedule: [...safeRetryBackoffMs],
      awaitingRebind: state === STATES.AWAITING_REBIND,
      rebindRequired: state === STATES.AWAITING_REBIND,
      expectedRebind: {
        transactionId,
        targetSessionId,
      },
    };
  }

  function writeState(nextState) {
    const current = readState();
    const merged = { ...current, ...nextState };
    const row = {
      state: normalizeState(merged.state),
      transaction_id: merged.transactionId || null,
      target_session_id: merged.targetSessionId || null,
      queued_target_session_id: merged.queuedTargetSessionId || null,
      attempts: Math.max(0, Number(merged.attempts || 0)),
      requested_count: Math.max(0, Number(merged.requestedCount || 0)),
      requested_at: merged.requestedAt || null,
      draining_started_at: merged.drainingStartedAt || null,
      restart_requested_at: merged.restartRequestedAt || null,
      force_after_at: merged.forceAfterAt || null,
      force_requested_at: merged.forceRequestedAt || null,
      spawn_deadline_at: merged.spawnDeadlineAt || null,
      awaiting_rebind_at: merged.awaitingRebindAt || null,
      rebind_deadline_at: merged.rebindDeadlineAt || null,
      retry_at: merged.retryAt || null,
      retry_backoff_ms: Number(merged.retryBackoffMs || 0) || null,
      retry_phase: merged.retryPhase || null,
      rebind_confirmed_at: merged.rebindConfirmedAt || null,
      last_rebind_signal_at: merged.lastRebindSignalAt || null,
      last_rebind_signal_session_id: merged.lastRebindSignalSessionId || null,
      last_rebind_signal_conversation_id: merged.lastRebindSignalConversationId || null,
      last_rebind_signal_transaction_id: merged.lastRebindSignalTransactionId || null,
      last_rebind_outcome: merged.lastRebindOutcome || null,
      last_rebind_error_code: merged.lastRebindErrorCode || null,
      last_rebind_error_retryable: merged.lastRebindErrorRetryable ? 1 : 0,
      last_rebind_error_terminal: merged.lastRebindErrorTerminal ? 1 : 0,
      ready_at: merged.readyAt || null,
      completed_at: merged.completedAt || null,
      last_failure_phase: merged.lastFailurePhase || null,
      last_failure_code: merged.lastFailureCode || null,
      last_failure_retryable: merged.lastFailureRetryable ? 1 : 0,
      last_failure_terminal: merged.lastFailureTerminal ? 1 : 0,
      last_failure_at: merged.lastFailureAt || null,
      terminal_outcome_phase: merged.terminalOutcomePhase || null,
      terminal_outcome_code: merged.terminalOutcomeCode || null,
      terminal_outcome_message: merged.terminalOutcomeMessage || null,
      terminal_outcome_attempts: Math.max(0, Number(merged.terminalOutcomeAttempts || 0)),
      terminal_outcome_at: merged.terminalOutcomeAt || null,
      last_error: merged.lastError || null,
      updated_at: isoNow(now),
    };
    updateRow.run(row);
    return readState();
  }

  function buildRestartCommand(targetSessionId) {
    return `gh copilot -- --allow-all --resume ${targetSessionId}`;
  }

  function buildControlPayload(state, force = false) {
    if (!state?.targetSessionId || !state?.transactionId) return null;
    return {
      type: 'restart_cli',
      transactionId: state.transactionId,
      targetSessionId: state.targetSessionId,
      command: buildRestartCommand(state.targetSessionId),
      state: state.state,
      attempts: state.attempts,
      maxAttempts: safeMaxAttempts,
      gracefulTimeoutMs: safeGracefulTimeoutMs,
      spawnTimeoutMs: safeSpawnTimeoutMs,
      rebindTimeoutMs: safeRebindTimeoutMs,
      retryAt: state.retryAt || null,
      retryBackoffMs: state.retryBackoffMs || null,
      force,
      requestedAt: state.requestedAt,
      restartRequestedAt: state.restartRequestedAt,
      forceAfterAt: state.forceAfterAt,
      spawnDeadlineAt: state.spawnDeadlineAt || null,
      rebindDeadlineAt: state.rebindDeadlineAt || null,
    };
  }

  function startTransaction(targetSessionId, reason = null) {
    const nowIso = isoNow(now);
    return writeState({
      state: STATES.DRAINING,
      transactionId: crypto.randomUUID(),
      targetSessionId,
      queuedTargetSessionId: null,
      attempts: 0,
      requestedCount: 1,
      requestedAt: nowIso,
      drainingStartedAt: nowIso,
      restartRequestedAt: null,
      forceAfterAt: null,
      forceRequestedAt: null,
      spawnDeadlineAt: null,
      awaitingRebindAt: null,
      rebindDeadlineAt: null,
      retryAt: null,
      retryBackoffMs: null,
      retryPhase: null,
      rebindConfirmedAt: null,
      lastRebindSignalAt: null,
      lastRebindSignalSessionId: null,
      lastRebindSignalConversationId: null,
      lastRebindSignalTransactionId: null,
      lastRebindOutcome: null,
      lastRebindErrorCode: null,
      lastRebindErrorRetryable: false,
      lastRebindErrorTerminal: false,
      readyAt: null,
      completedAt: null,
      lastFailurePhase: null,
      lastFailureCode: null,
      lastFailureRetryable: false,
      lastFailureTerminal: false,
      lastFailureAt: null,
      terminalOutcomePhase: null,
      terminalOutcomeCode: null,
      terminalOutcomeMessage: null,
      terminalOutcomeAttempts: 0,
      terminalOutcomeAt: null,
      lastError: reason || null,
    });
  }

  function requestRestart({ targetSessionId, reason = null } = {}) {
    const target = String(targetSessionId || '').trim();
    if (!target) {
      const state = writeState({ lastError: 'missing target session id' });
      return { ok: false, error: 'missing-target-session', state };
    }

    const current = readState();
    if (current.state === STATES.IDLE) {
      const state = startTransaction(target, reason);
      return { ok: true, accepted: true, queued: false, coalesced: false, state };
    }

    if (current.targetSessionId === target) {
      const state = writeState({
        requestedCount: Number(current.requestedCount || 0) + 1,
        lastError: reason || current.lastError || null,
      });
      return { ok: true, accepted: true, queued: false, coalesced: true, state };
    }

    const state = writeState({
      queuedTargetSessionId: target,
      lastError: reason || current.lastError || null,
    });
    return { ok: true, accepted: true, queued: true, coalesced: false, state };
  }

  function maybeStartQueuedTarget() {
    const current = readState();
    if (current.state !== STATES.IDLE) return current;
    if (!current.queuedTargetSessionId) return current;
    return startTransaction(current.queuedTargetSessionId, current.lastError || null);
  }

  function markReady() {
    const current = readState();
    if (current.state !== STATES.AWAITING_REBIND && current.state !== STATES.RESTARTING) return current;
    const nowIso = isoNow(now);
    return writeState({
      state: STATES.READY,
      readyAt: nowIso,
      completedAt: nowIso,
      rebindConfirmedAt: current.rebindConfirmedAt || nowIso,
      forceRequestedAt: current.forceRequestedAt || null,
      rebindDeadlineAt: null,
      retryAt: null,
      retryBackoffMs: null,
      retryPhase: null,
    });
  }

  function noteCliOffline() {
    const current = readState();
    if (current.state !== STATES.RESTARTING) return current;
    const nowIso = isoNow(now);
    return writeState({
      state: STATES.AWAITING_REBIND,
      awaitingRebindAt: nowIso,
      rebindDeadlineAt: addMs(nowIso, safeRebindTimeoutMs),
    });
  }

  function noteCliOnline() {
    return readState();
  }

  function buildRebindResult(base = {}) {
    const state = base.state || readState();
    return {
      ...base,
      state,
      awaitingRebind: state.state === STATES.AWAITING_REBIND,
      expected: {
        transactionId: state.transactionId || null,
        targetSessionId: state.targetSessionId || null,
      },
    };
  }

  function markFailure({
    state,
    phase,
    code,
    message,
    retryable,
    terminal,
    includeRebindFields = false,
  }) {
    const nowIso = isoNow(now);
    const patch = {
      lastFailurePhase: phase || null,
      lastFailureCode: code || null,
      lastFailureRetryable: !!retryable,
      lastFailureTerminal: !!terminal,
      lastFailureAt: nowIso,
      lastError: message || null,
    };
    if (includeRebindFields) {
      patch.lastRebindOutcome = terminal ? 'rejected' : 'failed';
      patch.lastRebindErrorCode = code || null;
      patch.lastRebindErrorRetryable = !!retryable;
      patch.lastRebindErrorTerminal = !!terminal;
    }
    return writeState({ ...state, ...patch });
  }

  function finalizeTerminalFailure({
    state,
    phase,
    code,
    message,
    attempts = null,
    includeRebindFields = false,
  }) {
    const nowIso = isoNow(now);
    const active = state || readState();
    return writeState({
      ...active,
      state: STATES.IDLE,
      transactionId: null,
      targetSessionId: null,
      attempts: 0,
      requestedCount: 0,
      requestedAt: null,
      drainingStartedAt: null,
      restartRequestedAt: null,
      forceAfterAt: null,
      forceRequestedAt: null,
      spawnDeadlineAt: null,
      awaitingRebindAt: null,
      rebindDeadlineAt: null,
      retryAt: null,
      retryBackoffMs: null,
      retryPhase: null,
      readyAt: null,
      completedAt: nowIso,
      lastFailurePhase: phase || null,
      lastFailureCode: code || null,
      lastFailureRetryable: false,
      lastFailureTerminal: true,
      lastFailureAt: nowIso,
      terminalOutcomePhase: phase || null,
      terminalOutcomeCode: code || null,
      terminalOutcomeMessage: message || null,
      terminalOutcomeAttempts: Math.max(0, Number(attempts != null ? attempts : (active.attempts || 0))),
      terminalOutcomeAt: nowIso,
      lastError: message || null,
      ...(includeRebindFields ? {
        lastRebindOutcome: 'rejected',
        lastRebindErrorCode: code || null,
        lastRebindErrorRetryable: false,
        lastRebindErrorTerminal: true,
      } : {}),
    });
  }

  function scheduleRetryOrTerminal({
    state,
    phase,
    code,
    message,
    includeRebindFields = false,
  }) {
    const current = state || readState();
    const attempt = Math.max(1, Number(current.attempts || 1));
    const failed = markFailure({
      state: current,
      phase,
      code,
      message,
      retryable: true,
      terminal: false,
      includeRebindFields,
    });
    if (attempt >= safeMaxAttempts) {
      return finalizeTerminalFailure({
        state: failed,
        phase,
        code: `${code}-exhausted`,
        message: `${message} (attempts exhausted ${attempt}/${safeMaxAttempts})`,
        attempts: attempt,
        includeRebindFields,
      });
    }
    const nowIso = isoNow(now);
    const idx = Math.max(0, Math.min(attempt - 1, safeRetryBackoffMs.length - 1));
    const backoffMs = Number(safeRetryBackoffMs[idx] || safeRetryBackoffMs[safeRetryBackoffMs.length - 1] || 1_000);
    return writeState({
      ...failed,
      state: STATES.DRAINING,
      restartRequestedAt: null,
      forceAfterAt: null,
      forceRequestedAt: null,
      spawnDeadlineAt: null,
      awaitingRebindAt: null,
      rebindDeadlineAt: null,
      drainingStartedAt: nowIso,
      retryAt: addMs(nowIso, backoffMs),
      retryBackoffMs: backoffMs,
      retryPhase: phase,
    });
  }

  function applySessionSync({
    sdkSessionId,
    conversationId = null,
    correlationId = null,
    targetSessionId = null,
    rebindCompleted = false,
    signalSource = 'session-sync',
  } = {}) {
    const normalizedSdkSessionId = normalizeId(sdkSessionId);
    const normalizedConversationId = normalizeId(conversationId);
    const normalizedCorrelationId = normalizeId(correlationId);
    const normalizedTargetSessionId = normalizeId(targetSessionId);
    const explicitRebindCompletion = parseBoolean(rebindCompleted, false);
    const nowIso = isoNow(now);
    const current = readState();

    const withSignalState = (patch = {}) => writeState({
      lastRebindSignalAt: nowIso,
      lastRebindSignalSessionId: normalizedSdkSessionId,
      lastRebindSignalConversationId: normalizedConversationId,
      lastRebindSignalTransactionId: normalizedCorrelationId,
      lastRebindOutcome: patch.lastRebindOutcome || null,
      lastRebindErrorCode: patch.lastRebindErrorCode || null,
      lastRebindErrorRetryable: patch.lastRebindErrorRetryable || false,
      lastRebindErrorTerminal: patch.lastRebindErrorTerminal || false,
      ...patch,
    });

    if (!explicitRebindCompletion) {
      return buildRebindResult({
        ok: true,
        considered: false,
        completed: false,
        reason: 'rebind-signal-missing',
        retryable: true,
        terminal: false,
        state: current,
      });
    }

    if (current.state !== STATES.AWAITING_REBIND && current.state !== STATES.RESTARTING) {
      const classification = classifyRebindConflict('not-awaiting-rebind');
      const state = withSignalState({
        lastRebindOutcome: 'ignored',
        lastRebindErrorCode: 'not-awaiting-rebind',
        lastRebindErrorRetryable: classification.retryable,
        lastRebindErrorTerminal: classification.terminal,
      });
      return buildRebindResult({
        ok: false,
        conflict: true,
        code: 'not-awaiting-rebind',
        considered: true,
        completed: false,
        retryable: classification.retryable,
        terminal: classification.terminal,
        message: 'Restart orchestrator is not awaiting rebind confirmation.',
        state,
      });
    }

    if (normalizedCorrelationId && current.transactionId && normalizedCorrelationId !== current.transactionId) {
      const classification = classifyRebindConflict('transaction-mismatch');
      const state = withSignalState({
        lastRebindOutcome: 'rejected',
        lastRebindErrorCode: 'transaction-mismatch',
        lastRebindErrorRetryable: classification.retryable,
        lastRebindErrorTerminal: classification.terminal,
      });
      const terminalState = finalizeTerminalFailure({
        state,
        phase: 'rebind',
        code: 'transaction-mismatch',
        message: `Rebind correlation ${normalizedCorrelationId} does not match active transaction.`,
        attempts: state.attempts,
        includeRebindFields: true,
      });
      return buildRebindResult({
        ok: false,
        conflict: true,
        code: 'transaction-mismatch',
        considered: true,
        completed: false,
        retryable: classification.retryable,
        terminal: classification.terminal,
        message: `Rebind correlation ${normalizedCorrelationId} does not match active transaction.`,
        state: terminalState,
      });
    }

    if (normalizedTargetSessionId && current.targetSessionId && normalizedTargetSessionId !== current.targetSessionId) {
      const classification = classifyRebindConflict('target-mismatch');
      const state = withSignalState({
        lastRebindOutcome: 'rejected',
        lastRebindErrorCode: 'target-mismatch',
        lastRebindErrorRetryable: classification.retryable,
        lastRebindErrorTerminal: classification.terminal,
      });
      const terminalState = finalizeTerminalFailure({
        state,
        phase: 'rebind',
        code: 'target-mismatch',
        message: `Rebind target ${normalizedTargetSessionId} does not match active orchestrator target.`,
        attempts: state.attempts,
        includeRebindFields: true,
      });
      return buildRebindResult({
        ok: false,
        conflict: true,
        code: 'target-mismatch',
        considered: true,
        completed: false,
        retryable: classification.retryable,
        terminal: classification.terminal,
        message: `Rebind target ${normalizedTargetSessionId} does not match active orchestrator target.`,
        state: terminalState,
      });
    }

    if (!normalizedSdkSessionId || normalizedSdkSessionId !== current.targetSessionId) {
      const classification = classifyRebindConflict('active-session-mismatch');
      const state = withSignalState({
        lastRebindOutcome: 'rejected',
        lastRebindErrorCode: 'active-session-mismatch',
        lastRebindErrorRetryable: classification.retryable,
        lastRebindErrorTerminal: classification.terminal,
        lastFailurePhase: 'rebind',
        lastFailureCode: 'active-session-mismatch',
        lastFailureRetryable: classification.retryable,
        lastFailureTerminal: classification.terminal,
        lastFailureAt: nowIso,
        lastError: `Rebind acknowledged for ${normalizedSdkSessionId || 'unknown'}, expected ${current.targetSessionId || 'unknown'}.`,
      });
      return buildRebindResult({
        ok: false,
        conflict: true,
        code: 'active-session-mismatch',
        considered: true,
        completed: false,
        retryable: classification.retryable,
        terminal: classification.terminal,
        message: `Rebind acknowledged for ${normalizedSdkSessionId || 'unknown'}, expected ${current.targetSessionId || 'unknown'}.`,
        state,
      });
    }

    const updated = withSignalState({
      rebindConfirmedAt: nowIso,
      rebindDeadlineAt: null,
      retryAt: null,
      retryBackoffMs: null,
      retryPhase: null,
      lastRebindOutcome: 'completed',
      lastRebindErrorCode: null,
      lastRebindErrorRetryable: false,
      lastRebindErrorTerminal: false,
      lastFailurePhase: null,
      lastFailureCode: null,
      lastFailureRetryable: false,
      lastFailureTerminal: false,
      lastFailureAt: null,
      lastError: null,
    });
    const state = (updated.state === STATES.AWAITING_REBIND || updated.state === STATES.RESTARTING)
      ? markReady()
      : updated;
    return buildRebindResult({
      ok: true,
      considered: true,
      completed: true,
      code: null,
      retryable: false,
      terminal: false,
      signalSource: String(signalSource || '').trim() || 'session-sync',
      state,
    });
  }

  function onDequeueProbe({ processingCount = 0 } = {}) {
    let state = readState();
    if (state.state === STATES.IDLE && state.queuedTargetSessionId) {
      state = maybeStartQueuedTarget();
    }

    if (state.state === STATES.IDLE) {
      return { blockDequeue: false, state };
    }

    if (state.state === STATES.DRAINING) {
      if (state.retryAt) {
        const retryAtMs = new Date(state.retryAt).getTime();
        if (Number.isFinite(retryAtMs) && now() < retryAtMs) {
          return { blockDequeue: true, control: null, state };
        }
      }
      if (Number(processingCount || 0) > 0) {
        const drainingStartedMs = state.drainingStartedAt ? new Date(state.drainingStartedAt).getTime() : 0;
        if (drainingStartedMs > 0 && now() - drainingStartedMs >= safeShutdownTimeoutMs) {
          const terminal = finalizeTerminalFailure({
            state,
            phase: 'shutdown',
            code: 'shutdown-timeout',
            message: `Graceful drain timed out after ${safeShutdownTimeoutMs}ms while queue job was active.`,
            attempts: state.attempts,
          });
          return { blockDequeue: false, control: null, state: terminal };
        }
        return { blockDequeue: true, control: null, state };
      }
      const nowIso = isoNow(now);
      state = writeState({
        state: STATES.RESTARTING,
        attempts: Number(state.attempts || 0) + 1,
        retryAt: null,
        retryBackoffMs: null,
        retryPhase: null,
        restartRequestedAt: nowIso,
        forceAfterAt: addMs(nowIso, safeGracefulTimeoutMs),
        spawnDeadlineAt: addMs(nowIso, safeSpawnTimeoutMs),
        forceRequestedAt: null,
      });
      return { blockDequeue: true, control: buildControlPayload(state, false), state };
    }

    if (state.state === STATES.RESTARTING) {
      const spawnDeadlineMs = state.spawnDeadlineAt ? new Date(state.spawnDeadlineAt).getTime() : 0;
      if (spawnDeadlineMs > 0 && now() >= spawnDeadlineMs) {
        state = scheduleRetryOrTerminal({
          state,
          phase: 'spawn',
          code: 'spawn-timeout',
          message: `CLI restart/resume did not go offline within ${safeSpawnTimeoutMs}ms.`,
        });
        if (state.state !== STATES.DRAINING) return { blockDequeue: false, control: null, state };
        return { blockDequeue: true, control: null, state };
      }
      const nowMs = now();
      const forceAfterMs = state.forceAfterAt ? new Date(state.forceAfterAt).getTime() : 0;
      const shouldForce = forceAfterMs > 0 && nowMs >= forceAfterMs;
      if (shouldForce && !state.forceRequestedAt) {
        state = writeState({ forceRequestedAt: isoNow(now) });
      }
      return { blockDequeue: true, control: buildControlPayload(state, shouldForce), state };
    }

    if (state.state === STATES.AWAITING_REBIND) {
      const rebindDeadlineMs = state.rebindDeadlineAt ? new Date(state.rebindDeadlineAt).getTime() : 0;
      if (rebindDeadlineMs > 0 && now() >= rebindDeadlineMs) {
        state = scheduleRetryOrTerminal({
          state,
          phase: 'rebind',
          code: 'rebind-timeout',
          message: `CLI restart resumed but session rebind did not complete within ${safeRebindTimeoutMs}ms.`,
          includeRebindFields: true,
        });
        if (state.state !== STATES.DRAINING) return { blockDequeue: false, control: null, state };
        return { blockDequeue: true, control: null, state };
      }
      return { blockDequeue: true, control: null, state };
    }

    if (state.state === STATES.READY) {
      const readyAtMs = state.readyAt ? new Date(state.readyAt).getTime() : 0;
      if (readyAtMs > 0 && now() - readyAtMs < safeReadyCooldownMs) {
        return { blockDequeue: true, control: null, state };
      }
      if (state.queuedTargetSessionId) {
        const promoted = startTransaction(state.queuedTargetSessionId, state.lastError || null);
        return { blockDequeue: true, control: null, state: promoted };
      }
      state = writeState({
        state: STATES.IDLE,
        transactionId: null,
        targetSessionId: null,
        attempts: 0,
        requestedCount: 0,
        requestedAt: null,
        drainingStartedAt: null,
        restartRequestedAt: null,
        forceAfterAt: null,
        forceRequestedAt: null,
        spawnDeadlineAt: null,
        awaitingRebindAt: null,
        rebindDeadlineAt: null,
        retryAt: null,
        retryBackoffMs: null,
        retryPhase: null,
        rebindConfirmedAt: state.rebindConfirmedAt || null,
        readyAt: null,
        completedAt: state.completedAt || isoNow(now),
        lastRebindSignalAt: state.lastRebindSignalAt || null,
        lastRebindSignalSessionId: state.lastRebindSignalSessionId || null,
        lastRebindSignalConversationId: state.lastRebindSignalConversationId || null,
        lastRebindSignalTransactionId: state.lastRebindSignalTransactionId || null,
        lastRebindOutcome: state.lastRebindOutcome || null,
        lastRebindErrorCode: state.lastRebindErrorCode || null,
        lastRebindErrorRetryable: state.lastRebindErrorRetryable || false,
        lastRebindErrorTerminal: state.lastRebindErrorTerminal || false,
        lastError: null,
      });
      return { blockDequeue: false, state };
    }

    return { blockDequeue: false, state };
  }

  return {
    STATES,
    requestRestart,
    onDequeueProbe,
    noteCliOffline,
    noteCliOnline,
    applySessionSync,
    getState: readState,
  };
}

