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
