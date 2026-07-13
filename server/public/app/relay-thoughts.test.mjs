import test from 'node:test';
import assert from 'node:assert/strict';

import { mergeRelayThoughts, normalizeRelayThoughtList } from './relay-thoughts.mjs';

test('normalizeRelayThoughtList collapses snapshots only for the same reasoning ID', () => {
  const thoughts = normalizeRelayThoughtList([
    { reasoningId: 'r-1', seq: 1, text: 'Plan', done: false, timestamp: '2026-01-01T00:00:00Z' },
    { reasoningId: 'r-1', seq: 2, text: 'Plan in detail', done: true, timestamp: '2026-01-01T00:00:01Z' },
    { reasoningId: 'r-2', seq: 3, text: 'Plan in detail', done: true, timestamp: '2026-01-01T00:00:02Z' },
  ]);

  assert.deepEqual(thoughts, [
    {
      reasoningId: 'r-1',
      seq: 2,
      text: 'Plan in detail',
      done: true,
      timestamp: '2026-01-01T00:00:01Z',
      subagentRunId: null,
    },
    {
      reasoningId: 'r-2',
      seq: 3,
      text: 'Plan in detail',
      done: true,
      timestamp: '2026-01-01T00:00:02Z',
      subagentRunId: null,
    },
  ]);
});

test('normalizeRelayThoughtList keeps identical text from separate thought sections', () => {
  const thoughts = normalizeRelayThoughtList([
    { reasoningId: 'r-1', seq: 1, text: 'Inspect the configuration.', done: true },
    { reasoningId: 'r-2', seq: 2, text: 'Inspect the configuration.', done: true },
  ]);

  assert.deepEqual(thoughts.map((thought) => thought.reasoningId), ['r-1', 'r-2']);
});

test('mergeRelayThoughts prefers richer cached snapshots on finalize', () => {
  const persisted = [
    { reasoningId: 'reasoning', seq: 3, text: 'The user is asking...', done: true, timestamp: '2026-01-01T00:00:03Z' },
    { reasoningId: 'message:m1', seq: 4, text: 'The user is asking...', done: true, timestamp: '2026-01-01T00:00:04Z' },
  ];
  const cached = new Map([
    ['reasoning', { reasoningId: 'reasoning', text: 'The user is asking... with actionable details', done: true, timestamp: '2026-01-01T00:00:05Z' }],
    ['reasoning-2', { reasoningId: 'reasoning-2', text: 'Check bootstrap and route wiring', done: true, timestamp: '2026-01-01T00:00:06Z' }],
  ]);

  const merged = mergeRelayThoughts(persisted, cached);
  assert.deepEqual(merged, [
    {
      reasoningId: 'message:m1',
      seq: 4,
      text: 'The user is asking...',
      done: true,
      timestamp: '2026-01-01T00:00:04Z',
      subagentRunId: null,
    },
    {
      reasoningId: 'reasoning',
      seq: null,
      text: 'The user is asking... with actionable details',
      done: true,
      timestamp: '2026-01-01T00:00:05Z',
      subagentRunId: null,
    },
    {
      reasoningId: 'reasoning-2',
      seq: null,
      text: 'Check bootstrap and route wiring',
      done: true,
      timestamp: '2026-01-01T00:00:06Z',
      subagentRunId: null,
    },
  ]);
});
