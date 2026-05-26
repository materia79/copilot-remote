import test from 'node:test';
import assert from 'node:assert/strict';
import { registerMessagesRoutes } from './messages-routes.mjs';

function createBaseDeps(overrides = {}) {
  const preparedStatement = {
    run() { return { changes: 0, lastInsertRowid: 0 }; },
    get() { return null; },
    all() { return []; },
  };

  return {
    auth: (_req, _res, next) => next(),
    io: { emit() {} },
    db: {
      prepare: () => preparedStatement,
      transaction: (fn) => (...args) => fn(...args),
    },
    stmts: {
      findPending: { get: () => null },
      findPendingForWorker: { get: () => null },
    },
    runtimeState: { relayPaused: false, cliOnline: true },
    config: {},
    uuidv4: () => 'uuid',
    ts: () => 'ts',
    MAX_UPLOAD_BYTES: 1,
    MAX_UPLOAD_ATTACHMENTS: 1,
    MAX_REPO_TREE_NODES: 16,
    MAX_REQUEUE_RETRIES: 1,
    MAX_IMAGE_DATA_URL_LENGTH: 1,
    MAX_WORKSPACE_PREVIEW_BYTES: 1024,
    MAX_REFERENCE_IMAGE_ATTACHMENT_BYTES: 1,
    remotePath: '',
    parseBooleanQueryFlag: () => false,
    buildRepositoryTreeSnapshot: () => ({ root: { path: '', name: 'repo', type: 'dir', children: [] } }),
    fetchBrowsableDrives: async () => [],
    fetchDriveDirectoryEntries: async () => [],
    mapDriveDirectoryEntry: () => ({}),
    driveDisplayName: () => '',
    normalizeDriveAbsolutePath: (value) => value,
    driveRootFromAbsolutePath: (value) => value,
    toDriveWebPath: (value) => value,
    readWorkspaceFileMeta: () => null,
    resolveWorkspaceFilePath: () => null,
    normalizeWorkspaceRelativePath: (value) => value,
    previewLanguageForWorkspaceFile: () => 'plaintext',
    readWorkspaceFilePreviewBuffer: () => Buffer.alloc(0),
    isLikelyBinaryPreviewBuffer: () => false,
    isLikelyTextContentType: () => true,
    workspacePreviewKindForMeta: () => 'text',
    workspaceContentType: () => 'text/plain',
    persistUploadBuffer: async () => null,
    isSha256: () => false,
    uploadPathForSha: () => '',
    uploadContentUrlForSha: () => '',
    maybeApplyWorkspaceRootFromMessage: () => ({}),
    updateConversationConfiguredWorkspaceRoot: () => ({ ok: false }),
    getOrCreateConversation: () => ({}),
    ensureRuntimeSessionBinding: () => ({}),
    resolveConversationWorkspaceState: () => null,
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
    resolveRequestedModel: () => ({ model: 'gpt-5.4', warning: null }),
    normalizeRelayMode: (value) => value,
    DEFAULT_RELAY_MODE: 'agent',
    DEFAULT_MODEL: 'gpt-5.4',
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
      observe: () => ({ accepted: true }),
      getOwner: () => null,
    },
    relayRestartOrchestrator: {
      getState: () => null,
      onDequeueProbe: () => null,
    },
    featureFlags: {
      SESSION_WORKER_ROUTING_ENABLED: true,
      SESSION_WORKER_CONTINUATION_ROUTING_ENABLED: true,
      SESSION_WORKER_FALLBACK_RESTART_ENABLED: false,
    },
    sessionWorkerRegistry: {
      getWorker: () => null,
      upsertWorker: () => {},
    },
    sessionWorkerSupervisor: {
      noteSessionHeartbeat: () => {},
      markIdle: () => {},
      ensureWorker: async () => ({ ok: true }),
      getWorkerState: () => ({ workerId: 'worker-requester', pid: 123 }),
      getLifecycleState: () => ({ retryCount: 0 }),
      markError: () => {},
    },
    requestRelayShutdown: () => ({ accepted: true, status: 'queued' }),
    ...overrides,
  };
}

function createResponseRecorder() {
  return {
    statusCode: 200,
    payload: null,
    headers: {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value;
    },
    json(value) {
      this.payload = value;
      return this;
    },
  };
}

