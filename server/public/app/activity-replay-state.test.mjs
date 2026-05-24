import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeRelayActivityTexts, shouldApplyConversationLoad } from './activity-replay-state.mjs';

test('mergeRelayActivityTexts keeps the richer cached chain when hydration is a subsequence', () => {
  const merged = mergeRelayActivityTexts(
    ['● Restarting relay', 'Tool (view): plan.md', 'Tool (powershell): command="Check relay status"'],
    ['Tool (view): plan.md', 'Tool (powershell): command="Check relay status"'],
  );
  assert.deepEqual(merged, [
    '● Restarting relay',
    'Tool (view): plan.md',
    'Tool (powershell): command="Check relay status"',
  ]);
});

test('mergeRelayActivityTexts upgrades cached partial history when hydration is richer', () => {
  const merged = mergeRelayActivityTexts(
    ['Tool (view): server.js', 'Tool (view): messages-routes.mjs'],
    ['● Restarting relay', 'Tool (view): server.js', 'Tool (view): messages-routes.mjs'],
  );
  assert.deepEqual(merged, [
    '● Restarting relay',
    'Tool (view): server.js',
    'Tool (view): messages-routes.mjs',
  ]);
});

test('mergeRelayActivityTexts de-dupes and preserves primary order for divergent snapshots', () => {
  const merged = mergeRelayActivityTexts(
    ['Tool (view): plan.md', 'Tool (powershell): command="Check relay status"'],
    ['Tool (view): plan.md', 'Search (grep): query="token"'],
  );
  assert.deepEqual(merged, [
    'Tool (view): plan.md',
    'Tool (powershell): command="Check relay status"',
    'Search (grep): query="token"',
  ]);
});

test('shouldApplyConversationLoad rejects stale or mismatched conversation loads', () => {
  assert.equal(shouldApplyConversationLoad({
    requestedConversationId: 'conv-a',
    activeConversationId: 'conv-a',
    capturedVersion: 2,
    currentVersion: 2,
  }), true);
  assert.equal(shouldApplyConversationLoad({
    requestedConversationId: 'conv-a',
    activeConversationId: 'conv-b',
    capturedVersion: 2,
    currentVersion: 2,
  }), false);
  assert.equal(shouldApplyConversationLoad({
    requestedConversationId: 'conv-a',
    activeConversationId: 'conv-a',
    capturedVersion: 1,
    currentVersion: 2,
  }), false);
});
