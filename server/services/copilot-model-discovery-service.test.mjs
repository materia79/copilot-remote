import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createCopilotModelDiscoveryService } from './copilot-model-discovery-service.mjs';

/** A listModels answer shaped like the runtime's ModelInfo entries. */
const MODEL_INFOS = [
  {
    id: 'gpt-5.4',
    name: 'GPT-5.4',
    capabilities: { limits: { max_prompt_tokens: 120_000, max_output_tokens: 8_000 } },
    billing: { tokenPrices: { inputPrice: 1, outputPrice: 2, batchSize: 1_000_000 } },
    supportedReasoningEfforts: ['low', 'medium', 'high'],
    defaultReasoningEffort: 'medium',
  },
  { id: 'gpt-5.4-mini', name: 'GPT-5.4 mini' },
];

function makeDeps({
  listModels = async () => MODEL_INFOS,
  createClientImpl = null,
  resolvable = true,
} = {}) {
  const state = {
    catalogUpdates: [],
    disposals: 0,
    clientsCreated: 0,
    warnings: [],
  };
  const deps = {
    createClient: createClientImpl || (async () => {
      state.clientsCreated += 1;
      return {
        client: { listModels },
        async dispose() { state.disposals += 1; },
      };
    }),
    resolveInstalledPaths: () => {
      if (!resolvable) throw new Error('Copilot SDK runtime not found');
      return { sdkPath: '/home/dev/.cache/copilot/pkg/linux-x64/1.0.82/copilot-sdk/index.js' };
    },
    updateModelCatalog: (snapshot) => { state.catalogUpdates.push(snapshot); },
    logger: { warn: (line) => state.warnings.push(String(line)) },
  };
  return { deps, state };
}

test('a successful refresh feeds the catalog with a server-discovery source tag', async () => {
  const { deps, state } = makeDeps();
  const service = createCopilotModelDiscoveryService(deps);
  const result = await service.refresh('boot');

  assert.equal(result.ok, true);
  assert.deepEqual(result.models, ['gpt-5.4', 'gpt-5.4-mini']);
  assert.equal(state.catalogUpdates.length, 1);
  const snapshot = state.catalogUpdates[0];
  assert.equal(snapshot.source, 'server-discovery:boot');
  assert.deepEqual(snapshot.models, ['gpt-5.4', 'gpt-5.4-mini']);
  // Same shape the extension publishes: prompt + output budget as the limit,
  // per-model metadata alongside.
  assert.equal(snapshot.contextLimitsByModel['gpt-5.4'], 128_000);
  assert.equal(snapshot.modelMetadataByModel['gpt-5.4'].defaultContextLimitTokens, 128_000);
  assert.equal(snapshot.modelMetadataByModel['gpt-5.4'].pricing.default.input, 1);
  // The session-less list cannot know the active model; the catalog keeps its
  // existing currentModel/defaultModel when the snapshot omits them.
  assert.equal('currentModel' in snapshot, false);
  assert.equal(snapshot.error, null);
  // The client never outlives the refresh.
  assert.equal(state.disposals, 1);
});

test('a rejected listModels is log-and-skip: no catalog write, client still disposed', async () => {
  const { deps, state } = makeDeps({ listModels: async () => { throw new Error('runtime refused'); } });
  const service = createCopilotModelDiscoveryService(deps);
  const result = await service.refresh('boot');

  assert.equal(result.ok, false);
  assert.match(result.error, /runtime refused/);
  assert.equal(state.catalogUpdates.length, 0);
  assert.equal(state.disposals, 1);
  assert.equal(state.warnings.some((line) => line.includes('runtime refused')), true);
});

test('an empty model list is skipped without writing an error into the catalog', async () => {
  const { deps, state } = makeDeps({ listModels: async () => [] });
  const service = createCopilotModelDiscoveryService(deps);
  const result = await service.refresh('boot');

  assert.equal(result.ok, false);
  assert.equal(state.catalogUpdates.length, 0);
  assert.equal(state.disposals, 1);
});