function registerHandlers(overrides = {}) {
  const handlers = {};
  const app = {
    post() {},
    get(path, ...fns) {
      handlers[path] = fns[fns.length - 1];
    },
  };
  registerMessagesRoutes(app, createBaseDeps(overrides));
  return handlers;
}

test('api files preview resolves against the selected conversation workspace root', () => {
  const scopeCalls = [];
  const filePathCalls = [];
  const handlers = registerHandlers({
    resolveConversationWorkspaceState: (scope) => {
      scopeCalls.push(scope);
      return {
        currentWorkspaceRootPath: 'C:\\selected-root',
      };
    },
    resolveWorkspaceFilePath: (requestedPath, rootOverride) => {
      filePathCalls.push({ requestedPath, rootOverride });
      return 'C:\\selected-root\\docs\\note.txt';
    },
    readWorkspaceFileMeta: () => ({
      kind: 'file',
      size: 4,
      contentType: 'text/plain',
    }),
    readWorkspaceFilePreviewBuffer: () => Buffer.from('test'),
  });

  const handler = handlers['/api/files-preview/*'];
  const res = createResponseRecorder();
  handler({
    params: { 0: 'docs\\note.txt' },
    query: { conversationId: 'conv-1' },
    headers: {},
  }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(scopeCalls, [{ conversationId: 'conv-1', sdkSessionId: '' }]);
  assert.deepEqual(filePathCalls, [{
    requestedPath: 'docs\\note.txt',
    rootOverride: 'C:\\selected-root',
  }]);
  assert.equal(res.payload?.path, 'docs/note.txt');
  assert.equal(res.payload?.content, 'test');
  assert.equal(res.payload?.rawUrl, '/api/files/docs/note.txt?conversationId=conv-1');
  assert.equal(res.headers['cache-control'], 'no-store');
});

test('api files passes the scoped workspace root string to resolveWorkspaceFilePath', () => {
  const filePathCalls = [];
  const handlers = registerHandlers({
    resolveConversationWorkspaceState: () => ({
      currentWorkspaceRootPath: 'C:\\selected-root',
    }),
    resolveWorkspaceFilePath: (requestedPath, rootOverride) => {
      filePathCalls.push({ requestedPath, rootOverride });
      return null;
    },
  });

  const handler = handlers['/api/files/*'];
  const res = createResponseRecorder();
  handler({
    params: { 0: 'docs\\note.txt' },
    query: { conversationId: 'conv-1' },
    headers: {},
  }, res);

  assert.equal(res.statusCode, 400);
  assert.deepEqual(filePathCalls, [{
    requestedPath: 'docs\\note.txt',
    rootOverride: 'C:\\selected-root',
  }]);
});

test('api repo tree passes the selected conversation workspace root as rootPath', () => {
  const snapshotCalls = [];
  const handlers = registerHandlers({
    resolveConversationWorkspaceState: () => ({
      currentWorkspaceRootPath: 'I:\\rabiribi',
    }),
    buildRepositoryTreeSnapshot: (options) => {
      snapshotCalls.push(options);
      return {
        root: { path: '', name: 'repo', type: 'dir', children: [] },
        rootName: 'repo',
        nodeCount: 1,
        maxNodes: options.maxNodes,
        truncated: false,
      };
    },
  });

  const handler = handlers['/api/repo/tree'];
  const res = createResponseRecorder();
  handler({
    query: { conversationId: 'conv-rabi' },
    headers: {},
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(snapshotCalls.length, 1);
  assert.equal(snapshotCalls[0].rootPath, 'I:\\rabiribi');
});

test('api repo tree passes null rootPath when no conversation workspace root is available', () => {
  const snapshotCalls = [];
  const handlers = registerHandlers({
    buildRepositoryTreeSnapshot: (options) => {
      snapshotCalls.push(options);
      return {
        root: { path: '', name: 'repo', type: 'dir', children: [] },
        rootName: 'repo',
        nodeCount: 1,
        maxNodes: options.maxNodes,
        truncated: false,
      };
    },
  });

  const handler = handlers['/api/repo/tree'];
  const res = createResponseRecorder();
  handler({
    query: {},
    headers: {},
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(snapshotCalls.length, 1);
  assert.equal(snapshotCalls[0].rootPath, null);
});
