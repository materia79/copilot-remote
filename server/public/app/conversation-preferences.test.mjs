import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizePreferredModelsByMode,
  resolveConversationComposerSelection,
  withUpdatedModelPreference,
} from './conversation-preferences.mjs';

const MODES = ['ask', 'plan', 'agent', 'autopilot'];
const MODELS = ['gpt-5.4-mini', 'gpt-5.3-codex'];

test('normalizePreferredModelsByMode keeps only supported modes with non-empty models', () => {
  const normalized = normalizePreferredModelsByMode(
    { ask: 'gpt-5.3-codex', invalid: 'x', agent: '' },
    { supportedModes: MODES },
  );
  assert.deepEqual(normalized, { ask: 'gpt-5.3-codex' });
});

test('resolveConversationComposerSelection restores per-mode model for a conversation', () => {
  const selection = resolveConversationComposerSelection({
    preferredRelayMode: 'agent',
    preferredModelsByMode: {
      ask: 'gpt-5.4-mini',
      agent: 'gpt-5.3-codex',
    },
    selectedMode: 'ask',
    selectedModel: 'gpt-5.4-mini',
    supportedModes: MODES,
    supportedModels: MODELS,
    fallbackMode: 'agent',
    fallbackModel: 'gpt-5.4-mini',
  });
  assert.equal(selection.mode, 'agent');
  assert.equal(selection.model, 'gpt-5.3-codex');
});

test('resolveConversationComposerSelection falls back when saved model is unavailable', () => {
  const selection = resolveConversationComposerSelection({
    preferredRelayMode: 'autopilot',
    preferredModelsByMode: { autopilot: 'claude-sonnet-4.6' },
    selectedMode: 'autopilot',
    selectedModel: 'claude-sonnet-4.6',
    supportedModes: MODES,
    supportedModels: MODELS,
    fallbackMode: 'agent',
    fallbackModel: 'gpt-5.4-mini',
  });
  assert.equal(selection.mode, 'autopilot');
  assert.equal(selection.model, 'gpt-5.4-mini');
});

test('withUpdatedModelPreference updates one mode without affecting others', () => {
  const firstConversation = withUpdatedModelPreference({
    preferredModelsByMode: { ask: 'gpt-5.4-mini', agent: 'gpt-5.3-codex' },
    mode: 'ask',
    model: 'gpt-5.3-codex',
    supportedModes: MODES,
  });
  assert.deepEqual(firstConversation, {
    ask: 'gpt-5.3-codex',
    agent: 'gpt-5.3-codex',
  });

  const secondConversation = withUpdatedModelPreference({
    preferredModelsByMode: { ask: 'gpt-5.4-mini', agent: 'gpt-5.3-codex' },
    mode: 'plan',
    model: 'gpt-5.4-mini',
    supportedModes: MODES,
  });
  assert.deepEqual(secondConversation, {
    ask: 'gpt-5.4-mini',
    agent: 'gpt-5.3-codex',
    plan: 'gpt-5.4-mini',
  });
});
