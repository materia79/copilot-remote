export const BASE = window.location.pathname.replace(/\/+$/, '');
export let TOKEN = '';
export let socket = null;
export let currentConvId = null;
export let CLIENT_ID = sessionStorage.getItem('copilot_client_id');
if (!CLIENT_ID) {
  CLIENT_ID = generateId();
  sessionStorage.setItem('copilot_client_id', CLIENT_ID);
}

export const seenMessageIds = new Set();
export const pendingUserMessageIds = new Set();
export const pendingUserMessageEntries = new Map();
export let cliOnline = false;
export let relayOnline = false;
export let conversations = {};
export let selectedAttachments = [];
export const RELAY_QUESTION_POLL_MS = 3000;
export const MAX_UPLOAD_ATTACHMENTS = 6;
export const FILE_PREVIEW_MAX_BYTES = 512 * 1024;
export const REPO_IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp', 'avif']);
export const WORKSPACE_FILE_EXTENSIONS = new Set([
  'md', 'txt', 'json', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'css', 'html', 'xml', 'yml', 'yaml',
  'toml', 'ini', 'csv', 'sql', 'ps1', 'sh', 'bat', 'go', 'py', 'java', 'rb', 'php', 'c', 'h', 'cpp',
  'hpp', 'rs', 'lock', 'log', 'svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'pdf',
]);
export let workspaceRootName = '';
export let workspaceRootEntrySet = new Set([
  '.github',
  'server',
  'tests',
  'readme.md',
  'package.json',
  'package-lock.json',
]);
export let relayQuestions = new Map();
export let relayActivities = new Map();
export let sessionWorkerStates = new Map();
export let thinkingMessageId = null;
export let relayQuestionPollTimer = null;
export let relayQuestionRenderHash = '';
export let relayQuestionDrafts = new Map();
export let selectedAttachmentsState = selectedAttachments;
export let filePreviewState = {
  path: '',
  source: 'workspace',
  mode: 'preview',
  allowHtml: false,
  loading: false,
  error: '',
  payload: null,
};
export let repoBrowserState = {
  open: false,
  loading: false,
  activeRoot: 'workspace',
  workspaceIncludeHidden: false,
  workspaceIncludeHeavy: false,
  drivesIncludeHidden: false,
  viewMode: 'list',
  rootName: 'repo',
  sessionRootPath: '',
  sessionRootName: 'Session',
  tree: null,
  nodeMap: new Map(),
  currentPath: '',
  truncated: false,
  nodeCount: 0,
  maxNodes: 0,
  loadingPath: '',
  error: '',
};
export let contextUsageRefreshTimer = null;
export let contextUsageRefreshSeq = 0;
export let compactInFlight = false;
export let deferredInstallPrompt = null;
export let viewportBaseHeight = window.innerHeight || document.documentElement.clientHeight || 0;
export let pullRefreshState = {
  active: false,
  ready: false,
  startY: 0,
  refreshing: false,
};
const SIDEBAR_WIDTH_PERCENT_MIN = 10;
const SIDEBAR_WIDTH_PERCENT_MAX = 50;
const SIDEBAR_WIDTH_PERCENT_FALLBACK = 24;
const SIDEBAR_WIDTH_PORTRAIT_STORAGE_KEY = 'copilot_sidebar_width_pct_portrait';
const SIDEBAR_WIDTH_LANDSCAPE_STORAGE_KEY = 'copilot_sidebar_width_pct_landscape';
const SIDEBAR_COLLAPSED_DESKTOP_STORAGE_KEY = 'copilot_sidebar_collapsed_desktop';
let sidebarWidthPercent = SIDEBAR_WIDTH_PERCENT_FALLBACK;

marked.setOptions({ breaks: true });

export function generateId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

export function setCurrentConv(id) {
  currentConvId = id;
  if (id) localStorage.setItem('copilot_last_conv', id);
  else localStorage.removeItem('copilot_last_conv');
  updateCompactButton();
}

function normalizePendingMessageText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function pendingConversationKey(conversationId) {
  return String(conversationId || '').trim() || '__new__';
}

function cleanupStalePendingUserMessages(maxAgeMs = 15 * 60 * 1000) {
  const cutoff = Date.now() - Math.max(60_000, Number(maxAgeMs) || 0);
  for (const [messageId, entry] of pendingUserMessageEntries.entries()) {
    const addedAt = Number(entry?.addedAt || 0);
    if (!Number.isFinite(addedAt) || addedAt < cutoff) {
      pendingUserMessageEntries.delete(messageId);
      pendingUserMessageIds.delete(messageId);
    }
  }
}

