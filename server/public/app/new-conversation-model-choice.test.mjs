import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildNewConversationModelChoices,
  newConversationContextTierState,
  reasoningChoicesForProviderModel,
  resolvePreferredReasoningEffort,
  shouldPromptForNewConversationModel,
} from './new-conversation-model-choice.mjs';

const CATALOG = {
  modelMetadataByModel: {
    // The relay caps the derived default tier at the runtime's real window.
    'gpt-5.4-mini': { defaultContextLimitTokens: 400000, contextWindowTokens: 400000 },
    'claude-opus-5': { defaultContextLimitTokens: 264000, contextWindowTokens: 264000, longContextLimitTokens: 1000000 },
    // No derived default at all: the real window is the fallback label.
    'gpt-5.6-terra': { contextWindowTokens: 1050000 },
  },
};

test('the modal shows a read-only context row for copilot models with a known window', () => {
  assert.deepEqual(newConversationContextTierState(CATALOG, { provider: 'github', modelId: 'gpt-5.4-mini' }), {
    visible: true,
    options: [{ value: 'default', label: '400K' }],
  });
  assert.deepEqual(newConversationContextTierState(CATALOG, { provider: 'github-copilot', modelId: 'gpt-5.6-terra' }), {
    visible: true,
    options: [{ value: 'default', label: '1.05M' }],
  });
  // Same options the composer chip offers, long tier included.
  assert.deepEqual(newConversationContextTierState(CATALOG, { provider: 'github', modelId: 'claude-opus-5' }).options, [
    { value: 'default', label: '264K' },
    { value: 'long_context', label: '1M' },
  ]);
});

test('the modal hides the context row for auto, unknown models and other providers', () => {
  assert.deepEqual(newConversationContextTierState(CATALOG, { provider: 'github', modelId: 'auto' }), { visible: false, options: [] });
  assert.deepEqual(newConversationContextTierState(CATALOG, { provider: 'github', modelId: 'mystery' }), { visible: false, options: [] });
  for (const provider of ['claude', 'openai', 'openai-byok', 'cursor', 'grok', '']) {
    assert.equal(newConversationContextTierState(CATALOG, { provider, modelId: 'gpt-5.4-mini' }).visible, false, provider);
  }
  assert.deepEqual(newConversationContextTierState({}, { provider: 'github', modelId: 'gpt-5.4-mini' }), { visible: false, options: [] });
});

test('the modal clamps a remembered effort the same way the composer does', () => {
  assert.equal(resolvePreferredReasoningEffort(['none', 'low', 'medium', 'high', 'xhigh'], ['max']), 'xhigh');
  assert.equal(resolvePreferredReasoningEffort(['minimal', 'low', 'medium', 'high'], ['minimal']), 'minimal');
  assert.equal(resolvePreferredReasoningEffort(['none', 'low', 'medium'], ['minimal']), 'low');
});

test('prompts for a new model while OpenAI is enabled', () => {
  assert.equal(shouldPromptForNewConversationModel({ provider: 'openai' }), true);
  assert.equal(shouldPromptForNewConversationModel({ provider: 'openai-byok' }), true);
  assert.equal(shouldPromptForNewConversationModel({ provider: 'openai-image' }), true);
  assert.equal(shouldPromptForNewConversationModel({ provider: 'github' }), false);
  assert.equal(shouldPromptForNewConversationModel({ provider: '' }), false);
});

test('new conversation choices exclude temporary runtime-locked models', () => {
  assert.deepEqual(buildNewConversationModelChoices([
    { value: 'auto', label: 'Auto' },
    { value: 'gpt-4o', label: 'GPT-4o' },
    { value: 'retired-model', label: 'Locked retired model', runtimeModelLock: true },
    { value: 'gpt-4o', label: 'Duplicate' },
  ]), [
    { value: 'auto', label: 'Auto' },
    { value: 'gpt-4o', label: 'GPT-4o' },
  ]);
});

test('resolves provider-specific reasoning choices for model selection modal', () => {
  assert.deepEqual(reasoningChoicesForProviderModel({
    reasoningByProvider: {
      openai: {
        'gpt-5.6': ['none', 'low', 'medium', 'high'],
      },
    },
    reasoningByModel: {
      'gpt-5.6': ['none'],
    },
  }, { provider: 'openai-byok', modelId: 'gpt-5.6' }), ['none', 'low', 'medium', 'high']);
});

test('prefers remembered reasoning effort and otherwise avoids none when possible', () => {
  assert.equal(
    resolvePreferredReasoningEffort(['none', 'low', 'medium'], ['high', 'medium']),
    'medium',
  );
  assert.equal(
    resolvePreferredReasoningEffort(['none', 'low', 'medium'], ['']),
    'low',
  );
});

test('ultracode is selectable when remembered but never a silent default', () => {
  const claudeLadder = ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultracode'];
  assert.equal(
    resolvePreferredReasoningEffort(claudeLadder, ['ultracode']),
    'ultracode',
  );
  // No stored preference: the first non-none tier wins, not the top rung.
  assert.equal(
    resolvePreferredReasoningEffort(claudeLadder, ['']),
    'low',
  );
});
