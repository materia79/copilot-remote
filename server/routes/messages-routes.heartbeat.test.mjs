import test from 'node:test';
import assert from 'node:assert/strict';
import { registerMessagesRoutes } from './messages-routes.mjs';

test('api heartbeat refreshes the session worker heartbeat', () => {
  const handlers = {};
  const app = {
    post(path, ...fns) {
      handlers[path] = fns[fns.length - 1];
    },
    get() {},
  };

  const noteCalls = [];
  const observeCalls = [];
  let touchCliCalls = 0;
  let payload = null;
  const preparedStatement = {
    run() { return { changes: 0, lastInsertRowid: 0 }; },
    get() { return null; },
    all() { return []; },
  };

  registerMessagesRoutes(app, {
    auth: (_req, _res, next) => next(),
    io: { emit() {} },
    db: { prepare: () => preparedStatement },
    stmts: {},
    runtimeState: { relayPaused: false },
    config: {},
    uuidv4: () => 'uuid',
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
    queueCounts: () => ({ pendingCount: 7 }),
    getModelCatalogState: () => ({}),
    buildRelayReadyBannerData: () => ({}),
    ensureSessionId: () => 'session-1',
    touchCli: () => { touchCliCalls += 1; },
    recoverProcessingOlderThan: () => [],
    addMsIso: () => '',
    computeRetryDelayMs: () => 0,
    resolveRequestedModel: () => ({}),
    normalizeRelayMode: (value) => value,
    DEFAULT_RELAY_MODE: 'agent',
    DEFAULT_MODEL: 'gpt-5.4-mini',
    configuredConversationSessionMode: 'isolated',
    parseAttachments: () => [],
    hydrateAttachment: () => null,
    relayActivityForResponse: () => [],
    relayActivityForQueueMessage: () => [],
    sanitizeActivityText: (value) => value,
    inFlightStateForConversation: () => null,
    emitToClientsExceptSessionId: () => {},
    relayBridgeOwnerService: {
      normalizeIdentity: ({ pid, parentPid, sessionId, conversationId }) => ({ pid, parentPid, sessionId, conversationId }),
      observe(identity) {
        observeCalls.push(identity);
        return { accepted: true };
      },
      getOwner: () => null,
    },
    relayRestartOrchestrator: { getState: () => null },
    featureFlags: {},
    sessionWorkerRegistry: { getWorker: () => null, upsertWorker: () => {} },
    sessionWorkerSupervisor: {
      noteSessionHeartbeat(sessionId) {
        noteCalls.push(sessionId);
      },
      markIdle: () => {},
      ensureWorker: async () => ({ ok: true }),
    },
  });

  assert.equal(typeof handlers['/api/heartbeat'], 'function');

  const res = {
    json(value) {
      payload = value;
      return this;
    },
  };

  handlers['/api/heartbeat']({
    headers: {
      'x-relay-process-pid': '111',
      'x-relay-parent-pid': '222',
      'x-relay-session-id': 'sdk-heartbeat',
      'x-relay-conversation-id': 'conv-heartbeat',
    },
  }, res);

  assert.equal(touchCliCalls, 1);
  assert.deepEqual(noteCalls, ['sdk-heartbeat']);
  assert.equal(observeCalls[0]?.sessionId, 'sdk-heartbeat');
  assert.deepEqual(payload, { ok: true, pendingCount: 7 });
});

