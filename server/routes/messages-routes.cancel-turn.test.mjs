import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { registerMessagesRoutes } from './messages-routes.mjs';

function createResponseRecorder() {
  return {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(value) {
      this.payload = value;
      return this;
    },
  };
}

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
      created_at TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE runtime_sessions (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL UNIQUE,
      sdk_session_id TEXT,
      strategy TEXT NOT NULL DEFAULT 'isolated',
      runtime_key TEXT,
      model TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT,
      last_used_at TEXT
    );
    CREATE TABLE deleted_sdk_sessions (
      sdk_session_id TEXT PRIMARY KEY,
      deleted_at TEXT NOT NULL
    );
    CREATE TABLE sdk_delete_requests (
      sdk_session_id TEXT PRIMARY KEY,
      conversation_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      requested_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      processing_at TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT,
      last_error TEXT
    );
    CREATE TABLE queue (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      runtime_session_id TEXT,
      is_new_conversation INTEGER NOT NULL DEFAULT 0,
      model TEXT,
      relay_mode TEXT NOT NULL DEFAULT 'agent',
      text TEXT,
      attachments TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      timestamp TEXT NOT NULL,
      processing_at TEXT,
      owner_sdk_session_id TEXT,
      owner_assigned_at TEXT,
      owner_lease_expires_at TEXT,
      owner_last_claimed_at TEXT,
      parked_at TEXT,
      parked_target_session_id TEXT,
      parked_transaction_id TEXT,
      parked_reason TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT,
      response_message_id TEXT,
      response TEXT
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
    CREATE TABLE relay_activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      queue_message_id TEXT NOT NULL,
      response_message_id TEXT,
      conversation_id TEXT NOT NULL,
      relay_mode TEXT NOT NULL DEFAULT 'agent',
      text TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE relay_stream_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      queue_message_id TEXT NOT NULL,
      response_message_id TEXT,
      conversation_id TEXT NOT NULL,
      relay_mode TEXT NOT NULL DEFAULT 'agent',
      seq INTEGER NOT NULL,
      text TEXT NOT NULL DEFAULT '',
      done INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE relay_control_requests (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      conversation_id TEXT,
      queue_message_id TEXT,
      sdk_session_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      request TEXT,
      result TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE TABLE relay_questions (
      id TEXT PRIMARY KEY,
      queue_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      relay_mode TEXT NOT NULL DEFAULT 'agent',
      prompt TEXT NOT NULL,
      choices TEXT,
      request TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      answer TEXT,
      sdk_session_id TEXT,
      owner_worker_id TEXT,
      continuation_id TEXT,
      continuation_question_id TEXT,
      created_at TEXT NOT NULL,
      answered_at TEXT,
      expires_at TEXT NOT NULL
    );
  `);

  const handlers = {};
  const emitted = [];
  const markIdleCalls = [];
  const markErrorCalls = [];
  const workerUpdates = [];
  const app = {
    post(path, ...fns) { handlers[path] = fns[fns.length - 1]; },
    get(path, ...fns) { handlers[path] = fns[fns.length - 1]; },
  };
  const stmts = {
    getConvAnyStatus: db.prepare('SELECT * FROM conversations WHERE id = ? LIMIT 1'),
    getRuntimeSessionByConversation: db.prepare('SELECT * FROM runtime_sessions WHERE conversation_id = ? LIMIT 1'),
    getLatestProcessingQueueByConversation: db.prepare(`
      SELECT *
      FROM queue
      WHERE conversation_id = ?
        AND status = 'processing'
      ORDER BY timestamp DESC
      LIMIT 1
    `),
    findQById: db.prepare('SELECT * FROM queue WHERE id = ? LIMIT 1'),
    setFailed: db.prepare(`
      UPDATE queue
      SET status = 'failed', response = ?
      WHERE id = ?
        AND status IN ('processing', 'pending', 'parked')
    `),
    setQueueResponseMessageId: db.prepare('UPDATE queue SET response_message_id = ? WHERE id = ?'),
    insertMsg: db.prepare(`
      INSERT INTO messages (id, conversation_id, role, text, model, mode, attachments, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `),
    linkActivityToResponse: db.prepare(`
      UPDATE relay_activity
      SET response_message_id = ?
      WHERE queue_message_id = ?
        AND response_message_id IS NULL
    `),
    linkStreamEventsToResponse: db.prepare(`
      UPDATE relay_stream_events
      SET response_message_id = ?
      WHERE queue_message_id = ?
        AND response_message_id IS NULL
    `),
    updateConvTime: db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?'),
    pruneQueue: db.prepare('DELETE FROM queue WHERE 1 = 0'),
  };

  registerMessagesRoutes(app, {
    auth: (_req, _res, next) => next(),
    io: { emit(event, payload) { emitted.push({ event, payload }); } },
    db,
    stmts,
    runtimeState: { relayPaused: false },
    config: {},
    uuidv4: (() => {
      let index = 0;
      return () => `uuid-${++index}`;
    })(),
    ts: () => 'ts',
    MAX_UPLOAD_BYTES: 1,
    MAX_UPLOAD_ATTACHMENTS: 1,
    MAX_REPO_TREE_NODES: 1,
    MAX_REQUEUE_RETRIES: 1,
    MAX_IMAGE_DATA_URL_LENGTH: 1,
    MAX_WORKSPACE_PREVIEW_BYTES: 1,
    MAX_REFERENCE_IMAGE_ATTACHMENT_BYTES: 1,
    remotePath: () => '',
    parseBooleanQueryFlag: () => false,
    buildRepositoryTreeSnapshot: () => ({}),
    fetchBrowsableDrives: async () => [],
    fetchDriveDirectoryEntries: async () => [],
    mapDriveDirectoryEntry: () => ({}),
    driveDisplayName: () => '',
    normalizeDriveAbsolutePath: (value) => value,
    driveRootFromAbsolutePath: (value) => value,
    toDriveWebPath: (value) => value,
    readWorkspaceFileMeta: async () => null,
    resolveWorkspaceFilePath: () => null,
    normalizeWorkspaceRelativePath: (value) => value,
    previewLanguageForWorkspaceFile: () => 'plaintext',
    readWorkspaceFilePreviewBuffer: async () => Buffer.alloc(0),
    isLikelyBinaryPreviewBuffer: () => false,
    isLikelyTextContentType: () => true,
    workspacePreviewKindForMeta: () => 'text',
    workspaceContentType: () => 'text/plain',
    persistUploadBuffer: async () => null,
    isSha256: () => false,
    uploadPathForSha: () => '',
    uploadContentUrlForSha: () => '',
    maybeApplyWorkspaceRootFromMessage: () => ({}),
    getOrCreateConversation: () => ({}),
    ensureRuntimeSessionBinding: () => ({}),
    linkUploadReferences: () => {},
    normalizeAttachments: () => [],
    collectReferenceAttachmentsFromText: () => ({ attachments: [], skipped: [] }),
    mergeMessageAttachments: () => [],
    attachmentSummary: () => '',
    createCompactedConversation: () => ({}),
    workspaceRootPayload: () => ({}),
    queueCounts: () => ({
      pendingCount: Number(db.prepare(`SELECT COUNT(*) AS count FROM queue WHERE status = 'pending'`).get()?.count || 0),
      processingCount: Number(db.prepare(`SELECT COUNT(*) AS count FROM queue WHERE status = 'processing'`).get()?.count || 0),
      parkedCount: Number(db.prepare(`SELECT COUNT(*) AS count FROM queue WHERE status = 'parked'`).get()?.count || 0),
    }),
    getModelCatalogState: () => ({}),
    buildRelayReadyBannerData: () => ({}),
    ensureSessionId: () => 'session-1',
    touchCli: () => {},
    recoverProcessingOlderThan: () => [],
    addMsIso: () => '',
    computeRetryDelayMs: () => 0,
    resolveRequestedModel: () => ({ ok: true, model: 'gpt-5.4-mini' }),
    normalizeRelayMode: (value) => value,
    DEFAULT_RELAY_MODE: 'agent',
    DEFAULT_MODEL: 'gpt-5.4-mini',
    configuredConversationSessionMode: 'isolated',
    parseAttachments: () => [],
    hydrateAttachment: () => null,
    relayActivityForResponse: () => [],
    relayActivityForQueueMessage: () => [],
    sanitizeActivityText: (value) => value,
    readSessionTranscriptMessages: () => [],
    inFlightStateForConversation: () => null,
    emitToClientsExceptSessionId: () => {},
    relayBridgeOwnerService: {
      normalizeIdentity: ({ sessionId }) => ({ sessionId }),
      observe: () => ({ accepted: true }),
      getOwner: () => null,
    },
    relayRestartOrchestrator: { getState: () => null },
    requestRelayShutdown: () => ({ accepted: true, status: 'queued' }),
    featureFlags: { SESSION_WORKER_ROUTING_ENABLED: true },
    sessionWorkerRegistry: {
      getWorker: (sessionId) => ({ sessionId, workerId: `worker-${sessionId}`, pid: 1234 }),
      upsertWorker: (worker) => workerUpdates.push(worker),
    },
    sessionWorkerSupervisor: {
      noteSessionHeartbeat: () => {},
      markIdle: (...args) => { markIdleCalls.push(args); },
      markError: (...args) => { markErrorCalls.push(args); },
      ensureWorker: async () => ({ ok: true }),
    },
  });

  return { db, handlers, emitted, markIdleCalls, markErrorCalls, workerUpdates };
}

function seedActiveTurn(db) {
  const now = '2026-05-24T20:00:00.000Z';
  db.prepare(`
    INSERT INTO conversations (id, title, sdk_session_id, status, updated_at)
    VALUES (?, ?, ?, 'active', ?)
  `).run('conv-1', 'Conversation', 'sdk-1', now);
  db.prepare(`
    INSERT INTO runtime_sessions (id, conversation_id, sdk_session_id)
    VALUES (?, ?, ?)
  `).run('runtime-1', 'conv-1', 'sdk-1');
  db.prepare(`
    INSERT INTO queue (id, conversation_id, model, relay_mode, status, timestamp, owner_sdk_session_id)
    VALUES (?, ?, ?, ?, 'processing', ?, ?)
  `).run('msg-1', 'conv-1', 'gpt-5.4', 'agent', now, 'sdk-1');
}

test('cancel-turn queues one abort control per active processing turn', () => {
  const { db, handlers } = createHarness();
  seedActiveTurn(db);

  const cancelHandler = handlers['/api/conversation/:conversationId/cancel-turn'];
  assert.equal(typeof cancelHandler, 'function');

  const first = createResponseRecorder();
  cancelHandler({
    params: { conversationId: 'conv-1' },
    body: { clientId: 'client-1', messageId: 'msg-1' },
    headers: {},
  }, first);

  assert.equal(first.statusCode, 200);
  assert.equal(first.payload?.ok, true);
  assert.equal(first.payload?.queued, true);
  assert.equal(first.payload?.duplicate, undefined);

  const second = createResponseRecorder();
  cancelHandler({
    params: { conversationId: 'conv-1' },
    body: { clientId: 'client-1', messageId: 'msg-1' },
    headers: {},
  }, second);

  assert.equal(second.statusCode, 200);
  assert.equal(second.payload?.duplicate, true);
  const rows = db.prepare('SELECT * FROM relay_control_requests ORDER BY created_at ASC').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.type, 'abort_turn');
  assert.equal(rows[0]?.queue_message_id, 'msg-1');
  assert.equal(rows[0]?.sdk_session_id, 'sdk-1');
  db.close();
});

test('abort control lookup stays scoped to the active queue message', () => {
  const { db, handlers } = createHarness();
  seedActiveTurn(db);

  handlers['/api/conversation/:conversationId/cancel-turn']({
    params: { conversationId: 'conv-1' },
    body: { clientId: 'client-1', messageId: 'msg-1' },
    headers: {},
  }, createResponseRecorder());

  const mismatch = createResponseRecorder();
  handlers['/api/control/active']({
    query: { sdkSessionId: 'sdk-1', queueMessageId: 'msg-2' },
    headers: { 'x-relay-session-id': 'sdk-1' },
  }, mismatch);

  assert.equal(mismatch.statusCode, 200);
  assert.equal(mismatch.payload?.control, null);
  db.close();
});

test('abort control completion marks the active queue row failed without worker error', () => {
  const { db, handlers, emitted, markIdleCalls, markErrorCalls, workerUpdates } = createHarness();
  seedActiveTurn(db);

  handlers['/api/conversation/:conversationId/cancel-turn']({
    params: { conversationId: 'conv-1' },
    body: { clientId: 'client-1', messageId: 'msg-1' },
    headers: {},
  }, createResponseRecorder());

  const claim = createResponseRecorder();
  handlers['/api/control/active']({
    query: { sdkSessionId: 'sdk-1' },
    headers: { 'x-relay-session-id': 'sdk-1' },
  }, claim);

  assert.equal(claim.statusCode, 200);
  assert.equal(claim.payload?.control?.status, 'processing');
  const controlId = String(claim.payload?.control?.id || '').trim();
  assert.ok(controlId);

  const complete = createResponseRecorder();
  handlers['/api/control/:controlId/result']({
    params: { controlId },
    body: { ok: true, note: 'session.abort completed' },
    headers: {},
  }, complete);

  assert.equal(complete.statusCode, 200);
  assert.equal(complete.payload?.ok, true);
  assert.equal(complete.payload?.control?.status, 'done');

  const queueRow = db.prepare('SELECT * FROM queue WHERE id = ?').get('msg-1');
  const responseMessage = db.prepare('SELECT * FROM messages WHERE id = ?').get(queueRow.response_message_id);
  assert.equal(queueRow.status, 'failed');
  assert.match(String(responseMessage?.text || ''), /stopped from the relay UI/i);
  assert.equal(markErrorCalls.length, 0);
  assert.equal(markIdleCalls.length, 1);
  assert.equal(workerUpdates[0]?.status, 'ready');
  assert.equal(emitted.some((entry) => entry.event === 'assistant_message'), true);
  assert.equal(emitted.some((entry) => entry.event === 'message_status' && entry.payload?.status === 'failed'), true);
  db.close();
});

test('heartbeat recovers an owned stale processing turn when the worker is idle', () => {
  const { db, handlers, emitted } = createHarness();
  seedActiveTurn(db);

  handlers['/api/conversation/:conversationId/cancel-turn']({
    params: { conversationId: 'conv-1' },
    body: { clientId: 'client-1', messageId: 'msg-1' },
    headers: {},
  }, createResponseRecorder());

  const heartbeat = createResponseRecorder();
  handlers['/api/heartbeat']({
    body: {},
    headers: {
      'x-relay-session-id': 'sdk-1',
    },
  }, heartbeat);

  assert.equal(heartbeat.statusCode, 200);
  const queueRow = db.prepare('SELECT * FROM queue WHERE id = ?').get('msg-1');
  const controlRow = db.prepare('SELECT * FROM relay_control_requests WHERE queue_message_id = ?').get('msg-1');
  assert.equal(queueRow.status, 'pending');
  assert.equal(queueRow.processing_at, null);
  assert.equal(controlRow.status, 'failed');
  assert.equal(controlRow.error, 'owner-heartbeat-idle');
  assert.equal(emitted.some((entry) => entry.event === 'message_status' && entry.payload?.status === 'pending'), true);
  db.close();
});

test('heartbeat keeps the owned active processing turn live when it reports the active queue message id', () => {
  const { db, handlers } = createHarness();
  seedActiveTurn(db);

  const before = db.prepare('SELECT owner_lease_expires_at, owner_last_claimed_at FROM queue WHERE id = ?').get('msg-1');
  assert.equal(before.owner_lease_expires_at, null);

  const heartbeat = createResponseRecorder();
  handlers['/api/heartbeat']({
    body: { activeQueueMessageId: 'msg-1' },
    headers: {
      'x-relay-session-id': 'sdk-1',
    },
  }, heartbeat);

  assert.equal(heartbeat.statusCode, 200);
  const queueRow = db.prepare('SELECT * FROM queue WHERE id = ?').get('msg-1');
  assert.equal(queueRow.status, 'processing');
  assert.ok(queueRow.owner_lease_expires_at);
  assert.ok(queueRow.owner_last_claimed_at);
  db.close();
});

test('stale abort controls are rejected instead of being claimed for a non-processing queue row', () => {
  const { db, handlers } = createHarness();
  seedActiveTurn(db);
  db.prepare(`UPDATE queue SET status = 'pending', processing_at = NULL WHERE id = ?`).run('msg-1');
  db.prepare(`
    INSERT INTO relay_control_requests (
      id, type, conversation_id, queue_message_id, sdk_session_id, status, request, created_at, updated_at
    ) VALUES (?, 'abort_turn', ?, ?, ?, 'pending', ?, ?, ?)
  `).run(
    'control-1',
    'conv-1',
    'msg-1',
    'sdk-1',
    '{"source":"test"}',
    '2026-05-24T23:00:00.000Z',
    '2026-05-24T23:00:00.000Z',
  );

  const claim = createResponseRecorder();
  handlers['/api/control/active']({
    query: { sdkSessionId: 'sdk-1', queueMessageId: 'msg-1' },
    headers: { 'x-relay-session-id': 'sdk-1' },
  }, claim);

  assert.equal(claim.statusCode, 200);
  assert.equal(claim.payload?.control, null);
  const controlRow = db.prepare('SELECT * FROM relay_control_requests WHERE id = ?').get('control-1');
  assert.equal(controlRow.status, 'failed');
  assert.equal(controlRow.error, 'stale-control');
  db.close();
});

test('cancel-turn ignores a stale client message id after the next queued turn becomes active', () => {
  const { db, handlers } = createHarness();
  seedActiveTurn(db);
  const now = '2026-05-24T20:00:01.000Z';
  db.prepare(`UPDATE queue SET status = 'done', processing_at = NULL WHERE id = ?`).run('msg-1');
  db.prepare(`
    INSERT INTO queue (id, conversation_id, model, relay_mode, status, timestamp, owner_sdk_session_id)
    VALUES (?, ?, ?, ?, 'processing', ?, ?)
  `).run('msg-2', 'conv-1', 'gpt-5.4', 'agent', now, 'sdk-1');

  const cancel = createResponseRecorder();
  handlers['/api/conversation/:conversationId/cancel-turn']({
    params: { conversationId: 'conv-1' },
    body: { clientId: 'client-1', messageId: 'msg-1' },
    headers: {},
  }, cancel);

  assert.equal(cancel.statusCode, 200);
  assert.equal(cancel.payload?.ok, true);
  assert.equal(cancel.payload?.queued, false);
  assert.equal(cancel.payload?.acknowledgement, 'already-finished');
  assert.equal(cancel.payload?.requestedMessageId, 'msg-1');
  assert.equal(cancel.payload?.activeMessageId, 'msg-2');
  const rows = db.prepare('SELECT * FROM relay_control_requests ORDER BY created_at ASC').all();
  assert.equal(rows.length, 0);
  db.close();
});
