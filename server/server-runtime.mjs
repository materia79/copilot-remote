'use strict';

import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import { execFile, execFileSync, spawn } from 'child_process';
import os from 'os';
import crypto from 'crypto';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import {
  resolveStartupWorkspaceRoot,
  workspaceRootDisplayName,
  parseCdCommandTarget,
  resolveCdCommandPath,
} from './workspace-root.mjs';
import { createSessionRepository } from './repositories/session-repository.mjs';
import { createMessageRepository } from './repositories/message-repository.mjs';
import { createQuestionRepository } from './repositories/question-repository.mjs';
import { registerSessionsRoutes } from './routes/sessions-routes.mjs';
import { registerMessagesRoutes } from './routes/messages-routes.mjs';
import { registerAskUserRoutes } from './routes/ask-user-routes.mjs';
import { registerRelayBoardRoutes } from './routes/relay-board-routes.mjs';
import { registerCacheRoutes } from './routes/cache-routes.mjs';
import { createDeleteArchiveService } from './services/delete-archive-service.mjs';
import { createSessionDiscoveryService } from './services/session-discovery-service.mjs';
import { createSessionTranscriptService } from './services/session-transcript-service.mjs';
import { createContextSnapshotService } from './services/context-snapshot-service.mjs';
import { createRelaySingletonGuard } from './services/relay-singleton-guard.mjs';
import { createRelayRestartOrchestrator } from './services/relay-restart-orchestrator-service.mjs';
import { createRelayBridgeOwnerService } from './services/relay-bridge-owner-service.mjs';
import { createRelayCliLauncherService } from './services/relay-cli-launcher-service.mjs';
import { createSessionWorkerRegistry } from './services/session-worker-registry-service.mjs';
import { createSessionWorkerSupervisor } from './services/session-worker-supervisor-service.mjs';
import { createSessionWorkerProcessInspector } from './services/session-worker-process-service.mjs';
import { FEATURES, normalizeFeatureFlags } from './features.mjs';
import { RELAY_RESTART_EXIT_CODE } from './relay-exit-codes.mjs';
import { DEFAULT_QUESTION_TIMEOUT_MS } from '../shared/question-timeout.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Config ────────────────────────────────────────────────────────────────────
const CONFIG_PATH    = process.env.COPILOT_WEB_RELAY_CONFIG
  ? path.resolve(String(process.env.COPILOT_WEB_RELAY_CONFIG))
  : path.join(__dirname, 'config.json');
const DATA_DIR       = path.join(__dirname, 'data');
const DB_PATH        = path.join(DATA_DIR, 'copilot.db');
const RELAY_LOCK_PATH = path.join(DATA_DIR, 'relay-server.lock');
const UPLOAD_DIR     = path.join(__dirname, 'uploads');
const INITIAL_WORKSPACE_ROOT = resolveStartupWorkspaceRoot(__dirname);
const WORKSPACE_ROOT_LOCKED = true;
const SESSION_COOKIE = 'copilot_session';
const AUTH_COOKIE = 'copilot_auth';

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const DEFAULT_CONFIG = { authToken: '', port: 3333, pollIntervalMs: 3000, conversationSessionMode: 'isolated', localhostOnly: true };
const DEFAULT_PROCESSING_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_MODEL = 'gpt-5.4-mini';
const MODEL_CATALOG_STALE_MS = 2 * 60 * 1000;
const SUPPORTED_RELAY_MODES = ['plan', 'ask', 'agent', 'autopilot'];
const DEFAULT_RELAY_MODE = 'agent';
const SUPPORTED_CONVERSATION_SESSION_MODES = ['isolated', 'shared'];
const DEFAULT_CONVERSATION_SESSION_MODE = 'isolated';
const MAX_UPLOAD_ATTACHMENTS = 6;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const MAX_IMAGE_DATA_URL_LENGTH = 12 * 1024 * 1024;
const MAX_REFERENCE_IMAGE_ATTACHMENT_BYTES = 1 * 1024 * 1024;
const REFERENCE_TOKEN_PATTERN_BACKTICK = /`@(file|folder):([^`]+)`/gi;
const REFERENCE_TOKEN_PATTERN_PLAIN = /(^|[\s(])@(file|folder):([^\s`]+)/gi;
const WORKSPACE_META_CACHE_TTL_MS = 2_000;
const MAX_WORKSPACE_PREVIEW_BYTES = 512 * 1024;
const WORKSPACE_PREVIEW_BINARY_SAMPLE_BYTES = 8 * 1024;
const WORKSPACE_RECURSIVE_WATCH_SUPPORTED = process.platform === 'win32' || process.platform === 'darwin';
const WORKSPACE_CONTENT_TYPES = Object.freeze({
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.ts': 'text/plain; charset=utf-8',
  '.tsx': 'text/plain; charset=utf-8',
  '.jsx': 'text/plain; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.yml': 'text/yaml; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
  '.toml': 'text/plain; charset=utf-8',
  '.ini': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.sql': 'text/plain; charset=utf-8',
  '.ps1': 'text/plain; charset=utf-8',
  '.sh': 'text/plain; charset=utf-8',
  '.bat': 'text/plain; charset=utf-8',
  '.go': 'text/plain; charset=utf-8',
  '.py': 'text/plain; charset=utf-8',
  '.java': 'text/plain; charset=utf-8',
  '.rb': 'text/plain; charset=utf-8',
  '.php': 'text/plain; charset=utf-8',
  '.c': 'text/plain; charset=utf-8',
  '.h': 'text/plain; charset=utf-8',
  '.cpp': 'text/plain; charset=utf-8',
  '.hpp': 'text/plain; charset=utf-8',
  '.rs': 'text/plain; charset=utf-8',
  '.lock': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
});
const WORKSPACE_MARKDOWN_EXTENSIONS = new Set(['.md', '.mdx', '.markdown']);
const WORKSPACE_PREVIEW_LANGUAGE_BY_EXTENSION = Object.freeze({
  '.md': 'markdown',
  '.mdx': 'markdown',
  '.markdown': 'markdown',
  '.txt': 'plaintext',
  '.json': 'json',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.jsx': 'javascript',
  '.css': 'css',
  '.html': 'xml',
  '.xml': 'xml',
  '.yml': 'yaml',
  '.yaml': 'yaml',
  '.toml': 'toml',
  '.ini': 'ini',
  '.csv': 'plaintext',
  '.sql': 'sql',
  '.ps1': 'powershell',
  '.sh': 'bash',
  '.bat': 'dos',
  '.go': 'go',
  '.py': 'python',
  '.java': 'java',
  '.rb': 'ruby',
  '.php': 'php',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.hpp': 'cpp',
  '.rs': 'rust',
  '.lock': 'plaintext',
  '.log': 'plaintext',
});
const WORKSPACE_CODE_EXTENSIONS = new Set(Object.keys(WORKSPACE_PREVIEW_LANGUAGE_BY_EXTENSION)
  .filter((ext) => !WORKSPACE_MARKDOWN_EXTENSIONS.has(ext)));
const WORKSPACE_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.bmp', '.avif']);
const REPO_HEAVY_DIR_NAMES = new Set(['.git', 'node_modules']);
const MAX_REPO_TREE_NODES = 20_000;
const MAX_REPO_TREE_DEPTH = 64;
const DRIVE_ROOT_PATTERN = /\b([A-Z]):\\/g;
const CURATED_MODEL_IDS = [
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.3-codex',
  'claude-sonnet-4.6',
  'claude-haiku-4.5',
];

