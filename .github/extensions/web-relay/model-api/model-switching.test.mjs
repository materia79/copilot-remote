import test from 'node:test';
import assert from 'node:assert/strict';

import { createModelSwitchingService, extractModelDescriptors } from './model-switching.mjs';

test('extractModelDescriptors keeps context limits from model RPC descriptors', () => {
  const descriptors = extractModelDescriptors({
    models: [
      { modelId: 'gpt-5.6-terra', capabilities: { limits: { max_context_window_tokens: 1050000, max_output_tokens: 16000 } }, billing: { tokenPrices: { batchSize: 1000000, maxPromptTokens: 312000, inputPrice: 100, outputPrice: 600, cacheReadPrice: 10, cacheWritePrice: 125, longContext: { maxPromptTokens: 1084000, inputPrice: 200, outputPrice: 1200 } } } },
      { id: 'claude-sonnet-4.6', capabilities: { maxContextTokens: '200000' } },
      { model: 'gemini-3.5-flash' },
      { modelId: 'not-a-model', contextWindow: 42 },
    ],
  });

  assert.deepEqual(descriptors, [
    { modelId: 'gpt-5.6-terra', contextLimitTokens: 328000, longContextLimitTokens: 1100000, pricing: { default: { input: 100, output: 600, cacheRead: 10, cacheWrite: 125, batchSize: 1000000 }, longContext: { input: 200, output: 1200, cacheRead: null, cacheWrite: null, batchSize: 1000000 } } },
    { modelId: 'claude-sonnet-4.6', contextLimitTokens: 200000, longContextLimitTokens: null, pricing: { default: null, longContext: null } },
    { modelId: 'gemini-3.5-flash', contextLimitTokens: null, longContextLimitTokens: null, pricing: { default: null, longContext: null } },
  ]);
});

test('createModelSwitchingService prefers models.list metadata over fallback session lists', async () => {
  const richModelsPayload = {
    models: [
      {
        id: 'gpt-5.6-luna',
        capabilities: { limits: { max_context_window_tokens: 1050000, max_output_tokens: 16000 } },
        billing: {
          tokenPrices: {
            batchSize: 1000000,
            maxPromptTokens: 312000,
            inputPrice: 100,
            outputPrice: 600,
            longContext: { maxPromptTokens: 1084000, inputPrice: 200, outputPrice: 1200 },
          },
        },
      },
    ],
  };
  const lowFidelityPayload = {
    list: [
      {
        id: 'gpt-5.6-luna',
        capabilities: { limits: { max_context_window_tokens: 1050000 } },
      },
    ],
  };
  const session = {
    connection: {
      sendRequest: async (method) => {
        if (method === 'models.list') return richModelsPayload;
        throw new Error(`Unexpected method ${method}`);
      },
    },
    rpc: {
      model: {
        list: async () => lowFidelityPayload,
      },
    },
  };
  const service = createModelSwitchingService({
    api: async () => ({}),
    dbg: () => {},
    getSession: () => session,
    modelSnapshotMinIntervalMs: 0,
  });

  const models = await service.getAvailableModels();
  assert.deepEqual(models, [
    {
      modelId: 'gpt-5.6-luna',
      contextLimitTokens: 328000,
      longContextLimitTokens: 1100000,
      pricing: {
        default: { input: 100, output: 600, cacheRead: null, cacheWrite: null, batchSize: 1000000 },
        longContext: { input: 200, output: 1200, cacheRead: null, cacheWrite: null, batchSize: 1000000 },
      },
    },
  ]);
});
