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
    requestRelayShutdown: () => ({ accepted: true, status: 'queued' }),
    featureFlags: {},
    sessionWorkerRegistry: { getWorker: () => null, upsertWorker: () => {} },
    sessionWorkerSupervisor: {
      noteSessionHeartbeat: () => {},
      markIdle: () => {},
      ensureWorker: async () => ({ ok: true }),
    },
    ...overrides,
  };
}

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

test('api relay shutdown accepts localhost request and queues shutdown', () => {
  const handlers = {};
  const app = {
    post(path, ...fns) { handlers[path] = fns[fns.length - 1]; },
    get() {},
  };
  const calls = [];
  registerMessagesRoutes(app, createBaseDeps({
    requestRelayShutdown: (request) => {
      calls.push(request);
      return { accepted: true, status: 'queued', reason: request.reason };
    },
  }));

  const handler = handlers['/api/relay/shutdown'];
  assert.equal(typeof handler, 'function');

  const res = createResponseRecorder();
  handler({
    ip: '::ffff:127.0.0.1',
    socket: { remoteAddress: '::ffff:127.0.0.1' },
    body: { reason: 'manual-restart' },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload?.ok, true);
  assert.equal(res.payload?.status, 'queued');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].reason, 'manual-restart');
});

test('api relay shutdown rejects non-localhost callers', () => {
  const handlers = {};
  const app = {
    post(path, ...fns) { handlers[path] = fns[fns.length - 1]; },
    get() {},
  };
  let called = false;
  registerMessagesRoutes(app, createBaseDeps({
    requestRelayShutdown: () => {
      called = true;
      return { accepted: true, status: 'queued' };
    },
  }));

  const handler = handlers['/api/relay/shutdown'];
  assert.equal(typeof handler, 'function');

  const res = createResponseRecorder();
  handler({
    ip: '10.0.0.45',
    socket: { remoteAddress: '10.0.0.45' },
    body: { reason: 'should-not-run' },
  }, res);

  assert.equal(res.statusCode, 403);
  assert.equal(called, false);
  assert.equal(String(res.payload?.error || '').includes('localhost-only'), true);
});
