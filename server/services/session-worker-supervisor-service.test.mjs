import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionWorkerRegistry } from './session-worker-registry-service.mjs';
import { createSessionWorkerSupervisor } from './session-worker-supervisor-service.mjs';

test('ensureWorker creates ready worker for session and reuses it', async () => {
  const registry = createSessionWorkerRegistry();
  const supervisor = createSessionWorkerSupervisor({ registry });

  const first = await supervisor.ensureWorker('sdk-a');
  assert.equal(first.ok, true);
  assert.equal(first.reused, false);
  assert.equal(first.worker.sdkSessionId, 'sdk-a');
  assert.equal(first.worker.status, 'ready');

  const second = await supervisor.ensureWorker('sdk-a');
  assert.equal(second.ok, true);
  assert.equal(second.reused, true);
  assert.equal(second.worker.sdkSessionId, 'sdk-a');
  assert.equal(second.lifecycle?.retryCount ?? 0, 0);
  assert.equal(second.lifecycle?.uiState, 'green');
});

test('ensureWorker applies retry backoff and enforces bounded restart attempts', async () => {
  const registry = createSessionWorkerRegistry();
  let currentTime = Date.parse('2026-01-01T00:00:00.000Z');
  let attempts = 0;
  const supervisor = createSessionWorkerSupervisor({
    registry,
    now: () => currentTime,
    maxRestartRetries: 2,
    restartBackoffBaseMs: 1_000,
    restartBackoffMaxMs: 10_000,
    spawnWorker: async () => {
      attempts += 1;
      throw new Error(`spawn failed ${attempts}`);
    },
  });

  const first = await supervisor.ensureWorker('sdk-b');
  assert.equal(first.ok, false);
  assert.equal(first.error, 'spawn-failed');
  assert.equal(first.worker.status, 'error');
  assert.equal(first.lifecycle.retryCount, 1);
  assert.equal(first.lifecycle.backoffMs, 1_000);
  assert.equal(first.lifecycle.uiState, 'yellow');

  const delayed = await supervisor.ensureWorker('sdk-b');
  assert.equal(delayed.ok, false);
  assert.equal(delayed.error, 'restart-delayed');
  assert.equal(attempts, 1);

  currentTime += 1_000;
  const second = await supervisor.ensureWorker('sdk-b');
  assert.equal(second.ok, false);
  assert.equal(second.error, 'spawn-failed');
  assert.equal(second.lifecycle.retryCount, 2);
  assert.equal(second.lifecycle.backoffMs, 2_000);
  assert.equal(second.lifecycle.uiState, 'yellow');

  currentTime += 2_000;
  const third = await supervisor.ensureWorker('sdk-b');
  assert.equal(third.ok, false);
  assert.equal(third.error, 'restart-exhausted');
  assert.equal(third.lifecycle.retryCount, 3);
  assert.equal(third.lifecycle.restartExhausted, true);
  assert.equal(third.lifecycle.uiState, 'yellow');

  const exhausted = await supervisor.ensureWorker('sdk-b');
  assert.equal(exhausted.ok, false);
  assert.equal(exhausted.error, 'restart-exhausted');
  assert.equal(attempts, 3);
});

test('lifecycle transition guards keep invalid state changes safe', () => {
  const registry = createSessionWorkerRegistry();
  const supervisor = createSessionWorkerSupervisor({
    registry,
  });

  supervisor.markError('sdk-c', 'boot failure');
  const unchanged = supervisor.markProcessing('sdk-c', 5);
  assert.equal(unchanged.status, 'error');
  assert.equal(unchanged.queueDepth, 0);

  const gate = supervisor.canAttemptRestart('sdk-c');
  assert.equal(gate.allowed, false);
  assert.equal(gate.reason, 'restart-delayed');
});

