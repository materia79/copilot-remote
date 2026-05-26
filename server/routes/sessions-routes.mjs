'use strict';

import fs from 'fs';
import path from 'path';
import { createSdkSessionSyncService } from '../services/sdk-session-sync-service.mjs';
import { stripRelayPromptContext } from '../services/relay-prompt-sanitizer.mjs';
import { persistConversationPreferences } from '../services/conversation-preferences-service.mjs';

const SESSION_WORKER_STATUS_QUEUE_STATES = Object.freeze(['pending', 'processing', 'parked']);

function normalizeWorkerStatusText(value, fallback = null) {
  const text = String(value || '').trim();
  return text || fallback;
}

function toSafeNonNegativeInt(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.trunc(numeric));
}

export function canUpdateWorkspaceRoot(runtimeState = {}) {
  return true;
}

export async function launchWorkspaceRootSession(runtimeState = {}, sessionWorkerSupervisor = null, sdkSessionId = '') {
  const sid = String(sdkSessionId || '').trim();
  if (!sid) {
    return { ok: false, statusCode: 400, error: 'Missing session id' };
  }
  const selectedWorkerState = typeof sessionWorkerSupervisor?.getWorkerState === 'function'
    ? sessionWorkerSupervisor.getWorkerState(sid)
    : null;
  const selectedWorkerStatus = String(selectedWorkerState?.status || '').trim().toLowerCase();
  if (['starting', 'ready', 'processing'].includes(selectedWorkerStatus)) {
    return { ok: false, statusCode: 409, error: 'Selected CLI is already running' };
  }
  if (!sessionWorkerSupervisor || typeof sessionWorkerSupervisor.ensureWorker !== 'function') {
    return { ok: false, statusCode: 500, error: 'Session worker launcher is unavailable' };
  }

  const result = await sessionWorkerSupervisor.ensureWorker(sid);
  if (!result?.ok) {
    return {
      ok: false,
      statusCode: 409,
      error: result?.error || 'launch-failed',
      worker: result?.worker || null,
      lifecycle: result?.lifecycle || null,
    };
  }
  return { ok: true, statusCode: 200, ...result };
}

export function learnWorkspaceRootFromSessionSync({
  learnConversationWorkspaceRoot = null,
  setWorkspaceRoot = null,
  sdkSessionId = '',
  conversationId = '',
  workspaceRootPath = '',
} = {}) {
  const nextRootPath = String(workspaceRootPath || '').trim();
  if (!nextRootPath) {
    return { ok: false, learned: false, changed: false, error: 'Missing workspace root path' };
  }
  if (typeof learnConversationWorkspaceRoot !== 'function' && typeof setWorkspaceRoot !== 'function') {
    return { ok: false, learned: false, changed: false, error: 'Workspace root updates are unavailable' };
  }

  if (typeof learnConversationWorkspaceRoot !== 'function') {
    const legacyResult = setWorkspaceRoot(nextRootPath, { reason: 'session-sync-cwd' });
    if (!legacyResult?.changed && legacyResult?.error) {
      return {
        ok: false,
        learned: false,
        changed: false,
        error: legacyResult.error,
      };
    }
    return {
      ok: true,
      learned: true,
      changed: !!legacyResult?.changed,
      rootPath: legacyResult?.rootPath || nextRootPath,
      rootName: legacyResult?.rootName || null,
      state: null,
    };
  }

  const convId = String(conversationId || '').trim();
  if (!convId) {
    return {
      ok: true,
      learned: false,
      changed: false,
      rootPath: nextRootPath,
      rootName: null,
      state: null,
    };
  }

  const result = learnConversationWorkspaceRoot({
    sdkSessionId,
    conversationId: convId,
    rootPath: nextRootPath,
    seedConfigured: true,
  });
  if (!result?.ok) {
    return {
      ok: false,
      learned: false,
      changed: false,
      error: result?.error || 'Failed to learn workspace root',
    };
  }
  const state = result?.state || null;

  return {
    ok: true,
    learned: true,
    changed: String(state?.runtimeWorkspaceRootPath || '').trim().toLowerCase() === nextRootPath.toLowerCase(),
    rootPath: state?.runtimeWorkspaceRootPath || state?.currentWorkspaceRootPath || nextRootPath,
    rootName: state?.runtimeWorkspaceRootName || state?.currentWorkspaceRootName || null,
    state,
  };
}

const MAX_CONVERSATION_TITLE_LENGTH = 120;
const FALLBACK_RELAY_MODE = 'agent';

export function normalizeConversationTitle(value) {
  const title = String(value || '').replace(/[\r\n]+/g, ' ').trim();
  if (!title) return '';
  return title.slice(0, MAX_CONVERSATION_TITLE_LENGTH);
}

export function normalizeRelayModePreference(value, {
  supportedRelayModes = [],
  fallbackMode = FALLBACK_RELAY_MODE,
} = {}) {
  const allowedModes = Array.isArray(supportedRelayModes)
    ? supportedRelayModes.map((mode) => String(mode || '').trim()).filter(Boolean)
    : [];
  const fallback = allowedModes.includes(fallbackMode)
    ? fallbackMode
    : (allowedModes[0] || FALLBACK_RELAY_MODE);
  const mode = String(value || '').trim();
  if (!mode) return fallback;
  return allowedModes.includes(mode) ? mode : fallback;
}

export function normalizePreferredModelsByMode(value, {
  supportedRelayModes = [],
} = {}) {
  const allowedModes = Array.isArray(supportedRelayModes)
    ? supportedRelayModes.map((mode) => String(mode || '').trim()).filter(Boolean)
    : [];
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
  for (const mode of allowedModes) {
    const model = String(parsed[mode] || '').trim();
    if (!model) continue;
    normalized[mode] = model;
  }
  return normalized;
}

function resolveConversationPreferences(row, {
  supportedRelayModes = [],
  defaultRelayMode = FALLBACK_RELAY_MODE,
} = {}) {
  return {
    preferredRelayMode: normalizeRelayModePreference(row?.preferred_relay_mode, {
      supportedRelayModes,
      fallbackMode: defaultRelayMode,
    }),
    preferredModelsByMode: normalizePreferredModelsByMode(row?.preferred_models_by_mode, {
      supportedRelayModes,
    }),
  };
}

function replaceYamlScalarLine(content, key, value) {
  const nextKey = String(key || '').trim();
  if (!nextKey) return String(content || '');
  const replacement = `${nextKey}: ${value}`;
  const pattern = new RegExp(`^\\s*${nextKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:\\s*.*$`, 'im');
  const text = String(content || '');
  if (pattern.test(text)) {
    return text.replace(pattern, replacement);
  }
  const trimmed = text.trimEnd();
  if (!trimmed) return `${replacement}\n`;
  return `${trimmed}\n${replacement}\n`;
}

function buildWorkspaceYamlTitleContent(existingContent, { sessionId = '', title = '', updatedAt = '' } = {}) {
  const sid = String(sessionId || '').trim();
  const nextTitle = normalizeConversationTitle(title);
  const iso = String(updatedAt || '').trim() || new Date().toISOString();
  const existingText = String(existingContent || '');

  if (!existingText.trim()) {
    return [
      `id: ${sid}`,
      `summary: ${nextTitle}`,
      `name: ${nextTitle}`,
      `updated_at: ${iso}`,
      `modified: ${iso}`,
      '',
    ].join('\n');
  }

  return replaceYamlScalarLine(
    replaceYamlScalarLine(
      replaceYamlScalarLine(
        replaceYamlScalarLine(existingText, 'summary', nextTitle),
        'name',
        nextTitle,
      ),
      'updated_at',
      iso,
    ),
    'modified',
    iso,
  ).replace(/\s*$/, '\n');
}

function updateConversationWorkspaceTitle({
  resolveSessionStateRoot = null,
  conversationId = '',
  sdkSessionId = '',
  title = '',
  updatedAt = '',
} = {}) {
  if (typeof resolveSessionStateRoot !== 'function') {
    return { ok: true, updated: false, reason: 'missing-session-root-resolver' };
  }

  const sid = String(sdkSessionId || conversationId || '').trim();
  if (!sid) {
    return { ok: true, updated: false, reason: 'missing-session-id' };
  }

  const root = String(resolveSessionStateRoot() || '').trim();
  if (!root) {
    return { ok: true, updated: false, reason: 'missing-session-root' };
  }

  const sessionRootPath = path.join(root, sid);
  if (!fs.existsSync(sessionRootPath)) {
    return { ok: true, updated: false, reason: 'missing-session-directory', sessionRootPath };
  }

  const stat = fs.statSync(sessionRootPath);
  if (!stat.isDirectory()) {
    return { ok: true, updated: false, reason: 'session-root-not-directory', sessionRootPath };
  }

  const workspaceYamlPath = path.join(sessionRootPath, 'workspace.yaml');
  const existingContent = fs.existsSync(workspaceYamlPath)
    ? fs.readFileSync(workspaceYamlPath, 'utf8')
    : '';
  const nextContent = buildWorkspaceYamlTitleContent(existingContent, {
    sessionId: sid,
    title,
    updatedAt,
  });
  fs.writeFileSync(workspaceYamlPath, nextContent, 'utf8');
  return {
    ok: true,
    updated: true,
    workspaceYamlPath,
  };
}

export function resolveConversationTitle({ title = '', titleSource = '', discoveredTitle = '' } = {}) {
  const storedTitle = String(title || '').trim();
  const source = String(titleSource || '').trim().toLowerCase();
  const discovered = String(discoveredTitle || '').trim();
  if (source === 'manual') return storedTitle || discovered;
  return discovered || storedTitle;
}

