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
