import test from 'node:test';
import assert from 'node:assert/strict';

import { registerSessionsRoutes } from './sessions-routes.mjs';
import { buildModelVariantCatalogPayload } from './sessions-routes.mjs';

function createMockApp() {
  const routes = new Map();
  return {
    routes,
    get(path, ...handlers) {
      routes.set(`GET ${path}`, handlers);
    },
    post(path, ...handlers) {
      routes.set(`POST ${path}`, handlers);
    },
    patch(path, ...handlers) {
      routes.set(`PATCH ${path}`, handlers);
    },
    delete(path, ...handlers) {
      routes.set(`DELETE ${path}`, handlers);
    },
  };
}

function createMockDb() {
  const noopStmt = {
    run() {},
    get() {
      return null;
    },
    all() {
      return [];
    },
  };
  return {
    prepare() {
      return noopStmt;
    },
    transaction(fn) {
      return (...args) => fn(...args);
    },
  };
}

function createRuntimeDeps({ rows, modelState, onRefresh }) {
  const app = createMockApp();
  const db = createMockDb();
  const ioEvents = [];
  const io = {
    emit(event, payload) {
      ioEvents.push({ event, payload });
    },
  };
  const auth = (_req, _res, next) => next();
  const ensureSessionId = () => true;
  const deps = {
    auth,
    io,
    db,
    stmts: {},
    runtimeState: {},
    config: {},
    parseAttachments: () => [],
    hydrateAttachment: (value) => value,
    relayActivityForResponse: () => [],
    relayThoughtsForResponse: () => [],
    buildContextResponseText: () => '',
    readContextFromSessionEvents: () => [],
    inFlightStateForConversation: () => null,
    createCompactedConversation: () => null,
    collectOrphanedUploadsFromConversation: () => [],
    deleteOrphanedUploads: () => ({ deletedCount: 0 }),
    queueCounts: () => ({ pending: 0, processing: 0 }),
    getModelCatalogState: () => modelState.current,
    updateModelCatalog: (next) => {
      modelState.current = { ...modelState.current, ...next };
      return modelState.current;
    },
    listModelVariantRows: () => rows.current.slice(),
    refreshModelVariantCatalogFromCli: async () => {
      await onRefresh();
      return modelState.current;
    },
    setEnabledModelVariants: () => modelState.current,
    SUPPORTED_REASONING_EFFORTS: ['none', 'low', 'medium'],
    buildRelayReadyBannerData: () => ({}),
    workspaceRootPayload: () => null,
    setWorkspaceRoot: () => ({ changed: false }),
    setDefaultSessionWorkspaceRootPath: () => ({ changed: false }),
    resolveConversationWorkspaceState: () => ({}),
    updateConversationConfiguredWorkspaceRoot: () => ({ changed: false }),
    learnConversationWorkspaceRoot: () => ({ learned: false }),
    setPendingSessionCwd: () => null,
    consumePendingSessionCwd: () => null,
    processingTimeoutMs: 0,
    localhostOnly: false,
    listenHost: '127.0.0.1',
    ensureSessionId,
    touchCli: () => {},
    markCliOffline: () => {},
    fetchUsageSummary: (_cb) => {},
    discoverSessionStateConversations: () => [],
    readSessionTranscriptMessages: () => [],
    parseSessionEventsToMessages: () => [],
    ensureRuntimeSessionBinding: () => ({ ok: true }),
    bootstrapRuntimeSessionBindings: () => ({ ok: true }),
    configuredConversationSessionMode: 'conversation-bound',
    SUPPORTED_RELAY_MODES: ['agent'],
    DEFAULT_RELAY_MODE: 'agent',
    SUPPORTED_CONVERSATION_SESSION_MODES: ['conversation-bound'],
    DEFAULT_CONVERSATION_SESSION_MODE: 'conversation-bound',
    DEFAULT_MODEL: 'gpt-5.4-mini',
    remotePath: () => null,
    computeRetryDelayMs: () => 0,
    relayRestartOrchestrator: null,
    relayBridgeOwnerService: null,
    featureFlags: {},
    sessionWorkerSupervisor: null,
    sessionWorkerRegistry: null,
    resolveSessionStateRoot: () => null,
  };
  registerSessionsRoutes(app, deps);
  return { app, ioEvents };
}

async function callRoute(handlers, req = {}) {
  const response = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  for (const handler of handlers) {
    let nextCalled = false;
    await handler(
      req,
      response,
      () => {
        nextCalled = true;
      },
    );
    if (!nextCalled) break;
  }
  return response;
}

