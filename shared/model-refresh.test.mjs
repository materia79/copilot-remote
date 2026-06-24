import test from 'node:test';
import assert from 'node:assert/strict';

import { selectModelIdsForVariantRefresh } from './model-refresh.mjs';

test('selectModelIdsForVariantRefresh prefers rpc snapshot models', () => {
  const result = selectModelIdsForVariantRefresh({
    snapshotModels: ['gpt-5.4-mini', 'claude-sonnet-4.6'],
    currentModel: 'gpt-5.4-mini',
    defaultModel: 'gpt-5.4-mini',
    helpModelIds: ['gemini-3-pro-preview'],
  });
  assert.equal(result.source, 'rpc-snapshot');
  assert.deepEqual(result.modelIds, ['gpt-5.4-mini', 'claude-sonnet-4.6']);
});

test('selectModelIdsForVariantRefresh falls back to help models', () => {
  const result = selectModelIdsForVariantRefresh({
    snapshotModels: [],
    currentModel: '',
    defaultModel: '',
    helpModelIds: ['gpt-5.4-mini', 'Enable this model to continue'],
  });
  assert.equal(result.source, 'copilot-help-manual-refresh');
  assert.deepEqual(result.modelIds, ['gpt-5.4-mini']);
});
