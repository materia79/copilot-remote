import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  isModelCatalogRefreshStale,
  latestModelCatalogRefresh,
} from '../shared/model-catalog-freshness.mjs';

const sourcePath = fileURLToPath(new URL('./server-runtime.mjs', import.meta.url));
const source = fs.readFileSync(sourcePath, 'utf8');

// ── Structural: touchModelSelectorState guard ────────────────────────────────

test('touchModelSelectorState is guarded by upsertSelectorState, not upsertVariant', () => {
  const touchBlock = /if \(receivedMetadata && modelSelectorSql\?\.\w+/.exec(source);
  assert.ok(touchBlock, 'receivedMetadata guard for touchModelSelectorState must exist');
  assert.match(
    touchBlock[0],
    /upsertSelectorState/,
    'touchModelSelectorState guard should check upsertSelectorState',
  );
  assert.doesNotMatch(
    touchBlock[0],
    /upsertVariant/,
    'touchModelSelectorState guard should not check upsertVariant',
  );
});

// ── Structural: bootstrap does not seed a fake-fresh timestamp ────────────────

test('bootstrap modelCatalog initializes refreshedAt as null', () => {
  const initBlock = /let modelCatalog = \{[^}]+\}/.exec(source);
  assert.ok(initBlock, 'modelCatalog initialization must exist');
  assert.match(
    initBlock[0],
    /refreshedAt:\s*null/,
    'bootstrap refreshedAt must be null so DB timestamp is used until a real snapshot arrives',
  );
});

test('getModelCatalogState does not special-case bootstrap source for in-memory freshness', () => {
  assert.doesNotMatch(
    source,
    /modelCatalog\.source\s*===\s*['"]bootstrap['"]\s*\?\s*null/,
    'bootstrap source should not nullify in-memory refreshedAt',
  );
});

test('getModelCatalogState computes effective freshness from in-memory refreshedAt', () => {
  assert.match(
    source,
    /const inMemoryRefresh = modelCatalog\.refreshedAt/,
    'inMemoryRefresh should use modelCatalog.refreshedAt directly',
  );
});

// ── Structural: touchModelSelectorState exists and writes DB ─────────────────

test('touchModelSelectorState calls upsertSelectorState.run', () => {
  assert.match(
    source,
    /function touchModelSelectorState\(/,
    'touchModelSelectorState function must exist',
  );
  assert.match(
    source,
    /modelSelectorSql\?\.upsertSelectorState\?\.run/,
    'touchModelSelectorState must use upsertSelectorState.run',
  );
});

// ── Freshness helper: 10-minute warning threshold ────────────────────────────

test('no age warning when refreshedAt is within 10 minutes', () => {
  const now = Date.now();
  const fiveMinAgo = new Date(now - 5 * 60 * 1000).toISOString();
  assert.equal(
    isModelCatalogRefreshStale(fiveMinAgo, { now, staleAfterMs: 10 * 60 * 1000 }),
    false,
    'refresh 5 minutes ago should not be stale at 10-minute threshold',
  );
});

test('age warning fires when refreshedAt exceeds 10 minutes', () => {
  const now = Date.now();
  const fifteenMinAgo = new Date(now - 15 * 60 * 1000).toISOString();
  assert.equal(
    isModelCatalogRefreshStale(fifteenMinAgo, { now, staleAfterMs: 10 * 60 * 1000 }),
    true,
    'refresh 15 minutes ago should be stale at 10-minute threshold',
  );
});

test('null refreshedAt is treated as stale', () => {
  assert.equal(
    isModelCatalogRefreshStale(null, { staleAfterMs: 10 * 60 * 1000 }),
    true,
  );
});

// ── Freshness helper: max(mem, db) effective freshness ───────────────────────

test('effective freshness picks newest of stale DB and fresh in-memory', () => {
  const now = Date.now();
  const staleDb = new Date(now - 20 * 60 * 1000).toISOString();
  const freshMem = new Date(now - 30 * 1000).toISOString();
  const effective = latestModelCatalogRefresh(staleDb, freshMem);
  assert.equal(effective, freshMem);
  assert.equal(
    isModelCatalogRefreshStale(effective, { now, staleAfterMs: 10 * 60 * 1000 }),
    false,
    'stale DB + fresh in-memory should suppress age warning',
  );
});

test('effective freshness picks newest of fresh DB and null in-memory', () => {
  const now = Date.now();
  const freshDb = new Date(now - 60 * 1000).toISOString();
  const effective = latestModelCatalogRefresh(freshDb, null);
  assert.equal(effective, freshDb);
  assert.equal(
    isModelCatalogRefreshStale(effective, { now, staleAfterMs: 10 * 60 * 1000 }),
    false,
  );
});

// ── Structural: updateModelCatalog persists context limits ───────────────────

test('updateModelCatalog writes context limits via updateContextLimitForBase', () => {
  assert.match(
    source,
    /modelSelectorSql\.updateContextLimitForBase\.run\(contextLimitTokens,\s*nowIso,\s*modelId\)/,
    'updateModelCatalog must persist context limits to DB rows',
  );
});

test('updateModelCatalog calls touchModelSelectorState when metadata received', () => {
  const startIdx = source.indexOf('function updateModelCatalog(');
  const nextFnIdx = source.indexOf('\nfunction ', startIdx + 1);
  const updateFn = source.slice(startIdx, nextFnIdx > startIdx ? nextFnIdx : startIdx + 3000);
  assert.match(
    updateFn,
    /touchModelSelectorState\(\{/,
    'updateModelCatalog must call touchModelSelectorState',
  );
  assert.match(
    updateFn,
    /receivedMetadata/,
    'touch must be gated on receivedMetadata',
  );
});