test('api stream persists events with increasing sequence', () => {
  const handlers = {};
  const app = {
    post(path, ...fns) {
      handlers[path] = fns[fns.length - 1];
    },
    get() {},
  };

  const emitted = [];
  const streamRows = [];
  const preparedStatement = {
    run() { return { changes: 0, lastInsertRowid: 0 }; },
    get() { return null; },
    all() { return []; },
  };

  registerMessagesRoutes(app, {
    auth: (_req, _res, next) => next(),
    io: { emit(event, payload) { emitted.push({ event, payload }); } },
    db: {
      prepare: () => preparedStatement,
      transaction: (fn) => (...args) => fn(...args),
    },
    stmts: {
      findQById: {
        get: () => ({ conversation_id: 'conv-1', response_message_id: null }),
      },
      getLastStreamSeqByQueueMessage: {
        get: (messageId) => {
          const rows = streamRows.filter((row) => row.messageId === messageId);
          if (!rows.length) return { max_seq: 0 };
          return { max_seq: Math.max(...rows.map((row) => row.seq)) };
        },
      },
      insertStreamEvent: {
        run: (messageId, responseMessageId, conversationId, relayMode, seq, text, done, createdAt) => {
          streamRows.push({
            messageId,
            responseMessageId,
            conversationId,
            relayMode,
            seq,
            text,
            done,
            createdAt,
          });
          return { changes: 1 };
        },
      },
    },
    runtimeState: { relayPaused: false },
    config: {},
    uuidv4: () => 'uuid',
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
    queueCounts: () => ({ pendingCount: 0, processingCount: 0, parkedCount: 0 }),
    getModelCatalogState: () => ({}),
    buildRelayReadyBannerData: () => ({}),
    ensureSessionId: () => 'session-1',
    touchCli: () => {},
    recoverProcessingOlderThan: () => [],
    addMsIso: () => '',
    computeRetryDelayMs: () => 0,
    resolveRequestedModel: () => ({}),
    normalizeRelayMode: (value) => value,
    DEFAULT_RELAY_MODE: 'agent',
    DEFAULT_MODEL: 'gpt-5.4-mini',
    configuredConversationSessionMode: 'isolated',
    parseAttachments: () => [],
    hydrateAttachment: () => null,
    relayActivityForResponse: () => [],
    relayActivityForQueueMessage: () => [],
    sanitizeActivityText: (value) => value,
    inFlightStateForConversation: () => null,
    emitToClientsExceptSessionId: () => {},
    relayBridgeOwnerService: {
      normalizeIdentity: () => null,
      observe: () => ({ accepted: true }),
      getOwner: () => null,
    },
    relayRestartOrchestrator: { getState: () => null },
    featureFlags: {},
    sessionWorkerRegistry: { getWorker: () => null, upsertWorker: () => {} },
    sessionWorkerSupervisor: {
      noteSessionHeartbeat: () => {},
      markIdle: () => {},
      ensureWorker: async () => ({ ok: true }),
    },
  });

  assert.equal(typeof handlers['/api/stream'], 'function');

  const makeRes = () => ({
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(value) {
      this.payload = value;
      return this;
    },
  });

  const res1 = makeRes();
  handlers['/api/stream']({
    body: {
      messageId: 'msg-1',
      conversationId: 'conv-1',
      text: 'hello',
      mode: 'agent',
      done: false,
    },
  }, res1);
  assert.equal(res1.statusCode, 200);
  assert.equal(res1.payload?.ok, true);
  assert.equal(res1.payload?.seq, 1);

  const res2 = makeRes();
  handlers['/api/stream']({
    body: {
      messageId: 'msg-1',
      conversationId: 'conv-1',
      text: 'hello world',
      mode: 'agent',
      done: true,
    },
  }, res2);
  assert.equal(res2.statusCode, 200);
  assert.equal(res2.payload?.ok, true);
  assert.equal(res2.payload?.seq, 2);

  assert.equal(streamRows.length, 2);
  assert.equal(streamRows[0].seq, 1);
  assert.equal(streamRows[1].seq, 2);
  assert.equal(streamRows[1].done, 1);

  const relayEvents = emitted.filter((entry) => entry.event === 'relay_stream');
  assert.equal(relayEvents.length, 2);
  assert.equal(relayEvents[0].payload?.seq, 1);
  assert.equal(relayEvents[1].payload?.seq, 2);
});

