import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createContextSnapshotService } from './context-snapshot-service.mjs';

function makeEvent(data, timestamp) {
  return JSON.stringify({
    type: 'turn.metrics',
    timestamp,
    data,
  });
}

test('context snapshot service returns the latest usage snapshot from session events', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'context-snapshot-'));
  const sessionId = 'session-a';
  const sessionDir = path.join(root, sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  const eventsPath = path.join(sessionDir, 'events.jsonl');
  fs.writeFileSync(eventsPath, [
    makeEvent({ currentModel: 'gpt-5.4-mini', currentTokens: 1000, systemTokens: 100, conversationTokens: 700, toolDefinitionsTokens: 200, maxContextTokens: 256000 }, '2026-05-24T19:00:00.000Z'),
    makeEvent({ currentModel: 'gpt-5.4-mini', currentTokens: 1600, systemTokens: 100, conversationTokens: 1100, toolDefinitionsTokens: 400, maxContextTokens: 256000 }, '2026-05-24T19:00:05.000Z'),
    '',
  ].join('\n'), 'utf8');

  const service = createContextSnapshotService({
    fs,
    path,
    resolveSessionStateRoot: () => root,
  });

  const result = service.readContextFromSessionEvents('runtime-a', sessionId);
  assert.equal(result.eventsPath, eventsPath);
  assert.equal(result.snapshot?.copilot_session_id, sessionId);
  assert.equal(result.snapshot?.used_total_tokens, 1600);
  assert.equal(result.snapshot?.messages_tokens, 1100);
  assert.equal(result.snapshot?.max_context_tokens, 256000);
  assert.equal(result.error, null);
});

test('context snapshot service advances incrementally and keeps the last good snapshot during partial writes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'context-snapshot-'));
  const sessionId = 'session-b';
  const sessionDir = path.join(root, sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  const eventsPath = path.join(sessionDir, 'events.jsonl');
  fs.writeFileSync(eventsPath, `${makeEvent({
    currentModel: 'claude-sonnet-4.6',
    currentTokens: 900,
    systemTokens: 200,
    conversationTokens: 500,
    toolDefinitionsTokens: 200,
    maxContextTokens: 160000,
  }, '2026-05-24T19:01:00.000Z')}\n`, 'utf8');

  const service = createContextSnapshotService({
    fs,
    path,
    resolveSessionStateRoot: () => root,
  });

  const first = service.readContextFromSessionEvents('runtime-b', sessionId);
  assert.equal(first.snapshot?.used_total_tokens, 900);

  const partialLine = makeEvent({
    currentModel: 'claude-sonnet-4.6',
    currentTokens: 1200,
    systemTokens: 250,
    conversationTokens: 700,
    toolDefinitionsTokens: 250,
    maxContextTokens: 160000,
  }, '2026-05-24T19:01:05.000Z');
  fs.appendFileSync(eventsPath, partialLine.slice(0, Math.floor(partialLine.length / 2)), 'utf8');

  const duringPartial = service.readContextFromSessionEvents('runtime-b', sessionId);
  assert.equal(duringPartial.snapshot?.used_total_tokens, 900);

  fs.appendFileSync(eventsPath, `${partialLine.slice(Math.floor(partialLine.length / 2))}\n`, 'utf8');

  const second = service.readContextFromSessionEvents('runtime-b', sessionId);
  assert.equal(second.snapshot?.used_total_tokens, 1200);
  assert.equal(second.snapshot?.messages_tokens, 700);
});

test('context snapshot service does not reuse stale snapshots after the events file is rewritten', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'context-snapshot-'));
  const sessionId = 'session-c';
  const sessionDir = path.join(root, sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  const eventsPath = path.join(sessionDir, 'events.jsonl');
  fs.writeFileSync(eventsPath, `${makeEvent({
    currentModel: 'gpt-5.4',
    currentTokens: 1500,
    systemTokens: 300,
    conversationTokens: 900,
    toolDefinitionsTokens: 300,
    maxContextTokens: 256000,
  }, '2026-05-24T19:02:00.000Z')}\n`, 'utf8');

  const service = createContextSnapshotService({
    fs,
    path,
    resolveSessionStateRoot: () => root,
  });

  const first = service.readContextFromSessionEvents('runtime-c', sessionId);
  assert.equal(first.snapshot?.used_total_tokens, 1500);

  fs.writeFileSync(eventsPath, '{"type":"hook.start","data":{"toolName":"view"}}\n', 'utf8');

  const second = service.readContextFromSessionEvents('runtime-c', sessionId);
  assert.equal(second.snapshot, null);
  assert.equal(second.error, 'No context-bearing events found for this session');
});

test('context snapshot service falls back to a lower-bound completion estimate when only assistant output tokens exist', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'context-snapshot-'));
  const sessionId = 'session-d';
  const sessionDir = path.join(root, sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  const eventsPath = path.join(sessionDir, 'events.jsonl');
  fs.writeFileSync(eventsPath, [
    JSON.stringify({
      type: 'assistant.message',
      timestamp: '2026-05-24T19:03:00.000Z',
      data: {
        model: 'gpt-5.4-mini',
        outputTokens: 900,
      },
    }),
    JSON.stringify({
      type: 'assistant.message',
      timestamp: '2026-05-24T19:03:05.000Z',
      data: {
        model: 'gpt-5.4-mini',
        outputTokens: 300,
      },
    }),
    '',
  ].join('\n'), 'utf8');

  const service = createContextSnapshotService({
    fs,
    path,
    resolveSessionStateRoot: () => root,
  });

  const result = service.readContextFromSessionEvents('runtime-d', sessionId);
  assert.equal(result.snapshot?.estimate_kind, 'assistant-output-lower-bound');
  assert.equal(result.snapshot?.used_total_tokens, 1200);
  assert.equal(result.snapshot?.messages_tokens, 1200);
  assert.equal(result.snapshot?.used_completion_tokens, 1200);
  assert.equal(result.snapshot?.max_context_tokens, 256000);
  assert.match(result.error || '', /lower-bound estimate/i);
});

test('context snapshot service prefers richer snapshots over completion-only estimates', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'context-snapshot-'));
  const sessionId = 'session-e';
  const sessionDir = path.join(root, sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  const eventsPath = path.join(sessionDir, 'events.jsonl');
  fs.writeFileSync(eventsPath, [
    JSON.stringify({
      type: 'assistant.message',
      timestamp: '2026-05-24T19:04:00.000Z',
      data: {
        model: 'gpt-5.4',
        outputTokens: 400,
      },
    }),
    makeEvent({
      currentModel: 'gpt-5.4',
      currentTokens: 1800,
      systemTokens: 200,
      conversationTokens: 1300,
      toolDefinitionsTokens: 300,
      maxContextTokens: 256000,
    }, '2026-05-24T19:04:05.000Z'),
    '',
  ].join('\n'), 'utf8');

  const service = createContextSnapshotService({
    fs,
    path,
    resolveSessionStateRoot: () => root,
  });

  const result = service.readContextFromSessionEvents('runtime-e', sessionId);
  assert.equal(result.snapshot?.estimate_kind, null);
  assert.equal(result.snapshot?.used_total_tokens, 1800);
  assert.equal(result.snapshot?.messages_tokens, 1300);
  assert.equal(result.snapshot?.max_context_tokens, 256000);
  assert.equal(result.error, null);
});
