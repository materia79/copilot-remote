import test from 'node:test';
import assert from 'node:assert/strict';

import { createSessionWorkerRegistry } from './session-worker-registry-service.mjs';
import { createSessionWorkerSupervisor } from './session-worker-supervisor-service.mjs';

test('supervisor waits for startup heartbeat when launched pid is unknown', async () => {
  const registry = createSessionWorkerRegistry();
  let nowMs = 1_000;
  const supervisor = createSessionWorkerSupervisor({
    registry,
    now: () => nowMs,
    heartbeatTimeoutMs: 1_000,
    spawnWorker: async () => ({ workerId: 'worker-abc123', pid: null }),
  });

  const ensureResult = await supervisor.ensureWorker('abc-123');
  assert.equal(ensureResult.ok, true);
  assert.equal(ensureResult.lifecycle?.awaitingHeartbeat, true);
  assert.equal(ensureResult.lifecycle?.degradedReason, null);

  nowMs += 500;
  const beforeTimeout = supervisor.getLifecycleState('abc-123');
  assert.equal(beforeTimeout?.degradedReason, null);

  nowMs += 600;
  const afterTimeout = supervisor.getLifecycleState('abc-123');
  assert.equal(afterTimeout?.degradedReason, 'startup-heartbeat-timeout');
  assert.equal(afterTimeout?.uiState, 'yellow');
});

test('supervisor marks stale pid when known launched pid is dead and work is pending', async () => {
  const registry = createSessionWorkerRegistry();
  const supervisor = createSessionWorkerSupervisor({
    registry,
    now: () => 2_000,
    heartbeatTimeoutMs: 5_000,
    isPidAlive: () => false,
    spawnWorker: async () => ({ workerId: 'worker-xyz789', pid: 98765 }),
  });

  const ensureResult = await supervisor.ensureWorker('xyz-789');
  assert.equal(ensureResult.ok, true);
  const status = supervisor.snapshot({
    pendingQuestionSessionIds: ['xyz-789'],
  });
  const lifecycle = status.lifecycle.find((entry) => entry.sdkSessionId === 'xyz-789');
  assert.equal(lifecycle?.degradedReason, 'stale-pid');
  assert.equal(lifecycle?.uiState, 'yellow');
  assert.equal(lifecycle?.stalePidDetected, true);
});

test('supervisor does not reuse worker after startup heartbeat timeout', async () => {
  const registry = createSessionWorkerRegistry();
  let nowMs = 10_000;
  let spawnCount = 0;
  const supervisor = createSessionWorkerSupervisor({
    registry,
    now: () => nowMs,
    heartbeatTimeoutMs: 1_000,
    spawnWorker: async () => {
      spawnCount += 1;
      return { workerId: `worker-timeout-${spawnCount}`, pid: null };
    },
  });

  const first = await supervisor.ensureWorker('retry-timeout');
  assert.equal(first.ok, true);
  assert.equal(first.reused, false);
  assert.equal(spawnCount, 1);

  nowMs += 1_500;
  const lifecycleAfterTimeout = supervisor.getLifecycleState('retry-timeout');
  assert.equal(lifecycleAfterTimeout?.degradedReason, 'startup-heartbeat-timeout');

  const second = await supervisor.ensureWorker('retry-timeout');
  assert.equal(second.ok, true);
  assert.equal(second.reused, false);
  assert.equal(spawnCount, 2);
});