test('evictIdleWorkers removes only ready sessions past timeout', async () => {
  const registry = createSessionWorkerRegistry();
  let currentTime = Date.parse('2026-01-01T00:00:00.000Z');
  const supervisor = createSessionWorkerSupervisor({
    registry,
    now: () => currentTime,
    idleEvictionMs: 5_000,
  });

  await supervisor.ensureWorker('sdk-d');
  supervisor.markProcessing('sdk-d', 1);
  currentTime += 20_000;
  assert.equal(supervisor.evictIdleWorkers().length, 0);

  supervisor.markIdle('sdk-d', 0);
  currentTime += 4_999;
  assert.equal(supervisor.evictIdleWorkers().length, 0);

  currentTime += 1;
  const evicted = supervisor.evictIdleWorkers();
  assert.equal(evicted.length, 1);
  assert.equal(evicted[0].sdkSessionId, 'sdk-d');
  assert.equal(supervisor.getWorkerState('sdk-d'), null);

  const recreated = await supervisor.ensureWorker('sdk-d');
  assert.equal(recreated.ok, true);
  assert.equal(recreated.worker.status, 'ready');
});

test('ensureWorker deduplicates concurrent starts for the same session', async () => {
  const registry = createSessionWorkerRegistry();
  let spawnCalls = 0;
  const supervisor = createSessionWorkerSupervisor({
    registry,
    spawnWorker: async (sdkSessionId) => {
      spawnCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { workerId: `worker-${sdkSessionId}`, pid: 1234 };
    },
  });

  const [first, second] = await Promise.all([
    supervisor.ensureWorker('sdk-e'),
    supervisor.ensureWorker('sdk-e'),
  ]);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(first.worker.workerId, 'worker-sdk-e');
  assert.equal(second.worker.workerId, 'worker-sdk-e');
  assert.equal(spawnCalls, 1);
});

test('ensureWorker returns missing-session-id for empty session values', async () => {
  const registry = createSessionWorkerRegistry();
  const supervisor = createSessionWorkerSupervisor({ registry });
  const result = await supervisor.ensureWorker('   ');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'missing-session-id');
  assert.equal(result.worker, null);
});

test('ensureWorker does not reuse ready state without worker identity', async () => {
  const registry = createSessionWorkerRegistry();
  registry.upsertWorker({
    sdkSessionId: 'sdk-f',
    status: 'ready',
    conversationId: 'conv-f',
    runtimeSessionId: 'runtime-f',
  });
  let spawnCalls = 0;
  const supervisor = createSessionWorkerSupervisor({
    registry,
    spawnWorker: async (sdkSessionId) => {
      spawnCalls += 1;
      return { workerId: `worker-${sdkSessionId}`, pid: 4321 };
    },
  });

  const result = await supervisor.ensureWorker('sdk-f');
  assert.equal(result.ok, true);
  assert.equal(result.reused, false);
  assert.equal(result.worker.workerId, 'worker-sdk-f');
  assert.equal(result.worker.pid, 4321);
  assert.equal(spawnCalls, 1);
});

test('ensureWorker reuses a live worker even when its heartbeat is stale', async () => {
  const registry = createSessionWorkerRegistry();
  registry.upsertWorker({
    sdkSessionId: 'sdk-live',
    workerId: 'worker-sdk-live',
    pid: 7777,
    status: 'error',
    lastError: 'heartbeat timeout',
  });
  let spawnCalls = 0;
  const supervisor = createSessionWorkerSupervisor({
    registry,
    isPidAlive: (pid) => Number(pid) === 7777,
    spawnWorker: async () => {
      spawnCalls += 1;
      return { workerId: 'worker-sdk-live-2', pid: 8888 };
    },
  });

  const result = await supervisor.ensureWorker('sdk-live');
  assert.equal(result.ok, true);
  assert.equal(result.reused, true);
  assert.equal(result.worker.pid, 7777);
  assert.equal(spawnCalls, 0);
});

