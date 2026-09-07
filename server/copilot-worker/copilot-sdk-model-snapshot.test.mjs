// Worker-published model-catalog snapshots (Phase 5A): with the extension
// retired, the SDK worker is one of the two publishers that keep the relay's
// `/api/models/snapshot` catalog populated (the server-side discovery service
// is the other). Spawn-free per DEVELOPING.md — everything runs against the
// fake client in the shared harness.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  baseMessage,
  createFakeCopilotClient,
  loadFixture,
  makeApiStub,
  makeRunner,
} from './copilot-sdk-test-harness.mjs';

/** A runtime catalog shaped like `rpc.model.list()`'s ModelInfo entries. */
const CATALOG = [
  {
    id: 'gpt-5-mini',
    name: 'GPT-5 mini',
    capabilities: { limits: { max_prompt_tokens: 100_000, max_output_tokens: 16_000 } },
  },
  {
    id: 'gpt-5.4',
    name: 'GPT-5.4',
    supportedReasoningEfforts: ['low', 'medium', 'high'],
    defaultReasoningEffort: 'medium',
  },
];

function setup({ clientOptions = {}, ...overrides } = {}) {
  const stub = makeApiStub(overrides.apiStubOptions);
  delete overrides.apiStubOptions;
  const client = createFakeCopilotClient({
    onSend: (session) => session.replay(loadFixture('happy-turn')),
    modelRpc: { catalog: CATALOG },
    ...clientOptions,
  });
  const { runner } = makeRunner({ stub, client, ...overrides });
  return { stub, client, runner };
}

const snapshotsOf = (stub) => stub.bodiesFor('/api/models/snapshot');

test('a created session publishes the cached catalog as a session-start snapshot', async () => {
  const { stub, client, runner } = setup();
  await runner.handlePendingPayload({ message: baseMessage });
  await runner.whenModelSnapshotPosted();

  const snapshots = snapshotsOf(stub);
  assert.equal(snapshots.length, 1);
  const body = snapshots[0];
  assert.equal(body.source, 'copilot-sdk-worker:session-start');
  assert.deepEqual(body.models, ['gpt-5-mini', 'gpt-5.4']);
  // The applied model, exactly as the extension reports its current model.
  assert.equal(body.currentModel, 'gpt-5-mini');
  assert.equal(body.defaultModel, 'gpt-5-mini');
  assert.equal(body.error, null);
  // Context limit = prompt + output budget, per the shared descriptor rules.
  assert.equal(body.contextLimitsByModel['gpt-5-mini'], 116_000);
  assert.equal(body.modelMetadataByModel['gpt-5.4'].defaultContextLimitTokens, null);
  // The switcher's single per-session list() serves the snapshot too: the
  // publish must not add a second RPC.
  assert.equal(client.session.rpc.model.listCalls, 1);
});

test('a resumed session tags its snapshot session-resume', async () => {
  const { stub, runner } = setup({ clientOptions: { resumeAvailable: true } });
  await runner.handlePendingPayload({ message: baseMessage });
  await runner.whenModelSnapshotPosted();

  const snapshots = snapshotsOf(stub);
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].source, 'copilot-sdk-worker:session-resume');
});

test('a live session.model_change re-publishes with the new current model', async () => {
  const { stub, client, runner } = setup();
  await runner.handlePendingPayload({ message: baseMessage });
  await runner.whenModelSnapshotPosted();
  assert.equal(snapshotsOf(stub).length, 1);

  client.session.emit({ type: 'session.model_change', data: { newModel: 'gpt-5.4', reasoningEffort: 'medium' } });
  await runner.whenModelSnapshotPosted();

  const snapshots = snapshotsOf(stub);
  assert.equal(snapshots.length, 2);
  assert.equal(snapshots[1].source, 'copilot-sdk-worker:model-change');
  assert.equal(snapshots[1].currentModel, 'gpt-5.4');
  // The model list itself did not change, only the current model.
  assert.deepEqual(snapshots[1].models, ['gpt-5-mini', 'gpt-5.4']);
});

test('an unchanged catalog is not re-posted', async () => {
  const { stub, client, runner } = setup();
  await runner.handlePendingPayload({ message: baseMessage });
  await runner.whenModelSnapshotPosted();

  // Same model, same catalog: content-identical, so the dedupe must hold it.
  client.session.emit({ type: 'session.model_change', data: { newModel: 'gpt-5-mini' } });
  await runner.whenModelSnapshotPosted();
  assert.equal(snapshotsOf(stub).length, 1);

  // A real change posts; repeating that change does not.
  client.session.emit({ type: 'session.model_change', data: { newModel: 'gpt-5.4' } });
  await runner.whenModelSnapshotPosted();
  client.session.emit({ type: 'session.model_change', data: { newModel: 'gpt-5.4' } });
  await runner.whenModelSnapshotPosted();
  assert.equal(snapshotsOf(stub).length, 2);
});

test('BYOK sessions publish no snapshot at all', async () => {
  const { stub, runner } = setup({
    // The provider block marks the session BYOK: its model list is the
    // OpenAI-compatible endpoint's, not the Copilot catalog.
    resolveProviderConfigImpl: () => ({
      type: 'openai',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'test-not-a-real-key',
    }),
  });
  await runner.handlePendingPayload({ message: baseMessage });
  await runner.whenModelSnapshotPosted();

  assert.equal(snapshotsOf(stub).length, 0);
});