export function persistConversationTitle({
  db,
  stmts,
  io = null,
  conversationId = '',
  title = '',
  resolveSessionStateRoot = null,
} = {}) {
  const id = String(conversationId || '').trim();
  const nextTitle = normalizeConversationTitle(title);
  if (!id) {
    return { ok: false, statusCode: 400, error: 'Missing conversation id' };
  }
  if (!nextTitle) {
    return { ok: false, statusCode: 400, error: 'Missing title' };
  }

  const existing = stmts?.getConvAnyStatus?.get?.(id) || null;
  if (existing && String(existing.status || '').trim() === 'deleted') {
    return { ok: false, statusCode: 404, error: 'Conversation not found' };
  }

  const updatedAt = existing?.updated_at || new Date().toISOString();

  if (!existing) {
    if (typeof stmts?.insertConv?.run === 'function') {
      stmts.insertConv.run(id, nextTitle, updatedAt, updatedAt);
    } else if (db && typeof db.prepare === 'function') {
      db.prepare(`INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`).run(id, nextTitle, updatedAt, updatedAt);
    }
  }

  if (typeof stmts?.updateConvTitle?.run === 'function') {
    stmts.updateConvTitle.run(nextTitle, id);
  } else if (db && typeof db.prepare === 'function') {
    db.prepare(`UPDATE conversations SET title = ?, title_source = 'manual' WHERE id = ?`).run(nextTitle, id);
  }

  if (typeof stmts?.setConvSdkSessionIdIfMissing?.run === 'function') {
    stmts.setConvSdkSessionIdIfMissing.run(id, updatedAt, id);
  } else if (db && typeof db.prepare === 'function') {
    db.prepare(`UPDATE conversations SET sdk_session_id = ?, updated_at = ? WHERE id = ? AND (sdk_session_id IS NULL OR sdk_session_id = '')`).run(id, updatedAt, id);
  }

  const workspaceResult = updateConversationWorkspaceTitle({
    resolveSessionStateRoot,
    conversationId: id,
    sdkSessionId: existing?.sdk_session_id || id,
    title: nextTitle,
    updatedAt,
  });

  const payload = {
    conversationId: id,
    title: nextTitle,
    updatedAt,
    workspaceYamlPath: workspaceResult.updated ? workspaceResult.workspaceYamlPath : null,
  };
  io?.emit?.('conversation_title_updated', payload);
  return { ok: true, ...payload, created: !existing };
}

export function buildSessionWorkerStatusPayload({
  featureFlags = null,
  supervisorSnapshot = null,
  queueRows = [],
} = {}) {
  const snapshot = supervisorSnapshot && typeof supervisorSnapshot === 'object'
    ? supervisorSnapshot
    : {};
  const workers = Array.isArray(snapshot.workers) ? snapshot.workers : [];
  const normalizedRows = Array.isArray(queueRows) ? queueRows : [];
  const workerBySession = new Map();
  for (const worker of workers) {
    const sid = normalizeWorkerStatusText(worker?.sdkSessionId);
    if (!sid) continue;
    workerBySession.set(sid, worker);
  }

  const integrity = {
    scannedQueueRowCount: normalizedRows.length,
    workerRegistryCount: workers.length,
    queueOwnerOrphanCount: 0,
    queueConversationMismatchCount: 0,
    queueRuntimeMismatchCount: 0,
    queueProcessingStateMismatchCount: 0,
    queueOwnerOrphanSamples: [],
    queueConversationMismatchSamples: [],
    queueRuntimeMismatchSamples: [],
    queueProcessingStateMismatchSamples: [],
  };

  for (const row of normalizedRows) {
    const messageId = normalizeWorkerStatusText(row?.id);
    const ownerSessionId = normalizeWorkerStatusText(row?.owner_sdk_session_id);
    const conversationId = normalizeWorkerStatusText(row?.conversation_id);
    const runtimeSessionId = normalizeWorkerStatusText(row?.runtime_session_id);
    const queueStatus = normalizeWorkerStatusText(row?.status, 'pending');
    if (!ownerSessionId) continue;

    const worker = workerBySession.get(ownerSessionId);
    if (!worker) {
      integrity.queueOwnerOrphanCount += 1;
      integrity.queueOwnerOrphanSamples.push({
        messageId,
        ownerSessionId,
        queueStatus,
      });
      continue;
    }

    if (conversationId && worker.conversationId && conversationId !== worker.conversationId) {
      integrity.queueConversationMismatchCount += 1;
      integrity.queueConversationMismatchSamples.push({
        messageId,
        ownerSessionId,
        queueConversationId: conversationId,
        workerConversationId: worker.conversationId,
      });
    }

    if (runtimeSessionId && worker.runtimeSessionId && runtimeSessionId !== worker.runtimeSessionId) {
      integrity.queueRuntimeMismatchCount += 1;
      integrity.queueRuntimeMismatchSamples.push({
        messageId,
        ownerSessionId,
        queueRuntimeSessionId: runtimeSessionId,
        workerRuntimeSessionId: worker.runtimeSessionId,
      });
    }

    if (queueStatus === 'processing' && normalizeWorkerStatusText(worker.status) !== 'processing') {
      integrity.queueProcessingStateMismatchCount += 1;
      integrity.queueProcessingStateMismatchSamples.push({
        messageId,
        ownerSessionId,
        queueStatus,
        workerStatus: normalizeWorkerStatusText(worker.status, 'unknown'),
      });
    }
  }

  return {
    enabled: featureFlags?.SESSION_WORKER_ROUTING_ENABLED === true,
    continuationRoutingEnabled: featureFlags?.SESSION_WORKER_CONTINUATION_ROUTING_ENABLED === true,
    fallbackRestartEnabled: false,
    uiState: normalizeWorkerStatusText(snapshot?.health?.uiState, 'white'),
    degradedReason: normalizeWorkerStatusText(snapshot?.health?.degradedReason, null),
    health: snapshot?.health && typeof snapshot.health === 'object' ? snapshot.health : null,
    workerCount: toSafeNonNegativeInt(snapshot.workerCount, workers.length),
    counts: snapshot.counts && typeof snapshot.counts === 'object' ? snapshot.counts : {},
    workers,
    pendingStarts: toSafeNonNegativeInt(snapshot.pendingStarts, 0),
    lifecycle: Array.isArray(snapshot.lifecycle) ? snapshot.lifecycle : [],
    integrity,
  };
}

export function buildConversationSessionRootPayload({
  conversationId = '',
  sdkSessionId = '',
  title = '',
  resolveSessionStateRoot = null,
} = {}) {
  const sid = String(sdkSessionId || '').trim() || String(conversationId || '').trim();
  if (!sid || typeof resolveSessionStateRoot !== 'function') return null;
  const root = String(resolveSessionStateRoot() || '').trim();
  if (!root) return null;
  const rootPath = path.join(root, sid);
  if (!fs.existsSync(rootPath)) return null;
  let stat = null;
  try {
    stat = fs.statSync(rootPath);
  } catch {
    return null;
  }
  if (!stat.isDirectory()) return null;
  return {
    sdkSessionId: sid,
    sessionRootPath: rootPath,
    sessionRootName: String(title || '').trim() || 'Session',
  };
}

function mergeUniqueActivityTexts(primary = [], secondary = []) {
  const merged = [];
  const seen = new Set();
  for (const value of [...(Array.isArray(primary) ? primary : []), ...(Array.isArray(secondary) ? secondary : [])]) {
    const text = String(value || '').trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    merged.push(text);
  }
  return merged;
}

function normalizeConversationMessageIdentityText(value) {
  const raw = String(value || '');
  const withoutAttachmentMarkers = raw.replace(/\s*\[(?:Attached file|Attached files):[^\]]+\]\s*/gi, ' ');
  return withoutAttachmentMarkers.replace(/\s+/g, ' ').trim();
}

function conversationMessageIdentityKey(message) {
  const role = String(message?.role || '').trim().toLowerCase();
  const timestamp = String(message?.timestamp || '').trim();
  const text = normalizeConversationMessageIdentityText(message?.text);
  return `${role}::${timestamp}::${text}`;
}

function conversationMessageRoleTextKey(message) {
  const role = String(message?.role || '').trim().toLowerCase();
  const text = normalizeConversationMessageIdentityText(message?.text);
  return `${role}::${text}`;
}

function isLikelyCanonicalDuplicateMessage(a, b, timestampWindowMs = 30_000) {
  const aRoleText = conversationMessageRoleTextKey(a);
  const bRoleText = conversationMessageRoleTextKey(b);
  if (!aRoleText || !bRoleText || aRoleText !== bRoleText) return false;

  const aSource = String(a?.sourceMessageId || '').trim();
  const bSource = String(b?.sourceMessageId || '').trim();
  if (aSource && bSource) return aSource === bSource;

  const aTs = normalizeConversationTimestampMs(a?.timestamp);
  const bTs = normalizeConversationTimestampMs(b?.timestamp);
  if (!aTs || !bTs) return false;
  return Math.abs(aTs - bTs) <= Math.max(1_000, Number(timestampWindowMs) || 30_000);
}

