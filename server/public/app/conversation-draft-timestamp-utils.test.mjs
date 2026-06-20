import assert from 'node:assert/strict';
import test from 'node:test';

import { isIncomingDraftTimestampStale, normalizeDraftTimestampMs } from './conversation-draft-timestamp-utils.mjs';

test('normalizeDraftTimestampMs parses valid timestamp', () => {
  const parsed = normalizeDraftTimestampMs('2026-06-20T10:11:12.123Z');
  assert.equal(parsed > 0, true);
});

test('normalizeDraftTimestampMs returns 0 for invalid values', () => {
  assert.equal(normalizeDraftTimestampMs(''), 0);
  assert.equal(normalizeDraftTimestampMs('bad'), 0);
  assert.equal(normalizeDraftTimestampMs(null), 0);
});

test('isIncomingDraftTimestampStale returns true for older incoming draft', () => {
  const stale = isIncomingDraftTimestampStale({
    existingMs: 2000,
    incomingMs: 1000,
  });
  assert.equal(stale, true);
});

test('isIncomingDraftTimestampStale returns false for newer incoming draft', () => {
  const stale = isIncomingDraftTimestampStale({
    existingMs: 1000,
    incomingMs: 2000,
  });
  assert.equal(stale, false);
});

test('isIncomingDraftTimestampStale returns false when one side is missing', () => {
  assert.equal(isIncomingDraftTimestampStale({ existingMs: 0, incomingMs: 2000 }), false);
  assert.equal(isIncomingDraftTimestampStale({ existingMs: 2000, incomingMs: 0 }), false);
});
