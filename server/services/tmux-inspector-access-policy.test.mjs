import test from 'node:test';
import assert from 'node:assert/strict';

import { createTmuxInspectorAccessPolicy, isActiveWorkerStatus } from './tmux-inspector-access-policy.mjs';

test('isActiveWorkerStatus accepts only active relay statuses', () => {
  assert.equal(isActiveWorkerStatus('starting'), true);
  assert.equal(isActiveWorkerStatus('ready'), true);
  assert.equal(isActiveWorkerStatus('processing'), true);
  assert.equal(isActiveWorkerStatus('error'), false);
  assert.equal(isActiveWorkerStatus('stopped'), false);
});

test('tmux inspector policy rejects missing session id', () => {
  const policy = createTmuxInspectorAccessPolicy({});
  const result = policy.evaluateSession('');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'missing-session-id');
});

test('tmux inspector policy rejects missing worker', () => {
  const policy = createTmuxInspectorAccessPolicy({
    sessionWorkerRegistry: {
      getWorker() {
        return null;
      },
    },
  });
  const result = policy.evaluateSession('abc-123');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'session-worker-not-found');
});

test('tmux inspector policy rejects inactive worker', () => {
  const policy = createTmuxInspectorAccessPolicy({
    sessionWorkerRegistry: {
      getWorker() {
        return { status: 'error', sdkSessionId: 'abc-123' };
      },
    },
  });
  const result = policy.evaluateSession('abc-123');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'session-worker-inactive');
});

test('tmux inspector policy accepts active worker from supervisor fallback', () => {
  const policy = createTmuxInspectorAccessPolicy({
    sessionWorkerRegistry: {
      getWorker() {
        return null;
      },
    },
    sessionWorkerSupervisor: {
      getWorkerState() {
        return { status: 'ready', sdkSessionId: 'abc-123' };
      },
    },
  });
  const result = policy.evaluateSession('abc-123');
  assert.equal(result.ok, true);
  assert.equal(result.code, 'ok');
  assert.equal(result.sdkSessionId, 'abc-123');
});

