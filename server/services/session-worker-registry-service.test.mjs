import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionWorkerRegistry } from './session-worker-registry-service.mjs';

test('registry upserts and lists worker states by sdkSessionId', () => {
  const registry = createSessionWorkerRegistry();
  const a = registry.upsertWorker({
    sdkSessionId: ' sdk-a ',
    workerId: 'worker-a',
    conversationId: 'conv-a',
    runtimeSessionId: 'runtime-a',
    status: ' READY ',
    queueDepth: 1,
  });
  assert.equal(a.sdkSessionId, 'sdk-a');
  assert.equal(a.workerId, 'worker-a');
  assert.equal(a.conversationId, 'conv-a');
  assert.equal(a.runtimeSessionId, 'runtime-a');
  assert.equal(a.status, 'ready');
  assert.equal(a.queueDepth, 1);
  assert.equal(Object.isFrozen(a), true);

  const updated = registry.upsertWorker({
    sdkSessionId: 'sdk-a',
    status: 'processing',
    queueDepth: 2,
  });
  assert.equal(updated.status, 'processing');
  assert.equal(updated.queueDepth, 2);
  assert.equal(updated.createdAt, a.createdAt);
  assert.ok(Date.parse(updated.updatedAt) >= Date.parse(a.updatedAt));

  const all = registry.listWorkers();
  assert.equal(all.length, 1);
  assert.equal(all[0].sdkSessionId, 'sdk-a');
  assert.equal(Object.isFrozen(all), true);
  assert.equal(Object.isFrozen(all[0]), true);
});

test('registry supports lifecycle lookups by worker, conversation, and runtime ids', () => {
  const registry = createSessionWorkerRegistry();
  registry.upsertWorker({
    sdkSessionId: 'sdk-b',
    workerId: 'worker-b',
    conversationId: 'conv-b',
    runtimeSessionId: 'runtime-b',
    status: 'ready',
  });
  assert.equal(registry.getWorkerByWorkerId('worker-b')?.sdkSessionId, 'sdk-b');
  assert.equal(registry.getWorkerByConversationId('conv-b')?.sdkSessionId, 'sdk-b');
  assert.equal(registry.getWorkerByRuntimeSessionId('runtime-b')?.sdkSessionId, 'sdk-b');

  registry.upsertWorker({
    sdkSessionId: 'sdk-b',
    workerId: 'worker-b2',
    conversationId: 'conv-b2',
    runtimeSessionId: 'runtime-b2',
  });
  assert.equal(registry.getWorkerByWorkerId('worker-b'), null);
  assert.equal(registry.getWorkerByConversationId('conv-b'), null);
  assert.equal(registry.getWorkerByRuntimeSessionId('runtime-b'), null);
  assert.equal(registry.getWorkerByWorkerId('worker-b2')?.sdkSessionId, 'sdk-b');
});

test('registry removeWorker clears session ownership entry', () => {
  const registry = createSessionWorkerRegistry();
  registry.upsertWorker({
    sdkSessionId: 'sdk-a',
    workerId: 'worker-a',
    conversationId: 'conv-a',
    runtimeSessionId: 'runtime-a',
    status: 'ready',
  });
  assert.equal(Boolean(registry.getWorker('sdk-a')), true);
  assert.equal(Boolean(registry.getWorkerByWorkerId('worker-a')), true);
  assert.equal(registry.removeWorker('sdk-a'), true);
  assert.equal(registry.getWorker('sdk-a'), null);
  assert.equal(registry.getWorkerByWorkerId('worker-a'), null);
  assert.equal(registry.getWorkerByConversationId('conv-a'), null);
  assert.equal(registry.getWorkerByRuntimeSessionId('runtime-a'), null);
});

test('registry normalizes state and handles invalid values safely', () => {
  const registry = createSessionWorkerRegistry();
  const created = registry.upsertWorker({
    sdkSessionId: 'sdk-c',
    status: '  queued ',
    pid: '12.9',
    queueDepth: 'nope',
    retryCount: '-3',
    createdAt: 'not-a-date',
    updatedAt: 'also-not-a-date',
  });
  assert.equal(created.status, 'processing');
  assert.equal(created.pid, null);
  assert.equal(created.queueDepth, 0);
  assert.equal(created.retryCount, 0);
  assert.match(created.createdAt, /\d{4}-\d{2}-\d{2}T/);
  assert.match(created.updatedAt, /\d{4}-\d{2}-\d{2}T/);

  const updated = registry.upsertWorker({
    sdkSessionId: 'sdk-c',
    status: 'unexpected-status',
  });
  assert.equal(updated.status, 'new');
});

test('registry throws clear errors for invalid upsert input', () => {
  const registry = createSessionWorkerRegistry();
  assert.throws(
    () => registry.upsertWorker(null),
    /state object/,
  );
  assert.throws(
    () => registry.upsertWorker([]),
    /state object/,
  );
  assert.throws(
    () => registry.upsertWorker({ status: 'ready' }),
    /sdkSessionId/,
  );
});

