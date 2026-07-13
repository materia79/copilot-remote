import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createContextSnapshotService } from './context-snapshot-service.mjs';

test('uses catalog context metadata when session events omit the model limit', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-remote-context-'));
  const sessionId = 'session-1';
  const sessionDir = path.join(root, sessionId);
  fs.mkdirSync(sessionDir);
  fs.writeFileSync(path.join(sessionDir, 'events.jsonl'), `${JSON.stringify({
    type: 'assistant.message',
    timestamp: '2026-07-11T00:00:00.000Z',
    data: {
      currentModel: 'gpt-5.6-terra',
      outputTokens: 100,
    },
  })}\n`);

  try {
    const service = createContextSnapshotService({
      fs,
      path,
      resolveSessionStateRoot: () => root,
      getModelContextLimitTokens: (modelId) => modelId === 'gpt-5.6-terra' ? 272000 : null,
    });
    const result = service.readContextFromSessionEvents(sessionId, sessionId);

    assert.equal(result.snapshot.max_context_tokens, 272000);
    assert.equal(result.snapshot.used_percent, 0.04);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('uses the GPT-5.6 fallback context limit when catalog metadata is unavailable', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-remote-context-'));
  const sessionId = 'session-5.6';
  const sessionDir = path.join(root, sessionId);
  fs.mkdirSync(sessionDir);
  fs.writeFileSync(path.join(sessionDir, 'events.jsonl'), `${JSON.stringify({
    type: 'assistant.message',
    timestamp: '2026-07-11T00:00:00.000Z',
    data: {
      currentModel: 'gpt-5.6-terra',
      outputTokens: 100,
    },
  })}\n`);

  try {
    const service = createContextSnapshotService({
      fs,
      path,
      resolveSessionStateRoot: () => root,
    });
    const result = service.readContextFromSessionEvents(sessionId, sessionId);

    assert.equal(result.snapshot.max_context_tokens, 272000);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