test('ensureWorker respawns only after the worker pid is gone', async () => {
  const registry = createSessionWorkerRegistry();
  registry.upsertWorker({
    sdkSessionId: 'sdk-gone',
    workerId: 'worker-sdk-gone',
    pid: 9999,
    status: 'ready',
    lastError: 'heartbeat timeout',
  });
  let spawnCalls = 0;
  const supervisor = createSessionWorkerSupervisor({
    registry,
    isPidAlive: () => false,
    spawnWorker: async (sdkSessionId) => {
      spawnCalls += 1;
      return { workerId: `worker-${sdkSessionId}-next`, pid: 1111 };
    },
  });

  const result = await supervisor.ensureWorker('sdk-gone');
  assert.equal(result.ok, true);
  assert.equal(result.reused, false);
  assert.equal(result.worker.workerId, 'worker-sdk-gone-next');
  assert.equal(result.worker.pid, 1111);
  assert.equal(spawnCalls, 1);
});

test('idle workers with dead pids fall back to white', async () => {
  const registry = createSessionWorkerRegistry();
  registry.upsertWorker({
    sdkSessionId: 'sdk-idle',
    workerId: 'worker-sdk-idle',
    pid: 5555,
    status: 'ready',
    lastError: 'heartbeat timeout',
  });
  const supervisor = createSessionWorkerSupervisor({
    registry,
    isPidAlive: () => false,
  });

  const snapshot = supervisor.snapshot();
  const worker = snapshot.workers.find((row) => row.sdkSessionId === 'sdk-idle');
  assert.equal(worker.uiState, 'white');
  assert.equal(worker.degradedReason, null);
});

test('processing workers remain green when the pid is still alive', async () => {
  const registry = createSessionWorkerRegistry();
  let currentTime = Date.parse('2026-01-01T00:00:00.000Z');
  const supervisor = createSessionWorkerSupervisor({
    registry,
    now: () => currentTime,
    heartbeatTimeoutMs: 1_000,
    degradedRecoveryGraceMs: 2_000,
    isPidAlive: () => true,
    spawnWorker: async () => ({ workerId: 'worker-busy', pid: 1234 }),
  });

  await supervisor.ensureWorker('sdk-busy');
  supervisor.markProcessing('sdk-busy', 1);
  currentTime += 5_000;

  const snapshot = supervisor.snapshot();
  const worker = snapshot.workers.find((row) => row.sdkSessionId === 'sdk-busy');
  assert.equal(worker.uiState, 'green');
  assert.equal(worker.degradedReason, null);
});

test('status precedence favors yellow over red/green and never reports green when degraded', async () => {
  const registry = createSessionWorkerRegistry();
  let currentTime = Date.parse('2026-01-01T00:00:00.000Z');
  const deadPids = new Set([1001]);
  const supervisor = createSessionWorkerSupervisor({
    registry,
    now: () => currentTime,
    heartbeatTimeoutMs: 5_000,
    degradedRecoveryGraceMs: 1_000,
    isPidAlive: (pid) => !deadPids.has(Number(pid)),
    spawnWorker: async (sdkSessionId) => ({
      workerId: `worker-${sdkSessionId}`,
      pid: sdkSessionId === 'sdk-precedence-yellow' ? 1001 : 1002,
    }),
  });
  await supervisor.ensureWorker('sdk-precedence-yellow');
  await supervisor.ensureWorker('sdk-precedence-red');
  await supervisor.ensureWorker('sdk-precedence-green');
  let snapshot = supervisor.snapshot({ pendingQuestionSessionIds: ['sdk-precedence-yellow', 'sdk-precedence-red'] });
  const yellowWorker = snapshot.workers.find((row) => row.sdkSessionId === 'sdk-precedence-yellow');
  const redWorker = snapshot.workers.find((row) => row.sdkSessionId === 'sdk-precedence-red');
  const greenWorker = snapshot.workers.find((row) => row.sdkSessionId === 'sdk-precedence-green');
  assert.equal(yellowWorker.uiState, 'yellow');
  assert.equal(yellowWorker.degradedReason, 'stale-pid');
  assert.equal(redWorker.uiState, 'red');
  assert.equal(greenWorker.uiState, 'green');
  assert.equal(snapshot.health.uiState, 'yellow');

  supervisor.resetHealth('sdk-precedence-yellow', { clearFailureCount: true });
  snapshot = supervisor.snapshot();
  const afterReset = snapshot.workers.find((row) => row.sdkSessionId === 'sdk-precedence-yellow');
  assert.equal(afterReset.uiState, 'white');
  registry.removeWorker('sdk-precedence-green');
  snapshot = supervisor.snapshot();
  const noWorker = snapshot.lifecycle.find((row) => row.sdkSessionId === 'sdk-precedence-green');
  assert.equal(noWorker.uiState, 'white');
});

