import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {
  buildSessionWorkerLogEnvelope,
  dequeuePendingMessage,
  dequeuePendingMessageForWorkerLoop,
  extractRestartTerminalOutcome,
  maybeTriggerWorkerFallbackRestart,
  parseTerminalFailureText,
  resolveBlockedWorkerTerminalFailure,
  resolvePrimedWorkerTerminalFailure,
  resolveTerminalFailurePayload,
} from './messages-routes.mjs';

function createQueueHarness() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE queue (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      runtime_session_id TEXT,
      is_new_conversation INTEGER NOT NULL DEFAULT 0,
      model TEXT,
      relay_mode TEXT NOT NULL DEFAULT 'agent',
      text TEXT NOT NULL,
      attachments TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      timestamp TEXT NOT NULL,
      processing_at TEXT,
      response_message_id TEXT,
      response TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT,
      owner_sdk_session_id TEXT,
      owner_assigned_at TEXT,
      owner_lease_expires_at TEXT,
      owner_last_claimed_at TEXT,
      parked_at TEXT,
      parked_target_session_id TEXT,
      parked_transaction_id TEXT,
      parked_reason TEXT
    );
  `);
  const stmts = {
    insertQ: db.prepare(`
      INSERT INTO queue (
        id, conversation_id, runtime_session_id, is_new_conversation,
        model, relay_mode, text, attachments, status, timestamp,
        retry_count, next_attempt_at, owner_sdk_session_id, owner_assigned_at,
        owner_lease_expires_at, owner_last_claimed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, 0, NULL, ?, ?, ?, ?)
    `),
    findPending: db.prepare(`
      SELECT *
      FROM queue
      WHERE status = 'pending'
        AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
      ORDER BY
        retry_count ASC,
        CASE WHEN next_attempt_at IS NULL THEN 0 ELSE 1 END ASC,
        COALESCE(next_attempt_at, timestamp) ASC,
        timestamp ASC
      LIMIT 1
    `),
    findPendingForWorker: db.prepare(`
      SELECT *
      FROM queue
      WHERE status = 'pending'
        AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
        AND (owner_sdk_session_id IS NULL OR owner_sdk_session_id = '' OR owner_sdk_session_id = ?)
      ORDER BY
        CASE WHEN owner_sdk_session_id = ? THEN 0 ELSE 1 END ASC,
        retry_count ASC,
        CASE WHEN next_attempt_at IS NULL THEN 0 ELSE 1 END ASC,
        COALESCE(next_attempt_at, timestamp) ASC,
        timestamp ASC
      LIMIT 1
    `),
    setProcessing: db.prepare(`UPDATE queue SET status = 'processing', processing_at = ? WHERE id = ?`),
    setProcessingWithWorkerLease: db.prepare(`
      UPDATE queue
      SET
        status = 'processing',
        processing_at = ?,
        owner_sdk_session_id = COALESCE(NULLIF(owner_sdk_session_id, ''), ?),
        owner_assigned_at = COALESCE(owner_assigned_at, ?),
        owner_lease_expires_at = ?,
        owner_last_claimed_at = ?
      WHERE id = ?
    `),
  };

  function enqueue({
    id,
    conversationId = `conv-${id}`,
    runtimeSessionId = null,
    model = 'gpt-5.4-mini',
    relayMode = 'agent',
    text = id,
    timestamp,
    ownerSessionId = null,
  }) {
    stmts.insertQ.run(
      id,
      conversationId,
      runtimeSessionId,
      0,
      model,
      relayMode,
      text,
      null,
      timestamp,
      ownerSessionId,
      ownerSessionId ? timestamp : null,
      null,
      null,
    );
  }

  return { db, stmts, enqueue };
}

test('dequeuePendingMessage keeps legacy ordering when routing flag is off', () => {
  const { db, stmts, enqueue } = createQueueHarness();
  enqueue({ id: 'msg-owner-b', timestamp: '2026-01-01T00:00:00.000Z', ownerSessionId: 'sdk-b' });
  enqueue({ id: 'msg-owner-a', timestamp: '2026-01-01T00:00:01.000Z', ownerSessionId: 'sdk-a' });

  const dequeued = dequeuePendingMessage({
    db,
    stmts,
    nowIso: '2026-01-01T00:00:02.000Z',
    routingEnabled: false,
    requesterSessionId: 'sdk-a',
  });

  assert.equal(dequeued?.id, 'msg-owner-b');
  assert.equal(dequeued?.status, 'processing');
  assert.equal(dequeued?.owner_sdk_session_id, 'sdk-b');
  db.close();
});

test('dequeuePendingMessage routes deterministically to requester ownership when routing flag is on', () => {
  const { db, stmts, enqueue } = createQueueHarness();
  enqueue({ id: 'msg-owner-b', timestamp: '2026-01-01T00:00:00.000Z', ownerSessionId: 'sdk-b' });
  enqueue({ id: 'msg-unowned', timestamp: '2026-01-01T00:00:01.000Z' });
  enqueue({ id: 'msg-owner-a', timestamp: '2026-01-01T00:00:02.000Z', ownerSessionId: 'sdk-a' });

  const first = dequeuePendingMessage({
    db,
    stmts,
    nowIso: '2026-01-01T00:00:03.000Z',
    routingEnabled: true,
    requesterSessionId: 'sdk-a',
  });
  assert.equal(first?.id, 'msg-owner-a');
  assert.equal(first?.owner_sdk_session_id, 'sdk-a');
  assert.ok(first?.owner_lease_expires_at);

  const second = dequeuePendingMessage({
    db,
    stmts,
    nowIso: '2026-01-01T00:00:04.000Z',
    routingEnabled: true,
    requesterSessionId: 'sdk-a',
  });
  assert.equal(second?.id, 'msg-unowned');
  assert.equal(second?.owner_sdk_session_id, 'sdk-a');
  assert.equal(Boolean(second?.owner_assigned_at), true);

  const blocked = dequeuePendingMessage({
    db,
    stmts,
    nowIso: '2026-01-01T00:00:05.000Z',
    routingEnabled: true,
    requesterSessionId: 'sdk-a',
  });
  assert.equal(blocked, null);
  db.close();
});

test('dequeuePendingMessageForWorkerLoop returns blocked reason when worker cannot restart yet', async () => {
  const { db, stmts, enqueue } = createQueueHarness();
  enqueue({ id: 'msg-owner-a', timestamp: '2026-01-01T00:00:00.000Z', ownerSessionId: 'sdk-a' });

  const calls = [];
  const supervisor = {
    ensureWorker: async (sdkSessionId) => {
      calls.push(['ensureWorker', sdkSessionId]);
      return {
        ok: false,
        error: 'restart-delayed',
        worker: { sdkSessionId, status: 'error' },
        lifecycle: { retryCount: 1, backoffMs: 1000 },
      };
    },
  };

  const result = await dequeuePendingMessageForWorkerLoop({
    db,
    stmts,
    nowIso: '2026-01-01T00:00:01.000Z',
    routingEnabled: true,
    requesterSessionId: 'sdk-a',
    sessionWorkerSupervisor: supervisor,
  });

  assert.equal(result.message, null);
  assert.equal(result.blockedReason, 'restart-delayed');
  assert.equal(result.attempts, 0);
  assert.deepEqual(calls, [['ensureWorker', 'sdk-a']]);
  assert.equal(stmts.findPending.get('2026-01-01T00:00:01.000Z')?.id, 'msg-owner-a');
  db.close();
});

test('dequeuePendingMessageForWorkerLoop retries transient dequeue errors deterministically', async () => {
  const { db, stmts, enqueue } = createQueueHarness();
  enqueue({ id: 'msg-owner-a', timestamp: '2026-01-01T00:00:00.000Z', ownerSessionId: 'sdk-a' });

  const supervisor = {
    ensureWorker: async () => ({ ok: true }),
    getWorkerState: () => ({ sdkSessionId: 'sdk-a', status: 'ready' }),
    getLifecycleState: () => ({ retryCount: 0 }),
    markError: () => {},
  };

  const originalGet = stmts.findPendingForWorker.get.bind(stmts.findPendingForWorker);
  let attempts = 0;
  const stmtsWithTransientFailure = {
    ...stmts,
    findPendingForWorker: {
      get: (...args) => {
        attempts += 1;
        if (attempts < 3) {
          const error = new Error('database is locked');
          error.code = 'SQLITE_BUSY';
          throw error;
        }
        return originalGet(...args);
      },
    },
  };

  const result = await dequeuePendingMessageForWorkerLoop({
    db,
    stmts: stmtsWithTransientFailure,
    nowIso: '2026-01-01T00:00:01.000Z',
    routingEnabled: true,
    requesterSessionId: 'sdk-a',
    transientRetryLimit: 2,
    transientRetryBackoffMs: 1,
    sessionWorkerSupervisor: supervisor,
  });

  assert.equal(result.message?.id, 'msg-owner-a');
  assert.equal(result.attempts, 3);
  assert.equal(attempts, 3);
  db.close();
});

test('dequeuePendingMessageForWorkerLoop marks worker error when transient retries are exhausted', async () => {
  const { db, stmts, enqueue } = createQueueHarness();
  enqueue({ id: 'msg-owner-a', timestamp: '2026-01-01T00:00:00.000Z', ownerSessionId: 'sdk-a' });

  const errors = [];
  const supervisor = {
    ensureWorker: async () => ({ ok: true }),
    markError: (sdkSessionId, error) => {
      errors.push([sdkSessionId, String(error?.message || error || '')]);
    },
  };

  const stmtsWithPermanentFailure = {
    ...stmts,
    findPendingForWorker: {
      get: () => {
        const error = new Error('database is locked');
        error.code = 'SQLITE_BUSY';
        throw error;
      },
    },
  };

  await assert.rejects(
    dequeuePendingMessageForWorkerLoop({
      db,
      stmts: stmtsWithPermanentFailure,
      nowIso: '2026-01-01T00:00:01.000Z',
      routingEnabled: true,
      requesterSessionId: 'sdk-a',
      transientRetryLimit: 1,
      transientRetryBackoffMs: 1,
      sessionWorkerSupervisor: supervisor,
    }),
    /database is locked/,
  );

  assert.equal(errors.length, 1);
  assert.equal(errors[0][0], 'sdk-a');
  db.close();
});

test('dequeuePendingMessageForWorkerLoop reports removed fallback restart path', async () => {
  const { db, stmts, enqueue } = createQueueHarness();
  enqueue({ id: 'msg-owner-a', timestamp: '2026-01-01T00:00:00.000Z', ownerSessionId: 'sdk-a' });
  const supervisor = {
    ensureWorker: async () => ({ ok: false, error: 'restart-exhausted', lifecycle: { retryCount: 3 } }),
  };
  const orchestrator = {
    getState: () => ({ state: 'idle' }),
    requestRestart: () => ({ ok: true, accepted: true, state: { state: 'draining' } }),
  };

  const result = await dequeuePendingMessageForWorkerLoop({
    db,
    stmts,
    nowIso: '2026-01-01T00:00:01.000Z',
    routingEnabled: true,
    requesterSessionId: 'sdk-a',
    sessionWorkerSupervisor: supervisor,
    workerFallbackRestartEnabled: false,
    relayRestartOrchestrator: orchestrator,
  });

  assert.equal(result.blockedReason, 'restart-exhausted');
  assert.equal(result.fallbackRestart?.requested, false);
  assert.equal(result.fallbackRestart?.considered, false);
  assert.equal(result.fallbackRestart?.skipped, 'removed-single-runtime-fallback');
  db.close();
});

test('dequeuePendingMessageForWorkerLoop keeps removed fallback inactive even for prior restart cases', async () => {
  const { db, stmts, enqueue } = createQueueHarness();
  enqueue({ id: 'msg-owner-a', timestamp: '2026-01-01T00:00:00.000Z', ownerSessionId: 'sdk-a' });
  const orchestrator = {
    getState: () => ({ state: 'idle' }),
    requestRestart: () => ({ ok: true, accepted: true, state: { state: 'draining' } }),
  };

  const notApproved = await dequeuePendingMessageForWorkerLoop({
    db,
    stmts,
    nowIso: '2026-01-01T00:00:01.000Z',
    routingEnabled: true,
    requesterSessionId: 'sdk-a',
    sessionWorkerSupervisor: {
      ensureWorker: async () => ({ ok: false, error: 'restart-delayed' }),
    },
    workerFallbackRestartEnabled: true,
    relayRestartOrchestrator: orchestrator,
  });
  assert.equal(notApproved.fallbackRestart?.skipped, 'removed-single-runtime-fallback');

  const inflight = await dequeuePendingMessageForWorkerLoop({
    db,
    stmts,
    nowIso: '2026-01-01T00:00:02.000Z',
    routingEnabled: true,
    requesterSessionId: 'sdk-a',
    sessionWorkerSupervisor: {
      ensureWorker: async () => ({ ok: false, error: 'restart-exhausted' }),
    },
    workerFallbackRestartEnabled: true,
    relayRestartOrchestrator: orchestrator,
    inFlightProcessingCount: 1,
  });
  assert.equal(inflight.fallbackRestart?.skipped, 'removed-single-runtime-fallback');
  db.close();
});

test('extractRestartTerminalOutcome returns explicit exhausted terminal summary', () => {
  const outcome = extractRestartTerminalOutcome({
    terminalOutcomeCode: 'spawn-timeout-exhausted',
    terminalOutcomePhase: 'spawn',
    terminalOutcomeMessage: 'attempts exhausted',
    terminalOutcomeAttempts: 3,
    terminalOutcomeAt: '2026-01-01T00:00:00.000Z',
  });
  assert.deepEqual(outcome, {
    phase: 'spawn',
    code: 'spawn-timeout-exhausted',
    message: 'attempts exhausted',
    attempts: 3,
    at: '2026-01-01T00:00:00.000Z',
  });
});

test('maybeTriggerWorkerFallbackRestart always reports removed single-runtime fallback', () => {
  const restart = maybeTriggerWorkerFallbackRestart({
    enabled: true,
    failureClass: 'restart-exhausted',
    requesterSessionId: 'sdk-a',
    relayRestartOrchestrator: {
      getState: () => ({
        state: 'idle',
        terminalOutcomeCode: 'spawn-timeout-exhausted',
        terminalOutcomePhase: 'spawn',
      }),
      requestRestart: () => ({ ok: true, accepted: true }),
    },
  });
  assert.equal(restart.considered, false);
  assert.equal(restart.requested, false);
  assert.equal(restart.skipped, 'removed-single-runtime-fallback');
  assert.equal(restart.terminalOutcome?.code, 'spawn-timeout-exhausted');
});

test('maybeTriggerWorkerFallbackRestart never requests orchestrator restart', () => {
  const restart = maybeTriggerWorkerFallbackRestart({
    enabled: true,
    failureClass: 'restart-exhausted',
    requesterSessionId: 'sdk-a',
    relayRestartOrchestrator: {
      getState: () => ({ state: 'idle' }),
      requestRestart: () => ({ ok: true, accepted: false, state: { state: 'idle' } }),
    },
  });
  assert.equal(restart.considered, false);
  assert.equal(restart.requested, false);
  assert.equal(restart.skipped, 'removed-single-runtime-fallback');
});

test('buildSessionWorkerLogEnvelope emits mandatory session-worker telemetry fields', () => {
  const envelope = buildSessionWorkerLogEnvelope({
    event: 'queue.message.dequeued',
    worker: 'worker-a',
    session: 'sdk-a',
    conversation: 'conv-a',
    message: 'msg-a',
    continuation: null,
    state: 'processing',
    queue: 'pending=1,processing=2,parked=0',
    retry: 2,
    pid: '321',
  });
  assert.deepEqual(Object.keys(envelope), [
    'event',
    'worker',
    'session',
    'conversation',
    'message',
    'continuation',
    'state',
    'queue',
    'retry',
    'pid',
  ]);
  assert.equal(envelope.continuation, 'none');
  assert.equal(envelope.retry, 2);
  assert.equal(envelope.pid, 321);
});

test('dequeuePendingMessageForWorkerLoop emits deterministic telemetry callback payloads', async () => {
  const { db, stmts, enqueue } = createQueueHarness();
  enqueue({ id: 'msg-owner-a', timestamp: '2026-01-01T00:00:00.000Z', ownerSessionId: 'sdk-a' });
  const telemetry = [];
  const supervisor = {
    ensureWorker: async () => ({ ok: true }),
    getWorkerState: () => ({ sdkSessionId: 'sdk-a', status: 'ready', workerId: 'worker-a', pid: 456 }),
    getLifecycleState: () => ({ retryCount: 0 }),
    markError: () => {},
  };
  const result = await dequeuePendingMessageForWorkerLoop({
    db,
    stmts,
    nowIso: '2026-01-01T00:00:01.000Z',
    routingEnabled: true,
    requesterSessionId: 'sdk-a',
    transientRetryLimit: 0,
    transientRetryBackoffMs: 1,
    sessionWorkerSupervisor: supervisor,
    telemetry: (payload) => telemetry.push(payload),
  });
  assert.equal(result.message?.id, 'msg-owner-a');
  assert.equal(telemetry.length, 1);
  assert.equal(telemetry[0].event, 'queue.dequeue.success');
  assert.equal(telemetry[0].sessionId, 'sdk-a');
  assert.equal(telemetry[0].workerId, 'worker-a');
  db.close();
});

test('parseTerminalFailureText extracts stable terminal fields from assistant text', () => {
  const parsed = parseTerminalFailureText(
    'No tool output was returned for a required function call. Error code: relay.missing-tool-output. IDs: functionCallId=call_abc, requestId=req_xyz. Retry and restart if needed. Details: Execution failed: CAPIError 400.',
  );
  assert.equal(parsed?.terminal, true);
  assert.equal(parsed?.stableCode, 'relay.missing-tool-output');
  assert.equal(parsed?.functionCallId, 'call_abc');
  assert.equal(parsed?.requestId, 'req_xyz');
});

test('resolveTerminalFailurePayload accepts explicit terminal payloads for deterministic failure transitions', () => {
  const resolved = resolveTerminalFailurePayload({
    terminal: true,
    terminalError: {
      code: 'missing-tool-output',
      message: 'No tool output was returned for a required function call.',
      detail: 'Execution failed: CAPIError 400',
      guidance: 'Retry and include the code if it repeats.',
      functionCallId: 'call_123',
      requestId: 'req_456',
    },
  });
  assert.equal(resolved?.terminal, true);
  assert.equal(resolved?.stableCode, 'relay.missing-tool-output');
  assert.equal(resolved?.functionCallId, 'call_123');
  assert.equal(resolved?.requestId, 'req_456');
});

test('resolveTerminalFailurePayload infers terminal payload from assistant failure text', () => {
  const resolved = resolveTerminalFailurePayload({
    text: 'No tool output was returned for a required function call. Error code: relay.missing-tool-output. IDs: functionCallId=call_99. Details: CAPIError 400.',
  });
  assert.equal(resolved?.terminal, true);
  assert.equal(resolved?.stableCode, 'relay.missing-tool-output');
  assert.equal(resolved?.functionCallId, 'call_99');
});

test('resolveBlockedWorkerTerminalFailure classifies terminal blocked startup reasons', () => {
  const exhausted = resolveBlockedWorkerTerminalFailure({
    blockedReason: 'restart-exhausted',
    requesterSessionId: 'sdk-a',
    lifecycle: { retryCount: 3, lastError: 'spawn retries exhausted' },
  });
  assert.equal(exhausted?.stableCode, 'relay.worker-restart-exhausted');
  assert.equal(exhausted?.requesterSessionId, 'sdk-a');

  const corrupted = resolveBlockedWorkerTerminalFailure({
    blockedReason: 'spawn-failed',
    requesterSessionId: 'sdk-b',
    lifecycle: { lastError: "Error: Session 'sdk-b' was found but could not be loaded. Session file is corrupted or incompatible" },
  });
  assert.equal(corrupted?.stableCode, 'relay.worker-session-load-failed');
  assert.equal(corrupted?.blockedReason, 'spawn-failed');
});

test('resolveBlockedWorkerTerminalFailure ignores transient blocked startup reasons', () => {
  const delayed = resolveBlockedWorkerTerminalFailure({
    blockedReason: 'restart-delayed',
    requesterSessionId: 'sdk-a',
    lifecycle: { retryCount: 1, lastError: 'backoff in progress' },
  });
  assert.equal(delayed, null);

  const genericSpawn = resolveBlockedWorkerTerminalFailure({
    blockedReason: 'spawn-failed',
    requesterSessionId: 'sdk-a',
    lifecycle: { lastError: 'temporary cli startup timeout' },
  });
  assert.equal(genericSpawn, null);
});

test('resolvePrimedWorkerTerminalFailure classifies stale/degraded primed workers as terminal', () => {
  const stale = resolvePrimedWorkerTerminalFailure({
    sessionId: 'sdk-stale',
    primeResult: {
      ok: true,
      worker: { sdkSessionId: 'sdk-stale', status: 'ready' },
      lifecycle: {
        uiState: 'yellow',
        degradedReason: 'stale-pid',
        retryCount: 0,
      },
    },
  });
  assert.equal(stale?.stableCode, 'relay.worker-stale-pid');
  assert.equal(stale?.requesterSessionId, 'sdk-stale');

  const exhausted = resolvePrimedWorkerTerminalFailure({
    sessionId: 'sdk-exhausted',
    primeResult: {
      ok: true,
      worker: { sdkSessionId: 'sdk-exhausted', status: 'error' },
      lifecycle: {
        uiState: 'yellow',
        degradedReason: 'restart-exhausted',
        retryCount: 3,
        lastError: 'spawn retries exhausted',
      },
    },
  });
  assert.equal(exhausted?.stableCode, 'relay.worker-restart-exhausted');
});

test('resolvePrimedWorkerTerminalFailure ignores healthy or non-terminal prime results', () => {
  const healthy = resolvePrimedWorkerTerminalFailure({
    sessionId: 'sdk-ready',
    primeResult: {
      ok: true,
      worker: { sdkSessionId: 'sdk-ready', status: 'ready' },
      lifecycle: { uiState: 'green' },
    },
  });
  assert.equal(healthy, null);

  const delayed = resolvePrimedWorkerTerminalFailure({
    sessionId: 'sdk-delayed',
    primeResult: {
      ok: false,
      error: 'restart-delayed',
      lifecycle: { retryCount: 1, lastError: 'backoff in progress' },
    },
  });
  assert.equal(delayed, null);
});
