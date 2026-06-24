import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isValidModelId,
  canonicalizeModelId,
  filterValidModelIds,
} from './model-id.mjs';

test('isValidModelId accepts canonical model ids', () => {
  assert.equal(isValidModelId('gpt-5.4-mini'), true);
  assert.equal(isValidModelId('claude-sonnet-4.6'), true);
  assert.equal(isValidModelId('openai/codex-5.3'), true);
  assert.equal(isValidModelId('gpt-5.4'), true);
  assert.equal(isValidModelId('anthropic/claude-sonnet-4.6'), true);
  assert.equal(isValidModelId('openai/gpt-5.4'), true);
});

test('isValidModelId rejects explanatory/non-model text', () => {
  assert.equal(isValidModelId('Requires enablement. Accept in settings.'), false);
  assert.equal(isValidModelId('Enable this model or pick a different one'), false);
  assert.equal(isValidModelId('https://github.com/settings/copilot/features'), false);
  assert.equal(isValidModelId('requires enablement'), false);
  assert.equal(isValidModelId('pick a different one'), false);
  assert.equal(isValidModelId('http://example.com'), false);
  assert.equal(isValidModelId('https://example.com/models'), false);
});

test('isValidModelId enforces length boundaries', () => {
  const validAtBoundary = `gpt-${'a'.repeat(116)}`;
  const invalidOverBoundary = `gpt-${'a'.repeat(117)}`;
  assert.equal(validAtBoundary.length, 120);
  assert.equal(invalidOverBoundary.length, 121);
  assert.equal(isValidModelId(validAtBoundary), true);
  assert.equal(isValidModelId(invalidOverBoundary), false);
});

test('isValidModelId rejects empty and malformed ids', () => {
  assert.equal(isValidModelId(''), false);
  assert.equal(isValidModelId('   '), false);
  assert.equal(isValidModelId('-gpt-5.4'), false);
  assert.equal(isValidModelId('gpt-5.4-'), false);
  assert.equal(isValidModelId('gpt'), false);
  assert.equal(isValidModelId('copilot-model-1'), false);
  assert.equal(isValidModelId('model:gpt-5.4'), false);
  assert.equal(isValidModelId('gpt 5.4'), false);
  assert.equal(isValidModelId('gpt@5.4'), false);
});

test('isValidModelId is case-insensitive for prefixes', () => {
  assert.equal(isValidModelId('GPT-5.4-MINI'), true);
  assert.equal(isValidModelId('OpenAI/GPT-5.4'), true);
});

test('isValidModelId deny-list substrings reject suspicious values', () => {
  assert.equal(isValidModelId('gpt-5.4-policy'), false);
  assert.equal(isValidModelId('gpt-5.4-settings'), false);
  assert.equal(isValidModelId('gpt-5.4-accept'), false);
  assert.equal(isValidModelId('gpt-5.4-not-authorized'), false);
  assert.equal(isValidModelId('gpt-5.4-missing-required-authentication'), false);
});

test('filterValidModelIds keeps only valid deduped ids', () => {
  const result = filterValidModelIds([
    'gpt-5.4-mini',
    'gpt-5.4-mini',
    'Enable this model',
    'claude-sonnet-4.6',
  ]);
  assert.deepEqual(result, ['gpt-5.4-mini', 'claude-sonnet-4.6']);
});

test('filterValidModelIds preserves first-seen ordering', () => {
  const result = filterValidModelIds([
    'openai/gpt-5.4',
    'gpt-5.4-mini',
    'openai/gpt-5.4',
    'claude-sonnet-4.6',
  ]);
  assert.deepEqual(result, ['gpt-5.4', 'gpt-5.4-mini', 'claude-sonnet-4.6']);
});

test('canonicalizeModelId normalizes provider-prefixed and cased ids', () => {
  assert.equal(canonicalizeModelId('OpenAI/GPT-5.4'), 'gpt-5.4');
  assert.equal(canonicalizeModelId('ANTHROPIC/claude-sonnet-4.6'), 'claude-sonnet-4.6');
  assert.equal(canonicalizeModelId('GPT-5.3-Codex'), 'gpt-5.3-codex');
});

test('filterValidModelIds dedupes case and provider aliases', () => {
  const result = filterValidModelIds([
    'GPT-5.4',
    'openai/gpt-5.4',
    'gpt-5.4',
    'claude-sonnet-4.6',
    'anthropic/claude-sonnet-4.6',
  ]);
  assert.deepEqual(result, ['gpt-5.4', 'claude-sonnet-4.6']);
});
