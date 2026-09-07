import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  compareCopilotModels,
  copilotCatalogIndexByModel,
  copilotModelSortKey,
  inferCopilotVendor,
  parseModelVersion,
  sortCopilotModels,
} from './copilot-model-order.mjs';
import { extractModelDescriptors } from './model-descriptors.mjs';

const FIXTURE = JSON.parse(fs.readFileSync(new URL('./fixtures/copilot-catalog-raw-2026-09-07.json', import.meta.url), 'utf8'));

/** The order a Copilot picker shows the 2026-09-07 live catalog in. */
const EXPECTED_ORDER = [
  // OpenAI, newest first; 5.6 siblings by picker category; 5.4 before 5.4 mini.
  'gpt-6-astra',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.3-codex',
  // Anthropic: 5.1 > 5 (Fable before Opus alphabetically, Sonnet is versatile),
  // 4.8 before its preview fast-mode twin, then 4.7, then the lightweight 4.5.
  'claude-fable-5.1',
  'claude-fable-5',
  'claude-opus-5',
  'claude-sonnet-5',
  'claude-opus-4.8',
  'claude-opus-4.8-fast',
  'claude-opus-4.7',
  'claude-haiku-4.5',
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'grok-4.6',
  'grok-4.5',
  'mai-code-1.1-flash',
  'mai-code-1-flash-picker',
  // "Azure OpenAI" is its own vendor, after Microsoft.
  'gpt-5-mini',
  'kimi-k3',
  'kimi-k2.7-code',
];

test('sortCopilotModels orders the live raw catalog canonically', () => {
  const descriptors = extractModelDescriptors(FIXTURE);
  assert.equal(descriptors.length, 27);
  assert.deepEqual(sortCopilotModels(descriptors).map((entry) => entry.modelId), EXPECTED_ORDER);
});

test('sortCopilotModels is pure and stable', () => {
  const descriptors = extractModelDescriptors(FIXTURE);
  const before = descriptors.map((entry) => entry.modelId);
  const sorted = sortCopilotModels(descriptors);
  assert.notEqual(sorted, descriptors);
  assert.deepEqual(descriptors.map((entry) => entry.modelId), before, 'input array untouched');
  assert.deepEqual(sortCopilotModels(sorted).map((entry) => entry.modelId), EXPECTED_ORDER, 'idempotent');
  // Reversed input, same output.
  assert.deepEqual(sortCopilotModels([...descriptors].reverse()).map((entry) => entry.modelId), EXPECTED_ORDER);
});

test('auto sorts first regardless of where it appears', () => {
  const sorted = sortCopilotModels([{ modelId: 'gpt-5.4' }, { modelId: 'claude-opus-5' }, { modelId: 'auto' }]);
  assert.deepEqual(sorted.map((entry) => entry.modelId), ['auto', 'gpt-5.4', 'claude-opus-5']);
});

test('parseModelVersion reads the first dotted number and compares segment-wise', () => {
  assert.deepEqual(parseModelVersion('gpt-5.6-terra'), [5, 6]);
  assert.deepEqual(parseModelVersion('gpt-6-astra'), [6]);
  assert.deepEqual(parseModelVersion('claude-opus-4.8-fast'), [4, 8]);
  assert.deepEqual(parseModelVersion('kimi-k3'), [3]);
  assert.deepEqual(parseModelVersion('mai-code-1.1-flash'), [1, 1]);
  assert.deepEqual(parseModelVersion('gpt-5.10'), [5, 10]);
  assert.equal(parseModelVersion('auto'), null);
  // 5.10 is newer than 5.9 (numeric, not lexical); 5.1 is newer than 5.
  assert.ok(compareCopilotModels({ modelId: 'gpt-5.10' }, { modelId: 'gpt-5.9' }) < 0);
  assert.ok(compareCopilotModels({ modelId: 'claude-fable-5.1' }, { modelId: 'claude-fable-5' }) < 0);
});

test('vendor rank uses the runtime vendor, inferring one only from bare ids', () => {
  assert.equal(inferCopilotVendor('gpt-5-mini'), 'OpenAI');
  assert.equal(inferCopilotVendor('grok-4.6'), 'xAI');
  assert.equal(inferCopilotVendor('kimi-k3'), 'Moonshot AI');
  assert.equal(inferCopilotVendor('mai-code-1.1-flash'), 'Microsoft');
  assert.equal(inferCopilotVendor('o1'), 'OpenAI');
  assert.equal(inferCopilotVendor('mystery-1'), null);
  // The runtime says gpt-5-mini is served by Azure OpenAI: that wins.
  assert.equal(copilotModelSortKey({ modelId: 'gpt-5-mini', vendor: 'Azure OpenAI' }).vendor, 'Azure OpenAI');
  assert.equal(copilotModelSortKey({ modelId: 'gpt-5-mini' }).vendor, 'OpenAI');
});

test('unknown vendors go after the ranked ones, alphabetically', () => {
  const sorted = sortCopilotModels([
    { modelId: 'zeta-2', vendor: 'Zeta Labs' },
    { modelId: 'alpha-9', vendor: 'Alpha Corp' },
    { modelId: 'kimi-k3', vendor: 'Moonshot AI' },
    { modelId: 'mystery-1' },
  ]);
  assert.deepEqual(sorted.map((entry) => entry.modelId), ['kimi-k3', 'alpha-9', 'zeta-2', 'mystery-1']);
});

test('ties break by picker category, then preview, then natural display name', () => {
  const sorted = sortCopilotModels([
    { modelId: 'gpt-7-b', vendor: 'OpenAI', pickerCategory: 'lightweight', displayName: 'GPT-7 B' },
    { modelId: 'gpt-7-a-preview', vendor: 'OpenAI', pickerCategory: 'powerful', preview: true, displayName: 'GPT-7 A' },
    { modelId: 'gpt-7-c', vendor: 'OpenAI', pickerCategory: 'powerful', displayName: 'GPT-7 C' },
    { modelId: 'gpt-7-a', vendor: 'OpenAI', pickerCategory: 'powerful', displayName: 'GPT-7 A' },
    { modelId: 'gpt-7-x', vendor: 'OpenAI', displayName: 'GPT-7 X' },
    { modelId: 'gpt-7-v', vendor: 'OpenAI', pickerCategory: 'versatile', displayName: 'GPT-7 V' },
  ]);
  assert.deepEqual(sorted.map((entry) => entry.modelId), [
    'gpt-7-a', 'gpt-7-c', 'gpt-7-a-preview', 'gpt-7-v', 'gpt-7-b', 'gpt-7-x',
  ]);
});

test('copilotCatalogIndexByModel numbers the canonical order from zero', () => {
  const index = copilotCatalogIndexByModel(extractModelDescriptors(FIXTURE));
  assert.equal(index.get('gpt-6-astra'), 0);
  assert.equal(index.get('gpt-5.4-mini'), 6);
  assert.equal(index.get('kimi-k2.7-code'), 26);
  assert.equal(index.size, 27);
});

test('descriptor-less inputs (strings, ids) still sort', () => {
  assert.deepEqual(sortCopilotModels(['claude-opus-5', 'gpt-5.4', '', 'auto']), ['auto', 'gpt-5.4', 'claude-opus-5']);
});
