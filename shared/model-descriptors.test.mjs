import test from 'node:test';
import assert from 'node:assert/strict';

import { extractModelDescriptors } from './model-descriptors.mjs';

test('extractModelDescriptors does not leak a sibling model context window', () => {
  const descriptors = extractModelDescriptors({
    id: 'gpt-5.4',
    data: [{ id: 'gpt-5.4-mini', contextWindow: 8000 }],
  });
  const byId = new Map(descriptors.map((entry) => [entry.modelId, entry]));
  assert.deepEqual([...byId.keys()], ['gpt-5.4', 'gpt-5.4-mini']);
  assert.equal(byId.get('gpt-5.4').contextLimitTokens, null);
  assert.equal(byId.get('gpt-5.4-mini').contextLimitTokens, 8000);
});

test('extractModelDescriptors still finds a model own nested context window', () => {
  const [descriptor] = extractModelDescriptors({
    id: 'gpt-5.4',
    capabilities: { contextWindow: 128000 },
  });
  assert.equal(descriptor.contextLimitTokens, 128000);
});

test('extractModelDescriptors treats batchSize-only pricing as no pricing', () => {
  const [descriptor] = extractModelDescriptors({
    id: 'gpt-5.4',
    tokenPrices: { batchSize: 1000000 },
  });
  assert.equal(descriptor.pricing.default, null);
});

test('extractModelDescriptors keeps pricing when a real rate is present', () => {
  const [descriptor] = extractModelDescriptors({
    id: 'gpt-5.4',
    tokenPrices: { inputPrice: 1.25, batchSize: 1000000 },
  });
  assert.deepEqual(descriptor.pricing.default, {
    input: 1.25,
    output: null,
    cacheRead: null,
    cacheWrite: null,
    batchSize: 1000000,
  });
});

// ── The live raw catalog (rpc.model.list(), runtime 1.0.83, 2026-09-07) ──────

import fs from 'node:fs';
import {
  KNOWN_REASONING_EFFORTS,
  buildModelSnapshotFields,
  modelMetadataFromDescriptor,
  supportedEffortsOf,
} from './model-descriptors.mjs';

const FIXTURE = JSON.parse(fs.readFileSync(new URL('./fixtures/copilot-catalog-raw-2026-09-07.json', import.meta.url), 'utf8'));
const byId = () => new Map(extractModelDescriptors(FIXTURE).map((entry) => [entry.modelId, entry]));

test('the raw fixture yields one descriptor per catalog entry', () => {
  const descriptors = extractModelDescriptors(FIXTURE);
  assert.equal(descriptors.length, 27);
  assert.deepEqual(descriptors.map((entry) => entry.modelId), FIXTURE.list.map((entry) => entry.id));
});

