'use strict';

function normalizeModeWith(value, normalizeMode) {
  if (typeof normalizeMode === 'function') {
    const normalized = normalizeMode(value);
    const text = String(normalized || '').trim();
    return text || null;
  }
  const text = String(value || '').trim();
  return text || null;
}

export function parsePreferredModelsByMode(value, { normalizeMode } = {}) {
  let parsed = value;
  if (typeof parsed === 'string') {
    const trimmed = parsed.trim();
    if (!trimmed) return {};
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return {};
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const normalized = {};
  for (const [mode, model] of Object.entries(parsed)) {
    const modeKey = normalizeModeWith(mode, normalizeMode);
    const modelText = String(model || '').trim();
    if (!modeKey || !modelText) continue;
    normalized[modeKey] = modelText;
  }
  return normalized;
}

export function mergePreferredModelForMode({
  preferredModelsByMode = {},
  relayMode = '',
  model = '',
  normalizeMode,
} = {}) {
  const normalized = parsePreferredModelsByMode(preferredModelsByMode, { normalizeMode });
  const modeKey = normalizeModeWith(relayMode, normalizeMode);
  const modelText = String(model || '').trim();
  if (!modeKey || !modelText) return normalized;
  normalized[modeKey] = modelText;
  return normalized;
}

export function persistConversationPreferences({
  db,
  stmts,
  conversationId = '',
  preferredRelayMode = '',
  preferredModelsByMode = {},
  updatedAt = new Date().toISOString(),
  createIfMissing = false,
  createTitle = 'Session',
  tolerateMissingColumns = false,
} = {}) {
  const convId = String(conversationId || '').trim();
  const mode = String(preferredRelayMode || '').trim();
  if (!db || !stmts || !convId || !mode) {
    return {
      ok: false,
      created: false,
      preferredRelayMode: mode,
      preferredModelsByMode: {},
      updatedAt,
    };
  }
  const normalizedMap = parsePreferredModelsByMode(preferredModelsByMode);
  const jsonMap = JSON.stringify(normalizedMap);
  const safeTitle = String(createTitle || '').trim() || 'Session';
  const writePreferences = db.transaction(() => {
    const existing = typeof stmts.getConvAnyStatus?.get === 'function'
      ? (stmts.getConvAnyStatus.get(convId) || null)
      : null;
    if (!existing && createIfMissing && typeof stmts.insertConv?.run === 'function') {
      stmts.insertConv.run(convId, safeTitle, updatedAt, updatedAt);
    }
    try {
      if (typeof stmts.updateConvPreferences?.run === 'function') {
        stmts.updateConvPreferences.run(mode, jsonMap, updatedAt, convId);
      } else {
        db.prepare(`
          UPDATE conversations
          SET preferred_relay_mode = ?, preferred_models_by_mode = ?, updated_at = ?
          WHERE id = ?
        `).run(mode, jsonMap, updatedAt, convId);
      }
    } catch (error) {
      if (!tolerateMissingColumns) throw error;
    }
    return {
      ok: true,
      created: !existing,
      preferredRelayMode: mode,
      preferredModelsByMode: normalizedMap,
      updatedAt,
    };
  });
  return writePreferences();
}

export function persistConversationModeModelPreference({
  db,
  stmts,
  conversationId = '',
  relayMode = '',
  model = '',
  normalizeMode,
  fallbackRelayMode = 'agent',
  updatedAt = new Date().toISOString(),
  createIfMissing = false,
  createTitle = 'Session',
  tolerateMissingColumns = false,
} = {}) {
  const convId = String(conversationId || '').trim();
  const modelText = String(model || '').trim();
  const normalizedRelayMode = normalizeModeWith(relayMode, normalizeMode);
  const fallbackMode = normalizeModeWith(fallbackRelayMode, normalizeMode) || String(fallbackRelayMode || '').trim() || 'agent';
  const mode = normalizedRelayMode || fallbackMode;
  if (!db || !stmts || !convId || !mode || !modelText) {
    return {
      ok: false,
      created: false,
      preferredRelayMode: mode || fallbackMode,
      preferredModelsByMode: {},
      updatedAt,
    };
  }

  const safeTitle = String(createTitle || '').trim() || 'Session';
  const writeModeModelPreference = db.transaction(() => {
    const existing = typeof stmts.getConvAnyStatus?.get === 'function'
      ? (stmts.getConvAnyStatus.get(convId) || null)
      : null;
    if (!existing && createIfMissing && typeof stmts.insertConv?.run === 'function') {
      stmts.insertConv.run(convId, safeTitle, updatedAt, updatedAt);
    }
    const currentMap = parsePreferredModelsByMode(existing?.preferred_models_by_mode, { normalizeMode });
    currentMap[mode] = modelText;
    const jsonMap = JSON.stringify(currentMap);
    try {
      if (typeof stmts.updateConvPreferences?.run === 'function') {
        stmts.updateConvPreferences.run(mode, jsonMap, updatedAt, convId);
      } else {
        db.prepare(`
          UPDATE conversations
          SET preferred_relay_mode = ?, preferred_models_by_mode = ?, updated_at = ?
          WHERE id = ?
        `).run(mode, jsonMap, updatedAt, convId);
      }
    } catch (error) {
      if (!tolerateMissingColumns) throw error;
    }
    return {
      ok: true,
      created: !existing,
      preferredRelayMode: mode,
      preferredModelsByMode: currentMap,
      updatedAt,
    };
  });
  return writeModeModelPreference();
}
