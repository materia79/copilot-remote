import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {
  mergePreferredModelForMode,
  parsePreferredModelsByMode,
  persistConversationModeModelPreference,
  persistConversationPreferences,
} from './conversation-preferences-service.mjs';

function createHarness() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      preferred_relay_mode TEXT,
      preferred_models_by_mode TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  const stmts = {
    getConvAnyStatus: db.prepare(`SELECT * FROM conversations WHERE id = ?`),
    insertConv: db.prepare(`INSERT OR IGNORE INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`),
    updateConvPreferences: db.prepare(`UPDATE conversations SET preferred_relay_mode = ?, preferred_models_by_mode = ?, updated_at = ? WHERE id = ?`),
  };
  return { db, stmts };
}

test('parsePreferredModelsByMode normalizes JSON using the provided mode normalizer', () => {
  const normalized = parsePreferredModelsByMode('{" ask ":"gpt-5.4-mini","bad":"","PLAN":"gpt-5.4"}', {
    normalizeMode: (value) => {
      const mode = String(value || '').trim().toLowerCase();
      return ['ask', 'plan', 'agent', 'autopilot'].includes(mode) ? mode : null;
    },
  });
  assert.deepEqual(normalized, {
    ask: 'gpt-5.4-mini',
    plan: 'gpt-5.4',
  });
});

test('mergePreferredModelForMode preserves existing entries while updating one mode', () => {
  const merged = mergePreferredModelForMode({
    preferredModelsByMode: '{"ask":"gpt-5.4-mini","agent":"gpt-5.3-codex"}',
    relayMode: 'plan',
    model: 'gpt-5.4',
    normalizeMode: (value) => String(value || '').trim().toLowerCase() || null,
  });
  assert.deepEqual(merged, {
    ask: 'gpt-5.4-mini',
    agent: 'gpt-5.3-codex',
    plan: 'gpt-5.4',
  });
});

test('persistConversationPreferences auto-creates missing conversations and stores the full map', () => {
  const { db, stmts } = createHarness();
  const result = persistConversationPreferences({
    db,
    stmts,
    conversationId: 'conv-1',
    preferredRelayMode: 'agent',
    preferredModelsByMode: { ask: 'gpt-5.4-mini', agent: 'gpt-5.3-codex' },
    updatedAt: '2026-05-25T00:00:00.000Z',
    createIfMissing: true,
    createTitle: 'Session',
  });
  assert.equal(result.ok, true);
  assert.equal(result.created, true);
  const row = stmts.getConvAnyStatus.get('conv-1');
  assert.equal(row.title, 'Session');
  assert.equal(row.preferred_relay_mode, 'agent');
  assert.equal(row.preferred_models_by_mode, '{"ask":"gpt-5.4-mini","agent":"gpt-5.3-codex"}');
  db.close();
});

test('persistConversationPreferences keeps prior mode entries when a new mode is added', () => {
  const { db, stmts } = createHarness();
  db.prepare(`
    INSERT INTO conversations (id, title, preferred_relay_mode, preferred_models_by_mode, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    'conv-2',
    'Conversation',
    'ask',
    '{"ask":"gpt-5.4-mini"}',
    'active',
    '2026-05-25T00:00:00.000Z',
    '2026-05-25T00:00:00.000Z',
  );
  const merged = mergePreferredModelForMode({
    preferredModelsByMode: stmts.getConvAnyStatus.get('conv-2').preferred_models_by_mode,
    relayMode: 'agent',
    model: 'gpt-5.3-codex',
    normalizeMode: (value) => String(value || '').trim().toLowerCase() || null,
  });
  const result = persistConversationPreferences({
    db,
    stmts,
    conversationId: 'conv-2',
    preferredRelayMode: 'agent',
    preferredModelsByMode: merged,
    updatedAt: '2026-05-25T00:01:00.000Z',
  });
  assert.equal(result.ok, true);
  assert.equal(result.created, false);
  const row = stmts.getConvAnyStatus.get('conv-2');
  assert.equal(row.preferred_relay_mode, 'agent');
  assert.equal(row.preferred_models_by_mode, '{"ask":"gpt-5.4-mini","agent":"gpt-5.3-codex"}');
  db.close();
});

test('persistConversationModeModelPreference merges using current DB state inside one write operation', () => {
  const { db, stmts } = createHarness();
  db.prepare(`
    INSERT INTO conversations (id, title, preferred_relay_mode, preferred_models_by_mode, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    'conv-3',
    'Conversation',
    'ask',
    '{"ask":"gpt-5.4-mini"}',
    'active',
    '2026-05-25T00:00:00.000Z',
    '2026-05-25T00:00:00.000Z',
  );

  const result = persistConversationModeModelPreference({
    db,
    stmts,
    conversationId: 'conv-3',
    relayMode: 'agent',
    model: 'gpt-5.3-codex',
    normalizeMode: (value) => String(value || '').trim().toLowerCase() || null,
    fallbackRelayMode: 'agent',
    updatedAt: '2026-05-25T00:02:00.000Z',
  });

  assert.equal(result.ok, true);
  assert.equal(result.created, false);
  assert.deepEqual(result.preferredModelsByMode, {
    ask: 'gpt-5.4-mini',
    agent: 'gpt-5.3-codex',
  });
  const row = stmts.getConvAnyStatus.get('conv-3');
  assert.equal(row.preferred_relay_mode, 'agent');
  assert.equal(row.preferred_models_by_mode, '{"ask":"gpt-5.4-mini","agent":"gpt-5.3-codex"}');
  db.close();
});
