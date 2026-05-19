'use strict';

import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import { execFile, spawn } from 'child_process';
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Config ────────────────────────────────────────────────────────────────────
const CONFIG_PATH    = path.join(__dirname, 'config.json');
const DATA_DIR       = path.join(__dirname, 'data');
const DB_PATH        = path.join(DATA_DIR, 'copilot.db');
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
const DEFAULT_QUESTION_TIMEOUT_MS = 5 * 60 * 1000;
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
const DRIVE_BROWSE_TYPES = new Set([2, 3]); // removable + fixed
const DRIVE_TYPE_LABELS = Object.freeze({
  2: 'removable',
  3: 'fixed',
  4: 'network',
});
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

const MAX_REQUEUE_RETRIES = Number.isFinite(Number(config.maxRequeueRetries))
  ? Math.max(1, Number(config.maxRequeueRetries))
  : 5;

const processingTimeoutMs = Number(config.processingTimeoutMs) > 0
  ? Number(config.processingTimeoutMs)
  : DEFAULT_PROCESSING_TIMEOUT_MS;
const localhostOnly = config.localhostOnly === true || String(config.localhostOnly || '').trim().toLowerCase() === 'true';
const listenHost = localhostOnly ? '127.0.0.1' : '0.0.0.0';
const OFFLINE_STALE_RECOVER_MS = 45_000;
let runtimeShutdownStarted = false;
const runtimeTimers = {
  cliStatus: null,
  ownerWatchdog: null,
  staleRecovery: null,
  questionExpiry: null,
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

function maybeApplyWorkspaceRootFromMessage(text) {
  const target = parseCdCommandTarget(text);
  if (!target) return { attempted: false, changed: false };
  if (WORKSPACE_ROOT_LOCKED) {
    return {
      attempted: true,
      changed: false,
      target,
      error: `Workspace root is locked to startup directory: ${currentWorkspaceRootPath()}`,
    };
  }
  const resolvedPath = resolveCdCommandPath(target, currentWorkspaceRootPath());
  if (!resolvedPath) {
    return {
      attempted: true,
      changed: false,
      target,
      error: 'Unable to resolve directory path',
    };
  }
  const update = applyWorkspaceRoot(resolvedPath, { reason: 'chat-cd-command' });
  return {
    attempted: true,
    changed: !!update.changed,
    target,
    rootPath: update.rootPath || null,
    rootName: update.rootName || null,
    error: update.error || null,
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
    archived   INTEGER NOT NULL DEFAULT 0,
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
    response            TEXT,
    retry_count         INTEGER NOT NULL DEFAULT 0,
    next_attempt_at     TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_queue_status ON queue(status, timestamp);

  CREATE TABLE IF NOT EXISTS runtime_sessions (
    id              TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL UNIQUE,
    strategy        TEXT NOT NULL DEFAULT 'isolated',
    runtime_key     TEXT NOT NULL,
    model           TEXT,
    status          TEXT NOT NULL DEFAULT 'active',
    created_at      TEXT NOT NULL,
    last_used_at    TEXT NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_runtime_sessions_last_used ON runtime_sessions(last_used_at DESC);

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
    created_at      TEXT NOT NULL,
    answered_at     TEXT,
    expires_at      TEXT NOT NULL,
    FOREIGN KEY (queue_id) REFERENCES queue(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_relay_questions_status ON relay_questions(status, expires_at, created_at);
  CREATE INDEX IF NOT EXISTS idx_relay_questions_conversation ON relay_questions(conversation_id, status, created_at);

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
db.exec(`UPDATE queue SET relay_mode = 'agent' WHERE relay_mode IS NULL OR relay_mode = ''`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_queue_next_attempt ON queue(status, next_attempt_at, timestamp)`);

const runtimeSessionColumns = db.prepare(`PRAGMA table_info(runtime_sessions)`).all().map((c) => c.name);
if (runtimeSessionColumns.length) {
  if (!runtimeSessionColumns.includes('strategy')) {
    db.exec(`ALTER TABLE runtime_sessions ADD COLUMN strategy TEXT NOT NULL DEFAULT 'isolated'`);
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

// ─── Prepared Statements ──────────────────────────────────────────────────────
const stmts = {
  // conversations
  getConv:        db.prepare(`SELECT * FROM conversations WHERE id = ?`),
  listConvIdsMissingRuntimeSession: db.prepare(`SELECT c.id AS id FROM conversations c LEFT JOIN runtime_sessions rs ON rs.conversation_id = c.id WHERE rs.id IS NULL`),
  listConvs:      db.prepare(`SELECT c.id, c.title, c.archived, c.compacted_into, c.compacted_from, c.created_at, c.updated_at, rs.id AS runtime_session_id, rs.strategy AS runtime_strategy, rs.status AS runtime_status, rs.last_used_at AS runtime_last_used_at, COUNT(m.id) as message_count FROM conversations c LEFT JOIN messages m ON m.conversation_id = c.id LEFT JOIN runtime_sessions rs ON rs.conversation_id = c.id GROUP BY c.id ORDER BY c.updated_at DESC`),
  insertConv:     db.prepare(`INSERT OR IGNORE INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`),
  updateConvTime: db.prepare(`UPDATE conversations SET updated_at = ? WHERE id = ?`),
  updateConvSeed: db.prepare(`UPDATE conversations SET summary_seed = ?, seed_pending = ?, compacted_from = ?, updated_at = ? WHERE id = ?`),
  markConvCompacted: db.prepare(`UPDATE conversations SET archived = 1, compacted_into = ?, updated_at = ? WHERE id = ?`),
  getConvSeed:    db.prepare(`SELECT summary_seed, seed_pending FROM conversations WHERE id = ?`),
  clearConvSeed:  db.prepare(`UPDATE conversations SET seed_pending = 0, updated_at = ? WHERE id = ?`),
  deleteConv:     db.prepare(`DELETE FROM conversations WHERE id = ?`),

  // messages
  getMessages:    db.prepare(`SELECT * FROM messages WHERE conversation_id = ? ORDER BY timestamp ASC`),
  getLatestConversationModel: db.prepare(`SELECT model FROM messages WHERE conversation_id = ? AND model IS NOT NULL AND model != '' ORDER BY timestamp DESC LIMIT 1`),
  getRecentMessagesDesc: db.prepare(`SELECT role, text, timestamp FROM messages WHERE conversation_id = ? ORDER BY timestamp DESC LIMIT ?`),
  insertMsg:      db.prepare(`INSERT INTO messages (id, conversation_id, role, text, model, mode, attachments, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),

  // queue
  insertQ:        db.prepare(`INSERT INTO queue (id, conversation_id, runtime_session_id, is_new_conversation, model, relay_mode, text, attachments, status, timestamp, retry_count, next_attempt_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, 0, NULL)`),
  findPending:    db.prepare(`SELECT * FROM queue WHERE status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY retry_count ASC, CASE WHEN next_attempt_at IS NULL THEN 0 ELSE 1 END ASC, COALESCE(next_attempt_at, timestamp) ASC, timestamp ASC LIMIT 1`),
  countStatus:    db.prepare(`SELECT status, COUNT(*) as cnt FROM queue WHERE status IN ('pending','processing') GROUP BY status`),
  countRuntimeSessions: db.prepare(`SELECT COUNT(*) AS cnt FROM runtime_sessions WHERE status = 'active'`),
  setProcessing:  db.prepare(`UPDATE queue SET status = 'processing', processing_at = ? WHERE id = ?`),
  setQueueRuntimeSession: db.prepare(`UPDATE queue SET runtime_session_id = ? WHERE id = ?`),
  setDone:        db.prepare(`UPDATE queue SET status = 'done', response = ?, processing_at = NULL, next_attempt_at = NULL WHERE id = ? AND status IN ('processing', 'pending')`),
  setFailed:      db.prepare(`UPDATE queue SET status = 'failed', response = ?, processing_at = NULL, next_attempt_at = NULL WHERE id = ?`),
  deleteConvQ:    db.prepare(`DELETE FROM queue WHERE conversation_id = ?`),
  findQById:      db.prepare(`SELECT * FROM queue WHERE id = ?`),
  pruneQueue:     db.prepare(`DELETE FROM queue WHERE status = 'done' AND id NOT IN (SELECT id FROM queue WHERE status = 'done' ORDER BY timestamp DESC LIMIT 200)`),
  recoverStale:   db.prepare(`UPDATE queue SET status = 'pending', processing_at = NULL, next_attempt_at = ? WHERE status = 'processing' AND processing_at < ?`),
  listRecoverableProcessing: db.prepare(`SELECT id, conversation_id FROM queue WHERE status = 'processing' AND processing_at < ?`),
  recoverProcessingBefore: db.prepare(`UPDATE queue SET status = 'pending', processing_at = NULL, next_attempt_at = ? WHERE status = 'processing' AND processing_at < ?`),
  listQueueForPauseDrop: db.prepare(`SELECT id, conversation_id FROM queue WHERE status IN ('pending', 'processing')`),
  deleteQueueById: db.prepare(`DELETE FROM queue WHERE id = ?`),
  getLatestProcessingQueueByConversation: db.prepare(`SELECT id, relay_mode, timestamp, processing_at FROM queue WHERE conversation_id = ? AND status = 'processing' ORDER BY COALESCE(processing_at, timestamp) DESC LIMIT 1`),

  // runtime sessions
  getRuntimeSessionByConversation: db.prepare(`SELECT * FROM runtime_sessions WHERE conversation_id = ?`),
  getRuntimeSessionById: db.prepare(`SELECT * FROM runtime_sessions WHERE id = ?`),
  listRuntimeSessions: db.prepare(`SELECT rs.*, c.title AS conversation_title, c.updated_at AS conversation_updated_at FROM runtime_sessions rs LEFT JOIN conversations c ON c.id = rs.conversation_id ORDER BY rs.last_used_at DESC`),
  insertRuntimeSession: db.prepare(`INSERT INTO runtime_sessions (id, conversation_id, strategy, runtime_key, model, status, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`),
  touchRuntimeSession: db.prepare(`UPDATE runtime_sessions SET model = ?, last_used_at = ?, status = 'active' WHERE id = ?`),
  deleteRuntimeSessionByConversation: db.prepare(`DELETE FROM runtime_sessions WHERE conversation_id = ?`),

  // relay questions
  insertQuestion: db.prepare(`INSERT INTO relay_questions (id, queue_id, conversation_id, message_id, relay_mode, prompt, choices, request, status, answer, created_at, answered_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, NULL, ?)`),
  getQuestion:    db.prepare(`SELECT * FROM relay_questions WHERE id = ?`),
  findPendingQuestionByMessage: db.prepare(`SELECT * FROM relay_questions WHERE message_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1`),
  listQuestions:  db.prepare(`SELECT * FROM relay_questions WHERE status = ? AND (? IS NULL OR conversation_id = ?) ORDER BY created_at ASC`),
  answerQuestion: db.prepare(`UPDATE relay_questions SET status = 'answered', answer = ?, answered_at = ? WHERE id = ? AND status = 'pending'`),
  timeoutQuestion:db.prepare(`UPDATE relay_questions SET status = 'timed_out' WHERE id = ? AND status = 'pending'`),
  deleteConvQuestions: db.prepare(`DELETE FROM relay_questions WHERE conversation_id = ?`),
  expireQuestions: db.prepare(`UPDATE relay_questions SET status = 'timed_out' WHERE status = 'pending' AND expires_at < ?`),

  // relay activity
  insertActivity: db.prepare(`INSERT INTO relay_activity (queue_message_id, response_message_id, conversation_id, relay_mode, text, created_at) VALUES (?, NULL, ?, ?, ?, ?)`),
  linkActivityToResponse: db.prepare(`UPDATE relay_activity SET response_message_id = ? WHERE queue_message_id = ? AND response_message_id IS NULL`),
  listActivityByResponse: db.prepare(`SELECT text FROM relay_activity WHERE response_message_id = ? ORDER BY id ASC`),
  listActivityByQueueMessage: db.prepare(`SELECT text FROM relay_activity WHERE queue_message_id = ? ORDER BY id ASC`),
  deleteConvActivity: db.prepare(`DELETE FROM relay_activity WHERE conversation_id = ?`),

  // uploads
  getUploadFile: db.prepare(`SELECT * FROM uploaded_files WHERE sha256 = ?`),
  insertUploadFile: db.prepare(`INSERT OR IGNORE INTO uploaded_files (sha256, original_name, mime_type, size_bytes, created_at) VALUES (?, ?, ?, ?, ?)`),
  insertUploadRef: db.prepare(`INSERT OR IGNORE INTO upload_refs (file_sha256, conversation_id, message_id, created_at) VALUES (?, ?, ?, ?)`),
  listUploadHashesByConversation: db.prepare(`SELECT DISTINCT file_sha256 FROM upload_refs WHERE conversation_id = ?`),
  deleteUploadRefsByConversation: db.prepare(`DELETE FROM upload_refs WHERE conversation_id = ?`),
  countUploadRefsBySha: db.prepare(`SELECT COUNT(*) AS cnt FROM upload_refs WHERE file_sha256 = ?`),
  deleteUploadFile: db.prepare(`DELETE FROM uploaded_files WHERE sha256 = ?`),
};

function queueCounts() {
  const rows = stmts.countStatus.all();
  const map = Object.fromEntries(rows.map(r => [r.status, r.cnt]));
  return { pendingCount: map.pending || 0, processingCount: map.processing || 0 };
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

function findLatestSessionEventsPath(root) {
  if (!root || !fs.existsSync(root)) return null;
  let latestPath = null;
  let latestMtime = 0;
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(root, entry.name, 'events.jsonl');
    if (!fs.existsSync(candidate)) continue;
    let stat = null;
    try { stat = fs.statSync(candidate); } catch { continue; }
    const mtime = Number(stat?.mtimeMs || 0);
    if (mtime > latestMtime) {
      latestMtime = mtime;
      latestPath = candidate;
    }
  }
  return latestPath;
}

function extractSessionIdFromEventsPath(eventsPath) {
  const parent = path.basename(path.dirname(String(eventsPath || '')));
  return parent || null;
}

function readContextFromSessionEvents(runtimeSessionId) {
  const sessionId = String(runtimeSessionId || '').trim();
  if (!sessionId) return { snapshot: null, eventsPath: null, error: 'Missing runtime session ID' };
  const root = resolveSessionStateRoot();
  const expectedEventsPath = path.join(root, sessionId, 'events.jsonl');
  let eventsPath = expectedEventsPath;
  let lookupWarning = null;
  if (!fs.existsSync(eventsPath)) {
    const latestEventsPath = findLatestSessionEventsPath(root);
    if (!latestEventsPath) {
      return { snapshot: null, eventsPath, error: `Session events file not found at ${expectedEventsPath}` };
    }
    eventsPath = latestEventsPath;
    lookupWarning = `Session events file not found for runtime ID ${sessionId}; using latest session events file instead.`;
  }

  let content = '';
  try {
    content = fs.readFileSync(eventsPath, 'utf8');
  } catch (e) {
    return { snapshot: null, eventsPath, error: `Failed reading events file: ${e?.message || String(e)}` };
  }

  const lines = String(content || '').split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    let event = null;
    try { event = JSON.parse(line); } catch { continue; }
    const data = event?.data && typeof event.data === 'object' ? event.data : null;
    if (!data) continue;
    const hasContextFields =
      Number.isFinite(Number(data.currentTokens)) ||
      Number.isFinite(Number(data.systemTokens)) ||
      Number.isFinite(Number(data.conversationTokens)) ||
      Number.isFinite(Number(data.toolDefinitionsTokens));
    if (!hasContextFields) continue;

    const currentModel = String(data.currentModel || '').trim() || null;
    const copilotSessionId = extractSessionIdFromEventsPath(eventsPath) || sessionId;
    const modelUsage = currentModel && data.modelMetrics?.[currentModel]?.usage && typeof data.modelMetrics[currentModel].usage === 'object'
      ? data.modelMetrics[currentModel].usage
      : null;
    return {
      eventsPath,
      error: lookupWarning,
      snapshot: {
        runtime_session_id: sessionId,
        copilot_session_id: copilotSessionId,
        model: currentModel,
        used_total_tokens: toNullableInt(data.currentTokens),
        system_tokens: toNullableInt(data.systemTokens),
        messages_tokens: toNullableInt(data.conversationTokens),
        tools_tokens: toNullableInt(data.toolDefinitionsTokens),
        used_prompt_tokens: toNullableInt(modelUsage?.inputTokens),
        used_completion_tokens: toNullableInt(modelUsage?.outputTokens),
        reasoning_tokens: toNullableInt(modelUsage?.reasoningTokens),
        cache_read_tokens: toNullableInt(modelUsage?.cacheReadTokens),
        cache_write_tokens: toNullableInt(modelUsage?.cacheWriteTokens),
        captured_at: String(event.timestamp || '').trim() || null,
      },
    };
  }

  return { snapshot: null, eventsPath, error: 'No context-bearing events found for this session' };
}

function buildContextResponseText({ snapshot, runtimeSession, conversationId, eventsPath, error }) {
  if (!snapshot) {
    const fallbackModel = String(runtimeSession?.model || '').trim() || 'unavailable';
    const fallbackSessionId = String(runtimeSession?.id || '').trim() || 'unavailable';
    return [
      '### Context window snapshot',
      '',
      '| Field | Value |',
      '|---|---|',
      `| Conversation ID | \`${conversationId}\` |`,
      `| Runtime session ID | \`${fallbackSessionId}\` |`,
      `| Copilot session ID | unavailable |`,
      `| Model | \`${fallbackModel}\` |`,
      '| Used tokens | unavailable |',
      '| Context limit | unavailable |',
      '| Usage | unavailable |',
      '| Free buffer | unavailable |',
      '| Prompt/input tokens | unavailable |',
      '| Completion/output tokens | unavailable |',
      '| Reasoning tokens | unavailable |',
      '| Cache read tokens | unavailable |',
      '| Cache write tokens | unavailable |',
      '| System tokens | unavailable |',
      '| Tools tokens | unavailable |',
      '| Messages tokens | unavailable |',
      '| Captured at | unavailable |',
      `| Events source | \`${contextField(eventsPath)}\` |`,
      `| Note | ${contextField(error)} |`,
      '',
      '_No context event snapshot available for this session yet._',
    ].join('\n');
  }

  const runtimeSessionId = contextField(snapshot.runtime_session_id || runtimeSession?.id);
  return [
    '### Context window snapshot',
    '',
    '| Field | Value |',
    '|---|---|',
    `| Conversation ID | \`${conversationId}\` |`,
    `| Runtime session ID | \`${runtimeSessionId}\` |`,
    `| Copilot session ID | \`${contextField(snapshot.copilot_session_id)}\` |`,
    `| Model | \`${contextField(snapshot.model || runtimeSession?.model)}\` |`,
    `| Used tokens | ${formatCount(snapshot.used_total_tokens)} |`,
    `| Context limit | ${formatCount(snapshot.max_context_tokens)} |`,
    `| Usage | ${formatPercent(snapshot.used_percent)} |`,
    `| Free buffer | ${formatCount(snapshot.free_tokens)} |`,
    `| Prompt/input tokens | ${formatCount(snapshot.used_prompt_tokens)} |`,
    `| Completion/output tokens | ${formatCount(snapshot.used_completion_tokens)} |`,
    `| Reasoning tokens | ${formatCount(snapshot.reasoning_tokens)} |`,
    `| Cache read tokens | ${formatCount(snapshot.cache_read_tokens)} |`,
    `| Cache write tokens | ${formatCount(snapshot.cache_write_tokens)} |`,
    `| System tokens | ${formatCount(snapshot.system_tokens)} |`,
    `| Tools tokens | ${formatCount(snapshot.tools_tokens)} |`,
    `| Messages tokens | ${formatCount(snapshot.messages_tokens)} |`,
    `| Captured at | ${contextField(snapshot.captured_at)} |`,
    `| Events source | \`${contextField(eventsPath)}\` |`,
    `| Note | ${contextField(error)} |`,
    '',
    '_Values are read from Copilot session-state events (`events.jsonl`). Missing fields are shown as unavailable._',
  ].join('\n');
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

function resolveWorkspaceFilePath(rawPath) {
  const normalized = normalizeWorkspaceRelativePath(rawPath);
  if (!normalized) return null;
  const activeWorkspaceRoot = currentWorkspaceRootPath();
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
  const psScript = [
    '$drives = Get-CimInstance Win32_LogicalDisk',
    '| Where-Object { $_.DriveType -in 2,3 }',
    '| Sort-Object DeviceID',
    '| ForEach-Object {',
    '  [pscustomobject]@{',
    '    drive = [string]$_.DeviceID;',
    '    label = [string]$_.VolumeName;',
    '    driveType = [int]$_.DriveType;',
    '    sizeBytes = [int64]$_.Size;',
    '    freeBytes = [int64]$_.FreeSpace;',
    '  }',
    '};',
    '$drives | ConvertTo-Json -Depth 4 -Compress',
  ].join(' ');

  execFile('powershell.exe', ['-NoProfile', '-Command', psScript], (err, stdout, stderr) => {
    if (err) return cb(new Error(`drive enumeration failed: ${stderr || err.message}`));

    const text = String(stdout || '').trim();
    if (!text) return cb(null, []);

    try {
      const parsed = JSON.parse(text);
      const list = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
      const drives = list
        .map((item) => {
          const driveId = String(item?.drive || '').trim().toUpperCase();
          if (!/^[A-Z]:$/.test(driveId)) return null;
          const driveTypeNumber = Number(item?.driveType || 0);
          if (!DRIVE_BROWSE_TYPES.has(driveTypeNumber)) return null;
          const rootAbsolute = `${driveId}\\`;
          return {
            drive: driveId,
            rootAbsolute,
            webPath: toDriveWebPath(rootAbsolute),
            label: item?.label ? String(item.label) : '',
            driveType: DRIVE_TYPE_LABELS[driveTypeNumber] || 'unknown',
            sizeBytes: Number(item?.sizeBytes || 0),
            freeBytes: Number(item?.freeBytes || 0),
          };
        })
        .filter(Boolean);
      cb(null, drives);
    } catch (parseErr) {
      cb(new Error(`drive enumeration parse failed: ${parseErr.message}`));
    }
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

  execFile('powershell.exe', ['-NoProfile', '-Command', psScript], (err, stdout, stderr) => {
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

function buildRepositoryTreeSnapshot({ includeHidden = false, includeHeavy = false, maxNodes = MAX_REPO_TREE_NODES } = {}) {
  const activeWorkspaceRoot = currentWorkspaceRootPath();
  const activeWorkspaceRootName = currentWorkspaceRootName();
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

function inFlightStateForConversation(conversationId) {
  const row = stmts.getLatestProcessingQueueByConversation.get(conversationId);
  if (!row) return null;
  return {
    messageId: row.id,
    status: 'processing',
    mode: normalizeRelayMode(row.relay_mode) || DEFAULT_RELAY_MODE,
    timestamp: row.timestamp || null,
    processingAt: row.processing_at || null,
    activities: relayActivityForQueueMessage(row.id),
  };
}

function recoverProcessingOlderThan(cutoffIso, requeueAtIso) {
  const rows = stmts.listRecoverableProcessing.all(cutoffIso);
  if (!rows.length) return [];

  const tx = db.transaction(() => {
    stmts.recoverProcessingBefore.run(requeueAtIso, cutoffIso);
  });
  tx();

  for (const row of rows) {
    io.emit('message_status', { messageId: row.id, conversationId: row.conversation_id, status: 'pending' });
  }
  io.emit('queue_updated', { recovered: rows.length });
  return rows;
}

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

function checkCliStatus() {
  const wasOnline = cliOnline;
  cliOnline = cliLastSeen !== null && (Date.now() - cliLastSeen) < 10_000;
  if (wasOnline !== cliOnline) {
    console.log(`[${ts()}] CLI ${cliOnline ? 'ONLINE' : 'OFFLINE'}`);
    io.emit('cli_status', { online: cliOnline });
  }
}
runtimeTimers.cliStatus = setInterval(checkCliStatus, 2000);

function ownerProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

if (managedOwnerPid) {
  runtimeTimers.ownerWatchdog = setInterval(() => {
    if (ownerProcessAlive(managedOwnerPid)) return;
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

function ensureRuntimeSessionBinding(conversationId, model, nowIso = new Date().toISOString()) {
  const normalizedModel = String(model || '').trim() || null;
  const existing = stmts.getRuntimeSessionByConversation.get(conversationId);
  if (existing?.id) {
    stmts.touchRuntimeSession.run(normalizedModel, nowIso, existing.id);
    return stmts.getRuntimeSessionById.get(existing.id);
  }

  const runtimeSessionId = uuidv4();
  const strategy = configuredConversationSessionMode;
  const runtimeKey = runtimeSessionId;
  stmts.insertRuntimeSession.run(
    runtimeSessionId,
    conversationId,
    strategy,
    runtimeKey,
    normalizedModel,
    nowIso,
    nowIso,
  );
  return stmts.getRuntimeSessionById.get(runtimeSessionId);
}

function bootstrapRuntimeSessionBindings() {
  const missing = stmts.listConvIdsMissingRuntimeSession.all();
  if (!missing.length) return 0;
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    for (const row of missing) {
      const conversationId = row?.id;
      if (!conversationId) continue;
      const latestModel = stmts.getLatestConversationModel.get(conversationId)?.model || null;
      ensureRuntimeSessionBinding(conversationId, latestModel, now);
    }
  });
  tx();
  return missing.length;
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

app.post('/api/upload', auth, express.raw({ type: () => true, limit: `${MAX_UPLOAD_BYTES}b` }), (req, res) => {
  const payload = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!payload.length) return res.status(400).json({ error: 'Empty upload payload' });
  if (payload.length > MAX_UPLOAD_BYTES) return res.status(400).json({ error: 'Uploaded file too large' });

  const rawNameHeader = String(req.headers['x-file-name'] || req.query.name || '').trim();
  let decodedName = '';
  try { decodedName = decodeURIComponent(rawNameHeader); } catch { decodedName = rawNameHeader; }
  const fileName = decodedName || `upload-${Date.now()}`;
  const fileType = String(req.headers['x-file-type'] || req.headers['content-type'] || req.query.type || 'application/octet-stream').trim().toLowerCase();

  try {
    const attachment = persistUploadBuffer(payload, { name: fileName, type: fileType });
    if (!attachment) return res.status(500).json({ error: 'Upload persistence failed' });
    res.json({ ok: true, attachment });
  } catch (e) {
    res.status(400).json({ error: e?.message || 'Upload failed' });
  }
});

app.get('/api/upload/:sha256/content', auth, (req, res) => {
  const sha256 = String(req.params.sha256 || '').trim().toLowerCase();
  if (!isSha256(sha256)) return res.status(400).json({ error: 'Invalid file id' });
  const file = stmts.getUploadFile.get(sha256);
  if (!file) return res.status(404).json({ error: 'Not found' });
  const filePath = uploadPathForSha(sha256);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Missing file on disk' });
  res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  fs.createReadStream(filePath).pipe(res);
});

app.get('/api/files/*', auth, (req, res) => {
  const requestedPath = String(req.params?.[0] || '').trim();
  const filePath = resolveWorkspaceFilePath(requestedPath);
  if (!filePath) return res.status(400).json({ error: 'Invalid file path' });

  let meta = null;
  try {
    meta = readWorkspaceFileMeta(filePath);
  } catch (error) {
    return res.status(500).json({ error: error?.message || 'Failed to read file metadata' });
  }

  if (!meta || meta.kind === 'missing') return res.status(404).json({ error: 'File not found' });
  if (meta.kind !== 'file') return res.status(400).json({ error: 'Path must reference a file' });

  const safeName = path.basename(filePath).replace(/"/g, '');
  res.setHeader('Content-Type', meta.contentType);
  res.setHeader('Content-Length', String(meta.size));
  res.setHeader('Content-Disposition', `inline; filename="${safeName}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  const stream = fs.createReadStream(filePath);
  stream.on('error', (error) => {
    workspaceFileMetaCache.delete(filePath);
    if (res.headersSent) {
      res.destroy(error);
      return;
    }
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      res.status(404).json({ error: 'File not found' });
      return;
    }
    res.status(500).json({ error: 'Failed to read file' });
  });
  stream.pipe(res);
});

app.get('/api/files-preview/*', auth, (req, res) => {
  const requestedPath = String(req.params?.[0] || '').trim();
  const normalizedPath = normalizeWorkspaceRelativePath(requestedPath);
  const filePath = resolveWorkspaceFilePath(requestedPath);
  if (!filePath || !normalizedPath) return res.status(400).json({ error: 'Invalid file path' });

  let meta = null;
  try {
    meta = readWorkspaceFileMeta(filePath);
  } catch (error) {
    return res.status(500).json({ error: error?.message || 'Failed to read file metadata' });
  }

  if (!meta || meta.kind === 'missing') return res.status(404).json({ error: 'File not found' });
  if (meta.kind !== 'file') return res.status(400).json({ error: 'Path must reference a file' });

  const ext = path.extname(filePath).toLowerCase();
  const size = Number(meta.size || 0);
  const contentType = meta.contentType || workspaceContentType(filePath);
  const language = previewLanguageForWorkspaceFile(filePath);

  let previewBuffer = Buffer.alloc(0);
  try {
    previewBuffer = readWorkspaceFilePreviewBuffer(filePath, size);
  } catch (error) {
    workspaceFileMetaCache.delete(filePath);
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      return res.status(404).json({ error: 'File not found' });
    }
    return res.status(500).json({ error: 'Failed to read file' });
  }

  const truncated = size > MAX_WORKSPACE_PREVIEW_BYTES;
  const contentBuffer = truncated
    ? previewBuffer.subarray(0, Math.min(previewBuffer.length, MAX_WORKSPACE_PREVIEW_BYTES))
    : previewBuffer;

  const likelyBinaryType = contentType === 'application/pdf'
    || contentType === 'application/octet-stream';
  const likelyBinaryBytes = isLikelyBinaryPreviewBuffer(contentBuffer);
  const likelyTextType = isLikelyTextContentType(contentType);

  let kind = workspacePreviewKindForMeta(ext, contentType);
  if ((kind === 'markdown' || kind === 'code' || kind === 'text') && likelyBinaryType) {
    kind = 'binary';
  } else if ((kind === 'markdown' || kind === 'code' || kind === 'text') && (!likelyTextType && likelyBinaryBytes)) {
    kind = 'binary';
  }

  const normalizedWebPath = normalizedPath.replace(/\\/g, '/');
  const payload = {
    ok: true,
    path: normalizedWebPath,
    name: path.basename(filePath),
    kind,
    language,
    contentType,
    size,
    truncated,
    previewBytes: contentBuffer.length,
    rawUrl: `${remotePath}/api/files/${normalizedWebPath.split('/').map((part) => encodeURIComponent(part)).join('/')}`,
  };

  if (kind !== 'binary' && kind !== 'image') {
    payload.content = contentBuffer.toString('utf8');
  }

  res.setHeader('Cache-Control', 'no-store');
  res.json(payload);
});

app.get('/api/repo/tree', auth, (req, res) => {
  const includeHidden = parseBooleanQueryFlag(req.query.includeHidden, false);
  const includeHeavy = parseBooleanQueryFlag(req.query.includeHeavy, false);
  const snapshot = buildRepositoryTreeSnapshot({ includeHidden, includeHeavy, maxNodes: MAX_REPO_TREE_NODES });
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    ok: true,
    ...snapshot,
  });
});

app.get('/api/drives/roots', auth, (req, res) => {
  fetchBrowsableDrives((err, drives) => {
    if (err) return res.status(500).json({ error: err.message || 'Failed to enumerate drives' });
    const root = {
      path: '',
      name: 'Drives',
      type: 'dir',
      children: drives.map((drive) => ({
        path: drive.webPath,
        name: driveDisplayName(drive),
        type: 'dir',
        driveType: drive.driveType,
        label: drive.label || '',
        sizeBytes: drive.sizeBytes,
        freeBytes: drive.freeBytes,
        children: [],
        lazy: true,
        childrenLoaded: false,
      })),
      childrenLoaded: true,
    };
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      ok: true,
      root,
      nodeCount: root.children.length + 1,
      truncated: false,
      maxNodes: root.children.length + 1,
      includeHidden: false,
      includeHeavy: false,
      rootName: 'Drives',
      driveTypes: ['fixed', 'removable'],
    });
  });
});

app.get('/api/drives/list', auth, (req, res) => {
  const includeHidden = parseBooleanQueryFlag(req.query.includeHidden, false);
  const requestedPath = String(req.query.path || '').trim();

  fetchBrowsableDrives((drivesErr, drives) => {
    if (drivesErr) return res.status(500).json({ error: drivesErr.message || 'Failed to enumerate drives' });
    const allowedRoots = new Set(drives.map((drive) => drive.rootAbsolute.toUpperCase()));
    const absolutePath = normalizeDriveAbsolutePath(requestedPath);
    const rootAbsolute = driveRootFromAbsolutePath(absolutePath).toUpperCase();
    if (!absolutePath || !rootAbsolute || !allowedRoots.has(rootAbsolute)) {
      return res.status(400).json({ error: 'Invalid drive path' });
    }

    let stat = null;
    try {
      stat = fs.statSync(absolutePath);
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return res.status(404).json({ error: 'Path not found' });
      return res.status(500).json({ error: error?.message || 'Failed to read path metadata' });
    }
    if (!stat.isDirectory()) return res.status(400).json({ error: 'Path must reference a directory' });

    fetchDriveDirectoryEntries(absolutePath, { includeHidden }, (listErr, entries) => {
      if (listErr) return res.status(500).json({ error: listErr.message || 'Failed to list directory' });
      const children = entries
        .map(mapDriveDirectoryEntry)
        .filter((entry) => {
          if (!entry?.path) return false;
          const entryRoot = driveRootFromAbsolutePath(entry.path).toUpperCase();
          return allowedRoots.has(entryRoot);
        });
      const driveMeta = drives.find((drive) => drive.rootAbsolute.toUpperCase() === rootAbsolute);
      const nodePath = toDriveWebPath(absolutePath);
      const node = {
        path: nodePath,
        name: absolutePath.length <= 3 ? driveDisplayName(driveMeta) : (path.win32.basename(absolutePath) || nodePath),
        type: 'dir',
        driveType: driveMeta?.driveType || null,
        label: driveMeta?.label || '',
        children,
        childrenLoaded: true,
      };
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        ok: true,
        node,
        includeHidden,
      });
    });
  });
});

app.get('/api/drives/file', auth, (req, res) => {
  const requestedPath = String(req.query.path || '').trim();
  fetchBrowsableDrives((drivesErr, drives) => {
    if (drivesErr) return res.status(500).json({ error: drivesErr.message || 'Failed to enumerate drives' });
    const allowedRoots = new Set(drives.map((drive) => drive.rootAbsolute.toUpperCase()));
    const filePath = normalizeDriveAbsolutePath(requestedPath);
    const rootAbsolute = driveRootFromAbsolutePath(filePath).toUpperCase();
    if (!filePath || !rootAbsolute || !allowedRoots.has(rootAbsolute)) {
      return res.status(400).json({ error: 'Invalid drive file path' });
    }

    let meta = null;
    try {
      meta = readWorkspaceFileMeta(filePath);
    } catch (error) {
      return res.status(500).json({ error: error?.message || 'Failed to read file metadata' });
    }

    if (!meta || meta.kind === 'missing') return res.status(404).json({ error: 'File not found' });
    if (meta.kind !== 'file') return res.status(400).json({ error: 'Path must reference a file' });

    const safeName = path.win32.basename(filePath).replace(/"/g, '');
    res.setHeader('Content-Type', meta.contentType);
    res.setHeader('Content-Length', String(meta.size));
    res.setHeader('Content-Disposition', `inline; filename="${safeName}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    const stream = fs.createReadStream(filePath);
    stream.on('error', (error) => {
      workspaceFileMetaCache.delete(filePath);
      if (res.headersSent) {
        res.destroy(error);
        return;
      }
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
        res.status(404).json({ error: 'File not found' });
        return;
      }
      res.status(500).json({ error: 'Failed to read file' });
    });
    stream.pipe(res);
  });
});

app.get('/api/drives/files-preview', auth, (req, res) => {
  const requestedPath = String(req.query.path || '').trim();
  fetchBrowsableDrives((drivesErr, drives) => {
    if (drivesErr) return res.status(500).json({ error: drivesErr.message || 'Failed to enumerate drives' });
    const allowedRoots = new Set(drives.map((drive) => drive.rootAbsolute.toUpperCase()));
    const filePath = normalizeDriveAbsolutePath(requestedPath);
    const rootAbsolute = driveRootFromAbsolutePath(filePath).toUpperCase();
    if (!filePath || !rootAbsolute || !allowedRoots.has(rootAbsolute)) {
      return res.status(400).json({ error: 'Invalid drive file path' });
    }

    let meta = null;
    try {
      meta = readWorkspaceFileMeta(filePath);
    } catch (error) {
      return res.status(500).json({ error: error?.message || 'Failed to read file metadata' });
    }

    if (!meta || meta.kind === 'missing') return res.status(404).json({ error: 'File not found' });
    if (meta.kind !== 'file') return res.status(400).json({ error: 'Path must reference a file' });

    const ext = path.extname(filePath).toLowerCase();
    const size = Number(meta.size || 0);
    const contentType = meta.contentType || workspaceContentType(filePath);
    const language = previewLanguageForWorkspaceFile(filePath);

    let previewBuffer = Buffer.alloc(0);
    try {
      previewBuffer = readWorkspaceFilePreviewBuffer(filePath, size);
    } catch (error) {
      workspaceFileMetaCache.delete(filePath);
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
        return res.status(404).json({ error: 'File not found' });
      }
      return res.status(500).json({ error: 'Failed to read file' });
    }

    const truncated = size > MAX_WORKSPACE_PREVIEW_BYTES;
    const contentBuffer = truncated
      ? previewBuffer.subarray(0, Math.min(previewBuffer.length, MAX_WORKSPACE_PREVIEW_BYTES))
      : previewBuffer;

    const likelyBinaryType = contentType === 'application/pdf'
      || contentType === 'application/octet-stream';
    const likelyBinaryBytes = isLikelyBinaryPreviewBuffer(contentBuffer);
    const likelyTextType = isLikelyTextContentType(contentType);

    let kind = workspacePreviewKindForMeta(ext, contentType);
    if ((kind === 'markdown' || kind === 'code' || kind === 'text') && likelyBinaryType) {
      kind = 'binary';
    } else if ((kind === 'markdown' || kind === 'code' || kind === 'text') && (!likelyTextType && likelyBinaryBytes)) {
      kind = 'binary';
    }

    const normalizedWebPath = toDriveWebPath(filePath);
    const payload = {
      ok: true,
      path: normalizedWebPath,
      name: path.win32.basename(filePath),
      kind,
      language,
      contentType,
      size,
      truncated,
      previewBytes: contentBuffer.length,
      rawUrl: `${remotePath}/api/drives/file?path=${encodeURIComponent(normalizedWebPath)}`,
    };

    if (kind !== 'binary' && kind !== 'image') {
      payload.content = contentBuffer.toString('utf8');
    }

    res.setHeader('Cache-Control', 'no-store');
    res.json(payload);
  });
});

// POST /api/message — browser sends a message
app.post('/api/message', auth, (req, res) => {
  const { messageId: clientMessageId, clientId, conversationId, text, newConversation, model, relayMode, mode, attachments: rawAttachments } = req.body;
  const sessionId = clientId || ensureSessionId(req, res);
  const trimmedText = String(text || '').trim();
  const normalizedAttachments = normalizeAttachments(rawAttachments);
  const referenceResolution = collectReferenceAttachmentsFromText(trimmedText);
  const attachments = mergeMessageAttachments(normalizedAttachments, referenceResolution.attachments);

  if (trimmedText.toLowerCase() === '/compact') {
    if (attachments.length) return res.status(400).json({ error: 'Compact command does not accept attachments' });
    if (!conversationId) return res.status(400).json({ error: 'Compact command requires an existing conversation' });
    const compacted = createCompactedConversation(conversationId);
    if (!compacted) return res.status(404).json({ error: 'Conversation not found' });
    io.emit('conversation_compacted', compacted);
    return res.json({
      ok: true,
      command: 'compact',
      compacted: true,
      sourceConversationId: compacted.sourceConversationId,
      conversationId: compacted.targetConversationId,
      compactedConversationId: compacted.targetConversationId,
      runtimeSessionId: compacted.runtimeSessionId,
      summarySeedPreview: compacted.summarySeed.slice(0, 240),
    });
  }

  if (trimmedText.toLowerCase() === '/context') {
    if (attachments.length) return res.status(400).json({ error: 'Context command does not accept attachments' });
    const convId = (newConversation || !conversationId) ? uuidv4() : conversationId;
    getOrCreateConversation(convId, '/context');
    const now = new Date().toISOString();
    const runtimeSession = ensureRuntimeSessionBinding(convId, String(model || '').trim() || null, now);
    const parsed = readContextFromSessionEvents(runtimeSession?.id || null);
    const responseText = buildContextResponseText({
      snapshot: parsed.snapshot,
      runtimeSession,
      conversationId: convId,
      eventsPath: parsed.eventsPath,
      error: parsed.error,
    });

    const userMessageId = clientMessageId || uuidv4();
    const responseId = uuidv4();
    stmts.insertMsg.run(userMessageId, convId, 'user', '/context', null, normalizeRelayMode(relayMode || mode) || DEFAULT_RELAY_MODE, null, now);
    stmts.insertMsg.run(responseId, convId, 'assistant', responseText, runtimeSession?.model || null, normalizeRelayMode(relayMode || mode) || DEFAULT_RELAY_MODE, null, now);
    stmts.updateConvTime.run(now, convId);

    emitToClientsExceptSessionId(
      'user_message',
      { conversationId: convId, messageId: userMessageId, senderClientId: sessionId, message: { role: 'user', text: '/context', model: runtimeSession?.model || null, mode: normalizeRelayMode(relayMode || mode) || DEFAULT_RELAY_MODE, timestamp: now, attachments: [] } },
      sessionId,
    );
    io.emit('assistant_message', {
      conversationId: convId,
      sourceMessageId: userMessageId,
      messageId: responseId,
      message: { role: 'assistant', text: responseText, model: runtimeSession?.model || null, mode: normalizeRelayMode(relayMode || mode) || DEFAULT_RELAY_MODE, timestamp: now, activities: [] },
    });
    io.emit('message_status', { messageId: userMessageId, conversationId: convId, status: 'done' });

    return res.json({
      ok: true,
      messageId: userMessageId,
      responseMessageId: responseId,
      conversationId: convId,
      runtimeSessionId: runtimeSession?.id || null,
      command: 'context',
    });
  }

  if (!trimmedText && attachments.length === 0) return res.status(400).json({ error: 'Empty message' });
  const modelResolution = resolveRequestedModel(model);
  if (!modelResolution.ok) return res.status(400).json({ error: modelResolution.error, supportedModels: modelResolution.available || [] });
  const requestedModel = modelResolution.model;
  const requestedRelayMode = normalizeRelayMode(relayMode || mode);
  if (!requestedRelayMode) return res.status(400).json({ error: 'Unsupported relay mode' });
  const workspaceRootUpdate = attachments.length === 0
    ? maybeApplyWorkspaceRootFromMessage(trimmedText)
    : { attempted: false, changed: false };

  const convId = (newConversation || !conversationId) ? uuidv4() : conversationId;
  getOrCreateConversation(convId, trimmedText || attachmentSummary(attachments) || 'Image');
  const convSeed = stmts.getConvSeed.get(convId);
  const shouldApplySeed = Number(convSeed?.seed_pending || 0) > 0 && String(convSeed?.summary_seed || '').trim().length > 0;

  const now   = new Date().toISOString();
  const runtimeSession = ensureRuntimeSessionBinding(convId, requestedModel, now);
  const msgId = clientMessageId || uuidv4();
  const queueText = shouldApplySeed
    ? [
        '[Carry-over context from previous compacted conversation]',
        String(convSeed.summary_seed).trim(),
        '',
        '[New user request]',
        trimmedText || '(User sent image attachments only.)',
      ].join('\n')
    : trimmedText;

  stmts.insertMsg.run(msgId, convId, 'user', trimmedText, requestedModel, requestedRelayMode, attachments.length ? JSON.stringify(attachments) : null, now);
  linkUploadReferences(convId, msgId, attachments);
  stmts.updateConvTime.run(now, convId);
  stmts.insertQ.run(msgId, convId, runtimeSession?.id || null, (!conversationId || !!newConversation) ? 1 : 0, requestedModel, requestedRelayMode, queueText, attachments.length ? JSON.stringify(attachments) : null, now);
  if (shouldApplySeed) {
    stmts.clearConvSeed.run(now, convId);
  }

  console.log(`[${ts()}] QUEUED    ${msgId.slice(0,8)} conv=${convId.slice(0,8)} rs=${String(runtimeSession?.id || 'none').slice(0,8)} new=${!conversationId || !!newConversation} model=${requestedModel} mode=${requestedRelayMode} text="${trimmedText.slice(0,60)}"${shouldApplySeed ? ' seeded=1' : ''}${attachments.length ? ` attachments=${attachments.length}` : ''}`);

  emitToClientsExceptSessionId(
    'user_message',
    { conversationId: convId, messageId: msgId, senderClientId: sessionId, message: { role: 'user', text: trimmedText, model: requestedModel, mode: requestedRelayMode, timestamp: now, attachments } },
    sessionId,
  );
  io.emit('message_status', { messageId: msgId, conversationId: convId, status: 'pending' });
  if (workspaceRootUpdate.changed) {
    io.emit('workspace_root_changed', {
      source: 'chat-cd-command',
      commandTarget: workspaceRootUpdate.target || null,
      ...workspaceRootPayload(),
    });
  }

  res.json({
    ok: true,
    messageId: msgId,
    conversationId: convId,
    runtimeSessionId: runtimeSession?.id || null,
    warning: modelResolution.warning || null,
    workspaceRootWarning: workspaceRootUpdate.error || null,
    workspaceRootChanged: !!workspaceRootUpdate.changed,
    ...workspaceRootPayload(),
    referenceAttachmentCount: referenceResolution.attachments.length,
    skippedReferenceAttachments: referenceResolution.skipped,
  });
});

// GET /api/conversations — list all conversations
app.get('/api/conversations', auth, (req, res) => {
  const rows = stmts.listConvs.all();
  const conversations = rows.map(r => ({
    id:           r.id,
    title:        r.title,
    archived:     Number(r.archived || 0) === 1,
    compactedInto: r.compacted_into || null,
    compactedFrom: r.compacted_from || null,
    runtimeSessionId: r.runtime_session_id || null,
    runtimeSessionStrategy: r.runtime_strategy || null,
    runtimeSessionStatus: r.runtime_status || null,
    runtimeSessionLastUsedAt: r.runtime_last_used_at || null,
    createdAt:    r.created_at,
    updatedAt:    r.updated_at,
    messageCount: r.message_count,
  }));
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

app.get('/api/context/:conversationId', auth, (req, res) => {
  const conversationId = String(req.params.conversationId || '').trim();
  if (!conversationId) return res.status(400).json({ error: 'Missing conversationId' });
  const runtimeSession = stmts.getRuntimeSessionByConversation.get(conversationId) || null;
  const parsed = readContextFromSessionEvents(runtimeSession?.id || null);

  res.json({
    conversationId,
    runtimeSessionId: runtimeSession?.id || null,
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
    const runtimeSession = stmts.getRuntimeSessionByConversation.get(explicitConversationId) || null;
    const parsed = readContextFromSessionEvents(runtimeSession?.id || null);
    return res.json({
      conversationId: explicitConversationId,
      runtimeSessionId: runtimeSession?.id || null,
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

  const runtimeSessions = stmts.listRuntimeSessions.all();
  const latest = runtimeSessions.length ? runtimeSessions[0] : null;
  const runtimeSession = latest?.id ? (stmts.getRuntimeSessionById.get(latest.id) || latest) : null;
  const parsed = readContextFromSessionEvents(runtimeSession?.id || null);
  const conversationId = String(runtimeSession?.conversation_id || '').trim() || null;
  return res.json({
    conversationId,
    runtimeSessionId: runtimeSession?.id || null,
    snapshot: parsed.snapshot || null,
    eventsPath: parsed.eventsPath || null,
    error: parsed.error || null,
    text: buildContextResponseText({
      snapshot: parsed.snapshot,
      runtimeSession,
      conversationId: conversationId || 'unavailable',
      eventsPath: parsed.eventsPath,
      error: parsed.error,
    }),
  });
});

// GET /api/conversation/:id — get full conversation
app.get('/api/conversation/:id', auth, (req, res) => {
  const conv = stmts.getConv.get(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Conversation not found' });
  const runtimeSession = stmts.getRuntimeSessionByConversation.get(req.params.id) || null;
  const inFlight = inFlightStateForConversation(req.params.id);
  const messages = stmts.getMessages.all(req.params.id).map(m => ({
    activities: m.role === 'assistant' ? relayActivityForResponse(m.id) : [],
    id:        m.id,
    role:      m.role,
    text:      m.text,
    model:     m.model || undefined,
    attachments: parseAttachments(m.attachments).map(hydrateAttachment).filter(Boolean),
    mode:      m.mode || undefined,
    timestamp: m.timestamp,
  }));
  res.json({
    id: conv.id,
    title: conv.title,
    archived: Number(conv.archived || 0) === 1,
    compactedInto: conv.compacted_into || null,
    compactedFrom: conv.compacted_from || null,
    runtimeSession: runtimeSession ? {
      id: runtimeSession.id,
      strategy: runtimeSession.strategy || null,
      status: runtimeSession.status || null,
      model: runtimeSession.model || null,
      createdAt: runtimeSession.created_at || null,
      lastUsedAt: runtimeSession.last_used_at || null,
    } : null,
    createdAt: conv.created_at,
    updatedAt: conv.updated_at,
    inFlight,
    messages,
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
app.delete('/api/conversation/:id', auth, (req, res) => {
  const id = req.params.id;
  if (!stmts.getConv.get(id)) return res.status(404).json({ error: 'Not found' });
  const orphanedUploads = collectOrphanedUploadsFromConversation(id);
  stmts.deleteConvQuestions.run(id);
  stmts.deleteConvActivity.run(id);
  stmts.deleteConvQ.run(id);
  stmts.deleteConv.run(id);  // cascades to messages via FK
  deleteOrphanedUploads(orphanedUploads);
  io.emit('conversation_deleted', { conversationId: id });
  res.json({ ok: true });
});

// GET /api/status — overall status
app.get('/api/status', auth, (req, res) => {
  ensureSessionId(req, res);
  const { pendingCount, processingCount } = queueCounts();
  const modelState = getModelCatalogState();
  const activeRuntimeSessionCount = Number(stmts.countRuntimeSessions.get()?.cnt || 0);
  const readyBanner = buildRelayReadyBannerData();
  res.json({
    cliOnline,
    relayPaused,
    pendingCount,
    processingCount,
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
      enabled: tunnelState.enabled,
      connected: tunnelState.connected,
      host: tunnelState.host,
      remotePort: tunnelState.remotePort,
      remoteBindMode: tunnelState.remoteBindMode,
      reconnectAttempts: tunnelState.reconnectAttempts,
      connectedSince: tunnelState.connectedSince,
    },
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

function fetchUsageSummary(cb) {
  execFile('gh', ['auth', 'token'], (err, stdout) => {
    if (err) return cb(new Error('gh auth token failed'));
    const ghToken = stdout.trim();
    fetch('https://api.github.com/copilot_internal/user', {
      headers: { Authorization: `Bearer ${ghToken}`, Accept: 'application/json' },
    })
      .then(r => r.json())
      .then(data => {
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

// GET /api/usage — Copilot quota fetched live from GitHub API
app.get('/api/usage', auth, (req, res) => {
  fetchUsageSummary((err, summary) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(summary);
  });
});


// ─── CLI Routes ───────────────────────────────────────────────────────────────

function touchCli() {
  cliLastSeen = Date.now();
  if (!cliOnline) {
    cliOnline = true;
    console.log(`[${ts()}] CLI ONLINE (heartbeat)`);
    io.emit('cli_status', { online: true });
  }
}

// POST /api/heartbeat — CLI sends a ping every poll interval
app.post('/api/heartbeat', auth, (req, res) => {
  touchCli();
  const { pendingCount } = queueCounts();
  res.json({ ok: true, pendingCount });
});

// GET /api/pending — CLI fetches next pending message
app.get('/api/pending', auth, (req, res) => {
  touchCli();
  if (relayPaused) return res.json({ message: null, paused: true });

  const dequeue = db.transaction(() => {
    const now = new Date().toISOString();
    const msg = stmts.findPending.get(now);
    if (!msg) return null;
    stmts.setProcessing.run(now, msg.id);
    return { ...msg, status: 'processing', processing_at: now };
  });

  const msg = dequeue();
  if (msg) {
    const attachments = parseAttachments(msg.attachments).map(hydrateAttachment).filter(Boolean);
    let runtimeSession = msg.runtime_session_id
      ? stmts.getRuntimeSessionById.get(msg.runtime_session_id)
      : null;
    if (!runtimeSession) {
      const now = new Date().toISOString();
      runtimeSession = ensureRuntimeSessionBinding(
        msg.conversation_id,
        String(msg.model || '').trim() || null,
        now,
      );
      if (runtimeSession?.id && runtimeSession.id !== msg.runtime_session_id) {
        stmts.setQueueRuntimeSession.run(runtimeSession.id, msg.id);
      }
    }
    // Normalise snake_case → camelCase for the relay
    const out = {
      id:                msg.id,
      conversationId:    msg.conversation_id,
      runtimeSessionId:  runtimeSession?.id || null,
      isNewConversation: msg.is_new_conversation === 1,
      model:             String(msg.model || '').trim() || getModelCatalogState().currentModel || DEFAULT_MODEL,
      relayMode:         normalizeRelayMode(msg.relay_mode) || DEFAULT_RELAY_MODE,
      text:              msg.text,
      attachments,
      conversationSessionMode: configuredConversationSessionMode,
      status:            msg.status,
      timestamp:         msg.timestamp,
      processingAt:      msg.processing_at,
    };
    console.log(`[${ts()}] DEQUEUED  ${out.id.slice(0,8)} conv=${out.conversationId.slice(0,8)} rs=${String(out.runtimeSessionId || 'none').slice(0,8)} model=${out.model} mode=${out.relayMode} text="${out.text.slice(0,60)}"${attachments.length ? ` attachments=${attachments.length}` : ''}`);
    io.emit('message_status', { messageId: out.id, conversationId: out.conversationId, status: 'processing' });
    res.json({ message: out });
  } else {
    res.json({ message: null });
  }
});

app.post('/api/relay/pause', auth, (req, res) => {
  relayPaused = true;
  const rows = stmts.listQueueForPauseDrop.all();
  const dropQueue = db.transaction(() => {
    for (const row of rows) {
      stmts.deleteQueueById.run(row.id);
    }
  });
  dropQueue();

  for (const row of rows) {
    io.emit('message_status', { messageId: row.id, conversationId: row.conversation_id, status: 'dropped' });
  }

  io.emit('relay_pause_state', { paused: true, droppedCount: rows.length });
  console.log(`[${ts()}] RELAY     paused dropped=${rows.length}`);
  res.json({ ok: true, paused: true, droppedCount: rows.length });
});

app.post('/api/relay/resume', auth, (req, res) => {
  relayPaused = false;
  io.emit('relay_pause_state', { paused: false });
  console.log(`[${ts()}] RELAY     resumed`);
  res.json({ ok: true, paused: false });
});

app.post('/api/relay/recover-processing', auth, (req, res) => {
  const rawMaxAge = Number(req.body?.maxAgeMs);
  const maxAgeMs = Number.isFinite(rawMaxAge)
    ? Math.max(5_000, Math.min(300_000, rawMaxAge))
    : 15_000;
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
  const requeueAt = addMsIso(5_000);
  const rows = recoverProcessingOlderThan(cutoff, requeueAt);
  if (!rows.length) return res.json({ ok: true, recovered: 0, maxAgeMs });
  console.log(`[${ts()}] RELAY     recovered processing=${rows.length} maxAgeMs=${maxAgeMs}`);
  return res.json({ ok: true, recovered: rows.length, maxAgeMs });
});

// POST /api/response — CLI submits response
app.post('/api/response', auth, (req, res) => {
  touchCli();
  const { messageId, conversationId, text, model, mode } = req.body;

  if (!text?.trim()) return res.status(400).json({ error: 'Empty response' });
  if (!messageId) return res.status(400).json({ error: 'Missing messageId' });

  const q = stmts.findQById.get(messageId);
  const targetConversationId = q?.conversation_id || conversationId;
  if (!targetConversationId) return res.status(400).json({ error: 'Missing conversationId' });

  if (q && q.status === 'done') {
    console.log(`[${ts()}] RESPONSE  ${messageId?.slice(0,8)} ignored=already_done`);
    return res.json({ ok: true, ignored: 'already_done' });
  }
  if (q && q.status === 'failed') {
    console.log(`[${ts()}] RESPONSE  ${messageId?.slice(0,8)} ignored=already_failed`);
    return res.json({ ok: true, ignored: 'already_failed' });
  }

  const responseId = uuidv4();
  const now        = new Date().toISOString();
  const relayMode = normalizeRelayMode(mode || q?.relay_mode) || DEFAULT_RELAY_MODE;
  const finalize = db.transaction(() => {
    const result = stmts.setDone.run(text, messageId);
    if (result.changes === 0) return false;
    stmts.insertMsg.run(responseId, targetConversationId, 'assistant', text, model || null, relayMode, null, now);
    stmts.linkActivityToResponse.run(responseId, messageId);
    stmts.updateConvTime.run(now, targetConversationId);
    stmts.pruneQueue.run();
    return true;
  });

  const finalized = finalize();
  if (!finalized) {
    console.log(`[${ts()}] RESPONSE  ${messageId?.slice(0,8)} ignored=not_pending_or_processing`);
    return res.json({ ok: true, ignored: 'not_pending_or_processing' });
  }
  if (q?.runtime_session_id) {
    const nowIso = new Date().toISOString();
    const existing = stmts.getRuntimeSessionById.get(q.runtime_session_id);
    if (existing?.id) {
      stmts.touchRuntimeSession.run(
        String(model || existing.model || '').trim() || null,
        nowIso,
        existing.id,
      );
    }
  }
  const activities = relayActivityForResponse(responseId);

  console.log(`[${ts()}] RESPONSE  ${messageId?.slice(0,8)} conv=${targetConversationId?.slice(0,8)} mode=${relayMode} len=${text.length} preview="${text.slice(0,60)}"`);

  io.emit('assistant_message', {
    conversationId: targetConversationId,
    sourceMessageId: messageId,
    messageId: responseId,
    message: { role: 'assistant', text, model: model || null, mode: relayMode, timestamp: now, activities },
  });
  io.emit('message_status', { messageId, conversationId: targetConversationId, status: 'done' });

  res.json({ ok: true });
});

// POST /api/activity — relay sends in-flight activity updates (tool/search sections)
app.post('/api/activity', auth, (req, res) => {
  touchCli();
  const { messageId, conversationId, text, mode } = req.body || {};
  const activityText = sanitizeActivityText(text);
  if (!messageId || !conversationId || !activityText) {
    return res.status(400).json({ error: 'Missing activity payload' });
  }

  stmts.insertActivity.run(
    messageId,
    conversationId,
    normalizeRelayMode(mode) || DEFAULT_RELAY_MODE,
    activityText,
    new Date().toISOString(),
  );

  io.emit('relay_activity', {
    messageId,
    conversationId,
    mode: normalizeRelayMode(mode) || DEFAULT_RELAY_MODE,
    text: activityText,
    timestamp: new Date().toISOString(),
  });
  res.json({ ok: true });
});

// POST /api/requeue — relay re-queues a message it failed to process
app.post('/api/requeue', auth, (req, res) => {
  const { messageId } = req.body;
  const q = stmts.findQById.get(messageId);
  if (q && q.status === 'processing') {
    const retryCount = Number(q.retry_count || 0) + 1;
    if (retryCount >= MAX_REQUEUE_RETRIES) {
      const now = new Date().toISOString();
      const failText = `Relay timeout after ${retryCount} attempts. Message was skipped to keep the queue moving.`;
      const failResponse = JSON.stringify({ error: 'timeout', retryCount, failedAt: now });
      const responseId = uuidv4();
      const tx = db.transaction(() => {
        stmts.setFailed.run(failResponse, messageId);
        stmts.insertMsg.run(responseId, q.conversation_id, 'assistant', failText, q.model || null, normalizeRelayMode(q.relay_mode) || DEFAULT_RELAY_MODE, null, now);
        stmts.updateConvTime.run(now, q.conversation_id);
      });
      tx();
      console.log(`[${ts()}] FAILED    ${messageId?.slice(0,8)} retry=${retryCount} reason=timeout`);
      io.emit('assistant_message', {
        conversationId: q.conversation_id,
        messageId: responseId,
        message: {
          role: 'assistant',
          text: failText,
          model: q.model || null,
          mode: normalizeRelayMode(q.relay_mode) || DEFAULT_RELAY_MODE,
          timestamp: now,
        },
      });
      io.emit('message_status', { messageId, conversationId: q?.conversation_id, status: 'failed' });
    } else {
      const nextAttemptAt = addMsIso(computeRetryDelayMs(retryCount));
      const result = db.prepare(`UPDATE queue SET status = 'pending', processing_at = NULL, retry_count = ?, next_attempt_at = ? WHERE id = ? AND status = 'processing'`).run(retryCount, nextAttemptAt, messageId);
      if (result.changes > 0) {
        console.log(`[${ts()}] REQUEUED  ${messageId?.slice(0,8)} retry=${retryCount} next=${nextAttemptAt}`);
        io.emit('message_status', { messageId, conversationId: q?.conversation_id, status: 'pending' });
      }
    }
  }
  res.json({ ok: true });
});

// ─── Relay Question Routes ────────────────────────────────────────────────────

function questionExpiresAt(createdAt) {
  return new Date(new Date(createdAt).getTime() + DEFAULT_QUESTION_TIMEOUT_MS).toISOString();
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

app.get('/api/relay-questions', auth, (req, res) => {
  const conversationId = req.query.conversationId ? String(req.query.conversationId) : null;
  const status = String(req.query.status || 'pending').trim() || 'pending';
  const rows = stmts.listQuestions.all(status, conversationId, conversationId);
  res.json({ questions: rows.map(formatQuestionRow) });
});

app.get('/api/relay-question/:id', auth, (req, res) => {
  const row = stmts.getQuestion.get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json({ question: formatQuestionRow(row) });
});

app.post('/api/relay-question', auth, (req, res) => {
  const { queueId, messageId, conversationId, mode, prompt, choices, request, context, allowFreeform } = req.body;
  const q = stmts.findQById.get(queueId || messageId);
  if (!q || q.status !== 'processing') {
    return res.status(409).json({ error: 'No active relay turn' });
  }

  const effectiveMessageId = messageId || q.id;
  const existingPending = stmts.findPendingQuestionByMessage.get(effectiveMessageId);
  if (existingPending) {
    const question = formatQuestionRow(existingPending);
    return res.json({ question, reused: true });
  }

  const relayMode = normalizeRelayMode(mode || q.relay_mode) || DEFAULT_RELAY_MODE;
  const now = new Date().toISOString();
  const questionId = uuidv4();
  const promptText = sanitizeRelayQuestionPrompt({ prompt });
  const normalizedChoices = normalizeQuestionChoices(choices);
  const requestJson = sanitizeRelayQuestionRequest({
    request: parseQuestionRequest(request),
    context: sanitizeRelayQuestionContext(context),
    allowFreeform: typeof allowFreeform === 'boolean' ? allowFreeform : (!normalizedChoices.length),
  });
  const expiresAt = questionExpiresAt(now);

  stmts.insertQuestion.run(
    questionId,
    q.id,
    conversationId || q.conversation_id,
    effectiveMessageId,
    relayMode,
    promptText,
    normalizedChoices.length ? JSON.stringify(normalizedChoices) : null,
    requestJson,
    now,
    expiresAt,
  );

  const question = formatQuestionRow(stmts.getQuestion.get(questionId));
  console.log(`[${ts()}] QUESTION  ${questionId.slice(0,8)} conv=${question.conversationId.slice(0,8)} mode=${relayMode} prompt="${promptText.slice(0,60)}"`);
  io.emit('relay_question', { question });
  res.json({ question });
});

app.post('/api/relay-question/:id/answer', auth, (req, res) => {
  const { answer } = req.body;
  const text = String(answer || '').trim();
  if (!text) return res.status(400).json({ error: 'Empty answer' });

  const row = stmts.getQuestion.get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (row.status !== 'pending') return res.status(409).json({ error: `Question already ${row.status}` });

  const now = new Date().toISOString();
  const result = stmts.answerQuestion.run(text, now, row.id);
  if (result.changes === 0) return res.status(409).json({ error: 'Question is no longer pending' });

  const question = formatQuestionRow(stmts.getQuestion.get(row.id));
  console.log(`[${ts()}] QUESTION  ${row.id.slice(0,8)} answered len=${text.length}`);
  io.emit('relay_question_updated', { question });
  res.json({ ok: true, question });
});

app.post('/api/relay-question/:id/timeout', auth, (req, res) => {
  const row = stmts.getQuestion.get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (row.status !== 'pending') return res.json({ ok: true, question: formatQuestionRow(row) });

  const result = stmts.timeoutQuestion.run(row.id);
  if (result.changes > 0) {
    const question = formatQuestionRow(stmts.getQuestion.get(row.id));
    console.log(`[${ts()}] QUESTION  ${row.id.slice(0,8)} timed out`);
    io.emit('relay_question_updated', { question });
    return res.json({ ok: true, question });
  }

  return res.json({ ok: true, question: formatQuestionRow(stmts.getQuestion.get(row.id)) });
});

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
    tunnelLog(`Tunnel up → ${user}@${host}  remote port ${remotePort}`);
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
}

let runtimeShutdownPromise = null;
function shutdownRuntime(reason = 'unknown') {
  if (runtimeShutdownPromise) return runtimeShutdownPromise;

  runtimeShutdownStarted = true;
  console.log(`[${ts()}] Runtime shutdown started (${reason})`);
  clearRuntimeTimers();
  stopWorkspaceFileWatcher();
  stopSshTunnel();

  runtimeShutdownPromise = new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
      process.exit(0);
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
      '║         Copilot Web Proxy  -  Ready                         ║',
      '╠══════════════════════════════════════════════════════════════╣',
      `║  Local:      ${localUrl.padEnd(46)}║`,
      `║  Network:    ${String(networkText || '').padEnd(46)}║`,
      ...(remoteUrl ? [`║  Remote:     ${remoteUrl.padEnd(46)}║`] : []),
      ...(remoteUrl ? [`║  Tunnel:     ${(`mode=${tunnelRemoteBindMode}`).padEnd(46)}║`] : []),
      `║  Auth:       ${authText.padEnd(46)}║`,
      '╠══════════════════════════════════════════════════════════════╣',
      '║  CLI polling URL (for monitoring mode):                      ║',
      `║  GET:        ${pollingUrl.padEnd(46)}║`,
      '╚══════════════════════════════════════════════════════════════╝',
    ],
  };
}

// Graceful shutdown: stop timers/tunnel and release listener deterministically.
process.on('SIGTERM', () => { void shutdownRuntime('SIGTERM'); });
process.on('SIGINT',  () => { void shutdownRuntime('SIGINT'); });

// ─── Start ────────────────────────────────────────────────────────────────────
httpServer.listen(config.port, listenHost, () => {
  const readyBanner = buildRelayReadyBannerData();
  console.log('');
  for (const line of (readyBanner.lines || [])) {
    console.log(line);
  }
  console.log('\nCLI status: waiting for first heartbeat...\n');

  // Start SSH tunnel after server is listening
  if (tunnelEnabled) {
    tunnelLog(`SSH tunnel enabled (${tunnelRemoteBindMode}) → ${tunnelConfig.user}@${tunnelConfig.host}:${tunnelConfig.remotePort}`);
    spawnSshTunnel();
  }
});