test('snapshot marks stale pid and sticky yellow while reply is expected', async () => {
  const registry = createSessionWorkerRegistry();
  let currentTime = Date.parse('2026-01-01T00:00:00.000Z');
  let pidAlive = false;
  const supervisor = createSessionWorkerSupervisor({
    registry,
    now: () => currentTime,
    heartbeatTimeoutMs: 5_000,
    degradedRecoveryGraceMs: 2_000,
    isPidAlive: () => pidAlive,
    spawnWorker: async () => ({ workerId: 'worker-stale', pid: 9123 }),
  });

  await supervisor.ensureWorker('sdk-stale');
  supervisor.markProcessing('sdk-stale', 1);
  let snapshot = supervisor.snapshot();
  let worker = snapshot.workers.find((row) => row.sdkSessionId === 'sdk-stale');
  assert.equal(worker.uiState, 'yellow');
  assert.equal(worker.stalePidDetected, true);
  assert.equal(worker.degradedReason, 'stale-pid');

  pidAlive = true;
  supervisor.noteSessionHeartbeat('sdk-stale');
  currentTime += 1_000;
  snapshot = supervisor.snapshot();
  worker = snapshot.workers.find((row) => row.sdkSessionId === 'sdk-stale');
  assert.equal(worker.uiState, 'yellow');

  currentTime += 1_000;
  supervisor.noteSessionHeartbeat('sdk-stale');
  snapshot = supervisor.snapshot();
  worker = snapshot.workers.find((row) => row.sdkSessionId === 'sdk-stale');
  assert.equal(worker.uiState, 'green');
  assert.equal(worker.stalePidDetected, false);
  assert.equal(worker.degradedReason, null);
});

test('stale heartbeat alone does not turn a live worker yellow', async () => {
  const registry = createSessionWorkerRegistry();
  let currentTime = Date.parse('2026-01-01T00:00:00.000Z');
  const supervisor = createSessionWorkerSupervisor({
    registry,
    now: () => currentTime,
    heartbeatTimeoutMs: 1_000,
    degradedRecoveryGraceMs: 2_000,
    isPidAlive: () => true,
  });
  await supervisor.ensureWorker('sdk-heartbeat');
  currentTime += 2_000;
  let snapshot = supervisor.snapshot();
  let worker = snapshot.workers.find((row) => row.sdkSessionId === 'sdk-heartbeat');
  assert.equal(worker.uiState, 'green');
  assert.equal(worker.degradedReason, null);

  supervisor.noteSessionHeartbeat('sdk-heartbeat');
  currentTime += 1_000;
  snapshot = supervisor.snapshot();
  worker = snapshot.workers.find((row) => row.sdkSessionId === 'sdk-heartbeat');
  assert.equal(worker.uiState, 'green');

  currentTime += 1_000;
  supervisor.noteSessionHeartbeat('sdk-heartbeat');
  snapshot = supervisor.snapshot();
  worker = snapshot.workers.find((row) => row.sdkSessionId === 'sdk-heartbeat');
  assert.equal(worker.uiState, 'green');
});