export function trackPendingUserMessage(messageId, conversationId, text) {
  const id = String(messageId || '').trim();
  const fingerprint = normalizePendingMessageText(text);
  if (!id || !fingerprint) return false;
  cleanupStalePendingUserMessages();
  pendingUserMessageEntries.set(id, {
    conversationKey: pendingConversationKey(conversationId),
    fingerprint,
    addedAt: Date.now(),
  });
  pendingUserMessageIds.add(id);
  return true;
}

export function clearPendingUserMessage(messageId) {
  const id = String(messageId || '').trim();
  if (!id) return false;
  pendingUserMessageIds.delete(id);
  return pendingUserMessageEntries.delete(id);
}

export function hasPendingUserMessageDuplicate(conversationId, text) {
  const fingerprint = normalizePendingMessageText(text);
  if (!fingerprint) return false;
  cleanupStalePendingUserMessages();
  const conversationKey = pendingConversationKey(conversationId);
  for (const entry of pendingUserMessageEntries.values()) {
    if (entry?.conversationKey === conversationKey && entry?.fingerprint === fingerprint) {
      return true;
    }
  }
  return false;
}

export function authHeaders() {
  return TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {};
}

export function setToken(value) {
  TOKEN = String(value || '').trim();
}

export function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = value;
  let idx = 0;
  while (size >= 1024 && idx < units.length - 1) {
    size /= 1024;
    idx += 1;
  }
  const rounded = idx === 0 ? Math.round(size) : Math.round(size * 10) / 10;
  return `${rounded} ${units[idx]}`;
}

export function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

export function updateWorkspaceRootHints(payload) {
  const rootName = String(payload?.workspaceRootName || '').trim().toLowerCase();
  const entries = Array.isArray(payload?.workspaceRootEntries) ? payload.workspaceRootEntries : [];
  workspaceRootName = rootName;
  if (entries.length) {
    workspaceRootEntrySet = new Set(entries.map((entry) => String(entry || '').trim().toLowerCase()).filter(Boolean));
  }
}

export function clampContextUsageRatio(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (n <= 0) return 0;
  if (n >= 1) return 1;
  return n;
}

export function readContextUsageRatio(payload) {
  const snapshot = payload?.snapshot && typeof payload.snapshot === 'object' ? payload.snapshot : null;
  if (!snapshot) return null;
  const usedPct = Number(snapshot.used_percent);
  if (Number.isFinite(usedPct)) {
    return clampContextUsageRatio(usedPct / 100);
  }
  const usedTotal = Number(snapshot.used_total_tokens);
  const maxTokens = Number(snapshot.max_context_tokens);
  if (Number.isFinite(usedTotal) && Number.isFinite(maxTokens) && maxTokens > 0) {
    return clampContextUsageRatio(usedTotal / maxTokens);
  }
  return null;
}

export function applyContextUsageBar(ratio) {
  const inputArea = document.getElementById('input-area');
  if (!inputArea) return;

  const normalized = clampContextUsageRatio(ratio);
  if (normalized === null) {
    inputArea.style.setProperty('--context-usage-bar', 'linear-gradient(90deg, rgba(139,148,158,0.65) 0%, rgba(139,148,158,0.95) 50%, rgba(139,148,158,0.65) 100%)');
    inputArea.style.setProperty('--context-usage-glow', 'rgba(139,148,158,0.35)');
    inputArea.style.setProperty('--context-usage-opacity', '0.62');
    delete inputArea.dataset.contextUsageRatio;
    return;
  }

  const hue = Math.round((1 - normalized) * 120);
  const lightness = 49 - Math.round(normalized * 8);
  const baseColor = `hsl(${hue}, 88%, ${lightness}%)`;
  const shineAlpha = (0.44 + (normalized * 0.18)).toFixed(2);
  const glowAlpha = Math.min(0.86, 0.42 + (normalized * 0.28)).toFixed(2);
  inputArea.style.setProperty(
    '--context-usage-bar',
    `linear-gradient(90deg, rgba(255,255,255,0.16) 0%, ${baseColor} 24%, rgba(255,255,255,${shineAlpha}) 50%, ${baseColor} 76%, rgba(255,255,255,0.16) 100%)`
  );
  inputArea.style.setProperty('--context-usage-glow', `hsla(${hue}, 88%, 52%, ${glowAlpha})`);
  inputArea.style.setProperty('--context-usage-opacity', '0.98');
  inputArea.dataset.contextUsageRatio = normalized.toFixed(4);
}

