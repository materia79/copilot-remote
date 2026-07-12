import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isModelCatalogRefreshStale,
  latestModelCatalogRefresh,
} from './model-catalog-freshness.mjs';

test('uses the newest valid model catalog timestamp', () => {
  assert.equal(
    latestModelCatalogRefresh(
      '2026-07-12T07:32:22.351Z',
      '2026-07-12T09:03:53.203Z',
    ),
    '2026-07-12T09:03:53.203Z',
  );
});

test('keeps a freshly received snapshot from being treated as stale', () => {
  const now = Date.parse('2026-07-12T09:03:53.203Z');
  const refreshedAt = latestModelCatalogRefresh(
    '2026-07-12T07:32:22.351Z',
    '2026-07-12T09:03:53.203Z',
  );

  assert.equal(
    isModelCatalogRefreshStale(refreshedAt, {
      now,
      staleAfterMs: 2 * 60 * 1000,
    }),
    false,
  );
});