let config = { ...DEFAULT_CONFIG };
if (fs.existsSync(CONFIG_PATH)) {
  try { config = { ...config, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) }; }
  catch (e) { console.error('Failed to read config.json, using defaults.'); }
} else {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// --token <value> on the command line overrides config.json (in-memory only, not persisted)
const tokenArgIdx = process.argv.indexOf('--token');
if (tokenArgIdx !== -1 && process.argv[tokenArgIdx + 1]) {
  config.authToken = process.argv[tokenArgIdx + 1];
  console.log(`[server] Auth token set via --token argument (not persisted to config.json)`);
}

// --port <number> on the command line overrides config.json (in-memory only, not persisted)
const portArgIdx = process.argv.indexOf('--port');
if (portArgIdx !== -1 && process.argv[portArgIdx + 1]) {
  const parsedPort = Number.parseInt(String(process.argv[portArgIdx + 1]), 10);
  if (Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535) {
    config.port = parsedPort;
    console.log(`[server] Port set via --port argument: ${parsedPort} (not persisted to config.json)`);
  } else {
    console.warn(`[server] Ignoring invalid --port value: ${process.argv[portArgIdx + 1]}`);
  }
}

// --owner-pid <number> allows managed mode to auto-exit when the owning CLI process is gone.
const ownerPidArgIdx = process.argv.indexOf('--owner-pid');
const ownerPidRaw = ownerPidArgIdx !== -1 ? process.argv[ownerPidArgIdx + 1] : null;
const ownerPid = Number.parseInt(String(ownerPidRaw || ''), 10);
const managedOwnerPid = Number.isInteger(ownerPid) && ownerPid > 0 ? ownerPid : null;
if (managedOwnerPid) {
  console.log(`[server] Managed owner PID watchdog enabled: ${managedOwnerPid}`);
}

// Generate a random token if none is provided and token not given on CLI
if (!config.authToken || config.authToken === DEFAULT_CONFIG.authToken) {
  config.authToken = uuidv4();
  console.log(`[server] Generated random auth token (in-memory only): ${config.authToken}`);
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const relaySingletonGuard = createRelaySingletonGuard({
  lockPath: RELAY_LOCK_PATH,
  pid: process.pid,
  token: config.authToken,
  isProcessAlive,
  logger: console,
});
try {
  relaySingletonGuard.acquire();
} catch (error) {
  console.error(`[server] ${error?.message || String(error)}`);
  process.exit(1);
}

const MAX_REQUEUE_RETRIES = Number.isFinite(Number(config.maxRequeueRetries))
  ? Math.max(1, Number(config.maxRequeueRetries))
  : 5;

const processingTimeoutMs = Number(config.processingTimeoutMs) > 0
  ? Number(config.processingTimeoutMs)
  : DEFAULT_PROCESSING_TIMEOUT_MS;
const restartGracefulTimeoutMs = Number(config.restartGracefulTimeoutMs) > 0
  ? Number(config.restartGracefulTimeoutMs)
  : 8_000;
const restartReadyCooldownMs = Number(config.restartReadyCooldownMs) > 0
  ? Number(config.restartReadyCooldownMs)
  : 1_000;
const restartShutdownTimeoutMs = Number(config.restartShutdownTimeoutMs) > 0
  ? Number(config.restartShutdownTimeoutMs)
  : 45_000;
const restartSpawnTimeoutMs = Number(config.restartSpawnTimeoutMs) > 0
  ? Number(config.restartSpawnTimeoutMs)
  : 18_000;
const restartRebindTimeoutMs = Number(config.restartRebindTimeoutMs) > 0
  ? Number(config.restartRebindTimeoutMs)
  : 20_000;
const restartMaxAttempts = Number.isFinite(Number(config.restartMaxAttempts))
  ? Math.max(1, Number(config.restartMaxAttempts))
  : 3;
const restartRetryBackoffMs = Array.isArray(config.restartRetryBackoffMs)
  ? config.restartRetryBackoffMs
  : [1_000, 3_000, 7_000];
const localhostOnly = config.localhostOnly === true || String(config.localhostOnly || '').trim().toLowerCase() === 'true';
const listenHost = localhostOnly ? '127.0.0.1' : '0.0.0.0';
const OFFLINE_STALE_RECOVER_MS = 45_000;
let runtimeShutdownStarted = false;
const runtimeTimers = {
  cliStatus: null,
  ownerWatchdog: null,
  staleRecovery: null,
  questionExpiry: null,
  shutdownDrain: null,
};

// Remote path prefix when served behind a reverse proxy subpath.
// Trailing slashes are stripped. Empty string means root.
const remotePath = (config.remotePath || '').replace(/\/+$/, '');

let modelCatalog = {
  models: [DEFAULT_MODEL],
  currentModel: DEFAULT_MODEL,
  defaultModel: DEFAULT_MODEL,
  source: 'bootstrap',
  refreshedAt: new Date().toISOString(),
  error: null,
};

const workspaceFileMetaCache = new Map();
let workspaceFileWatcher = null;
let workspaceRootPath = INITIAL_WORKSPACE_ROOT;
let workspaceRootName = workspaceRootDisplayName(INITIAL_WORKSPACE_ROOT);

function currentWorkspaceRootPath() {
  return workspaceRootPath;
}

function currentWorkspaceRootName() {
  return workspaceRootName;
}

function workspaceRootPayload() {
  return {
    workspaceRootName: currentWorkspaceRootName(),
    workspaceRootPath: currentWorkspaceRootPath(),
    workspaceRootEntries: listWorkspaceRootEntries(),
  };
}

const ACTIVE_SESSION_CWD_STATUSES = new Set(['starting', 'ready', 'processing']);

function normalizeConversationWorkspaceRootPath(candidatePath) {
  const normalized = normalizeWorkspaceRootPath(candidatePath);
  return normalized || null;
}

function resolveConversationRecord({ conversationId = '', sdkSessionId = '' } = {}) {
  const convId = String(conversationId || '').trim();
  if (convId) {
    const direct = stmts.getConvAnyStatus.get(convId) || null;
    if (direct && String(direct.status || '').trim().toLowerCase() !== 'deleted') {
      return direct;
    }
  }
  const sid = String(sdkSessionId || '').trim();
  if (!sid || typeof stmts.getConvBySdkSessionId?.get !== 'function') return null;
  return stmts.getConvBySdkSessionId.get(sid) || null;
}

function isConversationSessionRunning(sdkSessionId) {
  const sid = String(sdkSessionId || '').trim();
  if (!sid) return false;
  const workerState = sessionWorkerRegistry?.getWorker?.(sid) || sessionWorkerSupervisor?.getWorkerState?.(sid) || null;
  const status = String(workerState?.status || '').trim().toLowerCase();
  return ACTIVE_SESSION_CWD_STATUSES.has(status);
}

function buildConversationWorkspaceRootState(row = null) {
  const conversation = row && typeof row === 'object' ? row : null;
  const conversationId = String(conversation?.id || '').trim() || null;
  const sdkSessionId = String(conversation?.sdk_session_id || conversationId || '').trim() || null;
  const configuredWorkspaceRootPath =
    normalizeConversationWorkspaceRootPath(conversation?.configured_workspace_root_path)
    || currentWorkspaceRootPath();
  const runtimeWorkspaceRootPath =
    normalizeConversationWorkspaceRootPath(conversation?.runtime_workspace_root_path)
    || null;
  const running = sdkSessionId ? isConversationSessionRunning(sdkSessionId) : false;
  const effectiveWorkspaceRootPath = running
    ? (runtimeWorkspaceRootPath || configuredWorkspaceRootPath || currentWorkspaceRootPath())
    : (configuredWorkspaceRootPath || runtimeWorkspaceRootPath || currentWorkspaceRootPath());
  const currentWorkspaceRootPathValue = effectiveWorkspaceRootPath || currentWorkspaceRootPath();
  return {
    conversationId,
    sdkSessionId,
    configuredWorkspaceRootPath: configuredWorkspaceRootPath || null,
    configuredWorkspaceRootName: configuredWorkspaceRootPath ? workspaceRootDisplayName(configuredWorkspaceRootPath) : null,
    runtimeWorkspaceRootPath,
    runtimeWorkspaceRootName: runtimeWorkspaceRootPath ? workspaceRootDisplayName(runtimeWorkspaceRootPath) : null,
    currentWorkspaceRootPath: currentWorkspaceRootPathValue || null,
    currentWorkspaceRootName: currentWorkspaceRootPathValue ? workspaceRootDisplayName(currentWorkspaceRootPathValue) : null,
    effectiveWorkspaceRootPath: effectiveWorkspaceRootPath || null,
    effectiveWorkspaceRootName: effectiveWorkspaceRootPath ? workspaceRootDisplayName(effectiveWorkspaceRootPath) : null,
    running,
  };
}

function resolveConversationWorkspaceState({ conversationId = '', sdkSessionId = '' } = {}) {
  return buildConversationWorkspaceRootState(resolveConversationRecord({ conversationId, sdkSessionId }));
}

function updateConversationConfiguredWorkspaceRoot({ conversationId = '', sdkSessionId = '', rootPath = '' } = {}) {
  const row = resolveConversationRecord({ conversationId, sdkSessionId });
  if (!row?.id) {
    return { ok: false, error: 'Conversation not found' };
  }
  const normalizedRootPath = normalizeConversationWorkspaceRootPath(rootPath);
  if (!normalizedRootPath) {
    return { ok: false, error: `Directory not found: ${String(rootPath || '').trim() || '(empty path)'}` };
  }
  const nowIso = new Date().toISOString();
  stmts.updateConvConfiguredWorkspaceRoot.run(normalizedRootPath, nowIso, row.id);
  const updated = resolveConversationRecord({ conversationId: row.id }) || row;
  return { ok: true, state: buildConversationWorkspaceRootState(updated) };
}

function learnConversationWorkspaceRoot({ sdkSessionId = '', conversationId = '', rootPath = '', seedConfigured = true } = {}) {
  let row = resolveConversationRecord({ conversationId, sdkSessionId });
  const fallbackConversationId = String(conversationId || '').trim();
  if (!row?.id && fallbackConversationId) {
    const nowIso = new Date().toISOString();
    stmts.insertConv.run(fallbackConversationId, 'Session', nowIso, nowIso);
    if (String(sdkSessionId || '').trim()) {
      stmts.setConvSdkSessionIdIfMissing.run(String(sdkSessionId || '').trim(), nowIso, fallbackConversationId);
    }
    row = resolveConversationRecord({ conversationId: fallbackConversationId, sdkSessionId }) || stmts.getConvAnyStatus.get(fallbackConversationId) || null;
  }
  if (!row?.id) {
    return { ok: false, error: 'Conversation not found' };
  }
  const normalizedRootPath = normalizeConversationWorkspaceRootPath(rootPath);
  if (!normalizedRootPath) {
    return { ok: false, error: `Directory not found: ${String(rootPath || '').trim() || '(empty path)'}` };
  }
  const nowIso = new Date().toISOString();
  stmts.updateConvRuntimeWorkspaceRoot.run(normalizedRootPath, nowIso, row.id);
  if (seedConfigured) {
    stmts.seedConvConfiguredWorkspaceRootIfMissing.run(normalizedRootPath, nowIso, row.id);
  }
  const updated = resolveConversationRecord({ conversationId: row.id }) || row;
  return { ok: true, state: buildConversationWorkspaceRootState(updated) };
}

function resolveLaunchWorkspaceRootForSession(sdkSessionId) {
  const state = resolveConversationWorkspaceState({ sdkSessionId });
  return state?.configuredWorkspaceRootPath || currentWorkspaceRootPath();
}

function normalizeWorkspaceRootPath(candidatePath) {
  const value = String(candidatePath || '').trim();
  if (!value) return null;
  const resolved = path.resolve(value);
  try {
    if (!fs.statSync(resolved).isDirectory()) return null;
  } catch {
    return null;
  }
  return resolved;
}

function stopWorkspaceFileWatcher() {
  if (!workspaceFileWatcher) return;
  try {
    workspaceFileWatcher.close();
  } catch {}
  workspaceFileWatcher = null;
}

function applyWorkspaceRoot(nextRootPath, options = {}) {
  const normalized = normalizeWorkspaceRootPath(nextRootPath);
  if (!normalized) {
    return {
      changed: false,
      error: `Directory not found: ${String(nextRootPath || '').trim() || '(empty path)'}`,
    };
  }

  const current = path.resolve(currentWorkspaceRootPath());
  if (path.resolve(normalized) === current) {
    return {
      changed: false,
      rootPath: current,
      rootName: currentWorkspaceRootName(),
    };
  }

  workspaceRootPath = normalized;
  workspaceRootName = workspaceRootDisplayName(normalized);
  process.env.COPILOT_WORKSPACE_ROOT = normalized;
  try {
    process.chdir(normalized);
  } catch (error) {
    console.warn(`[server] Failed to chdir to ${normalized}: ${error?.message || String(error)}`);
  }
  workspaceFileMetaCache.clear();
  stopWorkspaceFileWatcher();
  startWorkspaceFileWatcher();

  const reason = String(options.reason || 'runtime-update').trim() || 'runtime-update';
  console.log(`[server] Workspace root updated (${reason}): ${normalized}`);
  return { changed: true, rootPath: normalized, rootName: workspaceRootName };
}

function maybeApplyWorkspaceRootFromMessage(text, baseWorkspaceRoot = null) {
  const target = parseCdCommandTarget(text);
  if (!target) return { attempted: false, changed: false };
  const baseRoot = normalizeConversationWorkspaceRootPath(baseWorkspaceRoot) || currentWorkspaceRootPath();
  if (WORKSPACE_ROOT_LOCKED) {
    return {
      attempted: true,
      changed: false,
      target,
      error: `Workspace root is locked to startup directory: ${baseRoot}`,
    };
  }
  const resolvedPath = resolveCdCommandPath(target, baseRoot);
  if (!resolvedPath) {
    return {
      attempted: true,
      changed: false,
      target,
      error: 'Unable to resolve directory path',
    };
  }
  const changed = path.resolve(resolvedPath) !== path.resolve(baseRoot);
  return {
    attempted: true,
    changed,
    target,
    rootPath: resolvedPath,
    rootName: workspaceRootDisplayName(resolvedPath),
    resolvedPath,
    error: null,
  };
}

function uniqueStringList(values) {
  const out = [];
  const seen = new Set();
  for (const value of values || []) {
    const text = String(value || '').trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

function curatedModelList() {
  return uniqueStringList(CURATED_MODEL_IDS);
}

function getModelCatalogState() {
  const refreshedAtMs = Date.parse(modelCatalog.refreshedAt || '');
  const stale = Number.isFinite(refreshedAtMs)
    ? (Date.now() - refreshedAtMs) > MODEL_CATALOG_STALE_MS
    : true;
  const warning = modelCatalog.error
    ? `Model discovery error: ${modelCatalog.error}`
    : (stale ? 'Model list is stale; using cached/current model selection.' : null);
  return {
    models: uniqueStringList([...curatedModelList(), ...(Array.isArray(modelCatalog.models) ? modelCatalog.models : [])]),
    currentModel: String(modelCatalog.currentModel || '').trim() || null,
    defaultModel: String(modelCatalog.defaultModel || '').trim() || DEFAULT_MODEL,
    source: String(modelCatalog.source || 'unknown'),
    refreshedAt: modelCatalog.refreshedAt || null,
    stale,
    warning,
    error: modelCatalog.error || null,
  };
}

function updateModelCatalog(snapshot = {}) {
  const incomingModels = uniqueStringList(Array.isArray(snapshot.models) ? snapshot.models : []);
  const incomingCurrent = String(snapshot.currentModel || '').trim();
  const incomingDefault = String(snapshot.defaultModel || '').trim();
  const merged = uniqueStringList([
    ...curatedModelList(),
    ...incomingModels,
    incomingCurrent,
    incomingDefault,
    ...(Array.isArray(modelCatalog.models) ? modelCatalog.models : []),
    modelCatalog.currentModel,
    modelCatalog.defaultModel,
  ]);
  if (!merged.length) merged.push(DEFAULT_MODEL);
  const currentModel = incomingCurrent || modelCatalog.currentModel || incomingDefault || merged[0] || DEFAULT_MODEL;
  const defaultModel = incomingDefault || modelCatalog.defaultModel || currentModel || DEFAULT_MODEL;
  const models = uniqueStringList([currentModel, defaultModel, ...merged]);

  modelCatalog = {
    models,
    currentModel,
    defaultModel,
    source: String(snapshot.source || modelCatalog.source || 'unknown').trim() || 'unknown',
    refreshedAt: new Date().toISOString(),
    error: snapshot.error ? String(snapshot.error).trim().slice(0, 300) : null,
  };
  return getModelCatalogState();
}

function resolveRequestedModel(model) {
  const requested = String(model || '').trim();
  const state = getModelCatalogState();
  const fallbackModel = state.currentModel || state.defaultModel || DEFAULT_MODEL;
  if (!requested) {
    return { ok: true, model: fallbackModel, warning: null };
  }
  if (state.models.includes(requested)) {
    return { ok: true, model: requested, warning: null };
  }
  if (!state.stale && state.models.length) {
    return { ok: false, error: 'Unsupported model', available: state.models };
  }
  return {
    ok: true,
    model: requested,
    warning: state.warning || 'Model list unavailable; continuing with requested model.',
  };
}

function normalizeRelayMode(mode) {
  const value = String(mode || '').trim().toLowerCase();
  if (!value) return DEFAULT_RELAY_MODE;
  return SUPPORTED_RELAY_MODES.includes(value) ? value : null;
}

function normalizeConversationSessionMode(mode) {
  const value = String(mode || '').trim().toLowerCase();
  if (!value) return DEFAULT_CONVERSATION_SESSION_MODE;
  return SUPPORTED_CONVERSATION_SESSION_MODES.includes(value) ? value : null;
}

const configuredConversationSessionMode =
  normalizeConversationSessionMode(config.conversationSessionMode) || DEFAULT_CONVERSATION_SESSION_MODE;

updateModelCatalog({ models: [DEFAULT_MODEL], currentModel: DEFAULT_MODEL, defaultModel: DEFAULT_MODEL, source: 'bootstrap' });

// ─── SQLite Setup ─────────────────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS conversations (
    id         TEXT PRIMARY KEY,
    title      TEXT NOT NULL,
    title_source TEXT NOT NULL DEFAULT 'auto',
    sdk_session_id TEXT,
    preferred_relay_mode TEXT,
    preferred_models_by_mode TEXT,
    configured_workspace_root_path TEXT,
    runtime_workspace_root_path TEXT,
    archived   INTEGER NOT NULL DEFAULT 0,
    status     TEXT NOT NULL DEFAULT 'active',
    compacted_into TEXT,
    compacted_from TEXT,
    summary_seed TEXT,
    seed_pending INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id              TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    role            TEXT NOT NULL,
    text            TEXT NOT NULL,
    model           TEXT,
    mode            TEXT,
    attachments     TEXT,
    timestamp       TEXT NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, timestamp);

  CREATE TABLE IF NOT EXISTS queue (
    id                  TEXT PRIMARY KEY,
    conversation_id     TEXT NOT NULL,
    runtime_session_id  TEXT,
    is_new_conversation INTEGER NOT NULL DEFAULT 0,
    model               TEXT,
    relay_mode          TEXT NOT NULL DEFAULT 'agent',
    text                TEXT NOT NULL,
    attachments         TEXT,
    status              TEXT NOT NULL DEFAULT 'pending',
    timestamp           TEXT NOT NULL,
    processing_at       TEXT,
    response_message_id TEXT,
    response            TEXT,
    retry_count         INTEGER NOT NULL DEFAULT 0,
    next_attempt_at     TEXT,
    owner_sdk_session_id TEXT,
    owner_assigned_at   TEXT,
    owner_lease_expires_at TEXT,
    owner_last_claimed_at TEXT,
    parked_at           TEXT,
    parked_target_session_id TEXT,
    parked_transaction_id TEXT,
    parked_reason       TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_queue_status ON queue(status, timestamp);

  CREATE TABLE IF NOT EXISTS runtime_sessions (
    id              TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL UNIQUE,
    sdk_session_id  TEXT,
    strategy        TEXT NOT NULL DEFAULT 'isolated',
    runtime_key     TEXT NOT NULL,
    model           TEXT,
    status          TEXT NOT NULL DEFAULT 'active',
    created_at      TEXT NOT NULL,
    last_used_at    TEXT NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_runtime_sessions_last_used ON runtime_sessions(last_used_at DESC);

  CREATE TABLE IF NOT EXISTS deleted_sdk_sessions (
    sdk_session_id TEXT PRIMARY KEY,
    deleted_at     TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sdk_delete_requests (
    sdk_session_id TEXT PRIMARY KEY,
    conversation_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    requested_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    processing_at TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT,
    last_error TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_sdk_delete_requests_status
    ON sdk_delete_requests(status, requested_at, next_attempt_at);

  CREATE TABLE IF NOT EXISTS relay_control_requests (
    id              TEXT PRIMARY KEY,
    type            TEXT NOT NULL,
    conversation_id TEXT,
    queue_message_id TEXT,
    sdk_session_id  TEXT,
    status          TEXT NOT NULL DEFAULT 'pending',
    request         TEXT,
    result          TEXT,
    error           TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    completed_at    TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_relay_control_requests_status
    ON relay_control_requests(status, sdk_session_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_relay_control_requests_queue
    ON relay_control_requests(queue_message_id, type, status, created_at);

  CREATE TABLE IF NOT EXISTS relay_questions (
    id              TEXT PRIMARY KEY,
    queue_id        TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    message_id      TEXT NOT NULL,
    relay_mode      TEXT NOT NULL DEFAULT 'agent',
    prompt          TEXT NOT NULL,
    choices         TEXT,
    request         TEXT,
    status          TEXT NOT NULL DEFAULT 'pending',
    answer          TEXT,
    sdk_session_id  TEXT,
    owner_worker_id TEXT,
    continuation_id TEXT,
    continuation_question_id TEXT,
    created_at      TEXT NOT NULL,
    answered_at     TEXT,
    expires_at      TEXT NOT NULL,
    FOREIGN KEY (queue_id) REFERENCES queue(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_relay_questions_status ON relay_questions(status, expires_at, created_at);
  CREATE INDEX IF NOT EXISTS idx_relay_questions_conversation ON relay_questions(conversation_id, status, created_at);

  CREATE TABLE IF NOT EXISTS relay_boards (
    id                TEXT PRIMARY KEY,
    queue_id          TEXT NOT NULL,
    conversation_id   TEXT NOT NULL,
    message_id        TEXT NOT NULL,
    board_type        TEXT NOT NULL,
    relay_mode        TEXT NOT NULL DEFAULT 'agent',
    title             TEXT NOT NULL,
    body              TEXT NOT NULL,
    actions_json      TEXT,
    recommended_action TEXT,
    context_json      TEXT,
    status            TEXT NOT NULL DEFAULT 'pending',
    selected_action   TEXT,
    acted_at          TEXT,
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL,
    FOREIGN KEY (queue_id) REFERENCES queue(id) ON DELETE CASCADE,
    UNIQUE(message_id, board_type)
  );

  CREATE INDEX IF NOT EXISTS idx_relay_boards_status ON relay_boards(status, created_at);
  CREATE INDEX IF NOT EXISTS idx_relay_boards_conversation ON relay_boards(conversation_id, status, created_at);

  CREATE TABLE IF NOT EXISTS relay_activity (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    queue_message_id    TEXT NOT NULL,
    response_message_id TEXT,
    conversation_id     TEXT NOT NULL,
    relay_mode          TEXT NOT NULL DEFAULT 'agent',
    text                TEXT NOT NULL,
    created_at          TEXT NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_relay_activity_queue ON relay_activity(queue_message_id, id);
  CREATE INDEX IF NOT EXISTS idx_relay_activity_response ON relay_activity(response_message_id, id);

  CREATE TABLE IF NOT EXISTS relay_stream_events (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    queue_message_id    TEXT NOT NULL,
    response_message_id TEXT,
    conversation_id     TEXT NOT NULL,
    relay_mode          TEXT NOT NULL DEFAULT 'agent',
    seq                 INTEGER NOT NULL,
    text                TEXT NOT NULL DEFAULT '',
    done                INTEGER NOT NULL DEFAULT 0,
    created_at          TEXT NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
    UNIQUE(queue_message_id, seq)
  );

  CREATE INDEX IF NOT EXISTS idx_relay_stream_events_queue
    ON relay_stream_events(queue_message_id, seq);
  CREATE INDEX IF NOT EXISTS idx_relay_stream_events_response
    ON relay_stream_events(response_message_id, seq);
  CREATE INDEX IF NOT EXISTS idx_relay_stream_events_conversation
    ON relay_stream_events(conversation_id, queue_message_id, seq);

  CREATE TABLE IF NOT EXISTS uploaded_files (
    sha256        TEXT PRIMARY KEY,
    original_name TEXT,
    mime_type     TEXT,
    size_bytes    INTEGER NOT NULL,
    created_at    TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS upload_refs (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    file_sha256     TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    message_id      TEXT NOT NULL,
    created_at      TEXT NOT NULL,
    UNIQUE(file_sha256, message_id),
    FOREIGN KEY (file_sha256) REFERENCES uploaded_files(sha256) ON DELETE CASCADE,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_upload_refs_conv ON upload_refs(conversation_id, file_sha256);
  CREATE INDEX IF NOT EXISTS idx_upload_refs_sha ON upload_refs(file_sha256);
`);

// Backfill schema for pre-model databases.
const messageColumns = db.prepare(`PRAGMA table_info(messages)`).all().map((c) => c.name);
if (!messageColumns.includes('attachments')) {
  db.exec(`ALTER TABLE messages ADD COLUMN attachments TEXT`);
}
if (!messageColumns.includes('mode')) {
  db.exec(`ALTER TABLE messages ADD COLUMN mode TEXT`);
}

const queueColumns = db.prepare(`PRAGMA table_info(queue)`).all().map((c) => c.name);
if (!queueColumns.includes('model')) {
  db.exec(`ALTER TABLE queue ADD COLUMN model TEXT`);
}
if (!queueColumns.includes('runtime_session_id')) {
  db.exec(`ALTER TABLE queue ADD COLUMN runtime_session_id TEXT`);
}
if (!queueColumns.includes('relay_mode')) {
  db.exec(`ALTER TABLE queue ADD COLUMN relay_mode TEXT NOT NULL DEFAULT 'agent'`);
}
if (!queueColumns.includes('attachments')) {
  db.exec(`ALTER TABLE queue ADD COLUMN attachments TEXT`);
}
if (!queueColumns.includes('retry_count')) {
  db.exec(`ALTER TABLE queue ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0`);
}
if (!queueColumns.includes('next_attempt_at')) {
  db.exec(`ALTER TABLE queue ADD COLUMN next_attempt_at TEXT`);
}
if (!queueColumns.includes('owner_sdk_session_id')) {
  db.exec(`ALTER TABLE queue ADD COLUMN owner_sdk_session_id TEXT`);
}
if (!queueColumns.includes('owner_assigned_at')) {
  db.exec(`ALTER TABLE queue ADD COLUMN owner_assigned_at TEXT`);
}
if (!queueColumns.includes('owner_lease_expires_at')) {
  db.exec(`ALTER TABLE queue ADD COLUMN owner_lease_expires_at TEXT`);
}
if (!queueColumns.includes('owner_last_claimed_at')) {
  db.exec(`ALTER TABLE queue ADD COLUMN owner_last_claimed_at TEXT`);
}
if (!queueColumns.includes('response_message_id')) {
  db.exec(`ALTER TABLE queue ADD COLUMN response_message_id TEXT`);
}
if (!queueColumns.includes('parked_at')) {
  db.exec(`ALTER TABLE queue ADD COLUMN parked_at TEXT`);
}
if (!queueColumns.includes('parked_target_session_id')) {
  db.exec(`ALTER TABLE queue ADD COLUMN parked_target_session_id TEXT`);
}
if (!queueColumns.includes('parked_transaction_id')) {
  db.exec(`ALTER TABLE queue ADD COLUMN parked_transaction_id TEXT`);
}
if (!queueColumns.includes('parked_reason')) {
  db.exec(`ALTER TABLE queue ADD COLUMN parked_reason TEXT`);
}
db.exec(`UPDATE queue SET relay_mode = 'agent' WHERE relay_mode IS NULL OR relay_mode = ''`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_queue_next_attempt ON queue(status, next_attempt_at, timestamp)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_queue_owner_pending ON queue(status, owner_sdk_session_id, next_attempt_at, timestamp)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_queue_parked_release ON queue(status, parked_transaction_id, parked_target_session_id, parked_at, timestamp)`);

const runtimeSessionColumns = db.prepare(`PRAGMA table_info(runtime_sessions)`).all().map((c) => c.name);
if (runtimeSessionColumns.length) {
  if (!runtimeSessionColumns.includes('strategy')) {
    db.exec(`ALTER TABLE runtime_sessions ADD COLUMN strategy TEXT NOT NULL DEFAULT 'isolated'`);
  }
  if (!runtimeSessionColumns.includes('sdk_session_id')) {
    db.exec(`ALTER TABLE runtime_sessions ADD COLUMN sdk_session_id TEXT`);
  }
  if (!runtimeSessionColumns.includes('runtime_key')) {
    db.exec(`ALTER TABLE runtime_sessions ADD COLUMN runtime_key TEXT NOT NULL DEFAULT ''`);
    db.exec(`UPDATE runtime_sessions SET runtime_key = id WHERE runtime_key IS NULL OR runtime_key = ''`);
  }
  if (!runtimeSessionColumns.includes('model')) {
    db.exec(`ALTER TABLE runtime_sessions ADD COLUMN model TEXT`);
  }
  if (!runtimeSessionColumns.includes('status')) {
    db.exec(`ALTER TABLE runtime_sessions ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`);
  }
  if (!runtimeSessionColumns.includes('created_at')) {
    db.exec(`ALTER TABLE runtime_sessions ADD COLUMN created_at TEXT NOT NULL DEFAULT (datetime('now'))`);
  }
  if (!runtimeSessionColumns.includes('last_used_at')) {
    db.exec(`ALTER TABLE runtime_sessions ADD COLUMN last_used_at TEXT NOT NULL DEFAULT (datetime('now'))`);
  }
}

const conversationColumns = db.prepare(`PRAGMA table_info(conversations)`).all().map((c) => c.name);
if (!conversationColumns.includes('archived')) {
  db.exec(`ALTER TABLE conversations ADD COLUMN archived INTEGER NOT NULL DEFAULT 0`);
}
if (!conversationColumns.includes('sdk_session_id')) {
  db.exec(`ALTER TABLE conversations ADD COLUMN sdk_session_id TEXT`);
}
if (!conversationColumns.includes('preferred_relay_mode')) {
  db.exec(`ALTER TABLE conversations ADD COLUMN preferred_relay_mode TEXT`);
}
if (!conversationColumns.includes('preferred_models_by_mode')) {
  db.exec(`ALTER TABLE conversations ADD COLUMN preferred_models_by_mode TEXT`);
}
if (!conversationColumns.includes('configured_workspace_root_path')) {
  db.exec(`ALTER TABLE conversations ADD COLUMN configured_workspace_root_path TEXT`);
}
if (!conversationColumns.includes('runtime_workspace_root_path')) {
  db.exec(`ALTER TABLE conversations ADD COLUMN runtime_workspace_root_path TEXT`);
}
if (!conversationColumns.includes('compacted_into')) {
  db.exec(`ALTER TABLE conversations ADD COLUMN compacted_into TEXT`);
}
if (!conversationColumns.includes('compacted_from')) {
  db.exec(`ALTER TABLE conversations ADD COLUMN compacted_from TEXT`);
}
if (!conversationColumns.includes('summary_seed')) {
  db.exec(`ALTER TABLE conversations ADD COLUMN summary_seed TEXT`);
}
if (!conversationColumns.includes('seed_pending')) {
  db.exec(`ALTER TABLE conversations ADD COLUMN seed_pending INTEGER NOT NULL DEFAULT 0`);
}
if (!conversationColumns.includes('status')) {
  db.exec(`ALTER TABLE conversations ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`);
}
if (!conversationColumns.includes('title_source')) {
  db.exec(`ALTER TABLE conversations ADD COLUMN title_source TEXT NOT NULL DEFAULT 'auto'`);
}

db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_runtime_sessions_sdk_session_id ON runtime_sessions(sdk_session_id) WHERE sdk_session_id IS NOT NULL AND sdk_session_id != ''`);

const relayQuestionColumns = db.prepare(`PRAGMA table_info(relay_questions)`).all().map((c) => c.name);
if (relayQuestionColumns.length && !relayQuestionColumns.includes('sdk_session_id')) {
  db.exec(`ALTER TABLE relay_questions ADD COLUMN sdk_session_id TEXT`);
}
if (relayQuestionColumns.length && !relayQuestionColumns.includes('owner_worker_id')) {
  db.exec(`ALTER TABLE relay_questions ADD COLUMN owner_worker_id TEXT`);
}
if (relayQuestionColumns.length && !relayQuestionColumns.includes('continuation_id')) {
  db.exec(`ALTER TABLE relay_questions ADD COLUMN continuation_id TEXT`);
}
if (relayQuestionColumns.length && !relayQuestionColumns.includes('continuation_question_id')) {
  db.exec(`ALTER TABLE relay_questions ADD COLUMN continuation_question_id TEXT`);
}
db.exec(`CREATE INDEX IF NOT EXISTS idx_relay_questions_continuation ON relay_questions(continuation_id, continuation_question_id, status, created_at)`);

// ─── Prepared Statements ──────────────────────────────────────────────────────
const stmts = {
  ...createSessionRepository(db),
  ...createMessageRepository(db),
  ...createQuestionRepository(db),
};

const deleteArchiveService = createDeleteArchiveService(db, null);
void deleteArchiveService.retryPendingDeletesOnStartup()
  .then((result) => {
    if (result?.pendingCount > 0) {
      console.log(`Startup delete retry processed ${result.pendingCount} tombstoned conversation(s).`);
    }
  })
  .catch((error) => {
    console.warn(`Startup delete retry failed: ${error?.message || error}`);
  });
const relayRestartOrchestrator = createRelayRestartOrchestrator({
  db,
  gracefulTimeoutMs: restartGracefulTimeoutMs,
  readyCooldownMs: restartReadyCooldownMs,
  shutdownTimeoutMs: restartShutdownTimeoutMs,
  spawnTimeoutMs: restartSpawnTimeoutMs,
  rebindTimeoutMs: restartRebindTimeoutMs,
  maxAttempts: restartMaxAttempts,
  retryBackoffMs: restartRetryBackoffMs,
});
const sessionWorkerRegistry = createSessionWorkerRegistry();
const sessionWorkerProcessInspector = createSessionWorkerProcessInspector({
  platform: process.platform,
  execFileSyncImpl: execFileSync,
});
const relayCliLauncherService = createRelayCliLauncherService({
  cwd: (targetSessionId) => resolveLaunchWorkspaceRootForSession(targetSessionId),
  env: process.env,
  log: (message) => console.log(`[${ts()}] ${message}`),
});
function spawnSessionWorkerCli(targetSessionId) {
  const normalizedTargetSessionId = String(targetSessionId || '').trim();
  if (!normalizedTargetSessionId) {
    throw new Error('missing-target-session-id');
  }
  const liveWorker = sessionWorkerProcessInspector.findWindowsProcessForSession(normalizedTargetSessionId);
  if (liveWorker?.processId) {
    const workerId = `worker-${normalizedTargetSessionId.slice(0, 8)}`;
    console.log(`[${ts()}] worker launcher: reused ${workerId} session=${normalizedTargetSessionId.slice(0, 8)} pid=${liveWorker.processId}`);
    return { workerId, pid: liveWorker.processId };
  }
  const child = spawn('gh', ['copilot', '--', '--allow-all', '--session-id', normalizedTargetSessionId], {
    cwd: resolveLaunchWorkspaceRootForSession(normalizedTargetSessionId),
    env: process.env,
    detached: true,
    stdio: 'ignore',
    shell: process.platform === 'win32',
    windowsHide: process.platform === 'win32',
  });
  child.unref?.();
  const workerPid = Number.isInteger(Number(child?.pid)) ? Number(child.pid) : null;
  const workerId = `worker-${normalizedTargetSessionId.slice(0, 8)}`;
  console.log(`[${ts()}] worker launcher: spawned ${workerId} session=${normalizedTargetSessionId.slice(0, 8)} pid=${workerPid || 'none'}`);
  return { workerId, pid: workerPid };
}
const sessionWorkerSupervisor = createSessionWorkerSupervisor({
  registry: sessionWorkerRegistry,
  spawnWorker: async (sdkSessionId) => spawnSessionWorkerCli(sdkSessionId),
  diagnosticPlanReference: () => path.join(currentWorkspaceRootPath(), '.cursor', 'plans', 'worker-startup-monitoring-plan.md'),
  log: (message) => console.warn(`[${ts()}] ${message}`),
});
const featureFlags = normalizeFeatureFlags(FEATURES);

function queueCounts() {
  const rows = stmts.countStatus.all();
  const map = Object.fromEntries(rows.map(r => [r.status, r.cnt]));
  return { pendingCount: map.pending || 0, processingCount: map.processing || 0, parkedCount: map.parked || 0 };
}

let pendingRelayShutdownRequest = null;
function normalizeRestartRequestFlag(value) {
  if (value === true || value === 1) return true;
  if (value === false || value === 0 || value == null) return false;
  const normalized = String(value).trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on';
}

function getRelayShutdownState() {
  const pending = pendingRelayShutdownRequest;
  if (!pending) {
    return {
      status: runtimeShutdownStarted ? 'shutting_down' : 'idle',
      action: runtimeShutdownStarted ? 'shutdown' : null,
      restart: false,
      reason: null,
      requestedBy: null,
      requestedAt: null,
    };
  }
  return {
    status: runtimeShutdownStarted ? 'shutting_down' : 'queued',
    action: pending.action || 'shutdown',
    restart: pending.action === 'restart',
    reason: pending.reason || null,
    requestedBy: pending.requestedBy || null,
    requestedAt: pending.requestedAt || null,
  };
}

function requestRelayShutdown({ reason = 'manual-request', requestedBy = 'localhost-api', restart = false } = {}) {
  const safeReason = String(reason || 'manual-request').trim().slice(0, 140) || 'manual-request';
  const safeRequestedBy = String(requestedBy || 'localhost-api').trim().slice(0, 80) || 'localhost-api';
  const restartRequested = normalizeRestartRequestFlag(restart);
  const requestedAction = restartRequested ? 'restart' : 'shutdown';
  if (runtimeShutdownStarted) {
    return {
      accepted: false,
      status: 'shutting_down',
      action: requestedAction,
      restart: restartRequested,
      reason: safeReason,
    };
  }

  // Shutdown is intentionally deferred until the queue is idle; it will not interrupt an active turn.
  if (!pendingRelayShutdownRequest) {
    pendingRelayShutdownRequest = {
      action: requestedAction,
      reason: safeReason,
      requestedBy: safeRequestedBy,
      requestedAt: new Date().toISOString(),
    };
  } else if (restartRequested && pendingRelayShutdownRequest.action !== 'restart') {
    pendingRelayShutdownRequest = {
      ...pendingRelayShutdownRequest,
      action: 'restart',
      reason: safeReason,
      requestedBy: safeRequestedBy,
      requestedAt: new Date().toISOString(),
    };
  }

  const tryShutdownWhenIdle = () => {
    if (runtimeShutdownStarted) return;
    const counts = queueCounts();
    const queueFree = (counts.pendingCount + counts.processingCount + counts.parkedCount) === 0;
    if (!queueFree) return;
    const requestInfo = pendingRelayShutdownRequest;
    pendingRelayShutdownRequest = null;
    if (runtimeTimers.shutdownDrain) {
      try { clearInterval(runtimeTimers.shutdownDrain); } catch {}
      runtimeTimers.shutdownDrain = null;
    }
    const action = requestInfo?.action === 'restart' ? 'restart' : 'shutdown';
    const exitCode = action === 'restart' ? RELAY_RESTART_EXIT_CODE : 0;
    console.log(
      `[${ts()}] Relay ${action} request accepted by ${requestInfo?.requestedBy || 'unknown'}`
      + `; queue is idle, exiting now (reason=${requestInfo?.reason || 'manual-request'})`,
    );
    void shutdownRuntime(`api-${action}:${requestInfo?.reason || 'manual-request'}`, { exitCode });
  };

  if (!runtimeTimers.shutdownDrain) {
    runtimeTimers.shutdownDrain = setInterval(tryShutdownWhenIdle, 1000);
  }
  tryShutdownWhenIdle();
  const counts = queueCounts();
  return {
    accepted: true,
    status: 'queued',
    action: pendingRelayShutdownRequest?.action || requestedAction,
    restart: (pendingRelayShutdownRequest?.action || requestedAction) === 'restart',
    requestedAt: pendingRelayShutdownRequest?.requestedAt || new Date().toISOString(),
    reason: pendingRelayShutdownRequest?.reason || safeReason,
    requestedBy: pendingRelayShutdownRequest?.requestedBy || safeRequestedBy,
    queue: counts,
  };
}

function toNullableInt(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n);
}

function toNullablePercent(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100) / 100;
}

function formatCount(value) {
  const n = toNullableInt(value);
  return n === null ? 'unavailable' : String(n);
}

function formatPercent(value) {
  const n = toNullablePercent(value);
  return n === null ? 'unavailable' : `${n}%`;
}

function formatCompactTokens(value) {
  const n = toNullableInt(value);
  if (n === null) return 'unavailable';
  if (Math.abs(n) < 1000) return String(n);
  return `${(n / 1000).toFixed(1)}k`;
}

function getByPath(source, parts) {
  let cur = source;
  for (const part of parts) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

function findFirstNumericByKey(obj, candidateKeys) {
  if (!obj || typeof obj !== 'object') return null;
  const wanted = new Set((candidateKeys || []).map((k) => String(k || '').trim()).filter(Boolean));
  if (!wanted.size) return null;

  const stack = [obj];
  while (stack.length) {
    const current = stack.pop();
    if (!current || typeof current !== 'object') continue;
    for (const [key, value] of Object.entries(current)) {
      if (value && typeof value === 'object') {
        stack.push(value);
      }
      if (!wanted.has(key)) continue;
      const n = Number(value);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

function resolveContextLimitTokens(modelId, data, modelUsage) {
  const directCandidates = [
    getByPath(data, ['maxContextTokens']),
    getByPath(data, ['contextWindow']),
    getByPath(data, ['maxTokens']),
    getByPath(data, ['contextLimitTokens']),
    getByPath(data, ['max_context_tokens']),
    getByPath(data, ['tokenBudget']),
    getByPath(modelUsage, ['maxContextTokens']),
    getByPath(modelUsage, ['contextWindow']),
    getByPath(modelUsage, ['maxTokens']),
  ];
  for (const value of directCandidates) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return Math.round(n);
  }

  const model = String(modelId || '').trim().toLowerCase();
  const modelFallbackLimits = {
    'claude-sonnet-4.6': 160000,
    'claude-haiku-4.5': 160000,
    'gpt-5.4': 256000,
    'gpt-5.4-mini': 256000,
    'gpt-5.3-codex': 256000,
  };
  return modelFallbackLimits[model] || null;
}

function buildUsageGrid({ systemPct, messagesPct, freePct, bufferPct }) {
  const pctToCount = (pct) => {
    const n = Number(pct);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.max(0, Math.min(100, Math.round(n)));
  };

  let systemCount = pctToCount(systemPct);
  let messagesCount = pctToCount(messagesPct);
  let freeCount = pctToCount(freePct);
  let bufferCount = pctToCount(bufferPct);

  let total = systemCount + messagesCount + freeCount + bufferCount;
  if (total > 100) {
    const scale = 100 / total;
    systemCount = Math.round(systemCount * scale);
    messagesCount = Math.round(messagesCount * scale);
    freeCount = Math.round(freeCount * scale);
    bufferCount = Math.round(bufferCount * scale);
    total = systemCount + messagesCount + freeCount + bufferCount;
  }
  while (total < 100) {
    if (bufferCount >= freeCount) freeCount += 1;
    else bufferCount += 1;
    total += 1;
  }

  const cells = [
    ...Array(systemCount).fill('o'),
    ...Array(messagesCount).fill('O'),
    ...Array(freeCount).fill('.'),
    ...Array(bufferCount).fill('@'),
  ];
  const rows = [];
  for (let i = 0; i < 10; i++) {
    rows.push(cells.slice(i * 10, (i + 1) * 10).join(' '));
  }
  return rows;
}

function buildContextUsageBlock(snapshot, runtimeSession, extraEntries = []) {
  const model = contextField(snapshot?.model || runtimeSession?.model);
  const usedTotal = toNullableInt(snapshot?.used_total_tokens);
  const contextLimit = toNullableInt(snapshot?.max_context_tokens);
  const usedPct = toNullablePercent(snapshot?.used_percent);
  const systemTools = toNullableInt(snapshot?.system_tools_tokens);
  const messages = toNullableInt(snapshot?.messages_tokens);
  const freeTokens = toNullableInt(snapshot?.free_tokens);
  const bufferTokens = toNullableInt(snapshot?.buffer_tokens);
  const cacheRead = toNullableInt(snapshot?.cache_read_tokens);
  const cacheWrite = toNullableInt(snapshot?.cache_write_tokens);

  const safePct = (part, total) => {
    const a = Number(part);
    const b = Number(total);
    if (!Number.isFinite(a) || !Number.isFinite(b) || b <= 0) return null;
    return Math.round((a / b) * 10000) / 100;
  };

  const gridRows = buildUsageGrid({
    systemPct: safePct(systemTools, contextLimit),
    messagesPct: safePct(messages, contextLimit),
    freePct: safePct(freeTokens, contextLimit),
    bufferPct: safePct(bufferTokens, contextLimit),
  });

  const labelWidth = 13;
  const fmtLabel = (label) => `${String(label || '').trim()}:`.padEnd(labelWidth, ' ');
  const fmtMetric = (icon, label, value, pct = null) => {
    const base = `${icon} ${fmtLabel(label)} ${value}`;
    if (pct === null || pct === undefined || pct === '') return base;
    return `${base} (${pct})`;
  };

  const rightLines = [
    `${model}`,
    `${formatCompactTokens(usedTotal)}/${formatCompactTokens(contextLimit)} tokens (${formatPercent(usedPct)}),`,
    '',
    fmtMetric('o', 'System/Tools', formatCompactTokens(systemTools), formatPercent(safePct(systemTools, contextLimit))),
    fmtMetric('O', 'Messages', formatCompactTokens(messages), formatPercent(safePct(messages, contextLimit))),
    fmtMetric('.', 'Free Space', formatCompactTokens(freeTokens), formatPercent(safePct(freeTokens, contextLimit))),
    fmtMetric('@', 'Buffer', formatCompactTokens(bufferTokens), formatPercent(safePct(bufferTokens, contextLimit))),
    fmtMetric('R', 'Cache Read', formatCompactTokens(cacheRead)),
    fmtMetric('W', 'Cache Write', formatCompactTokens(cacheWrite)),
  ];

  const extras = Array.isArray(extraEntries) ? extraEntries : [];
  if (extras.length) {
    while (rightLines.length < gridRows.length) {
      rightLines.push('');
    }
    rightLines.push('');
    for (const entry of extras) {
      const label = String(entry?.label || '').trim();
      const value = String(entry?.value || '').trim();
      if (!label || !value) continue;
      if (entry?.multiline) {
        rightLines.push(`${fmtLabel(label)}`);
        rightLines.push(`  ${value}`);
      } else {
        rightLines.push(`${fmtLabel(label)} ${value}`);
      }
    }
  }

  const leftWidth = Math.max(0, ...gridRows.map((row) => String(row || '').length));
  const rowCount = Math.max(gridRows.length, rightLines.length);
  const merged = [];
  for (let i = 0; i < rowCount; i += 1) {
    const left = String(gridRows[i] || '').padEnd(leftWidth, ' ');
    const hasLeft = String(gridRows[i] || '').trim().length > 0;
    const right = String(rightLines[i] || '');
    if (right) merged.push(hasLeft ? `${left}   ${right}`.trimEnd() : right);
    else merged.push(left.trimEnd());
  }

  return merged.join('\n');
}

function contextField(value) {
  const text = String(value || '').trim();
  return text || 'unavailable';
}

function resolveSessionStateRoot() {
  const envOverride = String(process.env.COPILOT_SESSION_STATE_DIR || '').trim();
  const userProfile = String(process.env.USERPROFILE || '').trim();
  const home = String(process.env.HOME || '').trim();
  const homeDir = String(os.homedir() || '').trim();
  const candidates = [];
  if (envOverride) candidates.push(envOverride);
  if (userProfile) candidates.push(path.join(userProfile, '.copilot', 'session-state'));
  if (home) candidates.push(path.join(home, '.copilot', 'session-state'));
  if (homeDir) candidates.push(path.join(homeDir, '.copilot', 'session-state'));
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return candidates.find(Boolean) || path.join('.copilot', 'session-state');
}

function buildContextResponseText({ snapshot, runtimeSession, conversationId, eventsPath, error }) {
  const hasText = (value) => {
    const text = String(value || '').trim();
    return !!text && text.toLowerCase() !== 'unavailable';
  };
  const detailEntries = [];
  const pushDetail = (label, value) => {
    if (!hasText(value)) return;
    detailEntries.push({ label, value: String(value).trim(), multiline: false });
  };
  const pushDetailCount = (label, value) => {
    const n = toNullableInt(value);
    if (n === null) return;
    detailEntries.push({ label, value: formatCompactTokens(n), multiline: false });
  };

  const canonicalCopilotSessionId = contextField(
    snapshot?.copilot_session_id
    || runtimeSession?.sdk_session_id,
  );

  if (!snapshot) {
    const fallbackSnapshot = {
      ...snapshot,
      model: String(runtimeSession?.model || '').trim() || null,
    };
    pushDetail('Copilot session ID', canonicalCopilotSessionId);
    if (hasText(eventsPath)) detailEntries.push({ label: 'Events source', value: contextField(eventsPath), multiline: true });
    if (hasText(error)) detailEntries.push({ label: 'Note', value: contextField(error), multiline: true });
    return buildContextUsageBlock(fallbackSnapshot, runtimeSession, detailEntries);
  }

  pushDetail('Copilot session ID', canonicalCopilotSessionId);
  if (snapshot?.estimate_kind === 'assistant-output-lower-bound') {
    pushDetail('Estimate', 'Lower bound from assistant completion tokens');
  }
  pushDetailCount('Prompt/Input', snapshot.used_prompt_tokens);
  pushDetailCount('Completion/Output', snapshot.used_completion_tokens);
  pushDetailCount('Reasoning', snapshot.reasoning_tokens);
  pushDetailCount('System', snapshot.system_tokens);
  pushDetailCount('Tools', snapshot.tools_tokens);
  pushDetail('Captured', contextField(snapshot.captured_at));
  if (hasText(eventsPath)) detailEntries.push({ label: 'Events source', value: contextField(eventsPath), multiline: true });
  if (hasText(error)) detailEntries.push({ label: 'Note', value: contextField(error), multiline: true });

  return buildContextUsageBlock(snapshot, runtimeSession, detailEntries);
}

function computeRetryDelayMs(retryCount) {
  const base = 30_000;
  const max = 10 * 60_000;
  const n = Math.max(0, Number(retryCount) || 0);
  return Math.min(max, base * Math.pow(2, Math.min(n, 4)));
}

function addMsIso(ms) {
  return new Date(Date.now() + ms).toISOString();
}

function formatQuestionRow(row) {
  if (!row) return null;
  const parsedRequest = parseQuestionRequest(row.request);
  const envelope = normalizeQuestionEnvelope(parsedRequest);
  const choices = parseQuestionChoices(row.choices);
  return {
    id: row.id,
    queueId: row.queue_id,
    conversationId: row.conversation_id,
    sdkSessionId: row.sdk_session_id || null,
    ownerWorkerId: row.owner_worker_id || null,
    continuationId: row.continuation_id || null,
    continuationQuestionId: row.continuation_question_id || null,
    messageId: row.message_id,
    mode: normalizeRelayMode(row.relay_mode) || DEFAULT_RELAY_MODE,
    prompt: row.prompt,
    choices,
    request: envelope.request,
    context: envelope.context,
    allowFreeform: envelope.allowFreeform ?? !choices.length,
    status: row.status,
    answer: row.answer || null,
    createdAt: row.created_at,
    answeredAt: row.answered_at || null,
    expiresAt: row.expires_at,
  };
}

function parseBoardActions(rawActions) {
  if (!rawActions) return [];
  let input = rawActions;
  if (typeof rawActions === 'string') {
    try {
      input = JSON.parse(rawActions);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(input)) return [];
  return input
    .map((action) => {
      if (typeof action === 'string') {
        const id = action.trim().toLowerCase();
        return id ? { id, label: id } : null;
      }
      if (!action || typeof action !== 'object') return null;
      const id = String(action.id || action.actionId || action.value || '').trim().toLowerCase();
      if (!id) return null;
      const label = String(action.label || action.title || id).trim().slice(0, 120) || id;
      const mode = normalizeRelayMode(action.mode);
      const prompt = String(action.prompt || '').trim();
      return {
        id,
        label,
        mode: mode || null,
        prompt: prompt || null,
      };
    })
    .filter(Boolean)
    .slice(0, 8);
}

function parseBoardContext(rawContext) {
  if (!rawContext) return null;
  if (typeof rawContext !== 'string') return rawContext;
  try {
    return JSON.parse(rawContext);
  } catch {
    return null;
  }
}

function formatRelayBoardRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    queueId: row.queue_id,
    conversationId: row.conversation_id,
    messageId: row.message_id,
    boardType: String(row.board_type || '').trim().toLowerCase() || 'generic',
    mode: normalizeRelayMode(row.relay_mode) || DEFAULT_RELAY_MODE,
    title: String(row.title || '').trim(),
    body: String(row.body || '').trim(),
    actions: parseBoardActions(row.actions_json),
    recommendedAction: String(row.recommended_action || '').trim() || null,
    context: parseBoardContext(row.context_json),
    status: String(row.status || 'pending').trim().toLowerCase() || 'pending',
    selectedAction: String(row.selected_action || '').trim() || null,
    actedAt: row.acted_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at || row.created_at,
  };
}

function parseQuestionChoices(rawChoices) {
  if (!rawChoices) return [];
  if (Array.isArray(rawChoices)) return rawChoices;
  if (typeof rawChoices !== 'string') return [];
  try {
    const parsed = JSON.parse(rawChoices);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseQuestionRequest(rawRequest) {
  if (!rawRequest) return null;
  if (typeof rawRequest !== 'string') return rawRequest;
  try {
    return JSON.parse(rawRequest);
  } catch {
    return rawRequest;
  }
}

function normalizeQuestionEnvelope(parsedRequest) {
  if (!parsedRequest || typeof parsedRequest !== 'object' || Array.isArray(parsedRequest)) {
    return { request: parsedRequest, context: null, allowFreeform: null };
  }
  const hasEnvelopeFields =
    Object.prototype.hasOwnProperty.call(parsedRequest, 'request') ||
    Object.prototype.hasOwnProperty.call(parsedRequest, 'context') ||
    Object.prototype.hasOwnProperty.call(parsedRequest, 'allowFreeform');
  if (!hasEnvelopeFields) {
    return { request: parsedRequest, context: null, allowFreeform: null };
  }
  return {
    request: Object.prototype.hasOwnProperty.call(parsedRequest, 'request') ? parsedRequest.request : null,
    context: sanitizeRelayQuestionContext(parsedRequest.context),
    allowFreeform: typeof parsedRequest.allowFreeform === 'boolean' ? parsedRequest.allowFreeform : null,
  };
}

function normalizeQuestionChoices(rawChoices) {
  const input = Array.isArray(rawChoices) ? rawChoices : [];
  return input
    .map((choice) => {
      if (typeof choice === 'string') return choice.trim();
      if (choice && typeof choice === 'object') {
        return String(choice.label || choice.text || choice.value || choice.title || '').trim();
      }
      return '';
    })
    .filter(Boolean)
    .slice(0, 8);
}

function parseCookies(header) {
  const cookies = {};
  for (const part of String(header || '').split(/;\s*/)) {
    if (!part) continue;
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

function appendSetCookie(res, cookieValue) {
  if (!res) return;
  const existing = res.getHeader('Set-Cookie');
  if (!existing) {
    res.setHeader('Set-Cookie', cookieValue);
    return;
  }
  if (Array.isArray(existing)) {
    res.setHeader('Set-Cookie', [...existing, cookieValue]);
    return;
  }
  res.setHeader('Set-Cookie', [existing, cookieValue]);
}

function ensureSessionId(req, res) {
  const cookies = parseCookies(req.headers.cookie);
  let sessionId = cookies[SESSION_COOKIE];
  if (!sessionId) {
    sessionId = uuidv4();
    if (res) {
      appendSetCookie(res, `${SESSION_COOKIE}=${encodeURIComponent(sessionId)}; Path=/; SameSite=Lax`);
    }
  }
  return sessionId;
}

function parseAttachments(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== 'string') return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeReferenceTokenPath(rawPath, { trimTrailingPunctuation = false } = {}) {
  if (rawPath === null || rawPath === undefined) return '';
  let value = String(rawPath || '').replace(/\0/g, '').trim();
  if (!value) return '';
  if (trimTrailingPunctuation) {
    value = value.replace(/[),.;!?]+$/g, '').trim();
  }
  if (!value) return '';
  return value.replace(/\\/g, '/').replace(/\/+/g, '/').trim();
}

function extractReferenceTokensFromText(text) {
  const source = String(text || '');
  if (!source) return [];
  const tokens = [];
  const seen = new Set();

  let match = null;
  REFERENCE_TOKEN_PATTERN_BACKTICK.lastIndex = 0;
  while ((match = REFERENCE_TOKEN_PATTERN_BACKTICK.exec(source)) !== null) {
    const kind = String(match[1] || '').trim().toLowerCase();
    const tokenPath = normalizeReferenceTokenPath(match[2], { trimTrailingPunctuation: false });
    if (!tokenPath) continue;
    const key = `${kind}:${tokenPath.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    tokens.push({ kind, path: tokenPath, wrapped: true });
  }

  REFERENCE_TOKEN_PATTERN_PLAIN.lastIndex = 0;
  while ((match = REFERENCE_TOKEN_PATTERN_PLAIN.exec(source)) !== null) {
    const kind = String(match[2] || '').trim().toLowerCase();
    const tokenPath = normalizeReferenceTokenPath(match[3], { trimTrailingPunctuation: true });
    if (!tokenPath) continue;
    const key = `${kind}:${tokenPath.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    tokens.push({ kind, path: tokenPath, wrapped: false });
  }

  return tokens.filter((token) => token.kind === 'file' || token.kind === 'folder');
}

function resolveReferenceFolderToken(tokenPath) {
  const normalized = normalizeReferenceTokenPath(tokenPath);
  if (!normalized) return null;
  const looksDrivePath = /^[A-Za-z]:(?:\/|$)/.test(normalized);
  if (looksDrivePath) {
    const absolutePath = normalizeDriveAbsolutePath(normalized);
    if (!absolutePath) return null;
    try {
      const stat = fs.statSync(absolutePath);
      if (!stat.isDirectory()) return null;
    } catch {
      return null;
    }
    return {
      source: 'drives',
      absolutePath,
      webPath: toDriveWebPath(absolutePath),
    };
  }

  const absolutePath = resolveWorkspaceFilePath(normalized);
  if (!absolutePath) return null;
  try {
    const stat = fs.statSync(absolutePath);
    if (!stat.isDirectory()) return null;
  } catch {
    return null;
  }
  return {
    source: 'workspace',
    absolutePath,
    webPath: toRepoWebPath(path.relative(currentWorkspaceRootPath(), absolutePath)),
  };
}

function resolveReferenceFileToken(tokenPath) {
  const normalized = normalizeReferenceTokenPath(tokenPath);
  if (!normalized) return null;
  const looksDrivePath = /^[A-Za-z]:(?:\/|$)/.test(normalized);
  if (looksDrivePath) {
    const absolutePath = normalizeDriveAbsolutePath(normalized);
    if (!absolutePath) return null;
    const rootAbsolute = driveRootFromAbsolutePath(absolutePath);
    if (!rootAbsolute) return null;
    let meta = null;
    try {
      meta = readWorkspaceFileMeta(absolutePath);
    } catch {
      return null;
    }
    if (!meta || meta.kind !== 'file') return null;
    return {
      source: 'drives',
      absolutePath,
      webPath: toDriveWebPath(absolutePath),
      meta,
    };
  }

  const absolutePath = resolveWorkspaceFilePath(normalized);
  if (!absolutePath) return null;
  let meta = null;
  try {
    meta = readWorkspaceFileMeta(absolutePath);
  } catch {
    return null;
  }
  if (!meta || meta.kind !== 'file') return null;
  return {
    source: 'workspace',
    absolutePath,
    webPath: toRepoWebPath(path.relative(currentWorkspaceRootPath(), absolutePath)),
    meta,
  };
}

function buildReferenceAttachmentFromResolvedFile(resolvedFile) {
  if (!resolvedFile || typeof resolvedFile !== 'object') return null;
  const filePath = String(resolvedFile.absolutePath || '').trim();
  if (!filePath) return null;
  const contentType = String(resolvedFile?.meta?.contentType || workspaceContentType(filePath) || '').toLowerCase();
  if (!contentType.startsWith('image/')) return null;

  const size = Number(resolvedFile?.meta?.size || 0);
  if (!Number.isFinite(size) || size <= 0 || size > MAX_REFERENCE_IMAGE_ATTACHMENT_BYTES) {
    return null;
  }

  const webPath = String(resolvedFile.webPath || '').trim();
  if (!webPath) return null;
  const source = resolvedFile.source === 'drives' ? 'drives' : 'workspace';
  const rawUrl = source === 'drives'
    ? `${remotePath}/api/drives/file?path=${encodeURIComponent(webPath)}`
    : `${remotePath}/api/files/${webPath.split('/').map((part) => encodeURIComponent(part)).join('/')}`;
  return {
    name: path.basename(filePath),
    type: contentType,
    size,
    path: filePath,
    source: 'reference',
    referenceToken: `@file:${webPath}`,
    contentUrl: rawUrl,
  };
}

function collectReferenceAttachmentsFromText(text) {
  const tokens = extractReferenceTokensFromText(text);
  const attachments = [];
  const skipped = [];
  const seenPaths = new Set();

  for (const token of tokens) {
    if (token.kind === 'folder') continue;
    const resolved = resolveReferenceFileToken(token.path);
    if (!resolved) continue;
    const imageAttachment = buildReferenceAttachmentFromResolvedFile(resolved);
    if (!imageAttachment) {
      const maybeSize = Number(resolved?.meta?.size || 0);
      const maybeType = String(resolved?.meta?.contentType || '').toLowerCase();
      if (maybeType.startsWith('image/') && maybeSize > MAX_REFERENCE_IMAGE_ATTACHMENT_BYTES) {
        skipped.push({
          token: `@file:${resolved.webPath}`,
          reason: `image exceeds ${MAX_REFERENCE_IMAGE_ATTACHMENT_BYTES} bytes`,
        });
      }
      continue;
    }
    const key = String(imageAttachment.path || '').toLowerCase();
    if (!key || seenPaths.has(key)) continue;
    seenPaths.add(key);
    attachments.push(imageAttachment);
  }

  return { attachments, skipped };
}

function mergeMessageAttachments(primary, secondary) {
  const merged = [];
  const seen = new Set();
  for (const candidate of [...(Array.isArray(primary) ? primary : []), ...(Array.isArray(secondary) ? secondary : [])]) {
    if (!candidate || typeof candidate !== 'object') continue;
    const key = String(candidate.sha256 || candidate.path || candidate.dataUrl || '').trim().toLowerCase();
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    merged.push(candidate);
    if (merged.length >= MAX_UPLOAD_ATTACHMENTS) break;
  }
  return merged;
}

function isSha256(value) {
  return /^[a-f0-9]{64}$/.test(String(value || '').trim().toLowerCase());
}

function uploadPathForSha(sha256) {
  return path.join(UPLOAD_DIR, sha256);
}

function uploadContentUrlForSha(sha256) {
  return `/api/upload/${sha256}/content`;
}

function workspaceContentType(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  return WORKSPACE_CONTENT_TYPES[ext] || 'application/octet-stream';
}

function normalizeWorkspaceRelativePath(rawPath) {
  const value = String(rawPath || '').trim();
  if (!value) return '';
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return '';
  }
  const withoutNulls = decoded.replace(/\0/g, '');
  const normalized = withoutNulls
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+/g, '/')
    .trim();
  if (!normalized) return '';
  const parts = normalized.split('/').filter(Boolean);
  if (!parts.length) return '';
  if (parts.some((part) => part === '.' || part === '..')) return '';
  return parts.join(path.sep);
}

function resolveWorkspaceFilePath(rawPath, rootPath = null) {
  const normalized = normalizeWorkspaceRelativePath(rawPath);
  if (!normalized) return null;
  const activeWorkspaceRoot = normalizeConversationWorkspaceRootPath(rootPath) || currentWorkspaceRootPath();
  const absolutePath = path.resolve(activeWorkspaceRoot, normalized);
  const relativeToRoot = path.relative(activeWorkspaceRoot, absolutePath);
  if (!relativeToRoot || relativeToRoot === '.') return null;
  if (relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) return null;
  return absolutePath;
}

function cacheWorkspaceFileMeta(filePath, value) {
  workspaceFileMetaCache.set(filePath, { cachedAt: Date.now(), value });
  return value;
}

function readWorkspaceFileMeta(filePath) {
  const cached = workspaceFileMetaCache.get(filePath);
  if (cached && (Date.now() - cached.cachedAt) <= WORKSPACE_META_CACHE_TTL_MS) {
    return cached.value;
  }

  let stat = null;
  try {
    stat = fs.statSync(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      return cacheWorkspaceFileMeta(filePath, { kind: 'missing' });
    }
    throw error;
  }

  if (!stat.isFile()) {
    return cacheWorkspaceFileMeta(filePath, { kind: 'not_file' });
  }

  return cacheWorkspaceFileMeta(filePath, {
    kind: 'file',
    size: Number(stat.size || 0),
    contentType: workspaceContentType(filePath),
  });
}

function previewLanguageForWorkspaceFile(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  return WORKSPACE_PREVIEW_LANGUAGE_BY_EXTENSION[ext] || null;
}

function readWorkspaceFilePreviewBuffer(filePath, size) {
  const safeSize = Number.isFinite(Number(size)) ? Math.max(0, Number(size)) : 0;
  const targetBytes = Math.min(MAX_WORKSPACE_PREVIEW_BYTES + 1, Math.max(1, safeSize));
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(targetBytes);
    const bytesRead = fs.readSync(fd, buffer, 0, targetBytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    fs.closeSync(fd);
  }
}

function isLikelyBinaryPreviewBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return false;
  const sampleLength = Math.min(buffer.length, WORKSPACE_PREVIEW_BINARY_SAMPLE_BYTES);
  if (!sampleLength) return false;
  let suspicious = 0;
  for (let i = 0; i < sampleLength; i += 1) {
    const byte = buffer[i];
    if (byte === 0) return true;
    if (byte < 9) suspicious += 1;
    else if (byte > 13 && byte < 32) suspicious += 1;
  }
  return (suspicious / sampleLength) > 0.3;
}

function isLikelyTextContentType(contentType) {
  const value = String(contentType || '').toLowerCase();
  if (!value) return false;
  if (value.startsWith('text/')) return true;
  return value.includes('json')
    || value.includes('javascript')
    || value.includes('xml')
    || value.includes('yaml')
    || value.includes('toml');
}

function parseBooleanQueryFlag(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') return true;
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') return false;
  return fallback;
}

function workspacePreviewKindForMeta(ext, contentType) {
  const normalizedExt = String(ext || '').toLowerCase();
  const normalizedType = String(contentType || '').toLowerCase();
  if (WORKSPACE_MARKDOWN_EXTENSIONS.has(normalizedExt)) return 'markdown';
  if (WORKSPACE_IMAGE_EXTENSIONS.has(normalizedExt) || normalizedType.startsWith('image/')) return 'image';
  if (WORKSPACE_CODE_EXTENSIONS.has(normalizedExt)) return 'code';
  if (isLikelyTextContentType(normalizedType)) return 'text';
  return 'binary';
}

function shouldSkipRepoEntryName(entryName, { includeHidden = false, includeHeavy = false } = {}) {
  const name = String(entryName || '').trim();
  if (!name || name === '.' || name === '..') return true;
  const lower = name.toLowerCase();
  if (!includeHeavy && REPO_HEAVY_DIR_NAMES.has(lower)) return true;
  if (!includeHidden && name.startsWith('.')) return true;
  return false;
}

function compareRepoDirEntries(a, b) {
  const typeA = a.isDirectory() ? 0 : 1;
  const typeB = b.isDirectory() ? 0 : 1;
  if (typeA !== typeB) return typeA - typeB;
  return String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' });
}

function toRepoWebPath(value) {
  return String(value || '').replace(/\\/g, '/');
}

function normalizeDriveAbsolutePath(rawPath) {
  const value = String(rawPath || '').trim();
  if (!value) return '';
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return '';
  }
  const withoutNulls = decoded.replace(/\0/g, '');
  let normalized = withoutNulls
    .replace(/\//g, '\\')
    .replace(/\\+/g, '\\')
    .trim();
  if (!normalized) return '';
  if (/^[A-Za-z]:$/.test(normalized)) normalized = `${normalized}\\`;
  if (!/^[A-Za-z]:\\/.test(normalized)) return '';
  normalized = path.win32.normalize(normalized);
  if (!/^[A-Za-z]:\\/.test(normalized)) return '';
  const drive = `${normalized.slice(0, 1).toUpperCase()}:`;
  const rest = normalized.slice(3).replace(/^\\+/, '');
  return rest ? `${drive}\\${rest}` : `${drive}\\`;
}

function driveRootFromAbsolutePath(absolutePath) {
  const normalized = normalizeDriveAbsolutePath(absolutePath);
  if (!normalized) return '';
  return `${normalized.slice(0, 1).toUpperCase()}:\\`;
}

function toDriveWebPath(absolutePath) {
  const normalized = normalizeDriveAbsolutePath(absolutePath);
  if (!normalized) return '';
  const drive = `${normalized.slice(0, 1).toUpperCase()}:`;
  const rest = normalized.slice(3).replace(/\\/g, '/');
  return rest ? `${drive}/${rest}` : drive;
}

function driveDisplayName(drive) {
  const id = String(drive?.drive || '').trim();
  const label = String(drive?.label || '').trim();
  if (!id) return 'Drive';
  return label ? `${id} (${label})` : id;
}

function mapDriveDirectoryEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const absolutePath = normalizeDriveAbsolutePath(entry.fullPath);
  if (!absolutePath) return null;
  const webPath = toDriveWebPath(absolutePath);
  if (!webPath) return null;
  const type = String(entry.type || '').toLowerCase() === 'dir' ? 'dir' : 'file';
  const node = {
    path: webPath,
    name: String(entry.name || path.win32.basename(absolutePath) || webPath),
    type,
    mtime: entry.mtime ? String(entry.mtime) : null,
  };
  if (type === 'dir') {
    node.children = [];
    node.lazy = true;
    node.childrenLoaded = false;
    return node;
  }
  const ext = path.extname(absolutePath).toLowerCase();
  const contentType = workspaceContentType(absolutePath);
  node.ext = ext || null;
  node.size = Number(entry.size || 0);
  node.contentType = contentType;
  node.previewKind = workspacePreviewKindForMeta(ext, contentType);
  return node;
}

function fetchBrowsableDrives(cb) {
  execFile('fsutil.exe', ['fsinfo', 'drives'], { windowsHide: true }, (err, stdout, stderr) => {
    if (err) return cb(new Error(`drive enumeration failed: ${stderr || err.message}`));

    const text = String(stdout || '').trim().toUpperCase();
    if (!text) return cb(null, []);

    const drives = [];
    const seen = new Set();
    DRIVE_ROOT_PATTERN.lastIndex = 0;
    let match = null;
    while ((match = DRIVE_ROOT_PATTERN.exec(text)) !== null) {
      const driveId = String(match[1] || '').trim().toUpperCase();
      if (!/^[A-Z]$/.test(driveId) || seen.has(driveId)) continue;
      seen.add(driveId);
      const rootAbsolute = `${driveId}:\\`;
      drives.push({
        drive: `${driveId}:`,
        rootAbsolute,
        webPath: toDriveWebPath(rootAbsolute),
        label: '',
        driveType: null,
        sizeBytes: 0,
        freeBytes: 0,
      });
    }
    cb(null, drives);
  });
}

function fetchDriveDirectoryEntries(absoluteDirPath, { includeHidden = false } = {}, cb) {
  const normalizedDirPath = normalizeDriveAbsolutePath(absoluteDirPath);
  if (!normalizedDirPath) return cb(new Error('Invalid drive path'));
  const escapedPath = normalizedDirPath.replace(/'/g, "''");
  const forceFlag = includeHidden ? '-Force' : '';
  const psScript = [
    `$target = '${escapedPath}';`,
    `$rows = @(Get-ChildItem -LiteralPath $target ${forceFlag} -ErrorAction Stop`,
    '| Sort-Object @{Expression = { if ($_.PSIsContainer) { 0 } else { 1 } }}, Name',
    '| ForEach-Object {',
    '  $isDir = [bool]$_.PSIsContainer;',
    '  [pscustomobject]@{',
    '    name = [string]$_.Name;',
    '    fullPath = [string]$_.FullName;',
    '    type = if ($isDir) { "dir" } else { "file" };',
    '    ext = if ($isDir) { "" } else { [string]$_.Extension };',
    '    size = if ($isDir) { $null } else { [int64]$_.Length };',
    '    mtime = if ($_.LastWriteTimeUtc) { $_.LastWriteTimeUtc.ToString("o") } else { $null };',
    '  }',
    '});',
    '$rows | ConvertTo-Json -Depth 4 -Compress',
  ].join(' ');

  execFile('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', psScript], { windowsHide: true }, (err, stdout, stderr) => {
    if (err) return cb(new Error(`drive list failed: ${stderr || err.message}`));
    const text = String(stdout || '').trim();
    if (!text) return cb(null, []);
    try {
      const parsed = JSON.parse(text);
      const list = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
      cb(null, list);
    } catch (parseErr) {
      cb(new Error(`drive list parse failed: ${parseErr.message}`));
    }
  });
}

function buildRepositoryTreeSnapshot({
  includeHidden = false,
  includeHeavy = false,
  maxNodes = MAX_REPO_TREE_NODES,
  rootPath = null,
  rootName = null,
} = {}) {
  const activeWorkspaceRoot = normalizeConversationWorkspaceRootPath(rootPath) || currentWorkspaceRootPath();
  const activeWorkspaceRootName = String(rootName || '').trim() || workspaceRootDisplayName(activeWorkspaceRoot);
  const safeMaxNodes = Number.isFinite(Number(maxNodes))
    ? Math.max(500, Math.min(Number(maxNodes), MAX_REPO_TREE_NODES))
    : MAX_REPO_TREE_NODES;

  let nodeCount = 0;
  let truncated = false;

  function walk(absolutePath, relativePath, depth = 0) {
    if (truncated || nodeCount >= safeMaxNodes) {
      truncated = true;
      return null;
    }

    let stat = null;
    try {
      stat = fs.lstatSync(absolutePath);
    } catch {
      return null;
    }
    if (!stat) return null;
    if (stat.isSymbolicLink()) return null;

    const node = {
      path: toRepoWebPath(relativePath),
      name: relativePath ? path.basename(absolutePath) : activeWorkspaceRootName,
      type: stat.isDirectory() ? 'dir' : 'file',
      mtime: stat.mtime ? stat.mtime.toISOString() : null,
    };
    nodeCount += 1;

    if (node.type === 'file') {
      const ext = path.extname(absolutePath).toLowerCase();
      const contentType = workspaceContentType(absolutePath);
      node.ext = ext || null;
      node.size = Number(stat.size || 0);
      node.contentType = contentType;
      node.previewKind = workspacePreviewKindForMeta(ext, contentType);
      return node;
    }

    if (depth >= MAX_REPO_TREE_DEPTH) {
      node.children = [];
      node.depthLimited = true;
      return node;
    }

    let entries = [];
    try {
      entries = fs.readdirSync(absolutePath, { withFileTypes: true });
    } catch {
      node.children = [];
      node.readError = true;
      return node;
    }

    const visibleEntries = entries
      .filter((entry) => !shouldSkipRepoEntryName(entry?.name, { includeHidden, includeHeavy }))
      .sort(compareRepoDirEntries);

    node.children = [];
    for (const entry of visibleEntries) {
      if (nodeCount >= safeMaxNodes) {
        truncated = true;
        break;
      }
      const childName = String(entry?.name || '').trim();
      if (!childName) continue;
      const childAbsolutePath = path.join(absolutePath, childName);
      const childRelativePath = relativePath ? path.join(relativePath, childName) : childName;
      const childNode = walk(childAbsolutePath, childRelativePath, depth + 1);
      if (childNode) node.children.push(childNode);
    }

    return node;
  }

  const root = walk(activeWorkspaceRoot, '', 0) || {
    path: '',
    name: activeWorkspaceRootName,
    type: 'dir',
    children: [],
  };

  return {
    root,
    nodeCount,
    truncated,
    maxNodes: safeMaxNodes,
    includeHidden,
    includeHeavy,
    rootName: activeWorkspaceRootName,
    rootPath: activeWorkspaceRoot,
  };
}

function startWorkspaceFileWatcher() {
  if (workspaceFileWatcher) return;
  const rootForWatch = currentWorkspaceRootPath();
  const watchOptions = WORKSPACE_RECURSIVE_WATCH_SUPPORTED ? { recursive: true } : {};
  try {
    workspaceFileWatcher = fs.watch(rootForWatch, watchOptions, (eventType, changedPath) => {
      if (!changedPath) {
        workspaceFileMetaCache.clear();
        return;
      }
      const absoluteChangedPath = path.resolve(rootForWatch, String(changedPath));
      workspaceFileMetaCache.delete(absoluteChangedPath);
      if (eventType === 'rename') {
        workspaceFileMetaCache.delete(path.normalize(absoluteChangedPath));
      }
    });
    workspaceFileWatcher.on('error', (error) => {
      console.warn(`[server] Workspace watcher error: ${error?.message || String(error)}; clearing file cache`);
      workspaceFileMetaCache.clear();
    });
    console.log(`[server] Workspace file watcher enabled at: ${rootForWatch}`);
  } catch (error) {
    console.warn(`[server] Workspace file watcher unavailable: ${error?.message || String(error)}`);
  }
}

startWorkspaceFileWatcher();

function listWorkspaceRootEntries() {
  try {
    return fs.readdirSync(currentWorkspaceRootPath()).filter((name) => {
      const value = String(name || '').trim();
      return value && value !== '.' && value !== '..';
    });
  } catch {
    return [];
  }
}

function hydrateAttachment(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const att = { ...raw };
  const sha256 = String(att.sha256 || '').trim().toLowerCase();
  if (isSha256(sha256)) {
    att.sha256 = sha256;
    att.path = uploadPathForSha(sha256);
    att.reference = `@${att.path}`;
    att.contentUrl = uploadContentUrlForSha(sha256);
  }
  return att;
}

function persistUploadBuffer(buffer, options = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('Empty upload');
  if (buffer.length > MAX_UPLOAD_BYTES) throw new Error('Uploaded file too large');
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const filePath = uploadPathForSha(sha256);
  if (!fs.existsSync(filePath)) {
    const tmpPath = path.join(UPLOAD_DIR, `${sha256}.${process.pid}.${Date.now()}.tmp`);
    fs.writeFileSync(tmpPath, buffer);
    try {
      fs.renameSync(tmpPath, filePath);
    } catch (e) {
      if (fs.existsSync(tmpPath)) {
        try { fs.unlinkSync(tmpPath); } catch {}
      }
      if (!fs.existsSync(filePath)) throw e;
    }
  }

  const now = new Date().toISOString();
  const originalName = typeof options.name === 'string' ? options.name.trim().slice(0, 255) : '';
  const mimeType = typeof options.type === 'string' ? options.type.trim().toLowerCase().slice(0, 127) : 'application/octet-stream';
  stmts.insertUploadFile.run(
    sha256,
    originalName || null,
    mimeType || 'application/octet-stream',
    buffer.length,
    now,
  );
  const row = stmts.getUploadFile.get(sha256);
  return buildStoredAttachment({
    sha256,
    name: row?.original_name || originalName || `upload-${sha256.slice(0, 12)}`,
    type: row?.mime_type || mimeType || 'application/octet-stream',
    size: Number(row?.size_bytes || buffer.length),
  });
}

function buildStoredAttachment({ sha256, name, type, size }) {
  const normalizedSha = String(sha256 || '').trim().toLowerCase();
  if (!isSha256(normalizedSha)) return null;
  const normalizedName = String(name || '').trim().slice(0, 255) || `upload-${normalizedSha.slice(0, 12)}`;
  const normalizedType = String(type || '').trim().toLowerCase().slice(0, 127) || 'application/octet-stream';
  return {
    name: normalizedName,
    type: normalizedType,
    size: Number(size || 0),
    sha256: normalizedSha,
    path: uploadPathForSha(normalizedSha),
    reference: `@${uploadPathForSha(normalizedSha)}`,
    contentUrl: uploadContentUrlForSha(normalizedSha),
  };
}

function normalizeAttachments(rawAttachments) {
  if (!rawAttachments) return [];
  const input = Array.isArray(rawAttachments) ? rawAttachments : [rawAttachments];
  const attachments = [];

  for (const raw of input.slice(0, MAX_UPLOAD_ATTACHMENTS)) {
    if (!raw || typeof raw !== 'object') continue;
    const referencedSha = String(raw.sha256 || '').trim().toLowerCase();
    if (isSha256(referencedSha)) {
      const row = stmts.getUploadFile.get(referencedSha);
      if (!row) continue;
      const stored = buildStoredAttachment({
        sha256: referencedSha,
        name: raw.name || row.original_name || `upload-${referencedSha.slice(0, 12)}`,
        type: raw.type || row.mime_type || 'application/octet-stream',
        size: Number(row.size_bytes || 0),
      });
      if (stored) attachments.push(stored);
      continue;
    }
    const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, 120) : 'image';
    const type = typeof raw.type === 'string' ? raw.type.trim().toLowerCase() : '';
    const dataUrl = typeof raw.dataUrl === 'string' ? raw.dataUrl.trim() : '';
    if (!type.startsWith('image/')) continue;
    if (!dataUrl.startsWith(`data:${type};base64,`) && !dataUrl.startsWith('data:image/')) continue;
    if (dataUrl.length > MAX_IMAGE_DATA_URL_LENGTH) {
      throw new Error('Image attachment too large');
    }
    attachments.push({ name: name || 'image', type, dataUrl, size: 0 });
  }

  return attachments;
}

function attachmentSummary(attachments) {
  if (!attachments.length) return '';
  return attachments.map((att) => att.name ? `${att.name} (${att.type})` : att.type).join(', ');
}

function linkUploadReferences(conversationId, messageId, attachments) {
  if (!conversationId || !messageId || !Array.isArray(attachments) || !attachments.length) return;
  const now = new Date().toISOString();
  for (const att of attachments) {
    const sha256 = String(att?.sha256 || '').trim().toLowerCase();
    if (!isSha256(sha256)) continue;
    stmts.insertUploadRef.run(sha256, conversationId, messageId, now);
  }
}

function collectOrphanedUploadsFromConversation(conversationId) {
  const hashes = stmts.listUploadHashesByConversation.all(conversationId).map((row) => String(row.file_sha256 || '').trim().toLowerCase()).filter(Boolean);
  if (!hashes.length) return [];
  stmts.deleteUploadRefsByConversation.run(conversationId);
  const orphaned = [];
  for (const sha256 of hashes) {
    const refs = Number(stmts.countUploadRefsBySha.get(sha256)?.cnt || 0);
    if (refs > 0) continue;
    orphaned.push(sha256);
  }
  return orphaned;
}

function deleteOrphanedUploads(hashes) {
  for (const sha256 of (hashes || [])) {
    if (!isSha256(sha256)) continue;
    const refs = Number(stmts.countUploadRefsBySha.get(sha256)?.cnt || 0);
    if (refs > 0) continue;
    stmts.deleteUploadFile.run(sha256);
    const filePath = uploadPathForSha(sha256);
    if (fs.existsSync(filePath)) {
      try { fs.unlinkSync(filePath); } catch {}
    }
  }
}

function normalizeMessageLine(text, maxLength = 240) {
  const compact = String(text || '').replace(/\s+/g, ' ').trim();
  if (!compact) return '';
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function buildCompactSummary(conversation, recentMessagesDesc) {
  const title = normalizeMessageLine(conversation?.title || 'Untitled', 80) || 'Untitled';
  const sourceLines = Array.isArray(recentMessagesDesc) ? [...recentMessagesDesc].reverse() : [];
  const lines = [
    `Conversation title: ${title}`,
    'Carry-over summary (latest turns first in source, normalized below):',
  ];

  for (const row of sourceLines.slice(0, 16)) {
    const role = row?.role === 'assistant' ? 'Assistant' : 'User';
    const line = normalizeMessageLine(row?.text || '', 260);
    if (!line) continue;
    lines.push(`- ${role}: ${line}`);
  }

  if (lines.length <= 2) {
    lines.push('- No prior text messages were available.');
  }

  return lines.join('\n').slice(0, 3500);
}

function createCompactedConversation(sourceConversationId) {
  // Compaction stays scoped to sourceConversationId; it never consults a
  // global/latest session file that could belong to another conversation.
  const source = stmts.getConv.get(sourceConversationId);
  if (!source) return null;

  const now = new Date().toISOString();
  const targetConversationId = uuidv4();
  const recent = stmts.getRecentMessagesDesc.all(sourceConversationId, 24);
  const summarySeed = buildCompactSummary(source, recent);
  const nextTitleBase = normalizeMessageLine(source.title || 'Conversation', 64) || 'Conversation';
  const nextTitle = `${nextTitleBase} (compacted)`.slice(0, 80);

  let targetRuntimeSession = null;
  const tx = db.transaction(() => {
    stmts.insertConv.run(targetConversationId, nextTitle, now, now);
    stmts.updateConvSeed.run(summarySeed, 1, sourceConversationId, now, targetConversationId);
    stmts.markConvCompacted.run(targetConversationId, now, sourceConversationId);
    targetRuntimeSession = ensureRuntimeSessionBinding(targetConversationId, null, now);
  });
  tx();

  return {
    sourceConversationId,
    targetConversationId,
    runtimeSessionId: targetRuntimeSession?.id || null,
    summarySeed,
    createdAt: now,
    targetTitle: nextTitle,
  };
}

function sanitizeActivityText(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  return text.slice(0, 200);
}

function relayActivityForResponse(responseMessageId) {
  return stmts.listActivityByResponse
    .all(responseMessageId)
    .map((row) => sanitizeActivityText(row.text))
    .filter(Boolean)
    .slice(0, 48);
}

function relayActivityForQueueMessage(queueMessageId) {
  return stmts.listActivityByQueueMessage
    .all(queueMessageId)
    .map((row) => sanitizeActivityText(row.text))
    .filter(Boolean)
    .slice(0, 48);
}

function relayStreamEventsForQueueMessage(queueMessageId) {
  const rows = stmts.listStreamEventsByQueueMessage?.all(queueMessageId) || [];
  return rows
    .map((row) => {
      const seq = Math.max(0, Math.trunc(Number(row?.seq || 0)));
      return {
        seq,
        text: String(row?.text || ''),
        done: Number(row?.done || 0) === 1,
        timestamp: row?.created_at || null,
      };
    })
    .filter((row) => Number.isFinite(row.seq))
    .slice(0, 5000);
}

function inFlightStateForConversation(conversationId) {
  const row = stmts.getLatestProcessingQueueByConversation.get(conversationId);
  if (!row) return null;
  const streamEvents = relayStreamEventsForQueueMessage(row.id);
  const lastStreamEvent = streamEvents.length ? streamEvents[streamEvents.length - 1] : null;
  return {
    messageId: row.id,
    status: 'processing',
    mode: normalizeRelayMode(row.relay_mode) || DEFAULT_RELAY_MODE,
    timestamp: row.timestamp || null,
    processingAt: row.processing_at || null,
    activities: relayActivityForQueueMessage(row.id),
    streamEvents,
    streamDone: !!lastStreamEvent?.done,
    lastStreamSeq: lastStreamEvent?.seq || 0,
  };
}

function recoverProcessingOlderThan(cutoffIso, requeueAtIso) {
  const rows = stmts.listRecoverableProcessing.all(cutoffIso);
  if (!rows.length) return [];

  const tx = db.transaction(() => {
    stmts.recoverProcessingBefore.run(requeueAtIso, cutoffIso);
    const settleRecoveredAbortControls = db.prepare(`
      UPDATE relay_control_requests
      SET status = 'failed',
          error = ?,
          updated_at = ?,
          completed_at = ?
      WHERE queue_message_id = ?
        AND type = 'abort_turn'
        AND status IN ('pending', 'processing')
    `);
    const now = new Date().toISOString();
    for (const row of rows) {
      settleRecoveredAbortControls.run('queue-recovered', now, now, row.id);
    }
  });
  tx();

  for (const row of rows) {
    io.emit('message_status', { messageId: row.id, conversationId: row.conversation_id, status: 'pending' });
  }
  io.emit('queue_updated', { recovered: rows.length });
  return rows;
}

function fetchUsageSummary(cb) {
  execFile('gh', ['auth', 'token'], (err, stdout) => {
    if (err) return cb(new Error('gh auth token failed'));
    const ghToken = stdout.trim();
    fetch('https://api.github.com/copilot_internal/user', {
      headers: { Authorization: `Bearer ${ghToken}`, Accept: 'application/json' },
    })
      .then((r) => r.json())
      .then((data) => {
        const snap = data.quota_snapshots || {};
        const premium = snap.premium_interactions || {};
        const chat = snap.chat || {};
        cb(null, {
          plan: data.copilot_plan,
          resetDate: data.quota_reset_date,
          chat: {
            unlimited: chat.unlimited ?? true,
            remaining: chat.remaining ?? null,
            entitlement: chat.entitlement ?? null,
          },
          premiumInteractions: {
            unlimited: premium.unlimited ?? false,
            remaining: Math.round(premium.quota_remaining ?? premium.remaining ?? 0),
            entitlement: premium.entitlement ?? 1500,
            percentRemaining: premium.percent_remaining ?? null,
          },
        });
      })
      .catch((e) => cb(new Error(e.message)));
  });
}

const sessionDiscoveryService = createSessionDiscoveryService({
  fs,
  path,
  resolveSessionStateRoot,
});
const discoverSessionStateConversations = sessionDiscoveryService.discoverSessionStateConversations;
const sessionTranscriptService = createSessionTranscriptService({
  fs,
  path,
  resolveSessionStateRoot,
});
const readSessionTranscriptMessages = sessionTranscriptService.readSessionTranscriptMessages;
const contextSnapshotService = createContextSnapshotService({
  fs,
  path,
  resolveSessionStateRoot,
});
const readContextFromSessionEvents = contextSnapshotService.readContextFromSessionEvents;

// ─── Express + Socket.io Setup ────────────────────────────────────────────────
const app        = express();
const httpServer = http.createServer(app);
const io         = new Server(httpServer, { cors: { origin: '*' } });

app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public'), { etag: false, setHeaders: (res) => res.setHeader('Cache-Control', 'no-store') }));

// ─── CLI Status Tracking ──────────────────────────────────────────────────────
let cliLastSeen = null;
let cliOnline   = false;
let relayPaused = false;
const relayBridgeOwnerService = createRelayBridgeOwnerService();

const runtimeState = {
  get cliOnline() { return cliOnline; },
  set cliOnline(value) { cliOnline = value; },
  get relayPaused() { return relayPaused; },
  set relayPaused(value) { relayPaused = value; },
  get relayShutdown() { return getRelayShutdownState(); },
  get activeBridgeOwner() { return relayBridgeOwnerService.getOwner(); },
  get featureFlags() { return featureFlags; },
  get sessionWorkerSupervisor() { return sessionWorkerSupervisor; },
};

const sharedRouteDeps = {
  auth,
  io,
  db,
  stmts,
  config,
  runtimeState,
  uuidv4,
  ts,
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_ATTACHMENTS,
  MAX_REPO_TREE_NODES,
  MAX_REQUEUE_RETRIES,
  MAX_IMAGE_DATA_URL_LENGTH,
  MAX_WORKSPACE_PREVIEW_BYTES,
  MAX_REFERENCE_IMAGE_ATTACHMENT_BYTES,
  remotePath,
  parseBooleanQueryFlag,
  buildRepositoryTreeSnapshot,
  fetchBrowsableDrives,
  fetchDriveDirectoryEntries,
  mapDriveDirectoryEntry,
  driveDisplayName,
  normalizeDriveAbsolutePath,
  driveRootFromAbsolutePath,
  toDriveWebPath,
  readWorkspaceFileMeta,
  resolveWorkspaceFilePath,
  normalizeWorkspaceRelativePath,
  previewLanguageForWorkspaceFile,
  readWorkspaceFilePreviewBuffer,
  isLikelyBinaryPreviewBuffer,
  isLikelyTextContentType,
  workspacePreviewKindForMeta,
  workspaceContentType,
  persistUploadBuffer,
  isSha256,
  uploadPathForSha,
  uploadContentUrlForSha,
  maybeApplyWorkspaceRootFromMessage,
  updateConversationConfiguredWorkspaceRoot,
  setWorkspaceRoot: applyWorkspaceRoot,
  getOrCreateConversation,
  ensureRuntimeSessionBinding,
  linkUploadReferences,
  normalizeAttachments,
  collectReferenceAttachmentsFromText,
  mergeMessageAttachments,
  attachmentSummary,
  createCompactedConversation,
  workspaceRootPayload,
  queueCounts,
  getModelCatalogState,
  updateModelCatalog,
  buildRelayReadyBannerData,
  processingTimeoutMs,
  localhostOnly,
  listenHost,
  ensureSessionId,
  touchCli,
  markCliOffline,
  recoverProcessingOlderThan,
  addMsIso,
  computeRetryDelayMs,
  resolveRequestedModel,
  normalizeRelayMode,
  DEFAULT_RELAY_MODE,
  DEFAULT_MODEL,
  configuredConversationSessionMode,
  parseAttachments,
  hydrateAttachment,
  relayActivityForResponse,
  relayActivityForQueueMessage,
  sanitizeActivityText,
  inFlightStateForConversation,
  emitToClientsExceptSessionId,
  relayBridgeOwnerService,
  relayCliLauncherService,
  resolveConversationWorkspaceState,
  updateConversationConfiguredWorkspaceRoot,
  learnConversationWorkspaceRoot,
  featureFlags,
  sessionWorkerSupervisor,
  sessionWorkerRegistry,
  sessionWorkerProcessInspector,
  buildContextResponseText,
  readContextFromSessionEvents,
  discoverSessionStateConversations,
  readSessionTranscriptMessages,
  collectOrphanedUploadsFromConversation,
  deleteOrphanedUploads,
  fs,
  path,
  uploadsDir: UPLOAD_DIR,
  fetchUsageSummary,
  bootstrapRuntimeSessionBindings,
  SUPPORTED_RELAY_MODES,
  SUPPORTED_CONVERSATION_SESSION_MODES,
  DEFAULT_CONVERSATION_SESSION_MODE,
  DEFAULT_QUESTION_TIMEOUT_MS,
  questionExpiresAt,
  sanitizeRelayQuestionPrompt,
  sanitizeRelayQuestionRequest,
  sanitizeRelayQuestionContext,
  parseQuestionRequest,
  normalizeQuestionChoices,
  formatQuestionRow,
  parseBoardActions,
  formatRelayBoardRow,
  relayRestartOrchestrator,
  resolveSessionStateRoot,
  requestRelayShutdown,
};
registerMessagesRoutes(app, sharedRouteDeps);
registerSessionsRoutes(app, sharedRouteDeps);
registerAskUserRoutes(app, sharedRouteDeps);
registerRelayBoardRoutes(app, sharedRouteDeps);
registerCacheRoutes(app, sharedRouteDeps);
function markCliOffline(reason = 'offline', { clearOwner = true } = {}) {
  cliLastSeen = null;
  const wasOnline = cliOnline;
  cliOnline = false;
  if (clearOwner) {
    relayBridgeOwnerService.clearOwner();
  }
  relayRestartOrchestrator.noteCliOffline();
  if (wasOnline) {
    console.log(`[${ts()}] CLI OFFLINE${reason ? ` (${reason})` : ''}`);
    io.emit('cli_status', { online: false });
  }
}

function checkCliStatus() {
  const wasOnline = cliOnline;
  cliOnline = cliLastSeen !== null && (Date.now() - cliLastSeen) < 10_000;
  if (wasOnline !== cliOnline) {
    if (!cliOnline) {
      markCliOffline('heartbeat-timeout');
      return;
    }
    console.log(`[${ts()}] CLI ONLINE`);
    io.emit('cli_status', { online: true });
  }
}
runtimeTimers.cliStatus = setInterval(checkCliStatus, 2000);

if (managedOwnerPid) {
  runtimeTimers.ownerWatchdog = setInterval(() => {
    if (isProcessAlive(managedOwnerPid)) return;
    console.log(`[${ts()}] Owner process ${managedOwnerPid} is gone; shutting down managed relay.`);
    void shutdownRuntime(`owner-pid-missing:${managedOwnerPid}`);
  }, 3000);
}

// Auto-recover messages stuck in 'processing' past the configured timeout (e.g. after CLI crash)
function recoverStaleMessages() {
  const staleWindowMs = cliOnline
    ? processingTimeoutMs
    : Math.min(processingTimeoutMs, OFFLINE_STALE_RECOVER_MS);
  const cutoff = new Date(Date.now() - staleWindowMs).toISOString();
  const requeueAt = addMsIso(cliOnline ? 30_000 : 2_000);
  const recoveredRows = recoverProcessingOlderThan(cutoff, requeueAt);
  if (recoveredRows.length > 0) {
    console.log(
      `[${ts()}] Recovered ${recoveredRows.length} stale message(s) older than ${Math.round(staleWindowMs / 1000)}s (cliOnline=${cliOnline})`
    );
  }
}
runtimeTimers.staleRecovery = setInterval(recoverStaleMessages, 15_000);
recoverStaleMessages(); // run immediately on startup

function expirePendingQuestions() {
  const now = new Date().toISOString();
  const result = stmts.expireQuestions.run(now);
  if (result.changes > 0) {
    console.log(`[${ts()}] Timed out ${result.changes} relay question(s)`);
    io.emit('relay_question_changed', { expired: result.changes });
  }
}
runtimeTimers.questionExpiry = setInterval(expirePendingQuestions, 10_000);
expirePendingQuestions();
const runtimeBindingsBootstrapped = bootstrapRuntimeSessionBindings();
if (runtimeBindingsBootstrapped > 0) {
  console.log(`[${ts()}] Runtime sessions bootstrapped: ${runtimeBindingsBootstrapped}`);
}

function ts() { return new Date().toISOString().slice(11, 23); }

// ─── Auth Middleware ──────────────────────────────────────────────────────────
function auth(req, res, next) {
  const cookies = parseCookies(req.headers.cookie);
  const token =
    (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '') ||
    req.query.token ||
    req.body?.token ||
    cookies[AUTH_COOKIE];
  if (token === config.authToken) {
    if (res && cookies[AUTH_COOKIE] !== config.authToken) {
      const secureAttr = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase() === 'https'
        ? '; Secure'
        : '';
      appendSetCookie(res, `${AUTH_COOKIE}=${encodeURIComponent(config.authToken)}; Path=/; Max-Age=2592000; SameSite=Lax; HttpOnly${secureAttr}`);
    }
    return next();
  }
  res.status(401).json({ error: 'Unauthorized' });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function getOrCreateConversation(id, firstLine) {
  const now = new Date().toISOString();
  stmts.insertConv.run(id, (firstLine || 'Untitled').slice(0, 80), now, now);
  return stmts.getConv.get(id);
}

function ensureRuntimeSessionBinding(conversationId, model, nowIso = new Date().toISOString(), sdkSessionId = null) {
  const normalizedConversationId = String(conversationId || '').trim();
  if (!normalizedConversationId) return null;
  const normalizedModel = String(model || '').trim() || null;
  const normalizedSdkSessionId = String(sdkSessionId || '').trim() || null;
  if (normalizedSdkSessionId) {
    stmts.setConvSdkSessionIdIfMissing.run(normalizedConversationId, nowIso, normalizedSdkSessionId);
  }
  const existing = stmts.getRuntimeSessionByConversation.get(normalizedConversationId);
  if (existing?.id) {
    stmts.touchRuntimeSession.run(normalizedModel, nowIso, existing.id);
    if (normalizedSdkSessionId) {
      stmts.setRuntimeSessionSdkSessionIdIfMissing.run(normalizedSdkSessionId, nowIso, existing.id);
    }
    return stmts.getRuntimeSessionById.get(existing.id);
  }

  const runtimeSessionId = uuidv4();
  const strategy = configuredConversationSessionMode;
  const runtimeKey = runtimeSessionId;
  stmts.insertRuntimeSession.run(
    runtimeSessionId,
    normalizedConversationId,
    strategy,
    runtimeKey,
    normalizedModel,
    nowIso,
    nowIso,
    normalizedSdkSessionId,
  );
  return stmts.getRuntimeSessionById.get(runtimeSessionId);
}

function bootstrapRuntimeSessionBindings() {
  const discoveredSessions = discoverSessionStateConversations(400);
  const tombstonedSessions = new Set(
    stmts.listDeletedSdkSessions.all().map((row) => String(row?.sdk_session_id || '').trim()).filter(Boolean),
  );
  const missing = stmts.listConvIdsMissingRuntimeSession.all();
  const now = new Date().toISOString();
  let bootstrapped = 0;
  const tx = db.transaction(() => {
    for (const item of discoveredSessions) {
      const conversationId = String(item?.sdkSessionId || '').trim();
      const discoveredUpdatedAt = String(item?.updatedAt || '').trim() || now;
      if (!conversationId || tombstonedSessions.has(conversationId)) continue;

      const existingConversation = stmts.getConvAnyStatus.get(conversationId) || null;
      const discoveredTitle = String(item?.title || '').trim() || 'Session';
      if (!existingConversation) {
        stmts.insertConv.run(conversationId, discoveredTitle, discoveredUpdatedAt, discoveredUpdatedAt);
      }
      db.prepare(`
        UPDATE conversations
        SET sdk_session_id = ?,
            updated_at = CASE
              WHEN updated_at IS NULL OR updated_at = '' OR updated_at < ? THEN ?
              ELSE updated_at
            END
        WHERE id = ?
      `).run(conversationId, discoveredUpdatedAt, discoveredUpdatedAt, conversationId);

      const existingRuntimeSession = stmts.getRuntimeSessionByConversation.get(conversationId) || null;
      if (!existingRuntimeSession) {
        const latestModel = stmts.getLatestConversationModel.get(conversationId)?.model || null;
        const runtimeSession = ensureRuntimeSessionBinding(conversationId, latestModel, discoveredUpdatedAt, item?.sdkSessionId || null);
        if (runtimeSession?.id) {
          db.prepare(`
            UPDATE runtime_sessions
            SET sdk_session_id = ?, last_used_at = ?, status = 'active'
            WHERE id = ?
          `).run(conversationId, discoveredUpdatedAt, runtimeSession.id);
          bootstrapped += 1;
        }
      } else if (String(existingRuntimeSession.sdk_session_id || '').trim() !== conversationId) {
        db.prepare(`
          UPDATE runtime_sessions
          SET sdk_session_id = ?, last_used_at = ?, status = 'active'
          WHERE id = ?
        `).run(conversationId, discoveredUpdatedAt, existingRuntimeSession.id);
        bootstrapped += 1;
      }
    }

    for (const row of missing) {
      const conversationId = row?.id;
      if (!conversationId) continue;
      const latestModel = stmts.getLatestConversationModel.get(conversationId)?.model || null;
      ensureRuntimeSessionBinding(conversationId, latestModel, now);
      bootstrapped += 1;
    }
  });
  tx();
  return bootstrapped;
}

function emitToClientsExceptSessionId(event, payload, sessionId) {
  if (!sessionId) {
    io.emit(event, payload);
    return;
  }

  for (const socket of io.sockets.sockets.values()) {
    if (socket.data?.sessionId === sessionId) continue;
    socket.emit(event, payload);
  }
}

// ─── Web-Client Routes ────────────────────────────────────────────────────────




// ─── CLI Routes ───────────────────────────────────────────────────────────────

function touchCli() {
  cliLastSeen = Date.now();
  relayRestartOrchestrator.noteCliOnline();
  if (!cliOnline) {
    cliOnline = true;
    console.log(`[${ts()}] CLI ONLINE (heartbeat)`);
    io.emit('cli_status', { online: true });
  }
}

// POST /api/heartbeat — CLI sends a ping every poll interval

// ─── Relay Question Routes ────────────────────────────────────────────────────

function questionExpiresAt(createdAt, timeoutMs = DEFAULT_QUESTION_TIMEOUT_MS) {
  const normalizedTimeoutMs = Number.isFinite(Number(timeoutMs))
    ? Math.max(0, Math.trunc(Number(timeoutMs)))
    : DEFAULT_QUESTION_TIMEOUT_MS;
  return new Date(new Date(createdAt).getTime() + normalizedTimeoutMs).toISOString();
}

function sanitizeRelayQuestionPrompt(requestBody) {
  const prompt = String(
    requestBody?.prompt ||
    requestBody?.text ||
    requestBody?.message ||
    requestBody?.question ||
    requestBody?.content ||
    ''
  ).trim();
  if (prompt) return prompt;
  const keys = requestBody && typeof requestBody === 'object' ? Object.keys(requestBody).slice(0, 8) : [];
  return keys.length ? `Clarification needed (${keys.join(', ')})` : 'Clarification needed';
}

function sanitizeRelayQuestionRequest(requestBody) {
  if (!requestBody) return null;
  if (typeof requestBody === 'string') return requestBody;
  if (typeof requestBody !== 'object') return null;
  try {
    return JSON.stringify(requestBody);
  } catch {
    return null;
  }
}

function sanitizeRelayQuestionContext(rawContext) {
  if (!rawContext || typeof rawContext !== 'object' || Array.isArray(rawContext)) return null;
  const context = {};
  if (typeof rawContext.source === 'string' && rawContext.source.trim()) {
    context.source = rawContext.source.trim().slice(0, 64);
  }
  if (typeof rawContext.rationale === 'string' && rawContext.rationale.trim()) {
    context.rationale = rawContext.rationale.trim().slice(0, 240);
  }
  if (typeof rawContext.queueMessageId === 'string' && rawContext.queueMessageId.trim()) {
    context.queueMessageId = rawContext.queueMessageId.trim();
  }
  if (typeof rawContext.conversationId === 'string' && rawContext.conversationId.trim()) {
    context.conversationId = rawContext.conversationId.trim();
  }
  if (typeof rawContext.relayMode === 'string' && rawContext.relayMode.trim()) {
    context.relayMode = normalizeRelayMode(rawContext.relayMode) || DEFAULT_RELAY_MODE;
  }
  return Object.keys(context).length ? context : null;
}


// ─── Socket.io Auth ───────────────────────────────────────────────────────────
io.use((socket, next) => {
  const cookies = parseCookies(socket.request.headers.cookie);
  const token = socket.handshake.auth?.token || socket.handshake.query?.token || cookies[AUTH_COOKIE];
  if (token === config.authToken) return next();
  next(new Error('Unauthorized'));
});

io.engine.on('initial_headers', (headers, req) => {
  const sessionId = ensureSessionId(req);
  headers['Set-Cookie'] = `${SESSION_COOKIE}=${encodeURIComponent(sessionId)}; Path=/; SameSite=Lax`;
});

io.on('connection', (socket) => {
  const cookies = parseCookies(socket.request.headers.cookie);
  socket.data.sessionId = socket.handshake.auth?.clientId || socket.handshake.query?.clientId || cookies[SESSION_COOKIE] || null;
  // Send current CLI status immediately on connect
  socket.emit('cli_status', { online: cliOnline });
});

// ─── SSH Reverse Tunnel ────────────────────────────────────────────────────────
const tunnelConfig = config.sshTunnel || {};
const tunnelRemoteBindMode = String(tunnelConfig.remoteBind || 'loopback').trim().toLowerCase() === 'public'
  ? 'public'
  : 'loopback';
function buildTunnelRemoteForwardSpec(remotePort, localPort) {
  const localTargetHost = '127.0.0.1';
  if (tunnelRemoteBindMode === 'public') {
    return `*:${remotePort}:${localTargetHost}:${localPort}`;
  }
  // SSH default loopback bind is the most compatible for localhost-based reverse proxies.
  return `${remotePort}:${localTargetHost}:${localPort}`;
}
const tunnelEnabled = tunnelConfig.enabled === true
  && typeof tunnelConfig.host === 'string' && tunnelConfig.host.trim()
  && typeof tunnelConfig.user === 'string' && tunnelConfig.user.trim()
  && typeof tunnelConfig.remotePort === 'number' && tunnelConfig.remotePort > 0;

const tunnelState = {
  enabled: tunnelEnabled,
  connected: false,
  host: tunnelConfig.host || null,
  remotePort: tunnelConfig.remotePort || null,
  reconnectAttempts: 0,
  connectedSince: null,
  proc: null,
  backoffTimer: null,
  remoteBindMode: tunnelRemoteBindMode,
};

runtimeState.tunnelState = tunnelState;

function tunnelLog(msg) {
  console.log(`[${ts()}] [ssh-tunnel] ${msg}`);
}

function scheduleTunnelReconnect() {
  if (runtimeShutdownStarted) return;
  const BACKOFF_STEPS = [5_000, 10_000, 20_000, 40_000, 60_000];
  const delay = BACKOFF_STEPS[Math.min(tunnelState.reconnectAttempts, BACKOFF_STEPS.length - 1)];
  tunnelState.reconnectAttempts += 1;
  tunnelLog(`Reconnecting in ${delay / 1000}s (attempt ${tunnelState.reconnectAttempts})...`);
  tunnelState.backoffTimer = setTimeout(spawnSshTunnel, delay);
}

function spawnSshTunnel() {
  if (!tunnelEnabled || runtimeShutdownStarted) return;
  if (tunnelState.proc && tunnelState.proc.exitCode === null) {
    tunnelLog('Spawn skipped: existing tunnel process is still running.');
    return;
  }

  const { user, host, remotePort, identityFile } = tunnelConfig;
  const localPort = config.port || 3333;

  const args = [
    '-N',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'BatchMode=yes',
    '-o', 'ExitOnForwardFailure=yes',
    '-R', buildTunnelRemoteForwardSpec(remotePort, localPort),
  ];
  if (identityFile) args.push('-i', identityFile.replace(/^~/, os.homedir()));
  args.push(`${user}@${host}`);

  tunnelLog(`Spawning: ssh ${args.join(' ')}`);

  const proc = spawn('ssh', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  tunnelState.proc = proc;

  const connectedAt = Date.now();

  proc.stdout.on('data', (d) => tunnelLog(`stdout: ${d.toString().trim()}`));
  proc.stderr.on('data', (d) => tunnelLog(`stderr: ${d.toString().trim()}`));

  proc.on('spawn', () => {
    tunnelState.connected = true;
    tunnelState.connectedSince = new Date().toISOString();
    tunnelLog(`Tunnel up to ${user}@${host} remote port ${remotePort}`);
    io.emit('ssh_tunnel_status', { connected: true, host, remotePort });
  });

  proc.on('error', (e) => {
    tunnelLog(`Error: ${e.message}`);
  });

  proc.on('close', (code) => {
    const wasConnected = tunnelState.connected;
    tunnelState.connected = false;
    tunnelState.connectedSince = null;
    tunnelState.proc = null;
    // Reset backoff counter if connection lived long enough (>30s = stable)
    if (wasConnected && Date.now() - connectedAt > 30_000) {
      tunnelState.reconnectAttempts = 0;
    }
    if (runtimeShutdownStarted) {
      tunnelLog(`Process exited (code=${code}) during shutdown.`);
      return;
    }
    tunnelLog(`Process exited (code=${code}). Scheduling reconnect...`);
    io.emit('ssh_tunnel_status', { connected: false, host, remotePort });
    scheduleTunnelReconnect();
  });
}

function stopSshTunnel() {
  if (tunnelState.backoffTimer) {
    clearTimeout(tunnelState.backoffTimer);
    tunnelState.backoffTimer = null;
  }
  if (tunnelState.proc) {
    try { tunnelState.proc.kill('SIGTERM'); } catch (_) {}
    tunnelState.proc = null;
  }
}

function clearRuntimeTimers() {
  for (const timer of Object.values(runtimeTimers)) {
    if (!timer) continue;
    try { clearInterval(timer); } catch {}
  }
  runtimeTimers.cliStatus = null;
  runtimeTimers.ownerWatchdog = null;
  runtimeTimers.staleRecovery = null;
  runtimeTimers.questionExpiry = null;
  runtimeTimers.shutdownDrain = null;
}

let runtimeShutdownPromise = null;
let runtimeShutdownExitCode = 0;
function shutdownRuntime(reason = 'unknown', { exitCode = 0 } = {}) {
  if (runtimeShutdownPromise) return runtimeShutdownPromise;

  const numericExitCode = Number(exitCode);
  runtimeShutdownExitCode = Number.isInteger(numericExitCode) && numericExitCode >= 0
    ? numericExitCode
    : 0;
  runtimeShutdownStarted = true;
  console.log(`[${ts()}] Runtime shutdown started (${reason}, exitCode=${runtimeShutdownExitCode})`);
  clearRuntimeTimers();
  stopWorkspaceFileWatcher();
  stopSshTunnel();
  try { relaySingletonGuard.release(); } catch (error) {
    console.warn(`[${ts()}] Failed to release singleton lock: ${error?.message || error}`);
  }

  runtimeShutdownPromise = new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
      process.exit(runtimeShutdownExitCode);
    };

    const forceExitTimer = setTimeout(() => {
      console.warn(`[${ts()}] Runtime shutdown timeout reached; forcing exit.`);
      finish();
    }, 2000);
    if (typeof forceExitTimer.unref === 'function') forceExitTimer.unref();

    try { io.close(); } catch {}

    try {
      httpServer.close(() => {
        try { clearTimeout(forceExitTimer); } catch {}
        finish();
      });
    } catch {
      try { clearTimeout(forceExitTimer); } catch {}
      finish();
    }
  });

  return runtimeShutdownPromise;
}

function detectLocalIpv4() {
  let localIp = '<your-pc-ip>';
  try {
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces || {})) {
      for (const iface of (ifaces[name] || [])) {
        if (iface.family === 'IPv4' && !iface.internal) {
          localIp = iface.address;
          return localIp;
        }
      }
    }
  } catch {}
  return localIp;
}

function buildRelayReadyBannerData() {
  const localIp = detectLocalIpv4();
  const localUrl = `http://localhost:${config.port}/`;
  const networkUrl = localhostOnly ? null : `http://${String(localIp).slice(0, 15)}:${config.port}/`;
  const networkText = localhostOnly ? 'disabled (localhost only)' : networkUrl;
  const remoteUrl = tunnelEnabled ? `https://${String(tunnelConfig.host || '').slice(0, 30)}/` : null;
  const pollingUrl = `http://localhost:${config.port}/api/pending`;
  const authText = 'token required';

  return {
    title: 'Copilot Web Proxy  -  Ready',
    localUrl,
    networkUrl,
    networkText,
    remoteUrl,
    remoteBindMode: tunnelRemoteBindMode,
    authText,
    pollingUrl,
    localhostOnly,
    listenHost,
    lines: [
      '╔══════════════════════════════════════════════════════════════╗',
      '║         Copilot Web Proxy  -  Ready                          ║',
      '╠══════════════════════════════════════════════════════════════╣',
      `║  Local:      ${localUrl.padEnd(47)} ║`,
      `║  Network:    ${String(networkText || '').padEnd(47)} ║`,
      ...(remoteUrl ? [`║  Remote:     ${remoteUrl.padEnd(47)} ║`] : []),
      ...(remoteUrl ? [`║  Tunnel:     ${(`mode=${tunnelRemoteBindMode}`).padEnd(47)} ║`] : []),
      `║  Auth:       ${authText.padEnd(47)} ║`,
      '╠══════════════════════════════════════════════════════════════╣',
      '║  CLI polling URL (for monitoring mode):                      ║',
      `║  GET:        ${pollingUrl.padEnd(47)} ║`,
      '╚══════════════════════════════════════════════════════════════╝',
    ],
  };
}

// Graceful shutdown: stop timers/tunnel and release listener deterministically.
process.on('SIGTERM', () => { void shutdownRuntime('SIGTERM'); });
process.on('SIGINT',  () => { void shutdownRuntime('SIGINT'); });
process.on('exit', () => {
  try { relaySingletonGuard.release(); } catch {}
});

// ─── Start ────────────────────────────────────────────────────────────────────
httpServer.on('error', (error) => {
  console.error(`[server] HTTP server failed: ${error?.message || error}`);
  try { relaySingletonGuard.release(); } catch {}
  process.exit(1);
});
httpServer.listen(config.port, listenHost, () => {
  const readyBanner = buildRelayReadyBannerData();
  console.log('');
  for (const line of (readyBanner.lines || [])) {
    console.log(line);
  }
  console.log('\nCLI status: waiting for first heartbeat...\n');

  // Start SSH tunnel after server is listening
  if (tunnelEnabled) {
    tunnelLog(`SSH tunnel enabled (${tunnelRemoteBindMode}) to ${tunnelConfig.user}@${tunnelConfig.host}:${tunnelConfig.remotePort}`);
    spawnSshTunnel();
  }
});