export function scrollBottom() {
  const el = document.getElementById('messages');
  if (!el) return;
  el.scrollTop = el.scrollHeight;
}

export function scrollBottomAfterSend() {
  scrollBottom();
  requestAnimationFrame(() => {
    scrollBottom();
  });
  setTimeout(() => {
    scrollBottom();
  }, 120);
}

export function isMobileComposerViewport() {
  return window.matchMedia('(max-width: 680px)').matches;
}

export function releaseComposerFocusAfterSend(input) {
  if (!input || !isMobileComposerViewport()) return;
  try { input.blur(); } catch {}
  document.body.classList.remove('keyboard-open');
  syncViewportMetrics();
}

export function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  syncViewportMetrics();
}

export function updateSessionPill(conversation, runtimeSession) {
  const title = document.getElementById('chat-title');
  const sdkSessionId = String(
    runtimeSession?.sdkSessionId
    || runtimeSession?.sdk_session_id
    || conversation?.sdkSessionId
    || conversation?.sdk_session_id
    || '',
  ).trim();
  if (!sdkSessionId) {
    if (title) {
      delete title.dataset.copilotSessionId;
      title.title = '';
    }
    return;
  }
  if (title) {
    title.dataset.copilotSessionId = sdkSessionId;
    title.title = `Copilot session ${sdkSessionId} (click to copy)`;
  }
}

export function updateCompactButton() {
  const btn = document.getElementById('chat-menu-compact');
  if (!btn) return;
  const conv = currentConvId ? conversations[currentConvId] : null;
  const canCompact = !!(currentConvId && conv && !conv.archived && !compactInFlight);
  btn.disabled = !canCompact;
  btn.title = canCompact
    ? 'Compact conversation into a fresh session'
    : (compactInFlight ? 'Compacting conversation…' : 'Open an active conversation to compact');
}

export function updateCliStatus() {
  const dot = document.getElementById('cli-dot');
  const text = document.getElementById('cli-status-text');
  const banner = document.getElementById('offline-banner');
  const workerStates = Array.from(sessionWorkerStates.values());
  const processingCount = workerStates.filter((state) => String(state?.status || '').trim().toLowerCase() === 'processing').length;
  const errorCount = workerStates.filter((state) => String(state?.uiState || state?.derivedUiState || '').trim().toLowerCase() === 'error').length;
  const questionCount = workerStates.filter((state) => String(state?.uiState || state?.derivedUiState || '').trim().toLowerCase() === 'question').length;
  if (dot) {
    dot.className = relayOnline ? 'online' : 'offline';
    if (!relayOnline) {
      dot.title = 'Web relay unreachable';
    } else if (!cliOnline) {
      dot.title = 'Web relay reachable; CLI offline';
    } else if (processingCount > 0) {
      dot.title = `Web relay reachable; ${processingCount} session worker${processingCount === 1 ? '' : 's'} processing`;
    } else if (errorCount > 0) {
      dot.title = `Web relay reachable; ${errorCount} session worker${errorCount === 1 ? '' : 's'} degraded`;
    } else if (questionCount > 0) {
      dot.title = `Web relay reachable; ${questionCount} session worker${questionCount === 1 ? '' : 's'} waiting on a question`;
    } else {
      dot.title = 'Web relay reachable';
    }
  }
  if (text) text.textContent = cliOnline ? 'CLI online' : 'CLI offline';
  if (banner) {
    if (cliOnline) banner.classList.remove('visible');
    else banner.classList.add('visible');
  }
}

export function setCliOnline(value) {
  cliOnline = !!value;
  updateCliStatus();
}

export function setRelayOnline(value) {
  relayOnline = !!value;
  updateCliStatus();
}

function normalizeWorkerSessionId(value) {
  const text = String(value || '').trim();
  return text || '';
}

function normalizeWorkerStatus(value) {
  const text = String(value || '').trim().toLowerCase();
  return text || 'unknown';
}