test('a hung listModels is bounded by the timeout and the client is disposed', async () => {
  const { deps, state } = makeDeps({ listModels: () => new Promise(() => {}) });
  const service = createCopilotModelDiscoveryService({ ...deps, timeoutMs: 30 });
  const result = await service.refresh('boot');

  assert.equal(result.ok, false);
  assert.match(result.error, /timed out after 30ms/);
  assert.equal(state.catalogUpdates.length, 0);
  assert.equal(state.disposals, 1);
});

test('a client whose start outlives the timeout is disposed when it lands late', async () => {
  const { deps, state } = makeDeps();
  let releaseStart = () => {};
  deps.createClient = () => new Promise((resolve) => {
    releaseStart = () => resolve({
      client: { listModels: async () => MODEL_INFOS },
      async dispose() { state.disposals += 1; },
    });
  });
  const service = createCopilotModelDiscoveryService({ ...deps, timeoutMs: 30 });
  const result = await service.refresh('boot');
  assert.equal(result.ok, false);
  assert.match(result.error, /Copilot client start timed out/);
  assert.equal(state.disposals, 0);

  // The spawn settles after the refresh gave up on it: nobody owns that
  // runtime process except the late-dispose hook.
  releaseStart();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.disposals, 1);
  assert.equal(state.catalogUpdates.length, 0);
});

test('no resolvable Copilot CLI means no spawn at all', async () => {
  const { deps, state } = makeDeps({ resolvable: false });
  const service = createCopilotModelDiscoveryService(deps);
  const result = await service.refresh('boot');

  assert.equal(result.ok, false);
  assert.equal(result.skipped, true);
  assert.equal(state.clientsCreated, 0);
  assert.equal(state.catalogUpdates.length, 0);
});

test('concurrent refresh calls share one run (single-flight)', async () => {
  let release = null;
  const { deps, state } = makeDeps({
    listModels: () => new Promise((resolve) => { release = () => resolve(MODEL_INFOS); }),
  });
  const service = createCopilotModelDiscoveryService(deps);
  const first = service.refresh('boot');
  const second = service.refresh('manual');
  // The list call only starts after the client-start await settles.
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a, b);
  assert.equal(state.clientsCreated, 1);
  assert.equal(state.catalogUpdates.length, 1);
});

test('a successful refresh notifies the catalog-updated listener; failures do not', async () => {
  const { deps } = makeDeps();
  const service = createCopilotModelDiscoveryService(deps);
  let notified = 0;
  service.setOnCatalogUpdated(() => { notified += 1; });
  await service.refresh('boot');
  assert.equal(notified, 1);

  const failing = makeDeps({ listModels: async () => { throw new Error('down'); } });
  const failingService = createCopilotModelDiscoveryService(failing.deps);
  failingService.setOnCatalogUpdated(() => { notified += 1; });
  await failingService.refresh('boot');
  assert.equal(notified, 1);
});

test('dispose mid-refresh tears the live client down and settles without the full timeout', async () => {
  const { deps, state } = makeDeps();
  // Like the real transport: a pending RPC only settles when the client dies,
  // so only the dispose-first teardown path can end this refresh promptly.
  let rejectPendingList = () => {};
  deps.createClient = async () => {
    state.clientsCreated += 1;
    return {
      client: {
        listModels: () => new Promise((_resolve, reject) => { rejectPendingList = reject; }),
      },
      async dispose() {
        state.disposals += 1;
        rejectPendingList(new Error('connection got disposed'));
      },
    };
  };
  // A generous timeout so the test can only pass through dispose(), never by
  // waiting the race out.
  const service = createCopilotModelDiscoveryService({ ...deps, timeoutMs: 60_000 });
  const refreshing = service.refresh('boot');
  await new Promise((resolve) => setImmediate(resolve));

  await service.dispose();
  assert.equal(state.disposals, 1);
  // dispose() awaited the in-flight refresh; nothing should have reached the
  // catalog and refresh() must refuse new work afterwards.
  const result = await service.refresh('late');
  assert.equal(result.skipped, true);
  assert.equal(state.catalogUpdates.length, 0);
  // The original refresh settles instead of hanging (the timeout race is
  // unref'd, so an unsettled promise here would leak past the test).
  await refreshing;
});

