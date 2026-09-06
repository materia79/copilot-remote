import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';

import { createSdkSessionSyncService } from './sdk-session-sync-service.mjs';
import { applySchema } from '../db-schema.mjs';

function createTestDb() {
  const db = new Database(':memory:');
  applySchema(db);
  return db;
}

function insertConversation(db, id, sdkSessionId, nowIso = '2026-07-01T10:00:00.000Z') {
  db.prepare(`
    INSERT INTO conversations (id, title, created_at, sdk_session_id, status, updated_at)
    VALUES (?, 'Conversation', ?, ?, 'active', ?)
  `).run(id, nowIso, sdkSessionId, nowIso);
}

function insertRuntimeSession(db, id, conversationId, sdkSessionId, nowIso = '2026-07-01T10:00:00.000Z') {
  db.prepare(`
    INSERT INTO runtime_sessions (
      id, conversation_id, sdk_session_id, status, strategy, runtime_key, model, created_at, last_used_at
    ) VALUES (?, ?, ?, 'active', 'isolated', ?, NULL, ?, ?)
  `).run(id, conversationId, sdkSessionId, id, nowIso, nowIso);
}

function insertQueueRow(db, id, conversationId, status, ownerSdkSessionId, attemptId = null) {
  db.prepare(`
    INSERT INTO queue (id, conversation_id, status, owner_sdk_session_id, attempt_id, text, timestamp)
    VALUES (?, ?, ?, ?, ?, 'prompt', '2026-07-01T10:00:00.000Z')
  `).run(id, conversationId, status, ownerSdkSessionId, attemptId);
}

test('syncSession migrates pending queue owner from placeholder conversation id', () => {
  const db = createTestDb();
  insertConversation(db, 'conv-1', 'conv-1');
  insertRuntimeSession(db, 'runtime-1', 'conv-1', 'conv-1');
  insertQueueRow(db, 'q-pending', 'conv-1', 'pending', 'conv-1');

  const service = createSdkSessionSyncService(db);
  const result = service.syncSession({ sdk_session_id: 'sdk-1', conversation_id: 'conv-1' });

  assert.equal(result.conversationId, 'conv-1');
  assert.equal(result.sdkSessionId, 'sdk-1');
  assert.equal(result.runtimeSessionId, 'runtime-1');
  assert.equal(result.createdRuntimeSession, false);
  assert.equal(result.placeholderSdkSessionId, 'conv-1');

  const syncedConversation = db.prepare('SELECT sdk_session_id FROM conversations WHERE id = ?').get('conv-1');
  assert.equal(syncedConversation?.sdk_session_id, 'sdk-1');
  const syncedRuntimeSession = db.prepare('SELECT sdk_session_id FROM runtime_sessions WHERE id = ?').get('runtime-1');
  assert.equal(syncedRuntimeSession?.sdk_session_id, 'sdk-1');
  const pendingQueue = db.prepare('SELECT owner_sdk_session_id FROM queue WHERE id = ?').get('q-pending');
  assert.equal(pendingQueue?.owner_sdk_session_id, 'sdk-1');
});

test('placeholder rekey migrates every live queue status without touching attempt fences', () => {
  // Regression for audit #22: only pending rows used to migrate, so a
  // processing (or parked) row kept the placeholder owner and was orphaned the
  // moment the real session id took over.
  const db = createTestDb();
  insertConversation(db, 'conv-1', 'conv-1');
  insertRuntimeSession(db, 'runtime-1', 'conv-1', 'conv-1');
  insertQueueRow(db, 'q-pending', 'conv-1', 'pending', 'conv-1', 'attempt-pending');
  insertQueueRow(db, 'q-processing', 'conv-1', 'processing', 'conv-1', 'attempt-processing');
  insertQueueRow(db, 'q-parked', 'conv-1', 'parked', 'conv-1', 'attempt-parked');
  insertQueueRow(db, 'q-done', 'conv-1', 'done', 'conv-1', 'attempt-done');

  const service = createSdkSessionSyncService(db);
  const result = service.syncSession({ sdk_session_id: 'sdk-1', conversation_id: 'conv-1' });

  assert.equal(result.migratedQueueRows, 3);
  const rows = db.prepare('SELECT id, owner_sdk_session_id, attempt_id FROM queue ORDER BY id').all();
  assert.deepEqual(rows, [
    { id: 'q-done', owner_sdk_session_id: 'conv-1', attempt_id: 'attempt-done' },
    { id: 'q-parked', owner_sdk_session_id: 'sdk-1', attempt_id: 'attempt-parked' },
    { id: 'q-pending', owner_sdk_session_id: 'sdk-1', attempt_id: 'attempt-pending' },
    { id: 'q-processing', owner_sdk_session_id: 'sdk-1', attempt_id: 'attempt-processing' },
  ]);
});

