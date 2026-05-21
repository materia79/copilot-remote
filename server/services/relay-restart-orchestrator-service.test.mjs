import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createRelayRestartOrchestrator } from './relay-restart-orchestrator-service.mjs';

function createHarness(options = {}) {
  const db = new Database(':memory:');
  let nowMs = Date.parse('2026-01-01T00:00:00.000Z');
  const orchestrator = createRelayRestartOrchestrator({
    db,
    gracefulTimeoutMs: options.gracefulTimeoutMs ?? 100,
    readyCooldownMs: options.readyCooldownMs ?? 50,
    shutdownTimeoutMs: options.shutdownTimeoutMs ?? 5_000,
    spawnTimeoutMs: options.spawnTimeoutMs ?? 500,
    rebindTimeoutMs: options.rebindTimeoutMs ?? 500,
    maxAttempts: options.maxAttempts ?? 2,
    retryBackoffMs: options.retryBackoffMs ?? [200, 400],
    now: () => nowMs,
  });
  return {
    db,
    orchestrator,
    advance(ms) {
      nowMs += ms;
    },
  };
}

test('spawn timeout retries then reaches terminal exhausted outcome', () => {
  const h = createHarness({
    spawnTimeoutMs: 300,
    maxAttempts: 2,
    retryBackoffMs: [200, 400],
  });
  try {
    const requested = h.orchestrator.requestRestart({ targetSessionId: 'session-a', reason: 'test' });
    assert.equal(requested.ok, true);
    assert.equal(requested.state.state, 'draining');

    const first = h.orchestrator.onDequeueProbe({ processingCount: 0 });
    assert.equal(first.state.state, 'restarting');
    assert.equal(first.state.attempts, 1);
    assert.equal(first.blockDequeue, true);
    assert.equal(first.control?.type, 'restart_cli');

    h.advance(301);
    const afterFirstTimeout = h.orchestrator.onDequeueProbe({ processingCount: 0 });
    assert.equal(afterFirstTimeout.state.state, 'draining');
    assert.equal(afterFirstTimeout.state.retryPhase, 'spawn');
    assert.equal(afterFirstTimeout.state.lastFailureCode, 'spawn-timeout');
    assert.equal(afterFirstTimeout.state.lastFailureRetryable, true);
    assert.equal(afterFirstTimeout.blockDequeue, true);

    const stillWaiting = h.orchestrator.onDequeueProbe({ processingCount: 0 });
    assert.equal(stillWaiting.state.state, 'draining');
    assert.equal(stillWaiting.blockDequeue, true);

    h.advance(201);
    const secondAttempt = h.orchestrator.onDequeueProbe({ processingCount: 0 });
    assert.equal(secondAttempt.state.state, 'restarting');
    assert.equal(secondAttempt.state.attempts, 2);
    assert.equal(secondAttempt.blockDequeue, true);

    h.advance(301);
    const exhausted = h.orchestrator.onDequeueProbe({ processingCount: 0 });
    assert.equal(exhausted.blockDequeue, false);
    assert.equal(exhausted.state.state, 'idle');
    assert.equal(exhausted.state.terminalOutcomeCode, 'spawn-timeout-exhausted');
    assert.equal(exhausted.state.terminalOutcomeAttempts, 2);
    assert.equal(exhausted.state.lastFailureTerminal, true);
    assert.match(exhausted.state.terminalOutcomeMessage || '', /attempts exhausted 2\/2/i);
  } finally {
    h.db.close();
  }
});

test('terminal rebind mismatch is classified non-retryable and unblocks queue', () => {
  const h = createHarness({
    maxAttempts: 3,
  });
  try {
    const requested = h.orchestrator.requestRestart({ targetSessionId: 'session-a', reason: 'test' });
    assert.equal(requested.ok, true);

    const restart = h.orchestrator.onDequeueProbe({ processingCount: 0 });
    assert.equal(restart.state.state, 'restarting');
    h.orchestrator.noteCliOffline();

    const mismatch = h.orchestrator.applySessionSync({
      sdkSessionId: 'session-a',
      conversationId: 'conv-a',
      correlationId: 'wrong-transaction',
      rebindCompleted: true,
      signalSource: 'test',
    });
    assert.equal(mismatch.ok, false);
    assert.equal(mismatch.code, 'transaction-mismatch');
    assert.equal(mismatch.retryable, false);
    assert.equal(mismatch.terminal, true);
    assert.equal(mismatch.state.state, 'idle');
    assert.equal(mismatch.state.terminalOutcomeCode, 'transaction-mismatch');
    assert.equal(mismatch.state.lastFailurePhase, 'rebind');
    assert.equal(mismatch.state.lastFailureTerminal, true);

    const postTerminal = h.orchestrator.onDequeueProbe({ processingCount: 0 });
    assert.equal(postTerminal.blockDequeue, false);
    assert.equal(postTerminal.state.state, 'idle');
  } finally {
    h.db.close();
  }
});

test('noteCliOffline moves restarting flow into awaiting_rebind without reissuing control', () => {
  const h = createHarness();
  try {
    const requested = h.orchestrator.requestRestart({ targetSessionId: 'session-a', reason: 'test' });
    assert.equal(requested.ok, true);

    const restart = h.orchestrator.onDequeueProbe({ processingCount: 0 });
    assert.equal(restart.state.state, 'restarting');
    assert.equal(restart.control?.type, 'restart_cli');

    const awaiting = h.orchestrator.noteCliOffline();
    assert.equal(awaiting.state, 'awaiting_rebind');

    const held = h.orchestrator.onDequeueProbe({ processingCount: 0 });
    assert.equal(held.blockDequeue, true);
    assert.equal(held.state.state, 'awaiting_rebind');
    assert.equal(held.control, null);
  } finally {
    h.db.close();
  }
});

test('rebind confirmation is accepted while restarting when sdk session already matches target', () => {
  const h = createHarness();
  try {
    h.orchestrator.requestRestart({ targetSessionId: 'sdk-r', reason: 'mismatch' });
    const restarting = h.orchestrator.onDequeueProbe({ processingCount: 0 });
    assert.equal(restarting.state.state, 'restarting');

    const acknowledged = h.orchestrator.applySessionSync({
      sdkSessionId: 'sdk-r',
      targetSessionId: 'sdk-r',
      rebindCompleted: true,
      correlationId: restarting.state.transactionId,
    });
    assert.equal(acknowledged.ok, true);
    assert.equal(acknowledged.completed, true);
    assert.equal(h.orchestrator.getState().state, 'ready');
  } finally {
    h.db.close();
  }
});

test('rebind completion succeeds without conversation id when session and correlation match', () => {
  const h = createHarness();
  try {
    const requested = h.orchestrator.requestRestart({ targetSessionId: 'session-a', reason: 'test' });
    assert.equal(requested.ok, true);

    const restart = h.orchestrator.onDequeueProbe({ processingCount: 0 });
    assert.equal(restart.state.state, 'restarting');
    const transactionId = restart.state.transactionId;
    assert.ok(transactionId);

    const awaiting = h.orchestrator.noteCliOffline();
    assert.equal(awaiting.state, 'awaiting_rebind');

    const completed = h.orchestrator.applySessionSync({
      sdkSessionId: 'session-a',
      conversationId: null,
      correlationId: transactionId,
      targetSessionId: 'session-a',
      rebindCompleted: true,
      signalSource: 'test-no-conversation',
    });
    assert.equal(completed.ok, true);
    assert.equal(completed.completed, true);
    assert.equal(completed.state.state, 'ready');
    assert.equal(completed.state.lastRebindSignalConversationId, null);
  } finally {
    h.db.close();
  }
});

