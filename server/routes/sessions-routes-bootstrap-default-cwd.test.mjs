import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveBootstrapModelSelection,
  parseDefaultSessionWorkspaceRootUpdateRequest,
} from './sessions-routes.mjs';

test('resolveBootstrapModelSelection prefers requested model when supported', () => {
  const selected = resolveBootstrapModelSelection({
    requestedModel: 'gpt-5.4-mini',
    modelState: { models: ['gpt-5.4-mini', 'claude-4-sonnet'], currentModel: 'claude-4-sonnet' },
    defaultModel: 'gpt-5.4-mini',
  });
  assert.equal(selected, 'gpt-5.4-mini');
});

test('resolveBootstrapModelSelection falls back to current/default model', () => {
  const selectedCurrent = resolveBootstrapModelSelection({
    requestedModel: 'unknown-model',
    modelState: { models: ['gpt-5.4-mini'], currentModel: 'gpt-5.4-mini', defaultModel: 'gpt-5.4-mini' },
    defaultModel: 'gpt-5.4-mini',
  });
  assert.equal(selectedCurrent, 'gpt-5.4-mini');

  const selectedFallback = resolveBootstrapModelSelection({
    requestedModel: '',
    modelState: { models: [] },
    defaultModel: 'gpt-5.4-mini',
  });
  assert.equal(selectedFallback, 'gpt-5.4-mini');
});

test('parseDefaultSessionWorkspaceRootUpdateRequest reads supported body aliases', () => {
  const parsed = parseDefaultSessionWorkspaceRootUpdateRequest({
    default_session_workspace_root_path: 'C:\\dev\\project',
  });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.clearRequested, false);
  assert.equal(parsed.rootPath, 'C:\\dev\\project');
});

test('parseDefaultSessionWorkspaceRootUpdateRequest supports explicit clear', () => {
  const parsed = parseDefaultSessionWorkspaceRootUpdateRequest({ clear: true });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.clearRequested, true);
  assert.equal(parsed.rootPath, '');
});

test('parseDefaultSessionWorkspaceRootUpdateRequest rejects missing payload value', () => {
  const parsed = parseDefaultSessionWorkspaceRootUpdateRequest({});
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error, 'Missing rootPath');
});
