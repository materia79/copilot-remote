import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { createSdkSessionImportService } from './sdk-session-import-service.mjs';

function makeHarness({ eventsBySession = {}, failSessions = new Set(), sessionMetadata = {} } = {}) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, title_source TEXT NOT NULL DEFAULT 'auto',
      sdk_session_id TEXT, configured_workspace_root_path TEXT, runtime_workspace_root_path TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE deleted_sdk_sessions (sdk_session_id TEXT PRIMARY KEY);
    CREATE TABLE sdk_session_imports (
      sdk_session_id TEXT PRIMARY KEY, conversation_id TEXT, status TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0, started_at TEXT, completed_at TEXT,
      updated_at TEXT NOT NULL, last_error TEXT
    );
  `);
  const stmts = {
    getDeletedSdkSession: db.prepare(`SELECT sdk_session_id FROM deleted_sdk_sessions WHERE sdk_session_id = ?`),
    getSdkSessionImport: db.prepare(`SELECT * FROM sdk_session_imports WHERE sdk_session_id = ?`),
    upsertSdkSessionImport: db.prepare(`INSERT INTO sdk_session_imports (sdk_session_id, conversation_id, status, attempt_count, updated_at) VALUES (?, ?, 'pending', 0, ?) ON CONFLICT(sdk_session_id) DO NOTHING`),
    claimSdkSessionImport: db.prepare(`UPDATE sdk_session_imports SET status = 'processing', attempt_count = attempt_count + 1, started_at = ?, updated_at = ?, last_error = NULL WHERE sdk_session_id = ? AND (? = 1 OR status != 'completed') AND status != 'processing'`),
    completeSdkSessionImport: db.prepare(`UPDATE sdk_session_imports SET conversation_id = ?, status = 'completed', completed_at = ?, updated_at = ?, last_error = NULL WHERE sdk_session_id = ?`),
    failSdkSessionImport: db.prepare(`UPDATE sdk_session_imports SET status = 'failed', updated_at = ?, last_error = ? WHERE sdk_session_id = ?`),
    resetInterruptedSdkSessionImports: db.prepare(`UPDATE sdk_session_imports SET status = 'failed', updated_at = ?, last_error = 'Interrupted before import completion' WHERE status = 'processing'`),
  };
  const resumed = [];
  const resumeConfigs = [];
  const client = {
    async listSessions() {
      return Object.keys(eventsBySession).map((sessionId) => ({
        sessionId,
        metadata: {
          title: `Title ${sessionId}`,
          ...(sessionMetadata[sessionId] || {}),
        },
      }));
    },
    async resumeSession(sessionId, config) {
      resumed.push(sessionId);
      resumeConfigs.push(config);
      if (failSessions.has(sessionId)) throw new Error(`resume failed: ${sessionId}`);
      return { async getEvents() { return eventsBySession[sessionId]; }, async dispose() {} };
    },
  };
  const replaced = [];
  const service = createSdkSessionImportService({
    db,
    stmts,
    createClient: async () => ({ client, async dispose() {} }),
    parseSessionEventsToMessages: (events) => events.map((event) => ({ id: event.id, role: event.role, text: event.text })),
    replaceRetrievableHistory: (conversationId, messages) => replaced.push({ conversationId, messages }),
    ensureRuntimeSessionBinding: () => null,
    logger: { info() {} },
  });
  return { db, service, resumed, resumeConfigs, replaced };
}

test('imports all SDK sessions sequentially and skips completed ledger rows', async () => {
  const { db, service, resumed, resumeConfigs, replaced } = makeHarness({
    eventsBySession: {
      first: [{ id: 'm1', role: 'user', text: 'first' }],
      second: [{ id: 'm2', role: 'user', text: 'second' }],
    },
  });
  const first = await service.runStartupImport();
  assert.deepEqual(first, { listed: 2, completed: 2, failed: 0, skipped: 0 });
  assert.deepEqual(resumed, ['first', 'second']);
  assert.deepEqual(resumeConfigs, [
    { suppressResumeEvent: true },
    { suppressResumeEvent: true },
  ]);
  assert.equal(replaced.length, 2);

  const second = await service.runStartupImport();
  assert.deepEqual(second, { listed: 2, completed: 0, failed: 0, skipped: 2 });
  assert.deepEqual(resumed, ['first', 'second']);
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM conversations`).get().count, 2);
});

test('preserves SDK start and modified timestamps when importing', async () => {
  const { db, service } = makeHarness({
    eventsBySession: {
      dated: [{ id: 'm1', role: 'user', text: 'timestamp test' }],
    },
    sessionMetadata: {
      dated: {
        startTime: '2026-07-10T09:00:00.000Z',
        modifiedTime: '2026-07-11T10:30:00.000Z',
      },
    },
  });

  await service.runStartupImport();

  assert.deepEqual(
    db.prepare(`SELECT created_at, updated_at FROM conversations WHERE id = 'dated'`).get(),
    {
      created_at: '2026-07-10T09:00:00.000Z',
      updated_at: '2026-07-11T10:30:00.000Z',
    },
  );
});

test('records failures and retries them on a later startup pass', async () => {
  const failSessions = new Set(['broken']);
  const { db, service, resumed } = makeHarness({
    eventsBySession: { broken: [{ id: 'm1', role: 'user', text: 'retry me' }] },
    failSessions,
  });
  const failed = await service.runStartupImport();
  assert.equal(failed.failed, 1);
  assert.equal(db.prepare(`SELECT status FROM sdk_session_imports WHERE sdk_session_id = 'broken'`).get().status, 'failed');

  failSessions.delete('broken');
  const retried = await service.runStartupImport();
  assert.equal(retried.completed, 1);
  assert.deepEqual(resumed, ['broken', 'broken']);
  const row = db.prepare(`SELECT status, attempt_count FROM sdk_session_imports WHERE sdk_session_id = 'broken'`).get();
  assert.deepEqual(row, { status: 'completed', attempt_count: 2 });
});