test('POST /api/model-variants/refresh keeps enabled unavailable variants and rpc-snapshot source', async () => {
  const rows = {
    current: [
      {
        variantId: 'gpt-5.4-none',
        baseModelId: 'gpt-5.4',
        provider: 'openai',
        label: 'GPT-5.4',
        releaseStatus: null,
        reasoningEffort: 'none',
        enabled: true,
        sortOrder: 0,
      },
      {
        variantId: 'claude-sonnet-4.6-none',
        baseModelId: 'claude-sonnet-4.6',
        provider: 'anthropic',
        label: 'Claude Sonnet 4.6',
        releaseStatus: null,
        reasoningEffort: 'none',
        enabled: true,
        sortOrder: 1,
      },
    ],
  };
  const modelState = {
    current: {
      source: 'rpc-snapshot',
      refreshedAt: '2026-06-24T00:00:00.000Z',
      warning: null,
      error: null,
    },
  };

  const { app, ioEvents } = createRuntimeDeps({
    rows,
    modelState,
    onRefresh: async () => {
      rows.current = [
        {
          variantId: 'gpt-5.4-none',
          baseModelId: 'gpt-5.4',
          provider: 'openai',
          label: 'GPT-5.4',
          releaseStatus: 'unavailable',
          reasoningEffort: 'none',
          enabled: true,
          sortOrder: 0,
        },
        {
          variantId: 'claude-sonnet-4.6-none',
          baseModelId: 'claude-sonnet-4.6',
          provider: 'anthropic',
          label: 'Claude Sonnet 4.6',
          releaseStatus: 'unavailable',
          reasoningEffort: 'none',
          enabled: true,
          sortOrder: 1,
        },
        {
          variantId: 'gpt-5.5-none',
          baseModelId: 'gpt-5.5',
          provider: 'openai',
          label: 'GPT-5.5',
          releaseStatus: null,
          reasoningEffort: 'none',
          enabled: false,
          sortOrder: 2,
        },
        {
          variantId: 'claude-sonnet-4.7-none',
          baseModelId: 'claude-sonnet-4.7',
          provider: 'anthropic',
          label: 'Claude Sonnet 4.7',
          releaseStatus: null,
          reasoningEffort: 'none',
          enabled: false,
          sortOrder: 3,
        },
      ];
      modelState.current = {
        source: 'rpc-snapshot',
        refreshedAt: '2026-06-24T00:02:00.000Z',
        warning: null,
        error: null,
      };
    },
  });

  const handlers = app.routes.get('POST /api/model-variants/refresh');
  assert.ok(handlers, 'refresh route should be registered');
  const response = await callRoute(handlers, {
    headers: {},
    body: {},
    query: {},
    params: {},
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.source, 'rpc-snapshot');
  assert.equal(response.body.warning, null);
  assert.deepEqual(response.body.enabledVariantIds, ['gpt-5.4-none', 'claude-sonnet-4.6-none']);
  const unavailableEnabled = response.body.variants.filter((row) => row.enabled && row.releaseStatus === 'unavailable');
  assert.deepEqual(
    unavailableEnabled.map((row) => row.variantId),
    ['gpt-5.4-none', 'claude-sonnet-4.6-none'],
  );
  assert.equal(ioEvents.some((event) => event.event === 'models_updated'), true);
});

test('POST /api/model-variants/refresh reports help-fallback source and keeps unavailable-enabled rows', async () => {
  const rows = {
    current: [
      {
        variantId: 'gpt-5.4-none',
        baseModelId: 'gpt-5.4',
        provider: 'openai',
        label: 'GPT-5.4',
        releaseStatus: null,
        reasoningEffort: 'none',
        enabled: true,
        sortOrder: 0,
      },
    ],
  };
  const modelState = {
    current: {
      source: 'rpc-snapshot',
      refreshedAt: '2026-06-24T00:00:00.000Z',
      warning: null,
      error: null,
    },
  };
  const { app } = createRuntimeDeps({
    rows,
    modelState,
    onRefresh: async () => {
      rows.current = [
        {
          variantId: 'gpt-5.4-none',
          baseModelId: 'gpt-5.4',
          provider: 'openai',
          label: 'GPT-5.4',
          releaseStatus: 'unavailable',
          reasoningEffort: 'none',
          enabled: true,
          sortOrder: 0,
        },
        {
          variantId: 'gpt-5.5-none',
          baseModelId: 'gpt-5.5',
          provider: 'openai',
          label: 'GPT-5.5',
          releaseStatus: null,
          reasoningEffort: 'none',
          enabled: false,
          sortOrder: 1,
        },
      ];
      modelState.current = {
        source: 'copilot-help-manual-refresh',
        refreshedAt: '2026-06-24T00:03:00.000Z',
        warning: null,
        error: null,
      };
    },
  });

  const handlers = app.routes.get('POST /api/model-variants/refresh');
  assert.ok(handlers, 'refresh route should be registered');
  const response = await callRoute(handlers, {
    headers: {},
    body: {},
    query: {},
    params: {},
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.source, 'copilot-help-manual-refresh');
  assert.equal(response.body.warning, null);
  assert.deepEqual(response.body.enabledVariantIds, ['gpt-5.4-none']);
  assert.equal(response.body.variants[0].releaseStatus, 'unavailable');
});

test('payload helper keeps unavailable-enabled variants selectable after id changes', () => {
  const payload = buildModelVariantCatalogPayload({
    rows: [
      {
        variantId: 'gpt-5.4-none',
        baseModelId: 'gpt-5.4',
        provider: 'openai',
        label: 'GPT-5.4',
        releaseStatus: 'unavailable',
        reasoningEffort: 'none',
        enabled: true,
        sortOrder: 0,
      },
      {
        variantId: 'gpt-5.5-none',
        baseModelId: 'gpt-5.5',
        provider: 'openai',
        label: 'GPT-5.5',
        releaseStatus: null,
        reasoningEffort: 'none',
        enabled: false,
        sortOrder: 1,
      },
    ],
    modelState: {
      source: 'rpc-snapshot',
      refreshedAt: '2026-06-24T00:05:00.000Z',
      warning: null,
      error: null,
    },
    reasoningEfforts: ['none', 'low', 'medium'],
  });
  assert.deepEqual(payload.enabledVariantIds, ['gpt-5.4-none']);
  assert.equal(payload.warning, null);
  assert.equal(payload.source, 'rpc-snapshot');
});

test('GET /api/models exposes metadata validity flags and strict reasoning map', async () => {
  const rows = {
    current: [
      {
        variantId: 'gpt-5.4-none',
        baseModelId: 'gpt-5.4',
        provider: 'openai',
        label: 'GPT-5.4',
        releaseStatus: null,
        reasoningEffort: 'none',
        enabled: true,
        sortOrder: 0,
      },
      {
        variantId: 'gpt-5.4-low',
        baseModelId: 'gpt-5.4',
        provider: 'openai',
        label: 'GPT-5.4',
        releaseStatus: null,
        reasoningEffort: 'low',
        enabled: true,
        sortOrder: 1,
      },
    ],
  };
  const modelState = {
    current: {
      models: ['auto', 'gpt-5.4'],
      currentModel: 'gpt-5.4',
      defaultModel: 'gpt-5.4',
      reasoningByModel: {
        auto: ['none', 'low'],
        'gpt-5.4': ['none', 'low'],
      },
      reasoningEfforts: ['none', 'low'],
      stale: false,
      metadataValid: true,
      reasoningMetadataValid: true,
      refreshedAt: '2026-07-05T12:00:00.000Z',
      source: 'rpc-snapshot',
      warning: null,
      error: null,
    },
  };

  const { app } = createRuntimeDeps({ rows, modelState, onRefresh: async () => {} });
  const handlers = app.routes.get('GET /api/models');
  assert.ok(handlers, 'models route should be registered');
  const response = await callRoute(handlers, { headers: {}, body: {}, query: {}, params: {} });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.metadataValid, true);
  assert.equal(response.body.reasoningMetadataValid, true);
  assert.deepEqual(response.body.reasoningByModel['gpt-5.4'], ['none', 'low']);
});

test('GET /api/models reports invalid metadata when reasoning map is empty', async () => {
  const rows = { current: [] };
  const modelState = {
    current: {
      models: ['auto'],
      currentModel: 'gpt-5.4-mini',
      defaultModel: 'gpt-5.4-mini',
      reasoningByModel: {},
      reasoningEfforts: [],
      stale: true,
      metadataValid: false,
      reasoningMetadataValid: false,
      refreshedAt: null,
      source: 'bootstrap',
      warning: 'No model variants are enabled. Using fallback.',
      error: null,
    },
  };

  const { app } = createRuntimeDeps({ rows, modelState, onRefresh: async () => {} });
  const handlers = app.routes.get('GET /api/models');
  const response = await callRoute(handlers, { headers: {}, body: {}, query: {}, params: {} });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.metadataValid, false);
  assert.equal(response.body.reasoningMetadataValid, false);
  assert.equal(response.body.stale, true);
  assert.deepEqual(response.body.reasoningByModel, {});
});
