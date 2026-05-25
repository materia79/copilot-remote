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
    MAX_REPO_TREE_NODES: 1,
    MAX_REQUEUE_RETRIES: 1,
    MAX_IMAGE_DATA_URL_LENGTH: 1,
    MAX_WORKSPACE_PREVIEW_BYTES: 1,
    MAX_REFERENCE_IMAGE_ATTACHMENT_BYTES: 1,
    remotePath: '',
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
    queueCounts: () => ({ pendingCount: 1, processingCount: 0, parkedCount: 0 }),
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

test('api pending does not auto-prime retried stranded rows owned by another session', async () => {
  const handlers = {};
  const app = {
    post() {},
    get(path, ...fns) {
      handlers[path] = fns[fns.length - 1];
    },
  };

  const ensureCalls = [];
  const defaultStatement = {
    run() { return { changes: 0, lastInsertRowid: 0 }; },
    get() { return null; },
    all() { return []; },
  };
  const strandedOwnedByOtherSession = {
    get() {
      return {
        id: 'msg-stale',
        conversation_id: 'conv-stale',
        owner_sdk_session_id: 'sdk-stale',
        retry_count: 4,
      };
    },
  };
  const deps = createBaseDeps({
    db: {
      prepare(sql) {
        if (String(sql).includes('SELECT id, conversation_id, owner_sdk_session_id, retry_count')) {
          return strandedOwnedByOtherSession;
        }
        return defaultStatement;
      },
      transaction: (fn) => (...args) => fn(...args),
    },
    sessionWorkerSupervisor: {
      noteSessionHeartbeat: () => {},
      markIdle: () => {},
      ensureWorker: async (sdkSessionId) => {
        ensureCalls.push(sdkSessionId);
        return { ok: true, worker: { sdkSessionId, workerId: `worker-${sdkSessionId}` }, lifecycle: { retryCount: 0 } };
      },
      getWorkerState: () => ({ workerId: 'worker-requester', pid: 123 }),
      getLifecycleState: () => ({ retryCount: 0 }),
      markError: () => {},
    },
  });
  registerMessagesRoutes(app, deps);

  const handler = handlers['/api/pending'];
  assert.equal(typeof handler, 'function');

  const res = createResponseRecorder();
  await handler({
    headers: {
      'x-relay-process-pid': '111',
      'x-relay-parent-pid': '222',
      'x-relay-session-id': 'sdk-requester',
      'x-relay-conversation-id': 'conv-requester',
    },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload?.message, null);
  assert.equal(res.payload?.routing?.enabled, true);
  assert.equal(res.payload?.routing?.requesterSessionId, 'sdk-requester');
  assert.equal(res.payload?.routing?.primedSessionId, null);
  assert.deepEqual(ensureCalls, ['sdk-requester']);
});
