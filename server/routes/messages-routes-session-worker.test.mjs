import test from 'node:test';
import assert from 'node:assert/strict';

import {
  dequeuePendingMessageForWorkerLoop,
  resolveOpenAIReasoningEffort,
  shouldRequireNewOpenAIConversation,
  validateSubagentRunBinding,
} from './messages-routes.mjs';

test('OpenAI reasoning uses model capabilities instead of always forcing none', () => {
  assert.deepEqual(resolveOpenAIReasoningEffort(''), {
    ok: true,
    effort: 'none',
    supported: ['none'],
  });
  assert.deepEqual(resolveOpenAIReasoningEffort('none'), {
    ok: true,
    effort: 'none',
    supported: ['none'],
  });
  assert.deepEqual(resolveOpenAIReasoningEffort('high', 'gpt-5.6-luna'), {
    ok: true,
    effort: 'high',
    supported: ['none', 'low', 'medium', 'high', 'xhigh'],
  });
  assert.deepEqual(resolveOpenAIReasoningEffort('high', 'codex-5.3'), {
    ok: true,
    effort: 'high',
    supported: ['none', 'low', 'medium', 'high', 'xhigh'],
  });
  assert.deepEqual(resolveOpenAIReasoningEffort('xhigh', 'gpt-4o'), {
    ok: false,
    effort: null,
    supported: ['none'],
    error: 'OpenAI model "gpt-4o" does not support reasoning effort "xhigh"',
  });
});

test('overlapping GitHub models do not require a new OpenAI conversation', () => {
  assert.equal(shouldRequireNewOpenAIConversation({
    shouldCreateConversation: false,
    runtimeUsesOpenAI: false,
    requestedConfiguredOpenAIModel: true,
    githubModelAvailable: true,
  }), false);
  assert.equal(shouldRequireNewOpenAIConversation({
    shouldCreateConversation: false,
    runtimeUsesOpenAI: false,
    requestedConfiguredOpenAIModel: true,
    githubModelAvailable: false,
  }), true);
});

test('dequeuePendingMessageForWorkerLoop returns session-killed without calling ensureWorker', async () => {
  let ensureCalled = 0;
  const result = await dequeuePendingMessageForWorkerLoop({
    db: null,
    stmts: {},
    nowIso: new Date().toISOString(),
    routingEnabled: true,
    requesterSessionId: 'kill-blocked-session',
    sessionWorkerSupervisor: {
      isKillBlocked() {
        return true;
      },
      ensureWorker() {
        ensureCalled += 1;
        return { ok: true };
      },
      getWorkerState() {
        return { sdkSessionId: 'kill-blocked-session', status: 'ready', workerId: 'worker-123' };
      },
      getLifecycleState() {
        return { retryCount: 0, uiState: 'white' };
      },
    },
  });

  assert.equal(result.message, null);
  assert.equal(result.blockedReason, 'session-killed');
  assert.equal(result.attempts, 0);
  assert.equal(ensureCalled, 0);
});

test('dequeuePendingMessageForWorkerLoop does not clear kill marker before ensureWorker', async () => {
  let clearRestartCalls = 0;
  let ensureCalls = 0;
  const result = await dequeuePendingMessageForWorkerLoop({
    db: null,
    stmts: {},
    nowIso: new Date().toISOString(),
    routingEnabled: true,
    requesterSessionId: 'ensure-blocked-session',
    sessionWorkerSupervisor: {
      isKillBlocked() {
        return false;
      },
      clearRestartSchedule() {
        clearRestartCalls += 1;
      },
      ensureWorker() {
        ensureCalls += 1;
        return {
          ok: false,
          error: 'session-killed',
          worker: { sdkSessionId: 'ensure-blocked-session', status: 'error' },
          lifecycle: { retryCount: 1 },
        };
      },
      getWorkerState() {
        return null;
      },
    },
  });

  assert.equal(result.message, null);
  assert.equal(result.blockedReason, 'session-killed');
  assert.equal(clearRestartCalls, 0);
  assert.equal(ensureCalls, 1);
});

test('validateSubagentRunBinding rejects conversation mismatches', () => {
  const result = validateSubagentRunBinding({
    queueRow: { id: 'msg-1', conversation_id: 'conv-A' },
    messageId: 'msg-1',
    conversationId: 'conv-B',
    existingRun: null,
  });
  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 409);
  assert.equal(result.error, 'Queue message conversation mismatch');
});

test('validateSubagentRunBinding rejects existing run binding mismatches', () => {
  const result = validateSubagentRunBinding({
    queueRow: { id: 'msg-1', conversation_id: 'conv-A' },
    messageId: 'msg-1',
    conversationId: 'conv-A',
    existingRun: { queue_message_id: 'msg-2', conversation_id: 'conv-A' },
  });
  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 409);
  assert.equal(result.error, 'Subagent run message mismatch');
});

test('validateSubagentRunBinding returns authoritative conversation id when valid', () => {
  const result = validateSubagentRunBinding({
    queueRow: { id: 'msg-1', conversation_id: 'conv-A' },
    messageId: 'msg-1',
    conversationId: 'conv-A',
    existingRun: { queue_message_id: 'msg-1', conversation_id: 'conv-A' },
  });
  assert.equal(result.ok, true);
  assert.equal(result.conversationId, 'conv-A');
});