test('api response links persisted stream events to response message', async () => {
  const handlers = {};
  const app = {
    post(path, ...fns) {
      handlers[path] = fns[fns.length - 1];
    },
    get() {},
  };

  const linkCalls = [];
  const preparedStatement = {
    run() { return { changes: 0, lastInsertRowid: 0 }; },
    get() { return null; },
    all() { return []; },
  };

  registerMessagesRoutes(app, {
    auth: (_req, _res, next) => next(),
    io: { emit() {} },
    db: {
      prepare: () => preparedStatement,
      transaction: (fn) => (...args) => fn(...args),
    },
    stmts: {
      findQById: {
        get: () => ({
          id: 'msg-1',
          conversation_id: 'conv-1',
          status: 'processing',
          relay_mode: 'agent',
          model: 'gpt-5.4-mini',
          runtime_session_id: null,
          owner_sdk_session_id: null,
          retry_count: 0,
        }),
      },
      setDone: { run: () => ({ changes: 1 }) },
      setQueueResponseMessageId: { run: () => ({ changes: 1 }) },
      insertMsg: { run: () => ({ changes: 1 }) },
      linkActivityToResponse: { run: () => ({ changes: 1 }) },
      linkStreamEventsToResponse: {
        run: (responseId, messageId) => {
          linkCalls.push({ responseId, messageId });
          return { changes: 1 };
        },
      },
      updateConvTime: { run: () => ({ changes: 1 }) },
      pruneQueue: { run: () => ({ changes: 0 }) },
    },
    runtimeState: { relayPaused: false },
    config: {},
    uuidv4: () => 'resp-1',
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
    queueCounts: () => ({ pendingCount: 0, processingCount: 0, parkedCount: 0 }),
    getModelCatalogState: () => ({}),
    buildRelayReadyBannerData: () => ({}),
    ensureSessionId: () => 'session-1',
    touchCli: () => {},
    recoverProcessingOlderThan: () => [],
    addMsIso: () => '',
    computeRetryDelayMs: () => 0,
    resolveRequestedModel: () => ({}),
    normalizeRelayMode: (value) => value,
    DEFAULT_RELAY_MODE: 'agent',
    DEFAULT_MODEL: 'gpt-5.4-mini',
    configuredConversationSessionMode: 'isolated',
    parseAttachments: () => [],
    hydrateAttachment: () => null,
    relayActivityForResponse: () => [],
    relayActivityForQueueMessage: () => [],
    sanitizeActivityText: (value) => value,
    inFlightStateForConversation: () => null,
    emitToClientsExceptSessionId: () => {},
    relayBridgeOwnerService: {
      normalizeIdentity: () => null,
      observe: () => ({ accepted: true }),
      getOwner: () => null,
    },
    relayRestartOrchestrator: { getState: () => null },
    featureFlags: {},
    sessionWorkerRegistry: { getWorker: () => null, upsertWorker: () => {} },
    sessionWorkerSupervisor: {
      noteSessionHeartbeat: () => {},
      markIdle: () => {},
      ensureWorker: async () => ({ ok: true }),
    },
  });

  assert.equal(typeof handlers['/api/response'], 'function');

  const res = {
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(value) {
      this.payload = value;
      return this;
    },
  };

  await handlers['/api/response']({
    body: {
      messageId: 'msg-1',
      conversationId: 'conv-1',
      text: 'done text',
      model: 'gpt-5.4-mini',
      mode: 'agent',
    },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload?.ok, true);
  assert.equal(linkCalls.length, 1);
  assert.equal(linkCalls[0].messageId, 'msg-1');
  assert.equal(linkCalls[0].responseId, 'resp-1');
});

test('api response resolves opaque relay text from the session transcript', async () => {
  const handlers = {};
  const app = {
    post(path, ...fns) {
      handlers[path] = fns[fns.length - 1];
    },
    get() {},
  };

  const emitted = [];
  const setDoneCalls = [];
  const insertCalls = [];
  const preparedStatement = {
    run() { return { changes: 0, lastInsertRowid: 0 }; },
    get() { return null; },
    all() { return []; },
  };

  registerMessagesRoutes(app, {
    auth: (_req, _res, next) => next(),
    io: { emit(event, payload) { emitted.push({ event, payload }); } },
    db: {
      prepare: () => preparedStatement,
      transaction: (fn) => (...args) => fn(...args),
    },
    stmts: {
      getConvAnyStatus: {
        get: () => ({
          id: 'conv-1',
          sdk_session_id: 'sdk-1',
          status: 'active',
        }),
      },
      findQById: {
        get: () => ({
          id: 'msg-1',
          conversation_id: 'conv-1',
          status: 'processing',
          relay_mode: 'agent',
          model: 'gpt-5.4-mini',
          runtime_session_id: null,
          owner_sdk_session_id: null,
          retry_count: 0,
          timestamp: '2026-05-24T00:51:25.565Z',
        }),
      },
      setDone: {
        run: (value, messageId) => {
          setDoneCalls.push({ value, messageId });
          return { changes: 1 };
        },
      },
      setQueueResponseMessageId: { run: () => ({ changes: 1 }) },
      insertMsg: {
        run: (id, conversationId, role, text) => {
          insertCalls.push({ id, conversationId, role, text });
          return { changes: 1 };
        },
      },
      linkActivityToResponse: { run: () => ({ changes: 1 }) },
      linkStreamEventsToResponse: { run: () => ({ changes: 1 }) },
      updateConvTime: { run: () => ({ changes: 1 }) },
      pruneQueue: { run: () => ({ changes: 0 }) },
    },
    runtimeState: { relayPaused: false },
    config: {},
    uuidv4: () => 'resp-1',
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
    queueCounts: () => ({ pendingCount: 0, processingCount: 0, parkedCount: 0 }),
    getModelCatalogState: () => ({}),
    buildRelayReadyBannerData: () => ({}),
    ensureSessionId: () => 'session-1',
    touchCli: () => {},
    recoverProcessingOlderThan: () => [],
    addMsIso: () => '',
    computeRetryDelayMs: () => 0,
    resolveRequestedModel: () => ({}),
    normalizeRelayMode: (value) => value,
    DEFAULT_RELAY_MODE: 'agent',
    DEFAULT_MODEL: 'gpt-5.4-mini',
    configuredConversationSessionMode: 'isolated',
    parseAttachments: () => [],
    hydrateAttachment: () => null,
    relayActivityForResponse: () => [],
    relayActivityForQueueMessage: () => [],
    sanitizeActivityText: (value) => value,
    readSessionTranscriptMessages: () => ([
      { role: 'user', text: 'Test', timestamp: '2026-05-24T00:51:25.565Z' },
      { role: 'assistant', text: 'Test received.', timestamp: '2026-05-24T00:51:27.271Z' },
    ]),
    inFlightStateForConversation: () => null,
    emitToClientsExceptSessionId: () => {},
    relayBridgeOwnerService: {
      normalizeIdentity: () => null,
      observe: () => ({ accepted: true }),
      getOwner: () => null,
    },
    relayRestartOrchestrator: { getState: () => null },
    featureFlags: {},
    sessionWorkerRegistry: { getWorker: () => null, upsertWorker: () => {} },
    sessionWorkerSupervisor: {
      noteSessionHeartbeat: () => {},
      markIdle: () => {},
      ensureWorker: async () => ({ ok: true }),
    },
  });

  assert.equal(typeof handlers['/api/response'], 'function');

  const res = {
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(value) {
      this.payload = value;
      return this;
    },
  };

  await handlers['/api/response']({
    body: {
      messageId: 'msg-1',
      conversationId: 'conv-1',
      text: 'f21fe718-8f05-4388-9275-2768fc04ee46',
      model: 'gpt-5.4-mini',
      mode: 'agent',
    },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload?.ok, true);
  assert.equal(setDoneCalls[0]?.value, 'Test received.');
  assert.equal(insertCalls[0]?.text, 'Test received.');
  assert.equal(emitted.find((entry) => entry.event === 'assistant_message')?.payload?.message?.text, 'Test received.');
});

test('api response waits for a post-queue transcript assistant reply instead of reusing the previous one', async () => {
  const handlers = {};
  const app = {
    post(path, ...fns) {
      handlers[path] = fns[fns.length - 1];
    },
    get() {},
  };

  const setDoneCalls = [];
  let transcriptReads = 0;
  const preparedStatement = {
    run() { return { changes: 0, lastInsertRowid: 0 }; },
    get() { return null; },
    all() { return []; },
  };

  registerMessagesRoutes(app, {
    auth: (_req, _res, next) => next(),
    io: { emit() {} },
    db: {
      prepare: () => preparedStatement,
      transaction: (fn) => (...args) => fn(...args),
    },
    stmts: {
      getConvAnyStatus: {
        get: () => ({
          id: 'conv-1',
          sdk_session_id: 'sdk-1',
          status: 'active',
        }),
      },
      findQById: {
        get: () => ({
          id: 'msg-1',
          conversation_id: 'conv-1',
          status: 'processing',
          relay_mode: 'agent',
          model: 'gpt-5.4-mini',
          runtime_session_id: null,
          owner_sdk_session_id: null,
          retry_count: 0,
          timestamp: '2026-05-24T00:04:18.037Z',
        }),
      },
      setDone: {
        run: (value) => {
          setDoneCalls.push(value);
          return { changes: 1 };
        },
      },
      setQueueResponseMessageId: { run: () => ({ changes: 1 }) },
      insertMsg: { run: () => ({ changes: 1 }) },
      linkActivityToResponse: { run: () => ({ changes: 1 }) },
      linkStreamEventsToResponse: { run: () => ({ changes: 1 }) },
      updateConvTime: { run: () => ({ changes: 1 }) },
      pruneQueue: { run: () => ({ changes: 0 }) },
    },
    runtimeState: { relayPaused: false },
    config: {},
    uuidv4: () => 'resp-1',
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
    queueCounts: () => ({ pendingCount: 0, processingCount: 0, parkedCount: 0 }),
    getModelCatalogState: () => ({}),
    buildRelayReadyBannerData: () => ({}),
    ensureSessionId: () => 'session-1',
    touchCli: () => {},
    recoverProcessingOlderThan: () => [],
    addMsIso: () => '',
    computeRetryDelayMs: () => 0,
    resolveRequestedModel: () => ({}),
    normalizeRelayMode: (value) => value,
    DEFAULT_RELAY_MODE: 'agent',
    DEFAULT_MODEL: 'gpt-5.4-mini',
    configuredConversationSessionMode: 'isolated',
    parseAttachments: () => [],
    hydrateAttachment: () => null,
    relayActivityForResponse: () => [],
    relayActivityForQueueMessage: () => [],
    sanitizeActivityText: (value) => value,
    readSessionTranscriptMessages: () => {
      transcriptReads += 1;
      if (transcriptReads === 1) {
        return [
          { role: 'assistant', text: 'Shutdown accepted.', timestamp: '2026-05-24T00:02:42.793Z' },
        ];
      }
      return [
        { role: 'assistant', text: 'Shutdown accepted.', timestamp: '2026-05-24T00:02:42.793Z' },
        { role: 'assistant', text: 'Actual new reply.', timestamp: '2026-05-24T00:04:35.097Z' },
      ];
    },
    inFlightStateForConversation: () => null,
    emitToClientsExceptSessionId: () => {},
    relayBridgeOwnerService: {
      normalizeIdentity: () => null,
      observe: () => ({ accepted: true }),
      getOwner: () => null,
    },
    relayRestartOrchestrator: { getState: () => null },
    featureFlags: {},
    sessionWorkerRegistry: { getWorker: () => null, upsertWorker: () => {} },
    sessionWorkerSupervisor: {
      noteSessionHeartbeat: () => {},
      markIdle: () => {},
      ensureWorker: async () => ({ ok: true }),
    },
    opaqueResponseRecoveryWaitMs: 5,
    opaqueResponseRecoveryPollMs: 1,
  });

  const res = {
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(value) {
      this.payload = value;
      return this;
    },
  };

  await handlers['/api/response']({
    body: {
      messageId: 'msg-1',
      conversationId: 'conv-1',
      text: '8fe196e6-2dc1-4701-91b9-1a1e5ebe3cde',
      model: 'gpt-5.4-mini',
      mode: 'agent',
    },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(setDoneCalls[0], 'Actual new reply.');
});

test('api stream retries on sequence collision and returns next sequence', () => {
  const handlers = {};
  const app = {
    post(path, ...fns) {
      handlers[path] = fns[fns.length - 1];
    },
    get() {},
  };

  const emitted = [];
  const streamRows = [];
  let insertCalls = 0;
  const preparedStatement = {
    run() { return { changes: 0, lastInsertRowid: 0 }; },
    get() { return null; },
    all() { return []; },
  };

  registerMessagesRoutes(app, {
    auth: (_req, _res, next) => next(),
    io: { emit(event, payload) { emitted.push({ event, payload }); } },
    db: {
      prepare: () => preparedStatement,
      transaction: (fn) => {
        const tx = (...args) => fn(...args);
        tx.immediate = (...args) => fn(...args);
        return tx;
      },
    },
    stmts: {
      findQById: {
        get: () => ({ conversation_id: 'conv-1', response_message_id: null }),
      },
      getLastStreamSeqByQueueMessage: {
        get: (messageId) => {
          const rows = streamRows.filter((row) => row.messageId === messageId);
          if (!rows.length) return { max_seq: 0 };
          return { max_seq: Math.max(...rows.map((row) => row.seq)) };
        },
      },
      insertStreamEvent: {
        run: (messageId, responseMessageId, conversationId, relayMode, seq, text, done, createdAt) => {
          if (insertCalls === 0) {
            insertCalls += 1;
            streamRows.push({
              messageId,
              responseMessageId,
              conversationId,
              relayMode,
              seq: 1,
              text: 'writer-1',
              done: 0,
              createdAt,
            });
            throw new Error('UNIQUE constraint failed: relay_stream_events.queue_message_id, relay_stream_events.seq');
          }
          insertCalls += 1;
          streamRows.push({
            messageId,
            responseMessageId,
            conversationId,
            relayMode,
            seq,
            text,
            done,
            createdAt,
          });
          return { changes: 1 };
        },
      },
    },
    runtimeState: { relayPaused: false },
    config: {},
    uuidv4: () => 'uuid',
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
    queueCounts: () => ({ pendingCount: 0, processingCount: 0, parkedCount: 0 }),
    getModelCatalogState: () => ({}),
    buildRelayReadyBannerData: () => ({}),
    ensureSessionId: () => 'session-1',
    touchCli: () => {},
    recoverProcessingOlderThan: () => [],
    addMsIso: () => '',
    computeRetryDelayMs: () => 0,
    resolveRequestedModel: () => ({}),
    normalizeRelayMode: (value) => value,
    DEFAULT_RELAY_MODE: 'agent',
    DEFAULT_MODEL: 'gpt-5.4-mini',
    configuredConversationSessionMode: 'isolated',
    parseAttachments: () => [],
    hydrateAttachment: () => null,
    relayActivityForResponse: () => [],
    relayActivityForQueueMessage: () => [],
    sanitizeActivityText: (value) => value,
    inFlightStateForConversation: () => null,
    emitToClientsExceptSessionId: () => {},
    relayBridgeOwnerService: {
      normalizeIdentity: () => null,
      observe: () => ({ accepted: true }),
      getOwner: () => null,
    },
    relayRestartOrchestrator: { getState: () => null },
    featureFlags: {},
    sessionWorkerRegistry: { getWorker: () => null, upsertWorker: () => {} },
    sessionWorkerSupervisor: {
      noteSessionHeartbeat: () => {},
      markIdle: () => {},
      ensureWorker: async () => ({ ok: true }),
    },
  });

  assert.equal(typeof handlers['/api/stream'], 'function');

  const res = {
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(value) {
      this.payload = value;
      return this;
    },
  };

  handlers['/api/stream']({
    body: {
      messageId: 'msg-1',
      conversationId: 'conv-1',
      text: 'retry-me',
      mode: 'agent',
      done: false,
    },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload?.ok, true);
  assert.equal(res.payload?.seq, 2);
  assert.equal(insertCalls, 2);
  assert.equal(streamRows.length, 2);
  assert.equal(streamRows[0].seq, 1);
  assert.equal(streamRows[1].seq, 2);
  const relayEvents = emitted.filter((entry) => entry.event === 'relay_stream');
  assert.equal(relayEvents.length, 1);
  assert.equal(relayEvents[0].payload?.seq, 2);
});

test('api stream rejects queue conversation mismatch', () => {
  const handlers = {};
  const app = {
    post(path, ...fns) {
      handlers[path] = fns[fns.length - 1];
    },
    get() {},
  };
  const preparedStatement = {
    run() { return { changes: 0, lastInsertRowid: 0 }; },
    get() { return null; },
    all() { return []; },
  };

  registerMessagesRoutes(app, {
    auth: (_req, _res, next) => next(),
    io: { emit() {} },
    db: {
      prepare: () => preparedStatement,
      transaction: (fn) => (...args) => fn(...args),
    },
    stmts: {
      findQById: {
        get: () => ({ conversation_id: 'conv-server', response_message_id: null }),
      },
      getLastStreamSeqByQueueMessage: { get: () => ({ max_seq: 0 }) },
      insertStreamEvent: { run: () => ({ changes: 1 }) },
    },
    runtimeState: { relayPaused: false },
    config: {},
    uuidv4: () => 'uuid',
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
    queueCounts: () => ({ pendingCount: 0, processingCount: 0, parkedCount: 0 }),
    getModelCatalogState: () => ({}),
    buildRelayReadyBannerData: () => ({}),
    ensureSessionId: () => 'session-1',
    touchCli: () => {},
    recoverProcessingOlderThan: () => [],
    addMsIso: () => '',
    computeRetryDelayMs: () => 0,
    resolveRequestedModel: () => ({}),
    normalizeRelayMode: (value) => value,
    DEFAULT_RELAY_MODE: 'agent',
    DEFAULT_MODEL: 'gpt-5.4-mini',
    configuredConversationSessionMode: 'isolated',
    parseAttachments: () => [],
    hydrateAttachment: () => null,
    relayActivityForResponse: () => [],
    relayActivityForQueueMessage: () => [],
    sanitizeActivityText: (value) => value,
    inFlightStateForConversation: () => null,
    emitToClientsExceptSessionId: () => {},
    relayBridgeOwnerService: {
      normalizeIdentity: () => null,
      observe: () => ({ accepted: true }),
      getOwner: () => null,
    },
    relayRestartOrchestrator: { getState: () => null },
    featureFlags: {},
    sessionWorkerRegistry: { getWorker: () => null, upsertWorker: () => {} },
    sessionWorkerSupervisor: {
      noteSessionHeartbeat: () => {},
      markIdle: () => {},
      ensureWorker: async () => ({ ok: true }),
    },
  });

  assert.equal(typeof handlers['/api/stream'], 'function');

  const res = {
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(value) {
      this.payload = value;
      return this;
    },
  };

  handlers['/api/stream']({
    body: {
      messageId: 'msg-1',
      conversationId: 'conv-client',
      text: 'ignored',
      mode: 'agent',
      done: false,
    },
  }, res);

  assert.equal(res.statusCode, 409);
  assert.equal(res.payload?.error, 'Stream conversationId does not match queue conversation');
});

test('api stream links late events to existing response id on queue row', () => {
  const handlers = {};
  const app = {
    post(path, ...fns) {
      handlers[path] = fns[fns.length - 1];
    },
    get() {},
  };
  const streamRows = [];
  const preparedStatement = {
    run() { return { changes: 0, lastInsertRowid: 0 }; },
    get() { return null; },
    all() { return []; },
  };

  registerMessagesRoutes(app, {
    auth: (_req, _res, next) => next(),
    io: { emit() {} },
    db: {
      prepare: () => preparedStatement,
      transaction: (fn) => (...args) => fn(...args),
    },
    stmts: {
      findQById: {
        get: () => ({ conversation_id: 'conv-1', response_message_id: 'resp-1' }),
      },
      getLastStreamSeqByQueueMessage: { get: () => ({ max_seq: 0 }) },
      insertStreamEvent: {
        run: (messageId, responseMessageId, conversationId, relayMode, seq, text, done, createdAt) => {
          streamRows.push({
            messageId,
            responseMessageId,
            conversationId,
            relayMode,
            seq,
            text,
            done,
            createdAt,
          });
          return { changes: 1 };
        },
      },
    },
    runtimeState: { relayPaused: false },
    config: {},
    uuidv4: () => 'uuid',
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
    queueCounts: () => ({ pendingCount: 0, processingCount: 0, parkedCount: 0 }),
    getModelCatalogState: () => ({}),
    buildRelayReadyBannerData: () => ({}),
    ensureSessionId: () => 'session-1',
    touchCli: () => {},
    recoverProcessingOlderThan: () => [],
    addMsIso: () => '',
    computeRetryDelayMs: () => 0,
    resolveRequestedModel: () => ({}),
    normalizeRelayMode: (value) => value,
    DEFAULT_RELAY_MODE: 'agent',
    DEFAULT_MODEL: 'gpt-5.4-mini',
    configuredConversationSessionMode: 'isolated',
    parseAttachments: () => [],
    hydrateAttachment: () => null,
    relayActivityForResponse: () => [],
    relayActivityForQueueMessage: () => [],
    sanitizeActivityText: (value) => value,
    inFlightStateForConversation: () => null,
    emitToClientsExceptSessionId: () => {},
    relayBridgeOwnerService: {
      normalizeIdentity: () => null,
      observe: () => ({ accepted: true }),
      getOwner: () => null,
    },
    relayRestartOrchestrator: { getState: () => null },
    featureFlags: {},
    sessionWorkerRegistry: { getWorker: () => null, upsertWorker: () => {} },
    sessionWorkerSupervisor: {
      noteSessionHeartbeat: () => {},
      markIdle: () => {},
      ensureWorker: async () => ({ ok: true }),
    },
  });

  assert.equal(typeof handlers['/api/stream'], 'function');

  const res = {
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(value) {
      this.payload = value;
      return this;
    },
  };

  handlers['/api/stream']({
    body: {
      messageId: 'msg-1',
      conversationId: 'conv-1',
      text: 'late chunk',
      mode: 'agent',
      done: false,
    },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload?.ok, true);
  assert.equal(res.payload?.seq, 1);
  assert.equal(streamRows.length, 1);
  assert.equal(streamRows[0].responseMessageId, 'resp-1');
});