test('raw entries carry the per-model efforts exactly as the runtime lists them', () => {
  const map = byId();
  assert.deepEqual(map.get('gpt-5.4-mini').supportedEfforts, ['none', 'low', 'medium', 'high', 'xhigh']);
  assert.deepEqual(map.get('gpt-5.6-terra').supportedEfforts, ['none', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(map.get('claude-sonnet-5').supportedEfforts, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(map.get('gemini-3.6-flash').supportedEfforts, ['minimal', 'low', 'medium', 'high']);
  assert.deepEqual(map.get('kimi-k3').supportedEfforts, ['low', 'high', 'max']);
  // Effort-less models: the list is absent, not empty.
  assert.equal(map.get('claude-haiku-4.5').supportedEfforts, null);
  assert.equal(map.get('kimi-k2.7-code').supportedEfforts, null);
  // Every advertised level is in the shared vocabulary.
  for (const entry of map.values()) {
    for (const effort of entry.supportedEfforts || []) assert.ok(KNOWN_REASONING_EFFORTS.includes(effort), effort);
  }
});

test('the real context window is read and caps the prompt+output budget', () => {
  const map = byId();
  // haiku advertises 128000 prompt + 32000 output but a 144000 window.
  assert.equal(map.get('claude-haiku-4.5').contextWindowTokens, 144_000);
  assert.equal(map.get('claude-haiku-4.5').contextLimitTokens, 144_000);
  assert.equal(map.get('claude-haiku-4.5').maxPromptTokens, 128_000);
  assert.equal(map.get('gpt-5.4-mini').contextWindowTokens, 400_000);
  assert.equal(map.get('gpt-5.4-mini').contextLimitTokens, 400_000);
  // Tiered models keep their default-tier budget below the window.
  assert.equal(map.get('gpt-5.6-terra').contextWindowTokens, 1_050_000);
  assert.equal(map.get('gpt-5.6-terra').contextLimitTokens, 400_000);
  assert.equal(map.get('gpt-5.6-terra').longContextLimitTokens, 1_050_000);
  assert.equal(map.get('gpt-5.6-terra').maxPromptTokens, 922_000);
});

test('snake_case billing yields long-context limits and pricing', () => {
  const map = byId();
  const terra = map.get('gpt-5.6-terra');
  assert.deepEqual(terra.pricing.default, { input: 200, output: 1200, cacheRead: 20, cacheWrite: 250, batchSize: 1_000_000 });
  assert.deepEqual(terra.pricing.longContext, { input: 400, output: 1800, cacheRead: 40, cacheWrite: 500, batchSize: 1_000_000 });
  const mini = map.get('gpt-5.4-mini');
  assert.equal(mini.longContextLimitTokens, null);
  assert.equal(mini.pricing.longContext, null);
  assert.equal(mini.pricing.default.input, 75);
  // Every fixture model prices its default tier.
  for (const entry of map.values()) assert.ok(entry.pricing.default, entry.modelId);
});

test('raw entries carry display name, vendor, picker category and preview', () => {
  const map = byId();
  assert.equal(map.get('gpt-5.4-mini').displayName, 'GPT-5.4 mini');
  assert.equal(map.get('gpt-5.4-mini').vendor, 'OpenAI');
  assert.equal(map.get('gpt-5.4-mini').pickerCategory, 'lightweight');
  assert.equal(map.get('gpt-5-mini').vendor, 'Azure OpenAI');
  assert.equal(map.get('claude-opus-4.8-fast').preview, true);
  assert.equal(map.get('claude-opus-4.8').preview, false);
  assert.equal(map.get('kimi-k3').vendor, 'Moonshot AI');
  assert.equal(map.get('grok-4.6').vendor, 'xAI');
  assert.equal(map.get('gemini-3.8-flash').pickerCategory, 'versatile');
});

test('modelMetadataFromDescriptor emits every contract field, catalogIndex unassigned', () => {
  const metadata = modelMetadataFromDescriptor(byId().get('gpt-5.4-mini'));
  assert.deepEqual(Object.keys(metadata), [
    'defaultContextLimitTokens', 'longContextLimitTokens', 'pricing',
    'displayName', 'vendor', 'pickerCategory', 'preview',
    'contextWindowTokens', 'maxPromptTokens', 'supportedEfforts', 'catalogIndex',
  ]);
  assert.equal(metadata.defaultContextLimitTokens, 400_000);
  assert.equal(metadata.contextWindowTokens, 400_000);
  assert.equal(metadata.catalogIndex, null);
  assert.deepEqual(metadata.supportedEfforts, ['none', 'low', 'medium', 'high', 'xhigh']);
  // A bare id descriptor still produces the full shape.
  const bare = modelMetadataFromDescriptor({ modelId: 'gpt-x' });
  assert.equal(bare.supportedEfforts, null);
  assert.equal(bare.preview, false);
  assert.equal(bare.vendor, null);
});

test('the typed client-level ModelInfo shape yields the same metadata as the raw record', () => {
  const raw = FIXTURE.list.find((entry) => entry.id === 'gpt-5.6-terra');
  // What client.listModels() returns for the same model: camelCase billing,
  // typed effort list, the same snake_case limits block.
  const typed = {
    id: raw.id,
    name: raw.name,
    vendor: raw.vendor,
    preview: raw.preview,
    modelPickerCategory: raw.model_picker_category,
    capabilities: {
      supports: { vision: true, reasoningEffort: true },
      limits: { ...raw.capabilities.limits },
    },
    billing: {
      multiplier: 1,
      tokenPrices: {
        batchSize: raw.billing.token_prices.batch_size,
        inputPrice: raw.billing.token_prices.default.input_price,
        outputPrice: raw.billing.token_prices.default.output_price,
        cacheReadPrice: raw.billing.token_prices.default.cache_read_price,
        cacheWritePrice: raw.billing.token_prices.default.cache_write_price,
        maxPromptTokens: raw.billing.token_prices.default.max_prompt_tokens,
        longContext: {
          inputPrice: raw.billing.token_prices.long_context.input_price,
          outputPrice: raw.billing.token_prices.long_context.output_price,
          cacheReadPrice: raw.billing.token_prices.long_context.cache_read_price,
          cacheWritePrice: raw.billing.token_prices.long_context.cache_write_price,
          maxPromptTokens: raw.billing.token_prices.long_context.max_prompt_tokens,
        },
      },
    },
    supportedReasoningEfforts: raw.capabilities.supports.reasoning_effort,
    defaultReasoningEffort: 'medium',
  };
  const [fromRaw] = extractModelDescriptors(raw);
  const [fromTyped] = extractModelDescriptors(typed);
  assert.deepEqual(modelMetadataFromDescriptor(fromTyped), modelMetadataFromDescriptor(fromRaw));
  assert.deepEqual(supportedEffortsOf(typed), supportedEffortsOf(raw));
});

test('buildModelSnapshotFields publishes the snapshot triple every producer sends', () => {
  const fields = buildModelSnapshotFields(extractModelDescriptors(FIXTURE));
  assert.deepEqual(Object.keys(fields), ['models', 'contextLimitsByModel', 'modelMetadataByModel']);
  assert.equal(fields.models.length, 27);
  assert.equal(fields.contextLimitsByModel['claude-haiku-4.5'], 144_000);
  assert.equal(fields.modelMetadataByModel['gemini-3.6-flash'].supportedEfforts.includes('minimal'), true);
  assert.equal(fields.modelMetadataByModel['claude-haiku-4.5'].supportedEfforts, null);
  assert.equal(fields.modelMetadataByModel['gpt-6-astra'].vendor, 'OpenAI');
});

test('supportedEffortsOf reads both shapes and normalizes case', () => {
  assert.deepEqual(supportedEffortsOf({ supportedReasoningEfforts: ['Low', ' HIGH '] }), ['low', 'high']);
  assert.deepEqual(supportedEffortsOf({ capabilities: { supports: { reasoning_effort: ['none', 'max'] } } }), ['none', 'max']);
  assert.equal(supportedEffortsOf({ id: 'x' }), null);
  assert.equal(supportedEffortsOf(null), null);
});
