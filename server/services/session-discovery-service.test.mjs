import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSessionDiscoveryService } from './session-discovery-service.mjs';

test('discoverSessionStateConversations uses workspace summary/name for title', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-session-discovery-'));
  const summarySessionId = '11111111-1111-1111-1111-111111111111';
  const nameSessionId = '22222222-2222-2222-2222-222222222222';
  const fallbackSessionId = '33333333-3333-3333-3333-333333333333';

  fs.mkdirSync(path.join(root, summarySessionId), { recursive: true });
  fs.writeFileSync(path.join(root, summarySessionId, 'events.jsonl'), '', 'utf8');
  fs.utimesSync(path.join(root, summarySessionId, 'events.jsonl'), new Date('2026-05-21T17:00:00.000Z'), new Date('2026-05-21T17:00:00.000Z'));
  fs.writeFileSync(
    path.join(root, summarySessionId, 'workspace.yaml'),
    [
      `id: ${summarySessionId}`,
      'summary: Fix Relay New Conversation Stall',
      'modified: 2026-05-21T17:30:00.000Z',
    ].join('\n'),
    'utf8',
  );

  fs.mkdirSync(path.join(root, nameSessionId), { recursive: true });
  fs.writeFileSync(path.join(root, nameSessionId, 'events.jsonl'), '', 'utf8');
  fs.utimesSync(path.join(root, nameSessionId, 'events.jsonl'), new Date('2026-05-21T17:00:30.000Z'), new Date('2026-05-21T17:00:30.000Z'));
  fs.writeFileSync(
    path.join(root, nameSessionId, 'workspace.yaml'),
    [
      `id: ${nameSessionId}`,
      'name: Verify Session Delete Flow',
      'updated_at: 2026-05-21T17:31:00.000Z',
      'summary_count: 0',
    ].join('\n'),
    'utf8',
  );

  fs.mkdirSync(path.join(root, fallbackSessionId), { recursive: true });

  const service = createSessionDiscoveryService({
    fs,
    path,
    resolveSessionStateRoot: () => root,
  });
  const rows = service.discoverSessionStateConversations(20);
  const byId = new Map(rows.map((row) => [row.sdkSessionId, row]));

  assert.equal(byId.get(summarySessionId)?.title, 'Fix Relay New Conversation Stall');
  assert.equal(byId.get(summarySessionId)?.updatedAt, '2026-05-21T17:30:00.000Z');
  assert.equal(byId.get(nameSessionId)?.title, 'Verify Session Delete Flow');
  assert.equal(byId.get(nameSessionId)?.updatedAt, '2026-05-21T17:31:00.000Z');
  assert.equal(byId.get(fallbackSessionId)?.title, 'Session');
});

test('discoverSessionStateConversations uses freshest timestamp between workspace and events', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-session-discovery-freshest-'));
  const sessionId = '44444444-4444-4444-4444-444444444444';
  const sessionDir = path.join(root, sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  const eventsPath = path.join(sessionDir, 'events.jsonl');
  const workspacePath = path.join(sessionDir, 'workspace.yaml');
  fs.writeFileSync(eventsPath, '', 'utf8');
  fs.utimesSync(eventsPath, new Date('2026-05-21T17:45:00.000Z'), new Date('2026-05-21T17:45:00.000Z'));
  fs.writeFileSync(
    workspacePath,
    [
      `id: ${sessionId}`,
      'summary: Freshness Check',
      'updated_at: 2026-05-21T17:10:00.000Z',
    ].join('\n'),
    'utf8',
  );

  const service = createSessionDiscoveryService({
    fs,
    path,
    resolveSessionStateRoot: () => root,
  });
  const row = service.discoverSessionStateConversations(10).find((item) => item.sdkSessionId === sessionId);
  assert.equal(row?.title, 'Freshness Check');
  assert.equal(row?.updatedAt, '2026-05-21T17:45:00.000Z');
});