test('syncSession only migrates queue rows for the bound conversation', () => {
  const db = createTestDb();
  insertConversation(db, 'conv-1', 'conv-1');
  insertRuntimeSession(db, 'runtime-1', 'conv-1', 'conv-1');
  insertQueueRow(db, 'q-pending-other', 'conv-2', 'pending', 'conv-1');

  const service = createSdkSessionSyncService(db);
  service.syncSession({ sdk_session_id: 'sdk-1', conversation_id: 'conv-1' });

  const otherConversationQueue = db.prepare('SELECT owner_sdk_session_id FROM queue WHERE id = ?').get('q-pending-other');
  assert.equal(otherConversationQueue?.owner_sdk_session_id, 'conv-1');
});

test('a successful sync flips the import ledger to relay ownership', () => {
  // Once a live CLI session binds, the relay drives the conversation; the
  // startup import sweep must never again overwrite its history from the raw
  // transcript (audit #19).
  const db = createTestDb();
  insertConversation(db, 'conv-1', 'conv-1');
  db.prepare(`
    INSERT INTO sdk_session_imports (sdk_session_id, conversation_id, status, updated_at, origin)
    VALUES ('conv-1', 'conv-1', 'completed', '2026-07-01T10:00:00.000Z', 'imported')
  `).run();

  const service = createSdkSessionSyncService(db);
  service.syncSession({ sdk_session_id: 'sdk-1', conversation_id: 'conv-1' });

  const origins = db.prepare(`SELECT sdk_session_id, origin FROM sdk_session_imports ORDER BY sdk_session_id`).all();
  assert.deepEqual(origins, [{ sdk_session_id: 'conv-1', origin: 'relay' }]);
});

test('a conflicting sync throws 409 and leaves every table unchanged', () => {
  const db = createTestDb();
  insertConversation(db, 'conv-1', 'sdk-other');
  insertConversation(db, 'conv-2', 'sdk-1');
  insertQueueRow(db, 'q-pending', 'conv-1', 'pending', 'sdk-other');
  const snapshot = () => ({
    conversations: db.prepare('SELECT * FROM conversations ORDER BY id').all(),
    runtimeSessions: db.prepare('SELECT * FROM runtime_sessions ORDER BY id').all(),
    queue: db.prepare('SELECT * FROM queue ORDER BY id').all(),
    imports: db.prepare('SELECT * FROM sdk_session_imports ORDER BY sdk_session_id').all(),
  });
  const before = snapshot();

  const service = createSdkSessionSyncService(db);
  assert.throws(
    () => service.syncSession({ sdk_session_id: 'sdk-1', conversation_id: 'conv-1' }),
    (error) => error.statusCode === 409,
  );

  assert.deepEqual(snapshot(), before);
});

test('validateBinding reports conflicts without requiring the conversation to exist', () => {
  const db = createTestDb();
  insertConversation(db, 'conv-owner', 'sdk-1');
  const service = createSdkSessionSyncService(db);

  // Missing conversation passes: workspace learning creates it later.
  assert.equal(service.validateBinding({ sdk_session_id: 'sdk-new', conversation_id: 'conv-new' }), true);

  // A session bound to another conversation must be vetoed before any state
  // is created for the new conversation (audit #21).
  assert.throws(
    () => service.validateBinding({ sdk_session_id: 'sdk-1', conversation_id: 'conv-new' }),
    (error) => error.statusCode === 409,
  );
});
