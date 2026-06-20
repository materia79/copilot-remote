import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { createSessionHistoryRefreshService } from './session-history-refresh-service.mjs';

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      sdk_session_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      model TEXT,
      mode TEXT,
      attachments TEXT,
      timestamp TEXT NOT NULL
    );
    CREATE TABLE queue (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE relay_activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      queue_message_id TEXT NOT NULL,
      response_message_id TEXT,
      conversation_id TEXT NOT NULL,
      relay_mode TEXT NOT NULL DEFAULT 'agent',
      text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      subagent_run_id TEXT
    );
    CREATE TABLE relay_stream_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      queue_message_id TEXT NOT NULL,
      response_message_id TEXT,
      conversation_id TEXT NOT NULL,
      relay_mode TEXT NOT NULL DEFAULT 'agent',
      seq INTEGER NOT NULL,
      text TEXT NOT NULL,
      done INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE relay_thought (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      queue_message_id TEXT NOT NULL,
      response_message_id TEXT,
      conversation_id TEXT NOT NULL,
      relay_mode TEXT NOT NULL DEFAULT 'agent',
      reasoning_id TEXT,
      seq INTEGER NOT NULL,
      text TEXT NOT NULL,
      done INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE relay_questions (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL
    );
    CREATE TABLE relay_boards (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL
    );
    CREATE TABLE subagent_runs (
      id TEXT PRIMARY KEY,
      queue_message_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      parent_subagent_id TEXT,
      display_name TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    );
  `);
  return db;
}

function makeStmts(db) {
  return {
    getConv: db.prepare(`SELECT * FROM conversations WHERE id = ?`),
    insertConv: db.prepare(`INSERT OR IGNORE INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`),
    setConvSdkSessionIdIfMissing: db.prepare(`
      UPDATE conversations
      SET sdk_session_id = ?, updated_at = ?
      WHERE id = ? AND (sdk_session_id IS NULL OR sdk_session_id = '')
    `),
    insertMsg: db.prepare(`
      INSERT INTO messages (id, conversation_id, role, text, model, mode, attachments, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `),
    insertActivity: db.prepare(`
      INSERT INTO relay_activity (queue_message_id, response_message_id, conversation_id, relay_mode, text, created_at, subagent_run_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `),
    deleteConvActivity: db.prepare(`DELETE FROM relay_activity WHERE conversation_id = ?`),
    deleteConvThoughts: db.prepare(`DELETE FROM relay_thought WHERE conversation_id = ?`),
    deleteConvStreamEvents: db.prepare(`DELETE FROM relay_stream_events WHERE conversation_id = ?`),
    deleteConvSubagentRuns: db.prepare(`DELETE FROM subagent_runs WHERE conversation_id = ?`),
  };
}

test('clearRetrievableHistory removes only retrievable tables', () => {
  const db = makeDb();
  const stmts = makeStmts(db);
  db.prepare(`INSERT INTO conversations (id, title, sdk_session_id, created_at, updated_at) VALUES ('conv-1', 'One', 'conv-1', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`).run();
  db.prepare(`INSERT INTO messages (id, conversation_id, role, text, timestamp) VALUES ('m1', 'conv-1', 'user', 'hello', '2026-01-01T00:00:01Z')`).run();
  db.prepare(`INSERT INTO relay_activity (queue_message_id, response_message_id, conversation_id, relay_mode, text, created_at) VALUES ('q1', 'm2', 'conv-1', 'agent', 'Tool (rg)', '2026-01-01T00:00:02Z')`).run();
  db.prepare(`INSERT INTO relay_thought (queue_message_id, response_message_id, conversation_id, relay_mode, seq, text, created_at) VALUES ('q1', 'm2', 'conv-1', 'agent', 1, 'thinking', '2026-01-01T00:00:03Z')`).run();
  db.prepare(`INSERT INTO relay_stream_events (queue_message_id, response_message_id, conversation_id, relay_mode, seq, text, done, created_at) VALUES ('q1', 'm2', 'conv-1', 'agent', 1, 'partial', 0, '2026-01-01T00:00:04Z')`).run();
  db.prepare(`INSERT INTO subagent_runs (id, queue_message_id, conversation_id, status, started_at, updated_at) VALUES ('sub-1', 'q1', 'conv-1', 'running', '2026-01-01T00:00:05Z', '2026-01-01T00:00:05Z')`).run();
  db.prepare(`INSERT INTO relay_questions (id, conversation_id) VALUES ('rq-1', 'conv-1')`).run();
  db.prepare(`INSERT INTO queue (id, conversation_id, status) VALUES ('q1', 'conv-1', 'done')`).run();

  const service = createSessionHistoryRefreshService({ db, stmts });
  assert.equal(service.clearRetrievableHistory('conv-1'), true);

  assert.equal(Number(db.prepare(`SELECT COUNT(*) AS cnt FROM messages WHERE conversation_id = 'conv-1'`).get()?.cnt || 0), 0);
  assert.equal(Number(db.prepare(`SELECT COUNT(*) AS cnt FROM relay_activity WHERE conversation_id = 'conv-1'`).get()?.cnt || 0), 0);
  assert.equal(Number(db.prepare(`SELECT COUNT(*) AS cnt FROM relay_thought WHERE conversation_id = 'conv-1'`).get()?.cnt || 0), 0);
  assert.equal(Number(db.prepare(`SELECT COUNT(*) AS cnt FROM relay_stream_events WHERE conversation_id = 'conv-1'`).get()?.cnt || 0), 0);
  assert.equal(Number(db.prepare(`SELECT COUNT(*) AS cnt FROM subagent_runs WHERE conversation_id = 'conv-1'`).get()?.cnt || 0), 0);
  assert.equal(Number(db.prepare(`SELECT COUNT(*) AS cnt FROM relay_questions WHERE conversation_id = 'conv-1'`).get()?.cnt || 0), 1);
  assert.equal(Number(db.prepare(`SELECT COUNT(*) AS cnt FROM queue WHERE conversation_id = 'conv-1'`).get()?.cnt || 0), 1);
});

test('ensureConversationForRefresh bootstraps discovered-only session', () => {
  const db = makeDb();
  const stmts = makeStmts(db);
  const service = createSessionHistoryRefreshService({
    db,
    stmts,
    discoverSessionStateConversations: () => ([
      { sdkSessionId: 'conv-2', title: 'Discovered Session' },
    ]),
  });
  const result = service.ensureConversationForRefresh('conv-2');
  assert.equal(result.ok, true);
  assert.equal(result.created, true);
  assert.equal(result.conversation.id, 'conv-2');
  assert.equal(result.conversation.sdk_session_id, 'conv-2');
});

test('evaluateRefreshIdleState rejects busy queue and in-flight processing', () => {
  const db = makeDb();
  const stmts = makeStmts(db);
  db.prepare(`INSERT INTO conversations (id, title, sdk_session_id, created_at, updated_at) VALUES ('conv-3', 'Three', 'conv-3', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`).run();
  db.prepare(`INSERT INTO queue (id, conversation_id, status) VALUES ('q-3', 'conv-3', 'processing')`).run();

  const busyQueueService = createSessionHistoryRefreshService({
    db,
    stmts,
    inFlightStateForConversation: () => null,
  });
  assert.deepEqual(busyQueueService.evaluateRefreshIdleState('conv-3'), { idle: false, reason: 'queue-busy' });

  db.prepare(`DELETE FROM queue WHERE conversation_id = 'conv-3'`).run();
  const busyTurnService = createSessionHistoryRefreshService({
    db,
    stmts,
    inFlightStateForConversation: () => ({ status: 'processing' }),
  });
  assert.deepEqual(busyTurnService.evaluateRefreshIdleState('conv-3'), { idle: false, reason: 'turn-processing' });
});

test('persistRebuiltHistory stores messages and assistant activities', () => {
  const db = makeDb();
  const stmts = makeStmts(db);
  db.prepare(`INSERT INTO conversations (id, title, sdk_session_id, created_at, updated_at) VALUES ('conv-4', 'Four', 'conv-4', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`).run();
  const service = createSessionHistoryRefreshService({ db, stmts });

  const messages = [
    { id: 'u1', role: 'user', text: 'hello', timestamp: '2026-01-01T00:00:01Z' },
    { id: 'a1', role: 'assistant', text: 'world', timestamp: '2026-01-01T00:00:02Z', activities: ['Tool (rg): foo'] },
  ];
  const persisted = service.persistRebuiltHistory('conv-4', messages);
  assert.equal(persisted.insertedCount, 2);
  assert.equal(Number(db.prepare(`SELECT COUNT(*) AS cnt FROM messages WHERE conversation_id = 'conv-4'`).get()?.cnt || 0), 2);
  const activityRows = db.prepare(`
    SELECT queue_message_id, response_message_id, text
    FROM relay_activity
    WHERE conversation_id = 'conv-4'
    ORDER BY id ASC
  `).all();
  assert.deepEqual(activityRows, [
    { queue_message_id: 'a1', response_message_id: 'a1', text: 'Tool (rg): foo' },
  ]);
});

test('mapSdkEventsToMessages delegates to shared parser', () => {
  const db = makeDb();
  const stmts = makeStmts(db);
  const calls = [];
  const service = createSessionHistoryRefreshService({
    db,
    stmts,
    parseSessionEventsToMessages: (events) => {
      calls.push(events);
      return [{ id: 'a1', role: 'assistant', text: 'ok', timestamp: '2026-01-01T00:00:00Z' }];
    },
  });
  const mapped = service.mapSdkEventsToMessages([{ type: 'assistant.message', data: { content: 'ok' } }]);
  assert.equal(calls.length, 1);
  assert.equal(mapped.length, 1);
  assert.equal(mapped[0].id, 'a1');
});

test('replaceRetrievableHistory swaps messages atomically', () => {
  const db = makeDb();
  const stmts = makeStmts(db);
  db.prepare(`INSERT INTO conversations (id, title, sdk_session_id, created_at, updated_at) VALUES ('conv-5', 'Five', 'conv-5', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`).run();
  db.prepare(`INSERT INTO messages (id, conversation_id, role, text, timestamp) VALUES ('old', 'conv-5', 'user', 'old text', '2026-01-01T00:00:01Z')`).run();
  const service = createSessionHistoryRefreshService({ db, stmts });
  assert.equal(service.countRetrievableMessages('conv-5'), 1);

  service.replaceRetrievableHistory('conv-5', [
    { id: 'new-u', role: 'user', text: 'fresh', timestamp: '2026-01-01T00:00:02Z' },
    {
      id: 'new-a',
      role: 'assistant',
      text: 'reply',
      timestamp: '2026-01-01T00:00:03Z',
      activities: [{ text: 'Tool (rg): scan', subagentRunId: 'sub-9' }],
    },
  ]);

  const rows = db.prepare(`SELECT id, text FROM messages WHERE conversation_id = 'conv-5' ORDER BY timestamp ASC`).all();
  assert.deepEqual(rows, [
    { id: 'new-u', text: 'fresh' },
    { id: 'new-a', text: 'reply' },
  ]);
  const activityRow = db.prepare(`
    SELECT text, subagent_run_id
    FROM relay_activity
    WHERE conversation_id = 'conv-5'
    ORDER BY id ASC
  `).get();
  assert.deepEqual(activityRow, { text: 'Tool (rg): scan', subagent_run_id: 'sub-9' });
});

test('countRetrievableMessages reports stored message count', () => {
  const db = makeDb();
  const stmts = makeStmts(db);
  db.prepare(`INSERT INTO conversations (id, title, sdk_session_id, created_at, updated_at) VALUES ('conv-6', 'Six', 'conv-6', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`).run();
  db.prepare(`INSERT INTO messages (id, conversation_id, role, text, timestamp) VALUES ('m1', 'conv-6', 'user', 'one', '2026-01-01T00:00:01Z')`).run();
  db.prepare(`INSERT INTO messages (id, conversation_id, role, text, timestamp) VALUES ('m2', 'conv-6', 'assistant', 'two', '2026-01-01T00:00:02Z')`).run();
  const service = createSessionHistoryRefreshService({ db, stmts });
  assert.equal(service.countRetrievableMessages('conv-6'), 2);
});