const CANONICAL_UI_STATES = new Set(['offline', 'ready', 'question', 'error']);
const UI_STATE_ALIAS_MAP = new Map([
  ['offline', 'offline'],
  ['inactive', 'offline'],
  ['unknown', 'offline'],
  ['new', 'offline'],
  ['disconnected', 'offline'],
  ['stopped', 'offline'],
  ['idle', 'offline'],
  ['white', 'offline'],
  ['healthy', 'ready'],
  ['ready', 'ready'],
  ['online', 'ready'],
  ['active', 'ready'],
  ['busy', 'ready'],
  ['processing', 'ready'],
  ['starting', 'ready'],
  ['green', 'ready'],
  ['question', 'question'],
  ['question-pending', 'question'],
  ['question_pending', 'question'],
  ['awaiting-input', 'question'],
  ['awaiting_input', 'question'],
  ['needs-input', 'question'],
  ['needs_input', 'question'],
  ['input-required', 'question'],
  ['input_required', 'question'],
  ['waiting-for-input', 'question'],
  ['waiting_for_input', 'question'],
  ['red', 'question'],
  ['error', 'error'],
  ['degraded', 'error'],
  ['unsafe', 'error'],
  ['failed', 'error'],
  ['yellow', 'error'],
]);

function normalizeUiState(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return '';
  if (CANONICAL_UI_STATES.has(text)) return text;
  return UI_STATE_ALIAS_MAP.get(text) || '';
}

function normalizeUiStateFromStatus(value) {
  return normalizeUiState(normalizeWorkerStatus(value));
}

export function resolveConversationUiState({ conversation = null, workerState = null, hasPendingQuestion = false } = {}) {
  const backendUiState = normalizeUiState(
    workerState?.uiState
    || workerState?.ui_state
    || conversation?.runtimeSessionUiState
    || conversation?.runtime_session_ui_state,
  );
  if (backendUiState) return backendUiState;
  if (hasPendingQuestion) return 'question';

  const fallbackUiState = normalizeUiState(
    workerState?.derivedUiState
    || workerState?.fallbackUiState
    || normalizeUiStateFromStatus(workerState?.status)
    || normalizeUiStateFromStatus(conversation?.runtimeSessionStatus)
    || normalizeUiStateFromStatus(conversation?.runtime_session_status),
  );
  return fallbackUiState || 'offline';
}

function normalizeWorkerStateEntry(worker) {
  const sdkSessionId = normalizeWorkerSessionId(worker?.sdkSessionId);
  if (!sdkSessionId) return null;
  const explicitUiState = normalizeUiState(worker?.uiState || worker?.ui_state);
  const derivedUiState = normalizeUiStateFromStatus(worker?.status);
  return {
    sdkSessionId,
    status: normalizeWorkerStatus(worker?.status),
    uiState: explicitUiState || null,
    derivedUiState: derivedUiState || null,
    workerId: String(worker?.workerId || '').trim() || null,
    pid: Number.isInteger(Number(worker?.pid)) ? Number(worker.pid) : null,
    updatedAt: String(worker?.updatedAt || '').trim() || null,
  };
}

function buildSessionWorkerStateHash(map) {
  const parts = [];
  for (const [sid, state] of map.entries()) {
    parts.push(`${sid}:${state.status}:${state.uiState || ''}:${state.derivedUiState || ''}:${state.workerId || ''}:${state.pid || ''}:${state.updatedAt || ''}`);
  }
  return parts.sort().join('|');
}

let sessionWorkerStateHash = '';

export function setSessionWorkerStatesFromStatusPayload(payload) {
  const workers = Array.isArray(payload?.workers) ? payload.workers : [];
  const next = new Map();
  for (const worker of workers) {
    const normalized = normalizeWorkerStateEntry(worker);
    if (!normalized) continue;
    next.set(normalized.sdkSessionId, normalized);
  }
  const nextHash = buildSessionWorkerStateHash(next);
  if (nextHash === sessionWorkerStateHash) return false;
  sessionWorkerStateHash = nextHash;
  sessionWorkerStates = next;
  return true;
}

export function getSessionWorkerState(sdkSessionId) {
  const sid = normalizeWorkerSessionId(sdkSessionId);
  if (!sid) return null;
  return sessionWorkerStates.get(sid) || null;
}

function isPortraitViewport() {
  return !!window.matchMedia('(orientation: portrait)').matches;
}