test('scheduleStartupRefresh defers the boot refresh and dispose cancels a pending one', async () => {
  const { deps, state } = makeDeps();
  const service = createCopilotModelDiscoveryService(deps);
  service.scheduleStartupRefresh({ delayMs: 5 });
  assert.equal(state.clientsCreated, 0);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(state.clientsCreated, 1);
  assert.equal(state.catalogUpdates[0].source, 'server-discovery:boot');

  const pending = makeDeps();
  const pendingService = createCopilotModelDiscoveryService(pending.deps);
  pendingService.scheduleStartupRefresh({ delayMs: 1_000 });
  await pendingService.dispose();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(pending.state.clientsCreated, 0);
});

// ── The metadata contract from the typed client-level ModelInfo shape ────────

import fs from 'node:fs';
import { buildModelSnapshotFields, extractModelDescriptors } from '../../shared/model-descriptors.mjs';

const RAW_FIXTURE = JSON.parse(fs.readFileSync(new URL('../../shared/fixtures/copilot-catalog-raw-2026-09-07.json', import.meta.url), 'utf8'));

/** What client.listModels() returns for a raw CAPI record: typed, camelCase billing. */
function typedModelInfo(raw) {
  const prices = raw.billing?.token_prices || {};
  const toTyped = (tier) => (tier ? {
    inputPrice: tier.input_price,
    outputPrice: tier.output_price,
    cacheReadPrice: tier.cache_read_price,
    cacheWritePrice: tier.cache_write_price,
    maxPromptTokens: tier.max_prompt_tokens,
  } : undefined);
  return {
    id: raw.id,
    name: raw.name,
    vendor: raw.vendor,
    preview: raw.preview,
    modelPickerCategory: raw.model_picker_category,
    capabilities: {
      supports: { vision: true, reasoningEffort: Array.isArray(raw.capabilities.supports.reasoning_effort) },
      limits: { ...raw.capabilities.limits },
    },
    billing: {
      multiplier: 1,
      tokenPrices: prices.default ? {
        batchSize: prices.batch_size,
        ...toTyped(prices.default),
        longContext: toTyped(prices.long_context),
      } : undefined,
    },
    ...(Array.isArray(raw.capabilities.supports.reasoning_effort)
      ? { supportedReasoningEfforts: raw.capabilities.supports.reasoning_effort, defaultReasoningEffort: 'medium' }
      : {}),
  };
}

test('typed listModels entries publish the same metadata contract as the worker does from raw entries', async () => {
  const typed = RAW_FIXTURE.list.map(typedModelInfo);
  const { deps, state } = makeDeps({ listModels: async () => typed });
  const service = createCopilotModelDiscoveryService(deps);
  const result = await service.refresh('boot');
  assert.equal(result.ok, true);
  assert.equal(result.models.length, 27);
  const snapshot = state.catalogUpdates[0];
  assert.equal(snapshot.source, 'server-discovery:boot');
  // Byte-for-byte what the worker builds from the raw records.
  const fromRaw = buildModelSnapshotFields(extractModelDescriptors(RAW_FIXTURE));
  assert.deepEqual(snapshot.models, fromRaw.models);
  assert.deepEqual(snapshot.contextLimitsByModel, fromRaw.contextLimitsByModel);
  assert.deepEqual(snapshot.modelMetadataByModel, fromRaw.modelMetadataByModel);
  assert.deepEqual(snapshot.modelMetadataByModel['gpt-5.4-mini'].supportedEfforts, ['none', 'low', 'medium', 'high', 'xhigh']);
  assert.equal(snapshot.modelMetadataByModel['claude-haiku-4.5'].supportedEfforts, null);
  assert.equal(snapshot.modelMetadataByModel['claude-haiku-4.5'].contextWindowTokens, 144_000);
  assert.equal(snapshot.modelMetadataByModel['gpt-5-mini'].vendor, 'Azure OpenAI');
});