function normalizeConversationTimestampMs(value) {
  const parsed = Date.parse(String(value || '').trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

function isTranscriptUserEchoOfQueuedMessage({
  transcriptMessage = null,
  canonicalDbMessages = [],
  queueRowsById = new Map(),
  firstAssistantTimestampBySourceId = new Map(),
  responseGraceMs = 5_000,
} = {}) {
  if (String(transcriptMessage?.role || '').trim().toLowerCase() !== 'user') return false;
  const transcriptTimestampMs = normalizeConversationTimestampMs(transcriptMessage?.timestamp);
  if (!transcriptTimestampMs) return false;
  const graceMs = Math.max(0, Number(responseGraceMs) || 0);
  for (const dbMessage of Array.isArray(canonicalDbMessages) ? canonicalDbMessages : []) {
    const canonicalId = String(dbMessage?.id || '').trim();
    if (!canonicalId) continue;
    const canonicalTimestampMs = normalizeConversationTimestampMs(dbMessage?.timestamp);
    if (!canonicalTimestampMs || transcriptTimestampMs < canonicalTimestampMs) continue;
    const queueRow = queueRowsById.get(canonicalId) || null;
    if (!queueRow) continue;
    const queueStatus = String(queueRow?.status || '').trim().toLowerCase();
    if (queueStatus === 'pending' || queueStatus === 'processing' || queueStatus === 'parked') {
      return true;
    }
    const assistantTimestampMs = normalizeConversationTimestampMs(firstAssistantTimestampBySourceId.get(canonicalId));
    if (assistantTimestampMs && transcriptTimestampMs <= (assistantTimestampMs + graceMs)) {
      return true;
    }
  }
  return false;
}

function compareConversationMessageOrder(a, b) {
  const aTs = normalizeConversationTimestampMs(a?.timestamp);
  const bTs = normalizeConversationTimestampMs(b?.timestamp);
  if (aTs !== bTs) return aTs - bTs;
  const aId = String(a?.id || '').trim();
  const bId = String(b?.id || '').trim();
  return aId.localeCompare(bId);
}

export function normalizeConversationHistoryLimit(value, fallback = 20) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(100, Math.max(1, Math.trunc(numeric)));
}

function resolveConversationHistoryCursor(messages = [], {
  beforeMessageId = '',
  beforeTimestamp = '',
} = {}) {
  const cursorMessageId = String(beforeMessageId || '').trim();
  const cursorTimestampText = String(beforeTimestamp || '').trim();
  const list = Array.isArray(messages) ? messages : [];

  if (cursorMessageId) {
    const cursorMessage = list.find((message) => String(message?.id || '').trim() === cursorMessageId) || null;
    if (cursorMessage) {
      return {
        beforeMessageId: cursorMessageId,
        beforeTimestamp: String(cursorMessage.timestamp || '').trim() || null,
        timestampMs: normalizeConversationTimestampMs(cursorMessage.timestamp),
      };
    }
  }

  if (cursorTimestampText) {
    return {
      beforeMessageId: cursorMessageId || null,
      beforeTimestamp: cursorTimestampText,
      timestampMs: normalizeConversationTimestampMs(cursorTimestampText),
    };
  }

  return null;
}

export function selectConversationHistoryPage(messages = [], {
  limit = 20,
  beforeMessageId = '',
  beforeTimestamp = '',
} = {}) {
  const pageLimit = normalizeConversationHistoryLimit(limit);
  const ordered = Array.isArray(messages)
    ? messages.filter((message) => !!message).slice().sort(compareConversationMessageOrder)
    : [];
  const cursor = resolveConversationHistoryCursor(ordered, { beforeMessageId, beforeTimestamp });
  const olderMessages = cursor
    ? ordered.filter((message) => {
        const messageTimestampMs = normalizeConversationTimestampMs(message?.timestamp);
        if (messageTimestampMs < cursor.timestampMs) return true;
        if (messageTimestampMs > cursor.timestampMs) return false;
        if (!cursor.beforeMessageId) return false;
        return String(message?.id || '').trim().localeCompare(cursor.beforeMessageId) < 0;
      })
    : ordered;
  const pageMessages = olderMessages.slice(-pageLimit);
  const oldestMessage = pageMessages[0] || null;
  return {
    messages: pageMessages,
    pageInfo: {
      hasMore: olderMessages.length > pageMessages.length,
      nextCursor: oldestMessage ? {
        beforeMessageId: String(oldestMessage.id || '').trim(),
        beforeTimestamp: String(oldestMessage.timestamp || '').trim() || null,
      } : null,
    },
  };
}

export function buildConversationMessages({
  dbMessages = [],
  transcriptMessages = [],
  relayActivitiesByMessageId = new Map(),
  responseMessageToSourceId = new Map(),
  queueRows = [],
} = {}) {
  const normalizedDbMessages = Array.isArray(dbMessages)
    ? dbMessages.map((message) => {
        const id = String(message?.id || '').trim();
        return {
          activities: message?.role === 'assistant' ? (relayActivitiesByMessageId.get(id) || []) : [],
          id,
          role: message?.role,
          text: stripRelayPromptContext(message?.text, message?.mode),
          model: message?.model || undefined,
          attachments: message?.attachments || [],
          mode: message?.mode || undefined,
          timestamp: message?.timestamp,
          sourceMessageId: message?.role === 'assistant'
            ? (responseMessageToSourceId.get(id) || undefined)
            : undefined,
        };
      })
    : [];
  const normalizedTranscriptMessages = (Array.isArray(transcriptMessages) ? transcriptMessages : []).map((message) => {
    const id = String(message?.id || '').trim();
    return {
      ...message,
      id,
      activities: mergeUniqueActivityTexts(
        Array.isArray(message?.activities) ? message.activities : [],
        id ? (relayActivitiesByMessageId.get(id) || []) : [],
      ),
      text: stripRelayPromptContext(message?.text, message?.mode),
      sourceMessageId: message?.role === 'assistant'
        ? (responseMessageToSourceId.get(id) || message?.sourceMessageId || undefined)
        : message?.sourceMessageId,
    };
  });

  const transcriptById = new Map(
    normalizedTranscriptMessages
      .map((message) => [String(message?.id || '').trim(), message])
      .filter(([id]) => !!id),
  );

  const messagesById = new Map();
  for (const message of normalizedDbMessages) {
    messagesById.set(String(message.id || '').trim(), message);
  }

  if (normalizedDbMessages.length === 0) {
    return normalizedTranscriptMessages.slice().sort(compareConversationMessageOrder);
  }

  const dbIdentityKeys = new Set(
    normalizedDbMessages.map((message) => conversationMessageIdentityKey(message)),
  );
  const dbMessagesByRoleText = new Map();
  for (const message of normalizedDbMessages) {
    const key = conversationMessageRoleTextKey(message);
    if (!key || key.endsWith('::')) continue;
    const bucket = dbMessagesByRoleText.get(key) || [];
    bucket.push(message);
    dbMessagesByRoleText.set(key, bucket);
  }
  const queueRowsById = new Map(
    (Array.isArray(queueRows) ? queueRows : [])
      .map((row) => [String(row?.id || '').trim(), row])
      .filter(([id]) => !!id),
  );
  const firstAssistantTimestampBySourceId = new Map();
  for (const message of normalizedDbMessages) {
    if (String(message?.role || '').trim().toLowerCase() !== 'assistant') continue;
    const sourceMessageId = String(message?.sourceMessageId || '').trim();
    if (!sourceMessageId) continue;
    const timestamp = String(message?.timestamp || '').trim();
    if (!timestamp) continue;
    const existing = String(firstAssistantTimestampBySourceId.get(sourceMessageId) || '').trim();
    if (!existing || normalizeConversationTimestampMs(timestamp) < normalizeConversationTimestampMs(existing)) {
      firstAssistantTimestampBySourceId.set(sourceMessageId, timestamp);
    }
  }
  const retriedQueueRowsByRoleText = new Map();
  for (const row of Array.isArray(queueRows) ? queueRows : []) {
    const retryCount = Math.max(0, Number(row?.retry_count || 0));
    if (retryCount < 1) continue;
    const key = conversationMessageRoleTextKey({
      role: 'user',
      text: row?.text,
    });
    if (!key || key.endsWith('::')) continue;
    const bucket = retriedQueueRowsByRoleText.get(key) || [];
    bucket.push({
      id: String(row?.id || '').trim(),
      timestamp: String(row?.timestamp || '').trim(),
      retryCount,
    });
    retriedQueueRowsByRoleText.set(key, bucket);
  }

  for (const message of transcriptById.values()) {
    const id = String(message?.id || '').trim();
    if (!id) continue;
    const existing = messagesById.get(id);
    if (!existing) continue;
    if (existing.role !== 'assistant') continue;
    const transcriptMessage = transcriptById.get(id) || null;
    if (!transcriptMessage) continue;
    messagesById.set(id, {
      ...existing,
      activities: mergeUniqueActivityTexts(
        Array.isArray(existing.activities) ? existing.activities : [],
        Array.isArray(transcriptMessage.activities) ? transcriptMessage.activities : [],
      ),
      text: stripRelayPromptContext(existing.text, existing.mode),
    });
  }

  for (const message of normalizedTranscriptMessages) {
    const id = String(message?.id || '').trim();
    if (id && messagesById.has(id)) continue;
    const identityKey = conversationMessageIdentityKey(message);
    if (dbIdentityKeys.has(identityKey)) continue;
    const roleTextKey = conversationMessageRoleTextKey(message);
    const maybeCanonicalRows = roleTextKey ? (dbMessagesByRoleText.get(roleTextKey) || []) : [];
    const retriedQueueRows = roleTextKey ? (retriedQueueRowsByRoleText.get(roleTextKey) || []) : [];
    if (
      message?.role === 'user'
      && maybeCanonicalRows.length > 0
      && retriedQueueRows.some((row) => maybeCanonicalRows.some((dbRow) => String(dbRow?.id || '').trim() === row.id))
    ) {
      const messageTimestampMs = normalizeConversationTimestampMs(message?.timestamp);
      const earliestCanonicalTimestampMs = maybeCanonicalRows.reduce((earliest, row) => {
        const next = normalizeConversationTimestampMs(row?.timestamp);
        if (!next) return earliest;
        if (!earliest) return next;
        return Math.min(earliest, next);
      }, 0);
      if (!earliestCanonicalTimestampMs || !messageTimestampMs || messageTimestampMs >= earliestCanonicalTimestampMs) {
        continue;
      }
    }
    if (maybeCanonicalRows.some((row) => isLikelyCanonicalDuplicateMessage(row, message))) continue;
    if (isTranscriptUserEchoOfQueuedMessage({
      transcriptMessage: message,
      canonicalDbMessages: maybeCanonicalRows,
      queueRowsById,
      firstAssistantTimestampBySourceId,
    })) {
      continue;
    }
    dbIdentityKeys.add(identityKey);
    if (!id) continue;
    messagesById.set(id, message);
  }

  return Array.from(messagesById.values()).sort(compareConversationMessageOrder);
}

export function registerSessionsRoutes(app, deps) {
  const {
    auth,
    io,
    db,
    stmts,
    runtimeState,
    config,
    parseAttachments,
    hydrateAttachment,
    relayActivityForResponse,
    buildContextResponseText,
    readContextFromSessionEvents,
    inFlightStateForConversation,
    createCompactedConversation,
    collectOrphanedUploadsFromConversation,
    deleteOrphanedUploads,
    queueCounts,
    getModelCatalogState,
    updateModelCatalog,
    buildRelayReadyBannerData,
    workspaceRootPayload,
    setWorkspaceRoot,
    resolveConversationWorkspaceState,
    updateConversationConfiguredWorkspaceRoot,
    learnConversationWorkspaceRoot,
    processingTimeoutMs,
    localhostOnly,
    listenHost,
    ensureSessionId,
    touchCli,
    markCliOffline,
    fetchUsageSummary,
    discoverSessionStateConversations,
    readSessionTranscriptMessages,
    ensureRuntimeSessionBinding,
    bootstrapRuntimeSessionBindings,
    configuredConversationSessionMode,
    SUPPORTED_RELAY_MODES,
    DEFAULT_RELAY_MODE,
    SUPPORTED_CONVERSATION_SESSION_MODES,
    DEFAULT_CONVERSATION_SESSION_MODE,
    DEFAULT_MODEL,
    remotePath,
    computeRetryDelayMs,
    relayRestartOrchestrator,
    relayBridgeOwnerService,
    featureFlags,
    sessionWorkerSupervisor,
    sessionWorkerRegistry,
    resolveSessionStateRoot,
  } = deps;
  const sdkSessionSyncService = createSdkSessionSyncService(db);
  const SDK_DELETE_WAIT_TIMEOUT_MS = 12_000;
  const SDK_DELETE_POLL_MS = 200;
  const SDK_DELETE_STALE_PROCESSING_MS = 60_000;
  const markConversationDeleted = db.prepare(`UPDATE conversations SET status = 'deleted', updated_at = datetime('now') WHERE id = ?`);
  const listSessionWorkerQueueRows = db.prepare(`
    SELECT id, conversation_id, runtime_session_id, owner_sdk_session_id, status
    FROM queue
    WHERE status IN (${SESSION_WORKER_STATUS_QUEUE_STATES.map(() => '?').join(', ')})
    ORDER BY timestamp ASC
  `);
  const listPendingQuestionSessionRows = db.prepare(`
    SELECT DISTINCT TRIM(sdk_session_id) AS sdk_session_id
    FROM relay_questions
    WHERE status = 'pending'
      AND sdk_session_id IS NOT NULL
      AND TRIM(sdk_session_id) <> ''
  `);
  const hardDeleteConversationRows = db.transaction((conversationId) => {
    if (typeof stmts.deleteConvQuestions?.run === 'function') {
      stmts.deleteConvQuestions.run(conversationId);
    } else {
      db.prepare(`DELETE FROM relay_questions WHERE conversation_id = ?`).run(conversationId);
    }
    if (typeof stmts.deleteConvBoards?.run === 'function') {
      stmts.deleteConvBoards.run(conversationId);
    } else {
      db.prepare(`DELETE FROM relay_boards WHERE conversation_id = ?`).run(conversationId);
    }
    if (typeof stmts.deleteConvStreamEvents?.run === 'function') {
      stmts.deleteConvStreamEvents.run(conversationId);
    } else {
      db.prepare(`DELETE FROM relay_stream_events WHERE conversation_id = ?`).run(conversationId);
    }
    db.prepare(`DELETE FROM queue WHERE conversation_id = ?`).run(conversationId);
    db.prepare(`DELETE FROM messages WHERE conversation_id = ?`).run(conversationId);
    db.prepare(`DELETE FROM runtime_sessions WHERE conversation_id = ?`).run(conversationId);
    db.prepare(`DELETE FROM conversations WHERE id = ?`).run(conversationId);
  });

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function readBridgeIdentity(req) {
    return relayBridgeOwnerService?.normalizeIdentity?.({
      pid: req.headers['x-relay-process-pid'],
      parentPid: req.headers['x-relay-parent-pid'],
      sessionId: req.headers['x-relay-session-id'],
      conversationId: req.headers['x-relay-conversation-id'],
    }) || null;
  }

  function shortId(value) {
    const text = String(value || '').trim();
    if (!text) return 'none';
    return `${text.slice(0, 8)}…`;
  }

  function markWorkerSessionSeen({ sdkSessionId, conversationId, runtimeSessionId } = {}) {
    const sid = String(sdkSessionId || '').trim();
    if (!sid) return null;
    const existing = sessionWorkerRegistry?.getWorker?.(sid) || null;
    return sessionWorkerRegistry?.upsertWorker?.({
      ...(existing || {}),
      sdkSessionId: sid,
      conversationId: String(conversationId || '').trim() || existing?.conversationId || null,
      runtimeSessionId: String(runtimeSessionId || '').trim() || existing?.runtimeSessionId || null,
      status: existing?.status || 'new',
    }) || null;
  }

  function enqueueSdkDeleteRequest(sdkSessionId, conversationId = null) {
    const sid = String(sdkSessionId || '').trim();
    if (!sid) return false;
    const nowIso = new Date().toISOString();
    const convId = String(conversationId || '').trim() || null;
    stmts.upsertSdkDeleteRequest.run(sid, convId, nowIso, nowIso);
    return true;
  }

  async function waitForSdkDeleteCompletion(sdkSessionId, timeoutMs = SDK_DELETE_WAIT_TIMEOUT_MS) {
    const sid = String(sdkSessionId || '').trim();
    if (!sid) return { completed: false };
    const startedAt = Date.now();
    while ((Date.now() - startedAt) < timeoutMs) {
      const row = stmts.getSdkDeleteRequestBySessionId.get(sid);
      if (!row) return { completed: true };
      await sleep(SDK_DELETE_POLL_MS);
    }
    return { completed: false };
  }

  function finalizeDeletedConversationsForSdkSession(sdkSessionId) {
    const sid = String(sdkSessionId || '').trim();
    if (!sid) return [];
    const rows = stmts.listDeletedConversationsBySdkSessionId.all(sid);
    const finalized = [];
    for (const row of rows) {
      const conversationId = String(row?.id || '').trim();
      if (!conversationId) continue;
      const orphanedUploads = collectOrphanedUploadsFromConversation(conversationId);
      hardDeleteConversationRows(conversationId);
      deleteOrphanedUploads(orphanedUploads);
      io.emit('conversation_deleted', { conversationId });
      finalized.push(conversationId);
    }
    return finalized;
  }

  // GET /api/conversations — list all conversations
  app.get('/api/conversations', auth, (req, res) => {
    const resolveMessageCount = (sdkSessionId, currentCount) => {
      const numeric = Number(currentCount || 0);
      if (numeric > 0) return numeric;
      const sid = String(sdkSessionId || '').trim();
      if (!sid) return 0;
      const transcript = readSessionTranscriptMessages(sid, { limit: 2000 });
      return Array.isArray(transcript) ? transcript.length : 0;
    };

    const includeArchived = String(req.query.archived || '').trim().toLowerCase() === 'true';
    const rows = stmts.listConvs.all(includeArchived ? 1 : 0);
    const discovered = discoverSessionStateConversations(200);
    const discoveredBySdkSessionId = new Map(
      discovered
        .map((item) => [String(item?.sdkSessionId || '').trim(), item])
        .filter(([sid]) => !!sid),
    );
    const conversations = rows.map((r) => {
      const sid = String(r.sdk_session_id || '').trim();
      const discoveredItem = sid ? discoveredBySdkSessionId.get(sid) : null;
      const discoveredUpdatedAt = String(discoveredItem?.updatedAt || '').trim();
      const discoveredTitle = String(discoveredItem?.title || '').trim();
      const workspaceState = typeof resolveConversationWorkspaceState === 'function'
        ? resolveConversationWorkspaceState({ conversationId: r.id, sdkSessionId: sid })
        : null;
      const preferences = resolveConversationPreferences(r, {
        supportedRelayModes: SUPPORTED_RELAY_MODES,
        defaultRelayMode: DEFAULT_RELAY_MODE,
      });
      return {
        id:           r.id,
        sdkSessionId: sid || null,
        title:        resolveConversationTitle({
          title: r.title,
          titleSource: r.title_source,
          discoveredTitle,
        }),
        archived:     Number(r.archived || 0) === 1,
        compactedInto: r.compacted_into || null,
        compactedFrom: r.compacted_from || null,
        runtimeSessionId: r.runtime_session_id || null,
        runtimeSessionStrategy: r.runtime_strategy || null,
        runtimeSessionStatus: r.runtime_status || null,
        runtimeSessionLastUsedAt: r.runtime_last_used_at || null,
        configuredWorkspaceRootPath: workspaceState?.configuredWorkspaceRootPath || null,
        configuredWorkspaceRootName: workspaceState?.configuredWorkspaceRootName || null,
        runtimeWorkspaceRootPath: workspaceState?.runtimeWorkspaceRootPath || null,
        runtimeWorkspaceRootName: workspaceState?.runtimeWorkspaceRootName || null,
        currentWorkspaceRootPath: workspaceState?.currentWorkspaceRootPath || null,
        currentWorkspaceRootName: workspaceState?.currentWorkspaceRootName || null,
        createdAt:    r.created_at,
        updatedAt:    discoveredUpdatedAt || r.updated_at,
        messageCount: resolveMessageCount(r.sdk_session_id, r.message_count),
        preferredRelayMode: preferences.preferredRelayMode,
        preferredModelsByMode: preferences.preferredModelsByMode,
      };
    });

    const knownById = new Set(conversations.map((c) => String(c.id || '').trim()).filter(Boolean));
    const knownBySdkSessionId = new Set(conversations.map((c) => String(c.sdkSessionId || '').trim()).filter(Boolean));
    const deletedSdkSessions = new Set(
      stmts.listDeletedSdkSessions
        .all()
        .map((row) => String(row?.sdk_session_id || '').trim())
        .filter(Boolean),
    );
    for (const item of discovered) {
      const sdkSessionId = String(item?.sdkSessionId || '').trim();
      if (!sdkSessionId) continue;
      if (deletedSdkSessions.has(sdkSessionId)) continue;
      if (knownBySdkSessionId.has(sdkSessionId) || knownById.has(sdkSessionId)) continue;

      const runtimeSession = stmts.getRuntimeSessionBySdkSessionId.get(sdkSessionId) || null;
      const updatedAt = String(item?.updatedAt || '').trim() || new Date().toISOString();
      const workspaceState = typeof resolveConversationWorkspaceState === 'function'
        ? resolveConversationWorkspaceState({ conversationId: sdkSessionId, sdkSessionId })
        : null;
      const syntheticConversation = {
        id: sdkSessionId,
        sdkSessionId,
        title: String(item?.title || '').trim() || 'Session',
        archived: false,
        compactedInto: null,
        compactedFrom: null,
        runtimeSessionId: runtimeSession?.id || null,
        runtimeSessionStrategy: runtimeSession?.strategy || null,
        runtimeSessionStatus: runtimeSession?.status || null,
        runtimeSessionLastUsedAt: runtimeSession?.last_used_at || updatedAt,
        configuredWorkspaceRootPath: workspaceState?.configuredWorkspaceRootPath || null,
        configuredWorkspaceRootName: workspaceState?.configuredWorkspaceRootName || null,
        runtimeWorkspaceRootPath: workspaceState?.runtimeWorkspaceRootPath || null,
        runtimeWorkspaceRootName: workspaceState?.runtimeWorkspaceRootName || null,
        currentWorkspaceRootPath: workspaceState?.currentWorkspaceRootPath || null,
        currentWorkspaceRootName: workspaceState?.currentWorkspaceRootName || null,
        createdAt: updatedAt,
        updatedAt,
        messageCount: resolveMessageCount(sdkSessionId, 0),
        preferredRelayMode: normalizeRelayModePreference(null, {
          supportedRelayModes: SUPPORTED_RELAY_MODES,
          fallbackMode: DEFAULT_RELAY_MODE,
        }),
        preferredModelsByMode: {},
      };
      conversations.push(syntheticConversation);
      knownById.add(sdkSessionId);
      knownBySdkSessionId.add(sdkSessionId);
    }

    conversations.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
    res.json({ conversations });
  });

  app.get('/api/sessions', auth, (req, res) => {
    const sessions = stmts.listRuntimeSessions.all().map((row) => ({
      id: row.id,
      conversationId: row.conversation_id,
      conversationTitle: row.conversation_title || row.conversation_id,
      strategy: row.strategy || null,
      runtimeKey: row.runtime_key || null,
      model: row.model || null,
      status: row.status || null,
      createdAt: row.created_at || null,
      lastUsedAt: row.last_used_at || null,
      conversationUpdatedAt: row.conversation_updated_at || null,
    }));
    res.json({ sessions });
  });

  // GET /api/sdk-session-delete/pending — relay extension fetches next pending SDK delete request
  app.get('/api/sdk-session-delete/pending', auth, (req, res) => {
    touchCli();
    const nowIso = new Date().toISOString();
    const staleCutoff = new Date(Date.now() - SDK_DELETE_STALE_PROCESSING_MS).toISOString();
    stmts.resetStaleSdkDeleteProcessing.run(nowIso, staleCutoff);
    const dequeue = db.transaction(() => {
      const next = stmts.dequeueSdkDeleteRequest.get(nowIso);
      if (!next?.sdk_session_id) return null;
      const claimed = stmts.setSdkDeleteRequestProcessing.run(nowIso, nowIso, next.sdk_session_id);
      if (claimed.changes === 0) return null;
      return {
        sdkSessionId: next.sdk_session_id,
        conversationId: next.conversation_id || null,
        retryCount: Number(next.retry_count || 0),
        requestedAt: next.requested_at || nowIso,
      };
    });
    const request = dequeue();
    return res.json({ request });
  });

  // POST /api/sdk-session-delete/result — relay extension reports SDK delete result
  app.post('/api/sdk-session-delete/result', auth, (req, res) => {
    touchCli();
    const sdkSessionId = String(req.body?.sdk_session_id || '').trim();
    const ok = req.body?.ok === true;
    const errorText = String(req.body?.error || '').trim() || 'Unknown SDK delete failure';
    if (!sdkSessionId) return res.status(400).json({ error: 'Missing sdk_session_id' });

    if (ok) {
      stmts.deleteSdkDeleteRequest.run(sdkSessionId);
      const finalizedConversationIds = finalizeDeletedConversationsForSdkSession(sdkSessionId);
      sessionWorkerRegistry?.removeWorker?.(sdkSessionId);
      if (!finalizedConversationIds.length) {
        io.emit('conversation_deleted', { conversationId: sdkSessionId });
      }
      return res.json({ ok: true, finalizedConversationIds });
    }

    const nowIso = new Date().toISOString();
    const current = stmts.getSdkDeleteRequestBySessionId.get(sdkSessionId);
    if (!current) return res.json({ ok: true, ignored: 'request_missing' });
    const nextRetryCount = Number(current.retry_count || 0) + 1;
    const nextAttemptAt = new Date(Date.now() + computeRetryDelayMs(nextRetryCount)).toISOString();
    stmts.setSdkDeleteRequestPendingWithError.run(nextAttemptAt, nowIso, errorText, sdkSessionId);
    io.emit('conversation_delete_pending', {
      sdkSessionId,
      conversationId: current.conversation_id || null,
      retryCount: nextRetryCount,
      nextAttemptAt,
      error: errorText,
    });
    return res.json({ ok: true, pending: true, retryCount: nextRetryCount, nextAttemptAt });
  });

  app.post('/api/session-sync', auth, (req, res) => {
    const body = req.body || {};
    relayBridgeOwnerService?.observe?.(readBridgeIdentity(req));
    const sdkSessionId = String(body.sdk_session_id || '').trim();
    const conversationId = String(body.conversation_id || '').trim();
    const workspaceRootPath = String(
      body.workspace_root_path
      || body.workspaceRootPath
      || body.cwd
      || body.current_working_directory
      || '',
    ).trim();
    const orchestratorCorrelationId = String(
      body.orchestrator_correlation_id
      || body.orchestrator_transaction_id
      || body.restart_transaction_id
      || body.transaction_id
      || body.correlation_id
      || '',
    ).trim();
    const orchestratorTargetSessionId = String(
      body.orchestrator_target_session_id
      || body.restart_target_session_id
      || body.target_session_id
      || body.targetSessionId
      || '',
    ).trim();
    const rebindCompleted = body.rebind_completed === true
      || body.rebind_complete === true
      || body.rebindConfirmed === true
      || String(body.rebind_state || body.rebind_signal || '').trim().toLowerCase() === 'completed';
    if (rebindCompleted) {
      console.log(
        `[session-sync] rebind signal sid=${shortId(sdkSessionId)} conv=${shortId(conversationId)} tx=${shortId(orchestratorCorrelationId)} target=${shortId(orchestratorTargetSessionId)}`,
      );
    }

    if (!sdkSessionId || !conversationId) {
      return res.status(400).json({ error: 'Missing sdk_session_id or conversation_id' });
    }

    try {
      const workspaceRootSync = learnWorkspaceRootFromSessionSync({
        learnConversationWorkspaceRoot,
        sdkSessionId,
        conversationId,
        workspaceRootPath,
      });
      const sync = sdkSessionSyncService.syncSession({
        sdk_session_id: sdkSessionId,
        conversation_id: conversationId,
      });
      const rebind = relayRestartOrchestrator?.applySessionSync?.({
        sdkSessionId,
        conversationId,
        correlationId: orchestratorCorrelationId || null,
        targetSessionId: orchestratorTargetSessionId || null,
        rebindCompleted,
        signalSource: 'api-session-sync',
      }) || null;
      if (rebindCompleted) {
        console.log(
          `[session-sync] rebind outcome sid=${shortId(sdkSessionId)} tx=${shortId(orchestratorCorrelationId)} code=${String(rebind?.code || 'none')} completed=${rebind?.completed === true ? 'yes' : 'no'} state=${String(rebind?.state?.state || 'unknown')}`,
        );
      }
      if (rebindCompleted && rebind?.ok === false && rebind?.conflict) {
        const statusCode = rebind.retryable ? 409 : 409;
        return res.status(statusCode).json({
          error: rebind.message || 'Rebind confirmation conflict',
          code: rebind.code || 'rebind-conflict',
          retryable: rebind.retryable === true,
          terminal: rebind.terminal === true,
          rebind,
          restartOrchestrator: rebind.state || relayRestartOrchestrator?.getState?.() || null,
        });
      }
      stmts.clearDeletedSdkSession.run(sdkSessionId);
      markWorkerSessionSeen({
        sdkSessionId: sync?.sdkSessionId || sdkSessionId,
        conversationId: sync?.conversationId || conversationId,
        runtimeSessionId: sync?.runtimeSessionId || null,
      });
      io.emit('conversation_session_bound', {
        conversationId: sync?.conversationId || conversationId,
        sdkSessionId: sync?.sdkSessionId || sdkSessionId,
        runtimeSessionId: sync?.runtimeSessionId || null,
      });
      if (workspaceRootSync.ok && workspaceRootSync.state?.conversationId) {
        io.emit('conversation_workspace_root_updated', {
          conversationId: workspaceRootSync.state.conversationId,
          sdkSessionId: workspaceRootSync.state.sdkSessionId || sync?.sdkSessionId || sdkSessionId,
          configuredWorkspaceRootPath: workspaceRootSync.state.configuredWorkspaceRootPath || null,
          configuredWorkspaceRootName: workspaceRootSync.state.configuredWorkspaceRootName || null,
          runtimeWorkspaceRootPath: workspaceRootSync.state.runtimeWorkspaceRootPath || null,
          runtimeWorkspaceRootName: workspaceRootSync.state.runtimeWorkspaceRootName || null,
          currentWorkspaceRootPath: workspaceRootSync.state.currentWorkspaceRootPath || null,
          currentWorkspaceRootName: workspaceRootSync.state.currentWorkspaceRootName || null,
        });
      }
      return res.json({
        ok: true,
        session: {
          conversationId: sync?.conversationId || conversationId,
          sdkSessionId: sync?.sdkSessionId || sdkSessionId,
          runtimeSessionId: sync?.runtimeSessionId || null,
          createdRuntimeSession: sync?.createdRuntimeSession === true,
        },
        workspaceRoot: workspaceRootSync.ok ? {
          learned: workspaceRootSync.learned === true,
          changed: workspaceRootSync.changed === true,
          rootPath: workspaceRootSync.rootPath || workspaceRootPath || null,
          rootName: workspaceRootSync.rootName || null,
        } : null,
        rebind: rebind ? {
          considered: rebind.considered === true,
          completed: rebind.completed === true,
          awaitingRebind: rebind.awaitingRebind === true,
          code: rebind.code || null,
          retryable: rebind.retryable === true,
          terminal: rebind.terminal === true,
          expected: rebind.expected || null,
        } : null,
        bindingState: 'bound',
        restartOrchestrator: rebind?.state || relayRestartOrchestrator?.getState?.() || null,
        activeBridgeOwner: relayBridgeOwnerService?.getOwner?.() || null,
      });
    } catch (error) {
      const statusCode = Number(error?.statusCode || 500);
      const retryable = statusCode >= 500;
      const payload = {
        error: error?.message || 'Failed to sync session',
        code: statusCode === 409 ? 'binding-conflict' : 'session-sync-failed',
        retryable,
        terminal: !retryable,
      };
      return res.status(Number.isInteger(statusCode) ? statusCode : 500).json(payload);
    }
  });

  app.post('/api/session-workspace-root', auth, (req, res) => {
    const sdkSessionId = String(req.body?.sdk_session_id || req.body?.sdkSessionId || '').trim();
    const conversationId = String(req.body?.conversation_id || req.body?.conversationId || '').trim();
    const workspaceRootPath = String(
      req.body?.workspace_root_path
      || req.body?.workspaceRootPath
      || req.body?.cwd
      || req.body?.current_working_directory
      || '',
    ).trim();
    const result = learnWorkspaceRootFromSessionSync({
      learnConversationWorkspaceRoot,
      sdkSessionId,
      conversationId,
      workspaceRootPath,
    });
    if (!result.ok) {
      return res.status(400).json({
        ok: false,
        error: result.error || 'Failed to learn workspace root',
      });
    }
    if (result.state?.conversationId) {
      io.emit('conversation_workspace_root_updated', {
        conversationId: result.state.conversationId,
        sdkSessionId: result.state.sdkSessionId || sdkSessionId || null,
        configuredWorkspaceRootPath: result.state.configuredWorkspaceRootPath || null,
        configuredWorkspaceRootName: result.state.configuredWorkspaceRootName || null,
        runtimeWorkspaceRootPath: result.state.runtimeWorkspaceRootPath || null,
        runtimeWorkspaceRootName: result.state.runtimeWorkspaceRootName || null,
        currentWorkspaceRootPath: result.state.currentWorkspaceRootPath || null,
        currentWorkspaceRootName: result.state.currentWorkspaceRootName || null,
      });
    }
    return res.json({
      ok: true,
      learned: true,
      changed: result.changed === true,
      workspaceRootPath: result.rootPath || workspaceRootPath || null,
      workspaceRootName: result.rootName || null,
      conversationId: result.state?.conversationId || conversationId || null,
      sdkSessionId: result.state?.sdkSessionId || sdkSessionId || null,
      configuredWorkspaceRootPath: result.state?.configuredWorkspaceRootPath || null,
      configuredWorkspaceRootName: result.state?.configuredWorkspaceRootName || null,
      runtimeWorkspaceRootPath: result.state?.runtimeWorkspaceRootPath || null,
      runtimeWorkspaceRootName: result.state?.runtimeWorkspaceRootName || null,
      currentWorkspaceRootPath: result.state?.currentWorkspaceRootPath || null,
      currentWorkspaceRootName: result.state?.currentWorkspaceRootName || null,
      ...workspaceRootPayload(),
    });
  });

  app.get('/api/context/:conversationId', auth, (req, res) => {
    const conversationId = String(req.params.conversationId || '').trim();
    if (!conversationId) return res.status(400).json({ error: 'Missing conversationId' });
    // Prefer canonical sdk_session_id routing when available; keep conversation-id lookup for compatibility.
    const runtimeSessionBySdkSessionId = stmts.getRuntimeSessionBySdkSessionId.get(conversationId) || null;
    const runtimeSession = runtimeSessionBySdkSessionId
      || stmts.getRuntimeSessionByConversation.get(conversationId)
      || null;
    const copilotSessionId = String(runtimeSessionBySdkSessionId?.sdk_session_id || runtimeSession?.sdk_session_id || '').trim() || null;
    const parsed = readContextFromSessionEvents(
      runtimeSession?.id || null,
      copilotSessionId || runtimeSession?.runtime_key || runtimeSession?.id || null,
    );

    res.json({
      conversationId,
      runtimeSessionId: runtimeSession?.id || null,
      copilotSessionId,
      snapshot: parsed.snapshot || null,
      eventsPath: parsed.eventsPath || null,
      error: parsed.error || null,
      text: buildContextResponseText({
        snapshot: parsed.snapshot,
        runtimeSession,
        conversationId,
        eventsPath: parsed.eventsPath,
        error: parsed.error,
      }),
    });
  });

  app.get('/api/context', auth, (req, res) => {
    const explicitConversationId = String(req.query.conversationId || '').trim();
    if (explicitConversationId) {
      const runtimeSessionBySdkSessionId = stmts.getRuntimeSessionBySdkSessionId.get(explicitConversationId) || null;
      const runtimeSession = runtimeSessionBySdkSessionId
        || stmts.getRuntimeSessionByConversation.get(explicitConversationId)
        || null;
      const copilotSessionId = String(runtimeSessionBySdkSessionId?.sdk_session_id || runtimeSession?.sdk_session_id || '').trim() || null;
      const parsed = readContextFromSessionEvents(
        runtimeSession?.id || null,
        copilotSessionId || runtimeSession?.runtime_key || runtimeSession?.id || null,
      );
      return res.json({
        conversationId: explicitConversationId,
        runtimeSessionId: runtimeSession?.id || null,
        copilotSessionId,
        snapshot: parsed.snapshot || null,
        eventsPath: parsed.eventsPath || null,
        error: parsed.error || null,
        text: buildContextResponseText({
          snapshot: parsed.snapshot,
          runtimeSession,
          conversationId: explicitConversationId,
          eventsPath: parsed.eventsPath,
          error: parsed.error,
        }),
      });
    }
    return res.json({
      conversationId: null,
      runtimeSessionId: null,
      snapshot: null,
      eventsPath: null,
      error: 'Missing conversationId query parameter',
      text: 'Context is unavailable until a conversation is selected.',
    });
  });

  // GET /api/conversation/:id — get paginated conversation history
  app.get('/api/conversation/:id', auth, (req, res) => {
    const requestedId = String(req.params.id || '').trim();
    const limit = normalizeConversationHistoryLimit(req.query.limit, 20);
    const beforeMessageId = String(req.query.beforeMessageId || '').trim();
    const beforeTimestamp = String(req.query.beforeTimestamp || '').trim();
    if (stmts.getDeletedSdkSession.get(requestedId)) {
      return res.status(404).json({ error: 'Conversation not found' });
    }
    const conv = stmts.getConv.get(requestedId);
    if (!conv) {
      const discovered = discoverSessionStateConversations(400);
      const match = discovered.find((item) => String(item?.sdkSessionId || '').trim() === requestedId) || null;
      if (!match) return res.status(404).json({ error: 'Conversation not found' });
      const runtimeSession = stmts.getRuntimeSessionBySdkSessionId.get(requestedId) || null;
      const updatedAt = String(match?.updatedAt || '').trim() || new Date().toISOString();
      const discoveredTitle = String(match?.title || '').trim() || 'Session';
      const transcriptMessages = readSessionTranscriptMessages(requestedId, { limit: Number.POSITIVE_INFINITY });
      const history = selectConversationHistoryPage(
        buildConversationMessages({
          dbMessages: [],
          transcriptMessages,
        }),
        { limit, beforeMessageId, beforeTimestamp },
      );
      const sessionRoot = buildConversationSessionRootPayload({
        conversationId: requestedId,
        sdkSessionId: requestedId,
        title: discoveredTitle,
        resolveSessionStateRoot,
      });
      const workspaceState = typeof resolveConversationWorkspaceState === 'function'
        ? resolveConversationWorkspaceState({ conversationId: requestedId, sdkSessionId: requestedId })
        : null;
      return res.json({
        id: requestedId,
        sdkSessionId: requestedId,
        title: discoveredTitle,
        sessionRootPath: sessionRoot?.sessionRootPath || null,
        sessionRootName: sessionRoot?.sessionRootName || discoveredTitle,
        configuredWorkspaceRootPath: workspaceState?.configuredWorkspaceRootPath || null,
        configuredWorkspaceRootName: workspaceState?.configuredWorkspaceRootName || null,
        runtimeWorkspaceRootPath: workspaceState?.runtimeWorkspaceRootPath || null,
        runtimeWorkspaceRootName: workspaceState?.runtimeWorkspaceRootName || null,
        currentWorkspaceRootPath: workspaceState?.currentWorkspaceRootPath || null,
        currentWorkspaceRootName: workspaceState?.currentWorkspaceRootName || null,
        archived: false,
        compactedInto: null,
        compactedFrom: null,
        runtimeSession: runtimeSession ? {
          id: runtimeSession.id,
          sdkSessionId: runtimeSession.sdk_session_id || requestedId,
          strategy: runtimeSession.strategy || null,
          status: runtimeSession.status || null,
          model: runtimeSession.model || null,
          createdAt: runtimeSession.created_at || null,
          lastUsedAt: runtimeSession.last_used_at || null,
        } : null,
        createdAt: updatedAt,
        updatedAt,
        inFlight: null,
        preferredRelayMode: normalizeRelayModePreference(null, {
          supportedRelayModes: SUPPORTED_RELAY_MODES,
          fallbackMode: DEFAULT_RELAY_MODE,
        }),
        preferredModelsByMode: {},
        messages: history.messages,
        pageInfo: history.pageInfo,
      });
    }
    const runtimeSession = stmts.getRuntimeSessionByConversation.get(req.params.id) || null;
    const discoveredTitle = (() => {
      const sdkSessionId = String(conv.sdk_session_id || '').trim();
      if (!sdkSessionId) return null;
      const discovered = discoverSessionStateConversations(400);
      const match = discovered.find((item) => String(item?.sdkSessionId || '').trim() === sdkSessionId) || null;
      const title = String(match?.title || '').trim();
      return title || null;
    })();
    const resolvedTitle = resolveConversationTitle({
      title: conv.title,
      titleSource: conv.title_source,
      discoveredTitle,
    });
    const preferences = resolveConversationPreferences(conv, {
      supportedRelayModes: SUPPORTED_RELAY_MODES,
      defaultRelayMode: DEFAULT_RELAY_MODE,
    });
    const inFlight = inFlightStateForConversation(req.params.id);
    const transcriptMessages = readSessionTranscriptMessages(String(conv.sdk_session_id || req.params.id || '').trim(), { limit: Number.POSITIVE_INFINITY });
    const sessionRoot = buildConversationSessionRootPayload({
      conversationId: req.params.id,
      sdkSessionId: conv.sdk_session_id || req.params.id,
      title: resolvedTitle,
      resolveSessionStateRoot,
    });
    const workspaceState = typeof resolveConversationWorkspaceState === 'function'
      ? resolveConversationWorkspaceState({ conversationId: req.params.id, sdkSessionId: conv.sdk_session_id || req.params.id })
      : null;
    const dbMessages = stmts.getMessages.all(req.params.id);
    const queueRows = db.prepare(`
      SELECT id, response_message_id, text, timestamp, retry_count
      FROM queue
      WHERE conversation_id = ?
    `).all(req.params.id);
    const responseMessageToSourceId = new Map(
      queueRows
        .map((row) => [String(row?.response_message_id || '').trim(), String(row?.id || '').trim()])
        .filter(([responseMessageId, sourceMessageId]) => !!responseMessageId && !!sourceMessageId),
    );
    const relayActivitiesByMessageId = new Map(
      dbMessages
        .filter((m) => m.role === 'assistant')
        .map((m) => [m.id, relayActivityForResponse(m.id)]),
    );
    let messages = buildConversationMessages({
      dbMessages: dbMessages.map((message) => ({
        ...message,
        attachments: parseAttachments(message.attachments).map(hydrateAttachment).filter(Boolean),
      })),
      transcriptMessages,
      relayActivitiesByMessageId,
      responseMessageToSourceId,
      queueRows,
    });
    messages = messages.map((message) => {
      if (message.role !== 'assistant') return message;
      const sourceMessageId = responseMessageToSourceId.get(String(message.id || '').trim()) || message.sourceMessageId || undefined;
      return sourceMessageId ? { ...message, sourceMessageId } : message;
    });
    const history = selectConversationHistoryPage(messages, { limit, beforeMessageId, beforeTimestamp });
    res.json({
      id: conv.id,
      sdkSessionId: conv.sdk_session_id || null,
      title: resolvedTitle,
      sessionRootPath: sessionRoot?.sessionRootPath || null,
      sessionRootName: sessionRoot?.sessionRootName || resolvedTitle || 'Session',
      configuredWorkspaceRootPath: workspaceState?.configuredWorkspaceRootPath || null,
      configuredWorkspaceRootName: workspaceState?.configuredWorkspaceRootName || null,
      runtimeWorkspaceRootPath: workspaceState?.runtimeWorkspaceRootPath || null,
      runtimeWorkspaceRootName: workspaceState?.runtimeWorkspaceRootName || null,
      currentWorkspaceRootPath: workspaceState?.currentWorkspaceRootPath || null,
      currentWorkspaceRootName: workspaceState?.currentWorkspaceRootName || null,
      archived: Number(conv.archived || 0) === 1,
      compactedInto: conv.compacted_into || null,
      compactedFrom: conv.compacted_from || null,
      runtimeSession: runtimeSession ? {
        id: runtimeSession.id,
        sdkSessionId: runtimeSession.sdk_session_id || conv.sdk_session_id || null,
        strategy: runtimeSession.strategy || null,
        status: runtimeSession.status || null,
        model: runtimeSession.model || null,
        createdAt: runtimeSession.created_at || null,
        lastUsedAt: runtimeSession.last_used_at || null,
      } : null,
      createdAt: conv.created_at,
      updatedAt: conv.updated_at,
      inFlight,
      preferredRelayMode: preferences.preferredRelayMode,
      preferredModelsByMode: preferences.preferredModelsByMode,
      messages: history.messages,
      pageInfo: history.pageInfo,
    });
  });

  app.patch('/api/conversation/:id', auth, (req, res) => {
    const conversationId = String(req.params.id || '').trim();
    const result = persistConversationTitle({
      db,
      stmts,
      io,
      conversationId,
      title: req.body?.title,
      resolveSessionStateRoot,
    });
    if (!result.ok) {
      return res.status(result.statusCode || 500).json({ error: result.error || 'Failed to update conversation title' });
    }
    return res.json({
      ok: true,
      conversationId: result.conversationId,
      title: result.title,
      updatedAt: result.updatedAt,
      created: result.created === true,
    });
  });

  app.patch('/api/conversation/:id/preferences', auth, (req, res) => {
    const conversationId = String(req.params.id || '').trim();
    if (!conversationId) return res.status(400).json({ error: 'Missing conversation id' });
    const senderClientId = String(req.body?.clientId || '').trim() || null;

    const existing = stmts.getConvAnyStatus.get(conversationId);
    if (existing && String(existing.status || '').trim() === 'deleted') {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    const now = new Date().toISOString();
    const preferredRelayMode = normalizeRelayModePreference(req.body?.preferredRelayMode, {
      supportedRelayModes: SUPPORTED_RELAY_MODES,
      fallbackMode: DEFAULT_RELAY_MODE,
    });
    const preferredModelsByMode = normalizePreferredModelsByMode(req.body?.preferredModelsByMode, {
      supportedRelayModes: SUPPORTED_RELAY_MODES,
    });
    const persisted = persistConversationPreferences({
      db,
      stmts,
      conversationId,
      preferredRelayMode,
      preferredModelsByMode,
      updatedAt: now,
      createIfMissing: !existing,
      createTitle: 'Session',
    });

    io.emit('conversation_preferences_updated', {
      conversationId,
      preferredRelayMode: persisted.preferredRelayMode,
      preferredModelsByMode: persisted.preferredModelsByMode,
      updatedAt: persisted.updatedAt,
      senderClientId,
    });

    return res.json({
      ok: true,
      conversationId,
      preferredRelayMode: persisted.preferredRelayMode,
      preferredModelsByMode: persisted.preferredModelsByMode,
      updatedAt: persisted.updatedAt,
      created: persisted.created,
      senderClientId,
    });
  });

  app.post('/api/conversation/:id/workspace-root', auth, (req, res) => {
    const conversationId = String(req.params.id || '').trim();
    if (!conversationId) return res.status(400).json({ error: 'Missing conversation id' });
    const nextRootPath = String(
      req.body?.rootPath
      || req.body?.workspaceRootPath
      || req.body?.workspace_root_path
      || req.body?.cwd
      || '',
    ).trim();
    if (!nextRootPath) {
      return res.status(400).json({ error: 'Missing rootPath' });
    }
    if (typeof updateConversationConfiguredWorkspaceRoot !== 'function') {
      return res.status(500).json({ error: 'Conversation workspace updates are unavailable' });
    }
    const result = updateConversationConfiguredWorkspaceRoot({
      conversationId,
      rootPath: nextRootPath,
    });
    if (!result?.ok) {
      return res.status(400).json({ error: result?.error || 'Failed to update conversation workspace root' });
    }
    const state = result.state || null;
    io.emit('conversation_workspace_root_updated', {
      conversationId,
      sdkSessionId: state?.sdkSessionId || null,
      configuredWorkspaceRootPath: state?.configuredWorkspaceRootPath || null,
      configuredWorkspaceRootName: state?.configuredWorkspaceRootName || null,
      runtimeWorkspaceRootPath: state?.runtimeWorkspaceRootPath || null,
      runtimeWorkspaceRootName: state?.runtimeWorkspaceRootName || null,
      currentWorkspaceRootPath: state?.currentWorkspaceRootPath || null,
      currentWorkspaceRootName: state?.currentWorkspaceRootName || null,
    });
    return res.json({
      ok: true,
      conversationId,
      sdkSessionId: state?.sdkSessionId || null,
      configuredWorkspaceRootPath: state?.configuredWorkspaceRootPath || null,
      configuredWorkspaceRootName: state?.configuredWorkspaceRootName || null,
      runtimeWorkspaceRootPath: state?.runtimeWorkspaceRootPath || null,
      runtimeWorkspaceRootName: state?.runtimeWorkspaceRootName || null,
      currentWorkspaceRootPath: state?.currentWorkspaceRootPath || null,
      currentWorkspaceRootName: state?.currentWorkspaceRootName || null,
    });
  });

  app.post('/api/conversation/:id/compact', auth, (req, res) => {
    const sourceConversationId = req.params.id;
    const compacted = createCompactedConversation(sourceConversationId);
    if (!compacted) return res.status(404).json({ error: 'Conversation not found' });
    io.emit('conversation_compacted', compacted);
    res.json({
      ok: true,
      sourceConversationId: compacted.sourceConversationId,
      compactedConversationId: compacted.targetConversationId,
      conversationId: compacted.targetConversationId,
      runtimeSessionId: compacted.runtimeSessionId,
      summarySeedPreview: compacted.summarySeed.slice(0, 240),
    });
  });

  // DELETE /api/conversation/:id — delete conversation
  app.delete('/api/conversation/:id', auth, async (req, res) => {
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ error: 'Missing conversation id' });

    const existing = stmts.getConvAnyStatus.get(id);
    if (!existing) {
      const discovered = discoverSessionStateConversations(400);
      const isSdkSessionConversation = discovered.some((item) => String(item?.sdkSessionId || '').trim() === id);
      if (!isSdkSessionConversation) return res.json({ ok: true, alreadyDeleted: true });
      stmts.markDeletedSdkSession.run(id, new Date().toISOString());
      enqueueSdkDeleteRequest(id, null);
      const awaited = await waitForSdkDeleteCompletion(id);
      if (awaited.completed) return res.json({ ok: true, deleted: true, sdkSessionOnly: true });
      io.emit('conversation_delete_pending', { conversationId: id, sdkSessionOnly: true });
      return res.json({ ok: true, pending: true, sdkSessionOnly: true });
    }

    try {
      const sdkSessionId = String(existing.sdk_session_id || '').trim() || null;
      if (!sdkSessionId) {
        const orphanedUploads = collectOrphanedUploadsFromConversation(id);
        hardDeleteConversationRows(id);
        deleteOrphanedUploads(orphanedUploads);
        io.emit('conversation_deleted', { conversationId: id });
        return res.json({ ok: true });
      }

      markConversationDeleted.run(id);
      stmts.markDeletedSdkSession.run(sdkSessionId, new Date().toISOString());
      enqueueSdkDeleteRequest(sdkSessionId, id);
      const awaited = await waitForSdkDeleteCompletion(sdkSessionId);
      if (awaited.completed) return res.json({ ok: true });

      io.emit('conversation_delete_pending', { conversationId: id });
      return res.json({ ok: true, pending: true });
    } catch (error) {
      console.warn(`[archive] Delete failed for ${id}: ${error?.message || error}`);
      return res.status(500).json({ error: 'Failed to delete conversation' });
    }
  });

  // POST /api/conversation/:id/archive — archive conversation
  app.post('/api/conversation/:id/archive', auth, async (req, res) => {
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ error: 'Missing conversation id' });
    try {
      const existing = stmts.getConvAnyStatus.get(id);
      if (!existing || String(existing.status || '').trim() === 'deleted') {
        return res.json({ ok: true, alreadyDeleted: true });
      }
      db.prepare(`UPDATE conversations SET archived = 1, updated_at = datetime('now') WHERE id = ?`).run(id);
      io.emit('conversation_archived', { conversationId: id });
      return res.json({ ok: true });
    } catch (error) {
      console.warn(`[archive] Archive failed for ${id}: ${error?.message || error}`);
      return res.status(500).json({ error: 'Failed to archive conversation' });
    }
  });

  // GET /api/status — overall status
  app.get('/api/status', auth, (req, res) => {
    ensureSessionId(req, res);
    const { pendingCount, processingCount, parkedCount } = queueCounts();
    const modelState = getModelCatalogState();
    const activeRuntimeSessionCount = Number(stmts.countRuntimeSessions.get()?.cnt || 0);
    const readyBanner = buildRelayReadyBannerData();
    const pendingQuestionSessionIds = listPendingQuestionSessionRows.all()
      .map((row) => normalizeWorkerStatusText(row?.sdk_session_id))
      .filter(Boolean);
    res.json({
      cliOnline: runtimeState.cliOnline,
      relayPaused: runtimeState.relayPaused,
      pendingCount,
      processingCount,
      parkedCount,
      activeRuntimeSessionCount,
      supportedModels: modelState.models,
      defaultModel: modelState.defaultModel,
      currentModel: modelState.currentModel,
      modelsStale: modelState.stale,
      modelsRefreshedAt: modelState.refreshedAt,
      modelWarning: modelState.warning,
      supportedRelayModes: SUPPORTED_RELAY_MODES,
      defaultRelayMode: DEFAULT_RELAY_MODE,
      supportedConversationSessionModes: SUPPORTED_CONVERSATION_SESSION_MODES,
      conversationSessionMode: configuredConversationSessionMode,
      ...workspaceRootPayload(),
      processingTimeoutMs,
      localhostOnly,
      listenHost,
      readyBanner,
      remotePath,
      sshTunnel: {
        enabled: runtimeState.tunnelState?.enabled ?? false,
        connected: runtimeState.tunnelState?.connected ?? false,
        host: runtimeState.tunnelState?.host ?? null,
        remotePort: runtimeState.tunnelState?.remotePort ?? null,
        remoteBindMode: runtimeState.tunnelState?.remoteBindMode ?? null,
        reconnectAttempts: runtimeState.tunnelState?.reconnectAttempts ?? 0,
        connectedSince: runtimeState.tunnelState?.connectedSince ?? null,
      },
      activeBridgeOwner: runtimeState.activeBridgeOwner || null,
      restartOrchestrator: relayRestartOrchestrator?.getState?.() || null,
      relayShutdown: runtimeState.relayShutdown || null,
      features: featureFlags || {},
      sessionWorker: buildSessionWorkerStatusPayload({
        featureFlags,
        supervisorSnapshot: sessionWorkerSupervisor?.snapshot?.({ pendingQuestionSessionIds }) || null,
        queueRows: listSessionWorkerQueueRows.all(...SESSION_WORKER_STATUS_QUEUE_STATES),
      }),
    });
  });

  app.post('/api/workspace-root', auth, (req, res) => {
    const nextRootPath = String(req.body?.rootPath || req.body?.workspaceRootPath || '').trim();
    if (!nextRootPath) {
      return res.status(400).json({ error: 'Missing rootPath' });
    }
    if (typeof setWorkspaceRoot !== 'function') {
      return res.status(500).json({ error: 'Workspace root updates are unavailable' });
    }

    const result = setWorkspaceRoot(nextRootPath, { reason: 'manual-ui-change' });
    if (!result?.changed && result?.error) {
      return res.status(400).json({ error: result.error });
    }

    const payload = workspaceRootPayload();
    io.emit('workspace_root_changed', payload);
    return res.json({
      ok: true,
      changed: !!result?.changed,
      ...payload,
    });
  });

  app.post('/api/session-worker/:sdkSessionId/launch', auth, async (req, res) => {
    const sdkSessionId = String(req.params.sdkSessionId || '').trim();
    const result = await launchWorkspaceRootSession(runtimeState, sessionWorkerSupervisor, sdkSessionId);
    if (!result?.ok) {
      return res.status(result?.statusCode || 400).json({
        ok: false,
        error: result?.error || 'launch-failed',
        worker: result?.worker || null,
        lifecycle: result?.lifecycle || null,
      });
    }
    return res.json({
      ok: true,
      ...result,
    });
  });

  app.get('/api/restart-orchestrator', auth, (req, res) => {
    ensureSessionId(req, res);
    return res.json({ orchestrator: relayRestartOrchestrator?.getState?.() || null });
  });

  app.post('/api/restart-orchestrator/request', auth, (req, res) => {
    const targetSessionId = String(req.body?.targetSessionId || req.body?.target_session_id || '').trim();
    if (!targetSessionId) return res.status(400).json({ error: 'Missing targetSessionId' });
    const result = relayRestartOrchestrator?.requestRestart({
      targetSessionId,
      reason: String(req.body?.reason || 'manual-request').trim() || 'manual-request',
    });
    if (!result?.ok) return res.status(400).json({ error: result?.error || 'request rejected', orchestrator: result?.state || null });
    return res.json({ ok: true, ...result });
  });

  app.post('/api/restart-orchestrator/rebind', auth, (req, res) => {
    touchCli();
    relayBridgeOwnerService?.observe?.(readBridgeIdentity(req));
    const body = req.body || {};
    const sdkSessionId = String(body.sdk_session_id || body.sdkSessionId || '').trim();
    const conversationId = String(body.conversation_id || body.conversationId || '').trim() || null;
    const orchestratorCorrelationId = String(
      body.orchestrator_correlation_id
      || body.orchestrator_transaction_id
      || body.restart_transaction_id
      || body.transaction_id
      || body.correlation_id
      || '',
    ).trim();
    const orchestratorTargetSessionId = String(
      body.orchestrator_target_session_id
      || body.restart_target_session_id
      || body.target_session_id
      || body.targetSessionId
      || '',
    ).trim();
    if (!sdkSessionId) {
      return res.status(400).json({ error: 'Missing sdk_session_id' });
    }
    console.log(
      `[relay-rebind] request sid=${shortId(sdkSessionId)} conv=${shortId(conversationId)} tx=${shortId(orchestratorCorrelationId)} target=${shortId(orchestratorTargetSessionId)}`,
    );
    const rebind = relayRestartOrchestrator?.applySessionSync?.({
      sdkSessionId,
      conversationId,
      correlationId: orchestratorCorrelationId || null,
      targetSessionId: orchestratorTargetSessionId || null,
      rebindCompleted: true,
      signalSource: 'api-restart-orchestrator-rebind',
    }) || null;
    if (!rebind) {
      return res.status(503).json({
        error: 'Restart orchestrator unavailable',
        code: 'restart-orchestrator-unavailable',
      });
    }
    if (rebind.ok === false && rebind.conflict) {
      console.warn(
        `[relay-rebind] conflict sid=${shortId(sdkSessionId)} tx=${shortId(orchestratorCorrelationId)} code=${String(rebind.code || 'none')} retryable=${rebind.retryable === true ? 'yes' : 'no'} terminal=${rebind.terminal === true ? 'yes' : 'no'} state=${String(rebind?.state?.state || 'unknown')}`,
      );
      return res.status(409).json({
        error: rebind.message || 'Rebind confirmation conflict',
        code: rebind.code || 'rebind-conflict',
        retryable: rebind.retryable === true,
        terminal: rebind.terminal === true,
        rebind,
        restartOrchestrator: rebind.state || relayRestartOrchestrator?.getState?.() || null,
      });
    }
    console.log(
      `[relay-rebind] outcome sid=${shortId(sdkSessionId)} tx=${shortId(orchestratorCorrelationId)} completed=${rebind.completed === true ? 'yes' : 'no'} state=${String(rebind?.state?.state || 'unknown')}`,
    );
    return res.json({
      ok: rebind.ok === true,
      rebind: {
        considered: rebind.considered === true,
        completed: rebind.completed === true,
        awaitingRebind: rebind.awaitingRebind === true,
        code: rebind.code || null,
        retryable: rebind.retryable === true,
        terminal: rebind.terminal === true,
        expected: rebind.expected || null,
      },
      restartOrchestrator: rebind.state || relayRestartOrchestrator?.getState?.() || null,
      activeBridgeOwner: relayBridgeOwnerService?.getOwner?.() || null,
    });
  });

  app.post('/api/restart-orchestrator/bridge-exit', auth, (req, res) => {
    const requester = readBridgeIdentity(req);
    const activeOwner = relayBridgeOwnerService?.getOwner?.() || null;
    console.log(
      `[bridge-exit] request ownerSid=${shortId(requester?.sessionId)} ownerPid=${String(requester?.pid || 'none')} tx=${shortId(req.body?.transactionId)} target=${shortId(req.body?.targetSessionId)}`,
    );
    if (activeOwner && requester && !relayBridgeOwnerService?.isOwner?.(requester)) {
      return res.status(409).json({
        error: 'Bridge exit rejected for non-owner requester',
        code: 'bridge-owner-mismatch',
        activeBridgeOwner: activeOwner,
        restartOrchestrator: relayRestartOrchestrator?.getState?.() || null,
      });
    }

    const orchestratorState = relayRestartOrchestrator?.getState?.() || null;
    console.log(
      `[bridge-exit] outcome tx=${shortId(orchestratorState?.transactionId)} target=${shortId(orchestratorState?.targetSessionId)} state=${String(orchestratorState?.state || 'unknown')} launcher=skipped`,
    );
    return res.json({
      ok: true,
      activeBridgeOwner: relayBridgeOwnerService?.getOwner?.() || null,
      restartOrchestrator: relayRestartOrchestrator?.getState?.() || null,
      launcher: null,
    });
  });

  app.get('/api/models', auth, (req, res) => {
    ensureSessionId(req, res);
    const modelState = getModelCatalogState();
    res.json({
      models: modelState.models,
      currentModel: modelState.currentModel,
      defaultModel: modelState.defaultModel,
      stale: modelState.stale,
      refreshedAt: modelState.refreshedAt,
      source: modelState.source,
      warning: modelState.warning,
    });
  });

  app.post('/api/models/snapshot', auth, (req, res) => {
    const { models, currentModel, defaultModel, source, error } = req.body || {};
    const nextState = updateModelCatalog({
      models: Array.isArray(models) ? models : [],
      currentModel,
      defaultModel,
      source: source || 'relay-extension',
      error,
    });
    io.emit('models_updated', {
      models: nextState.models,
      currentModel: nextState.currentModel,
      defaultModel: nextState.defaultModel,
      stale: nextState.stale,
      refreshedAt: nextState.refreshedAt,
      warning: nextState.warning,
    });
    res.json({
      ok: true,
      models: nextState.models,
      currentModel: nextState.currentModel,
      defaultModel: nextState.defaultModel,
      stale: nextState.stale,
      refreshedAt: nextState.refreshedAt,
      warning: nextState.warning,
    });
  });

  // GET /api/usage — Copilot quota fetched live from GitHub API
  app.get('/api/usage', auth, (req, res) => {
    fetchUsageSummary((err, summary) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(summary);
    });
  });
}