function isOverlaySidebarViewport() {
  return window.matchMedia('(max-width: 680px)').matches;
}

function parseCssPx(value) {
  const numeric = Number.parseFloat(String(value || ''));
  return Number.isFinite(numeric) ? numeric : 0;
}

function isVisibleElement(el) {
  if (!el) return false;
  const style = window.getComputedStyle(el);
  return style.display !== 'none' && style.visibility !== 'hidden';
}

function measureSidebarHeaderMinWidthPx() {
  const header = document.querySelector('#sidebar .sidebar-header');
  if (!header) return 0;
  const headerStyle = window.getComputedStyle(header);
  const sidePadding = parseCssPx(headerStyle.paddingLeft) + parseCssPx(headerStyle.paddingRight);
  const headerGap = parseCssPx(headerStyle.columnGap || headerStyle.gap);

  let neededWidth = sidePadding;
  let sectionCount = 0;

  const statusDot = document.getElementById('cli-dot');
  if (isVisibleElement(statusDot)) {
    neededWidth += Math.ceil(statusDot.getBoundingClientRect().width || 0);
    sectionCount += 1;
  }

  const actions = document.getElementById('sidebar-actions');
  if (isVisibleElement(actions)) {
    const actionsStyle = window.getComputedStyle(actions);
    const actionGap = parseCssPx(actionsStyle.columnGap || actionsStyle.gap);
    const visibleButtons = Array.from(actions.children).filter(child => isVisibleElement(child));
    let actionsWidth = 0;
    for (const button of visibleButtons) {
      actionsWidth += Math.ceil(button.getBoundingClientRect().width || 0);
    }
    if (visibleButtons.length > 1) actionsWidth += actionGap * (visibleButtons.length - 1);
    neededWidth += actionsWidth;
    sectionCount += 1;
  }

  if (sectionCount > 1) {
    neededWidth += headerGap * (sectionCount - 1);
  }
  return Math.ceil(neededWidth + 4);
}

function sidebarWidthPercentMin() {
  const viewportWidth = Math.max(window.innerWidth || 0, document.documentElement.clientWidth || 0, 1);
  const headerMinPx = measureSidebarHeaderMinWidthPx();
  const headerMinPercent = (headerMinPx / viewportWidth) * 100;
  return Math.min(SIDEBAR_WIDTH_PERCENT_MAX, Math.max(SIDEBAR_WIDTH_PERCENT_MIN, headerMinPercent));
}

function clampSidebarWidthPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return SIDEBAR_WIDTH_PERCENT_FALLBACK;
  const minPercent = sidebarWidthPercentMin();
  if (numeric <= minPercent) return minPercent;
  if (numeric >= SIDEBAR_WIDTH_PERCENT_MAX) return SIDEBAR_WIDTH_PERCENT_MAX;
  return Math.round(numeric * 100) / 100;
}

function currentSidebarWidthStorageKey() {
  return isPortraitViewport()
    ? SIDEBAR_WIDTH_PORTRAIT_STORAGE_KEY
    : SIDEBAR_WIDTH_LANDSCAPE_STORAGE_KEY;
}

function oppositeSidebarWidthStorageKey() {
  return isPortraitViewport()
    ? SIDEBAR_WIDTH_LANDSCAPE_STORAGE_KEY
    : SIDEBAR_WIDTH_PORTRAIT_STORAGE_KEY;
}

function readSidebarWidthPercentForCurrentOrientation() {
  const primary = Number(localStorage.getItem(currentSidebarWidthStorageKey()));
  if (Number.isFinite(primary)) return clampSidebarWidthPercent(primary);
  const fallback = Number(localStorage.getItem(oppositeSidebarWidthStorageKey()));
  if (Number.isFinite(fallback)) return clampSidebarWidthPercent(fallback);
  return SIDEBAR_WIDTH_PERCENT_FALLBACK;
}

function persistSidebarWidthPercentForCurrentOrientation(percent) {
  localStorage.setItem(currentSidebarWidthStorageKey(), String(clampSidebarWidthPercent(percent)));
}