test('a runtime that refuses the list yields no snapshot, not a failed one', async () => {
  const { stub, runner } = setup({
    clientOptions: { modelRpc: { list: async () => { throw new Error('list refused'); } } },
  });
  assert.equal(await runner.handlePendingPayload({ message: baseMessage }), true);
  await runner.whenModelSnapshotPosted();

  // Unlike the extension, the worker never posts error-only snapshots: the
  // relay-side catalog keeps whatever it already has.
  assert.equal(snapshotsOf(stub).length, 0);
});

test('a failed snapshot POST is swallowed and retried on the next trigger', async () => {
  const failRoutes = new Set(['/api/models/snapshot']);
  const { stub, client, runner } = setup({ apiStubOptions: { failRoutes } });

  assert.equal(await runner.handlePendingPayload({ message: baseMessage }), true);
  await runner.whenModelSnapshotPosted();
  // The turn itself is untouched by the snapshot failure.
  assert.equal(stub.bodiesFor('/api/response').length, 1);
  assert.equal(stub.calls.filter((c) => c.routePath === '/api/models/snapshot').length, 1);

  // The failure was not recorded as published, so an otherwise-unchanged
  // catalog posts again once the relay recovers.
  failRoutes.delete('/api/models/snapshot');
  client.session.emit({ type: 'session.model_change', data: { newModel: 'gpt-5-mini' } });
  await runner.whenModelSnapshotPosted();
  assert.equal(snapshotsOf(stub).length, 2);
});

// ── The metadata contract, from the live raw catalog ─────────────────────────

import fs from 'node:fs';

const RAW_FIXTURE = JSON.parse(fs.readFileSync(new URL('../../shared/fixtures/copilot-catalog-raw-2026-09-07.json', import.meta.url), 'utf8'));

test('a raw rpc.model.list() catalog publishes the full per-model metadata contract', async () => {
  const { stub, runner } = setup({ clientOptions: { modelRpc: { catalog: RAW_FIXTURE.list } } });
  await runner.handlePendingPayload({ message: baseMessage });
  await runner.whenModelSnapshotPosted();

  const [body] = snapshotsOf(stub);
  // The seven keys the route reads, nothing else.
  assert.deepEqual(Object.keys(body).sort(), ['contextLimitsByModel', 'currentModel', 'defaultModel', 'error', 'modelMetadataByModel', 'models', 'source']);
  assert.equal(body.models.length, 27);
  assert.ok(body.models.includes('grok-4.6') && body.models.includes('kimi-k3'));
  const mini = body.modelMetadataByModel['gpt-5.4-mini'];
  assert.deepEqual(Object.keys(mini), [
    'defaultContextLimitTokens', 'longContextLimitTokens', 'pricing',
    'displayName', 'vendor', 'pickerCategory', 'preview',
    'contextWindowTokens', 'maxPromptTokens', 'supportedEfforts', 'catalogIndex',
  ]);
  assert.equal(mini.displayName, 'GPT-5.4 mini');
  assert.equal(mini.vendor, 'OpenAI');
  assert.equal(mini.pickerCategory, 'lightweight');
  assert.equal(mini.contextWindowTokens, 400_000);
  assert.equal(mini.maxPromptTokens, 272_000);
  assert.deepEqual(mini.supportedEfforts, ['none', 'low', 'medium', 'high', 'xhigh']);
  assert.equal(mini.catalogIndex, null, 'the relay assigns the index, not the worker');
  assert.equal(body.modelMetadataByModel['claude-haiku-4.5'].supportedEfforts, null);
  assert.equal(body.contextLimitsByModel['claude-haiku-4.5'], 144_000);
  assert.deepEqual(body.modelMetadataByModel['gemini-3.6-flash'].supportedEfforts, ['minimal', 'low', 'medium', 'high']);
  assert.equal(body.modelMetadataByModel['claude-opus-4.8-fast'].preview, true);
  assert.equal(body.modelMetadataByModel['gpt-5.6-terra'].pricing.longContext.input, 400);
});

test('a metadata-only change (same ids, same limits) still re-publishes', async () => {
  // Two catalogs with identical ids and context limits but a different effort
  // list: the dedupe signature must see the metadata, or a runtime that
  // changes a model's levels would never reach the relay.
  const catalogs = [
    [{ id: 'gpt-5.4', capabilities: { limits: { max_context_window_tokens: 400_000 }, supports: { reasoning_effort: ['low', 'high'] } } }],
    [{ id: 'gpt-5.4', capabilities: { limits: { max_context_window_tokens: 400_000 }, supports: { reasoning_effort: ['low', 'medium', 'high'] } } }],
  ];
  let calls = 0;
  const { stub, client, runner } = setup({
    clientOptions: { modelRpc: { list: async () => ({ list: catalogs[Math.min(calls++, 1)] }) } },
  });
  await runner.handlePendingPayload({ message: baseMessage });
  await runner.whenModelSnapshotPosted();
  assert.equal(snapshotsOf(stub).length, 1);
  assert.deepEqual(snapshotsOf(stub)[0].modelMetadataByModel['gpt-5.4'].supportedEfforts, ['low', 'high']);

  // A new session (resume) re-lists; the changed efforts must post again.
  client.session.emit({ type: 'session.model_change', data: { newModel: 'gpt-5.4' } });
  await runner.whenModelSnapshotPosted();
  const latest = snapshotsOf(stub).at(-1);
  assert.equal(latest.currentModel, 'gpt-5.4');
});
