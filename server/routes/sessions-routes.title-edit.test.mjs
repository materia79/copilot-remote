import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  normalizeConversationTitle,
  persistConversationTitle,
  resolveConversationTitle,
} from './sessions-routes.mjs';

function createHarness() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      title_source TEXT NOT NULL DEFAULT 'auto',
      sdk_session_id TEXT,
      archived INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      compacted_into TEXT,
      compacted_from TEXT,
      summary_seed TEXT,
      seed_pending INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  const stmts = {
    getConvAnyStatus: db.prepare(`SELECT * FROM conversations WHERE id = ?`),
    insertConv: db.prepare(`INSERT OR IGNORE INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`),
    updateConvTitle: db.prepare(`UPDATE conversations SET title = ?, title_source = 'manual', updated_at = ? WHERE id = ?`),
    setConvSdkSessionIdIfMissing: db.prepare(`UPDATE conversations SET sdk_session_id = ?, updated_at = ? WHERE id = ? AND (sdk_session_id IS NULL OR sdk_session_id = '')`),
  };
  const events = [];
  const io = { emit: (event, payload) => events.push({ event, payload }) };
  return { db, stmts, io, events };
}

test('resolveConversationTitle keeps manual titles over discovered ones', () => {
  assert.equal(resolveConversationTitle({
    title: 'Manual title',
    titleSource: 'manual',
    discoveredTitle: 'Workspace title',
  }), 'Manual title');
  assert.equal(resolveConversationTitle({
    title: 'Stored title',
    titleSource: 'auto',
    discoveredTitle: 'Workspace title',
  }), 'Workspace title');
});

test('persistConversationTitle updates existing conversations and emits the socket event', () => {
  const { db, stmts, io, events } = createHarness();
  const now = '2026-01-01T00:00:00.000Z';
  db.prepare(`
    INSERT INTO conversations (id, title, title_source, sdk_session_id, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('conv-1', 'Auto title', 'auto', 'sdk-1', 'active', now, now);

  const result = persistConversationTitle({
    db,
    stmts,
    io,
    conversationId: 'conv-1',
    title: 'Renamed conversation',
  });

  assert.equal(result.ok, true);
  assert.equal(result.created, false);
  assert.equal(result.title, 'Renamed conversation');
  const row = stmts.getConvAnyStatus.get('conv-1');
  assert.equal(row.title, 'Renamed conversation');
  assert.equal(row.title_source, 'manual');
  assert.equal(row.sdk_session_id, 'sdk-1');
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'conversation_title_updated');
  assert.equal(events[0].payload.conversationId, 'conv-1');
  db.close();
});

test('persistConversationTitle inserts missing conversations so title edits stay persistent', () => {
  const { db, stmts, io } = createHarness();

  const result = persistConversationTitle({
    db,
    stmts,
    io,
    conversationId: 'sdk-123',
    title: 'Manual session title',
  });

  assert.equal(result.ok, true);
  assert.equal(result.created, true);
  assert.equal(normalizeConversationTitle('  Manual session title  '), 'Manual session title');
  const row = stmts.getConvAnyStatus.get('sdk-123');
  assert.equal(row.title, 'Manual session title');
  assert.equal(row.title_source, 'manual');
  assert.equal(row.sdk_session_id, 'sdk-123');
  db.close();
});

test('persistConversationTitle updates the SDK workspace yaml title', () => {
  const { db, stmts, io } = createHarness();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-title-sync-'));
  const sessionId = 'sdk-xyz';
  const sessionDir = path.join(root, sessionId);
  const workspacePath = path.join(sessionDir, 'workspace.yaml');
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(workspacePath, [
    `id: ${sessionId}`,
    'summary: Old title',
    'name: Old title',
    'updated_at: 2026-01-01T00:00:00.000Z',
    'modified: 2026-01-01T00:00:00.000Z',
  ].join('\n'), 'utf8');
  db.prepare(`
    INSERT INTO conversations (id, title, title_source, sdk_session_id, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('conv-sync', 'Old title', 'auto', sessionId, 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');

  const result = persistConversationTitle({
    db,
    stmts,
    io,
    conversationId: 'conv-sync',
    title: 'Renamed session title',
    resolveSessionStateRoot: () => root,
  });

  assert.equal(result.ok, true);
  assert.equal(result.workspaceYamlPath, workspacePath);
  const updated = fs.readFileSync(workspacePath, 'utf8');
  assert.match(updated, /^summary:\s*Renamed session title$/m);
  assert.match(updated, /^name:\s*Renamed session title$/m);
  assert.match(updated, /^updated_at:\s*/m);
  assert.match(updated, /^modified:\s*/m);
  db.close();
});