function applySidebarWidthPercent(percent, { persist = true } = {}) {
  sidebarWidthPercent = clampSidebarWidthPercent(percent);
  const viewportWidth = Math.max(window.innerWidth || 0, document.documentElement.clientWidth || 0, 1);
  const widthPx = Math.round((viewportWidth * sidebarWidthPercent) / 100);
  document.documentElement.style.setProperty('--sidebar-width', `${Math.max(1, widthPx)}px`);
  if (persist) {
    persistSidebarWidthPercentForCurrentOrientation(sidebarWidthPercent);
  }
}

function readDesktopSidebarCollapsed() {
  return localStorage.getItem(SIDEBAR_COLLAPSED_DESKTOP_STORAGE_KEY) === '1';
}

function setDesktopSidebarCollapsed(collapsed) {
  const next = !!collapsed;
  document.body.classList.toggle('sidebar-collapsed', next);
  localStorage.setItem(SIDEBAR_COLLAPSED_DESKTOP_STORAGE_KEY, next ? '1' : '0');
}

export function isSidebarOpen() {
  const sidebar = document.getElementById('sidebar');
  if (isOverlaySidebarViewport()) {
    return !!sidebar?.classList.contains('open');
  }
  return !document.body.classList.contains('sidebar-collapsed');
}

export function openSidebar() {
  if (isOverlaySidebarViewport()) {
    document.body.classList.remove('sidebar-collapsed');
    document.getElementById('sidebar')?.classList.add('open');
    document.getElementById('sidebar-overlay')?.classList.add('visible');
    return;
  }
  setDesktopSidebarCollapsed(false);
}

export function closeSidebar() {
  document.getElementById('sidebar')?.classList.remove('open');
  document.getElementById('sidebar-overlay')?.classList.remove('visible');
}

export function toggleSidebar(forceOpen = null) {
  if (isOverlaySidebarViewport()) {
    const shouldOpen = typeof forceOpen === 'boolean' ? forceOpen : !isSidebarOpen();
    if (shouldOpen) openSidebar();
    else closeSidebar();
    return;
  }
  const nextOpen = typeof forceOpen === 'boolean' ? forceOpen : !isSidebarOpen();
  setDesktopSidebarCollapsed(!nextOpen);
}

export function syncSidebarLayoutState() {
  applySidebarWidthPercent(readSidebarWidthPercentForCurrentOrientation(), { persist: false });
  if (isOverlaySidebarViewport()) {
    document.body.classList.remove('sidebar-collapsed');
    return;
  }
  document.getElementById('sidebar')?.classList.remove('open');
  document.getElementById('sidebar-overlay')?.classList.remove('visible');
  setDesktopSidebarCollapsed(readDesktopSidebarCollapsed());
}

function beginSidebarResize(pointerDownEvent) {
  if (pointerDownEvent.button !== 0) return;
  if (isOverlaySidebarViewport() || !isSidebarOpen()) return;
  const startX = Number(pointerDownEvent.clientX || 0);
  const startPercent = sidebarWidthPercent;
  document.body.classList.add('sidebar-resizing');
  pointerDownEvent.preventDefault();

  const onPointerMove = (moveEvent) => {
    const viewportWidth = Math.max(window.innerWidth || 0, document.documentElement.clientWidth || 0, 1);
    const deltaX = Number(moveEvent.clientX || 0) - startX;
    const deltaPercent = (deltaX / viewportWidth) * 100;
    applySidebarWidthPercent(startPercent + deltaPercent, { persist: true });
  };

  const onPointerUp = () => {
    document.body.classList.remove('sidebar-resizing');
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerUp);
  };

  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);
}

export function initSidebarLayout() {
  syncSidebarLayoutState();
  if (window.__sidebarLayoutBound) return;
  window.__sidebarLayoutBound = true;

  const handle = document.getElementById('sidebar-resizer');
  if (handle) {
    handle.addEventListener('pointerdown', beginSidebarResize);
  }

  const resync = () => syncSidebarLayoutState();
  window.addEventListener('resize', resync, { passive: true });
  window.addEventListener('orientationchange', resync, { passive: true });
}

export function setCompactInFlight(value) {
  compactInFlight = !!value;
  updateCompactButton();
}

export function isCompactInFlight() {
  return compactInFlight;
}

export function setModelBanner(message) {
  const el = document.getElementById('model-banner');
  if (!el) return;
  const text = String(message || '').trim();
  if (!text) {
    el.textContent = '';
    el.classList.remove('visible');
    return;
  }
  el.textContent = text;
  el.classList.add('visible');
}

