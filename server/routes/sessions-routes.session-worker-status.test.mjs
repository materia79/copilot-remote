import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSessionWorkerStatusPayload, buildConversationSessionRootPayload } from './sessions-routes.mjs';

test('buildSessionWorkerStatusPayload includes rollout flags and supervisor snapshot defaults', () => {
  const payload = buildSessionWorkerStatusPayload({
    featureFlags: {
      SESSION_WORKER_ROUTING_ENABLED: true,
      SESSION_WORKER_CONTINUATION_ROUTING_ENABLED: false,
      SESSION_WORKER_FALLBACK_RESTART_ENABLED: true,
    },
    supervisorSnapshot: null,
    queueRows: null,
  });
  assert.equal(payload.enabled, true);
  assert.equal(payload.continuationRoutingEnabled, false);
  assert.equal(payload.fallbackRestartEnabled, false);
  assert.equal(payload.workerCount, 0);
  assert.deepEqual(payload.integrity, {
    scannedQueueRowCount: 0,
    workerRegistryCount: 0,
    queueOwnerOrphanCount: 0,
    queueConversationMismatchCount: 0,
    queueRuntimeMismatchCount: 0,
    queueProcessingStateMismatchCount: 0,
    queueOwnerOrphanSamples: [],
    queueConversationMismatchSamples: [],
    queueRuntimeMismatchSamples: [],
    queueProcessingStateMismatchSamples: [],
  });
});

test('buildSessionWorkerStatusPayload tracks deterministic orphan and mismatch counters', () => {
  const payload = buildSessionWorkerStatusPayload({
    featureFlags: { SESSION_WORKER_ROUTING_ENABLED: true },
    supervisorSnapshot: {
      workerCount: 2,
      counts: { processing: 1, ready: 1 },
      workers: [
        {
          sdkSessionId: 'sdk-a',
          workerId: 'worker-a',
          conversationId: 'conv-a',
          runtimeSessionId: 'runtime-a',
          status: 'ready',
        },
        {
          sdkSessionId: 'sdk-b',
          workerId: 'worker-b',
          conversationId: 'conv-b',
          runtimeSessionId: 'runtime-b',
          status: 'processing',
        },
      ],
      pendingStarts: 0,
      lifecycle: [],
    },
    queueRows: [
      {
        id: 'msg-orphan',
        conversation_id: 'conv-x',
        runtime_session_id: 'runtime-x',
        owner_sdk_session_id: 'sdk-missing',
        status: 'pending',
      },
      {
        id: 'msg-mismatch-conv',
        conversation_id: 'conv-z',
        runtime_session_id: 'runtime-a',
        owner_sdk_session_id: 'sdk-a',
        status: 'processing',
      },
      {
        id: 'msg-mismatch-runtime',
        conversation_id: 'conv-b',
        runtime_session_id: 'runtime-z',
        owner_sdk_session_id: 'sdk-b',
        status: 'processing',
      },
    ],
  });
  assert.equal(payload.integrity.queueOwnerOrphanCount, 1);
  assert.equal(payload.integrity.queueConversationMismatchCount, 1);
  assert.equal(payload.integrity.queueRuntimeMismatchCount, 1);
  assert.equal(payload.integrity.queueProcessingStateMismatchCount, 1);
  assert.equal(payload.integrity.queueOwnerOrphanSamples[0].messageId, 'msg-orphan');
  assert.equal(payload.integrity.queueConversationMismatchSamples[0].messageId, 'msg-mismatch-conv');
  assert.equal(payload.integrity.queueRuntimeMismatchSamples[0].messageId, 'msg-mismatch-runtime');
  assert.equal(payload.integrity.queueProcessingStateMismatchSamples[0].messageId, 'msg-mismatch-conv');
});

test('buildSessionWorkerStatusPayload surfaces canonical health metadata', () => {
  const payload = buildSessionWorkerStatusPayload({
    featureFlags: { SESSION_WORKER_ROUTING_ENABLED: true },
    supervisorSnapshot: {
      workerCount: 1,
      counts: { ready: 1 },
      workers: [{
        sdkSessionId: 'sdk-health',
        workerId: 'worker-health',
        status: 'ready',
        uiState: 'yellow',
        degradedReason: 'heartbeat-timeout',
        lastHeartbeatAt: '2026-01-01T00:00:00.000Z',
        lastFailureAt: '2026-01-01T00:00:01.000Z',
        failureCount: 2,
        stalePidDetected: true,
      }],
      pendingStarts: 0,
      lifecycle: [],
      health: {
        uiState: 'yellow',
        degradedReason: 'heartbeat-timeout',
        counts: { white: 0, green: 0, red: 0, yellow: 1 },
      },
    },
    queueRows: [],
  });
  assert.equal(payload.uiState, 'yellow');
  assert.equal(payload.degradedReason, 'heartbeat-timeout');
  assert.equal(payload.health?.counts?.yellow, 1);
  assert.equal(payload.workers[0].uiState, 'yellow');
  assert.equal(payload.workers[0].failureCount, 2);
});

test('buildConversationSessionRootPayload returns an existing session directory', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-session-root-'));
  const sessionId = 'session-abc12345';
  const sessionPath = path.join(tmpRoot, sessionId);
  fs.mkdirSync(sessionPath, { recursive: true });

  const payload = buildConversationSessionRootPayload({
    conversationId: 'conv-1',
    sdkSessionId: sessionId,
    title: 'A Session Title',
    resolveSessionStateRoot: () => tmpRoot,
  });

  assert.deepEqual(payload, {
    sdkSessionId: sessionId,
    sessionRootPath: sessionPath,
    sessionRootName: 'A Session Title',
  });
});