export function showTransientRelayNotice(message, ms = 4000) {
  const text = String(message || '').trim();
  if (!text) return;
  setModelBanner(text);
  setTimeout(() => {
    const el = document.getElementById('model-banner');
    if (!el) return;
    if (String(el.textContent || '').trim() === text) {
      setModelBanner('');
    }
  }, Math.max(1500, Number(ms) || 4000));
}

export function syncViewportMetrics() {
  const layoutHeight = window.innerHeight || document.documentElement.clientHeight || 0;
  const vv = window.visualViewport;
  let appHeight = layoutHeight;

  if (vv) {
    const visibleHeight = Math.max(0, vv.height || 0);
    const offsetTop = Math.max(0, vv.offsetTop || 0);
    const baselineCandidate = Math.max(layoutHeight, visibleHeight + offsetTop);
    if (baselineCandidate > viewportBaseHeight) viewportBaseHeight = baselineCandidate;
    appHeight = baselineCandidate;
  } else if (layoutHeight > viewportBaseHeight) {
    viewportBaseHeight = layoutHeight;
  }

  document.documentElement.style.setProperty('--app-height', `${Math.max(0, Math.round(appHeight))}px`);
}

export function setPullRefreshIndicator(distance, label, ready = false) {
  const el = document.getElementById('pull-refresh-indicator');
  if (!el) return;
  const span = el.querySelector('span');
  if (span) span.textContent = label;
  el.classList.add('visible');
  el.classList.toggle('ready', !!ready);
  el.style.transform = `translateY(${Math.min(distance / 2, 28)}px)`;
}

export function resetPullRefreshIndicator() {
  const el = document.getElementById('pull-refresh-indicator');
  if (!el) return;
  const span = el.querySelector('span');
  if (span) span.textContent = 'Pull down to refresh';
  el.classList.remove('visible', 'ready');
  el.style.transform = '';
}

export let summaryModalState = {
  kind: '',
  refresh: null,
  loading: false,
};

export function setSummaryModalLoading(loading) {
  summaryModalState.loading = !!loading;
  const refreshBtn = document.getElementById('summary-modal-refresh');
  if (refreshBtn) {
    refreshBtn.disabled = summaryModalState.loading || !summaryModalState.refresh;
    refreshBtn.textContent = summaryModalState.loading ? 'Loading…' : 'Refresh';
  }
}

export function renderSummaryModalContent({ title, subtitle = '', bodyHtml = '', refresh = null, kind = '' }) {
  summaryModalState.kind = String(kind || '').trim();
  summaryModalState.refresh = typeof refresh === 'function' ? refresh : null;

  const titleEl = document.getElementById('summary-modal-title');
  const subtitleEl = document.getElementById('summary-modal-subtitle');
  const bodyEl = document.getElementById('summary-modal-body');
  if (titleEl) titleEl.textContent = String(title || 'Details').trim() || 'Details';
  if (subtitleEl) subtitleEl.textContent = String(subtitle || '').trim();
  if (bodyEl) bodyEl.innerHTML = bodyHtml || '';
  setSummaryModalLoading(false);
}

export function openSummaryModal({ title, subtitle = '', bodyHtml = '', refresh = null, kind = '' }) {
  renderSummaryModalContent({ title, subtitle, bodyHtml, refresh, kind });
  const modal = document.getElementById('summary-modal');
  modal?.classList.add('visible');
  modal?.setAttribute('aria-hidden', 'false');
}

export function closeSummaryModal() {
  summaryModalState.kind = '';
  summaryModalState.refresh = null;
  summaryModalState.loading = false;
  const modal = document.getElementById('summary-modal');
  modal?.classList.remove('visible');
  modal?.setAttribute('aria-hidden', 'true');
  const titleEl = document.getElementById('summary-modal-title');
  const subtitleEl = document.getElementById('summary-modal-subtitle');
  const bodyEl = document.getElementById('summary-modal-body');
  if (titleEl) titleEl.textContent = 'Details';
  if (subtitleEl) subtitleEl.textContent = '';
  if (bodyEl) bodyEl.innerHTML = '';
  setSummaryModalLoading(false);
}

export async function refreshSummaryModal() {
  if (!summaryModalState.refresh || summaryModalState.loading) return;
  setSummaryModalLoading(true);
  try {
    await summaryModalState.refresh();
  } finally {
    setSummaryModalLoading(false);
  }
}

