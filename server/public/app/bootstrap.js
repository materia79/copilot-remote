import {
  TOKEN,
  CLIENT_ID,
  currentConvId,
  conversations,
  seenMessageIds,
  relayQuestions,
  relayBoards,
  relayQuestionDrafts,
  relayActivities,
  repoBrowserState,
  pendingUserMessageIds,
  escHtml,
  setToken,
  setCliOnline,
  setRelayOnline,
  setSessionWorkerStatesFromStatusPayload,
  setCurrentConv,
  updateWorkspaceRootHints,
  updateCliStatus,
  openSidebar,
  closeSidebar,
  updateCompactButton,
  updateSessionPill,
  setModelBanner,
  showTransientRelayNotice,
  applyContextUsageBar,
  scrollBottom,
  setPullRefreshIndicator,
  resetPullRefreshIndicator,
  setSummaryModalLoading,
  renderSummaryModalContent,
  openSummaryModal,
  closeSummaryModal,
  refreshSummaryModal,
  syncViewportMetrics,
  isMobileComposerViewport,
  releaseComposerFocusAfterSend,
  autoResize,
  clearPendingUserMessage,
  hasPendingUserMessageDuplicate,
  initSidebarLayout,
  toggleSidebar,
  loadConversationScrollTop,
  loadConversationLoadedMessageCount,
  saveConversationScrollTop,
} from './store.js';
import {
  verifyExistingSession,
  verifyToken,
  refreshWorkspaceRootHints,
  loadUsageSummary,
  loadContextSummary,
  loadModelCatalog,
  loadConversation,
  updateConversationTitle,
  updateConversationPreferences,
  killSessionWorker,
  scheduleContextUsageRefresh,
} from './api-client.js';
import { loadConversations, refreshConversations, openConversation, renderConvList, applyLoadedConversationState } from './journal-view.js';
import { newConversation, deleteConv } from './journal-view.js';
import { loadRelayQuestions, renderRelayQuestions, upsertRelayQuestion, updatePendingQuestionBanner } from './ask-user-view.js';
import { openPendingQuestionFromBanner, submitRelayQuestionChoice, submitRelayQuestionAnswer, onRelayQuestionDraftInput, handleRelayQuestionKey } from './ask-user-view.js';
import { loadRelayBoards, renderRelayBoards, upsertRelayBoard, submitRelayBoardAction } from './relay-board-view.js';
import { showThinking, removeThinking, renderThinkingActivities, appendThinkingActivity, applyRelayStreamEvent, clearRelayStreamStateForMessage, restoreInFlightThinking, applyConversationTurnStatus, renderMessages, appendMessage, compactCurrentConversation, sendMessage, handleKey, getConversationLoadedMessageCount, loadOlderConversationMessages, syncComposerControlState, getRenderedConversationMessageFingerprints } from './conversation-view.js';
import { loadRepoBrowserTree, openRepoBrowser, closeRepoBrowser, setRepoBrowserSessionInfo } from './attachments-view.js';
import { handleAttachmentInput, removeAttachment, clearAttachments, openUploadedAttachmentViewer, setFilePreviewMode, toggleFilePreviewHtml, closeFilePreview, openWorkspaceFilePreview, openWorkspaceFilePreviewFromRepo, setRepoBrowserRoot, setRepoBrowserViewMode, toggleRepoBrowserHidden, toggleRepoBrowserHeavy, refreshRepoBrowser, focusRepoTree, setRepoCurrentPath } from './attachments-view.js';
import { initEmojiPicker, toggleEmojiPicker } from './emoji-view.js';
import {
  resolveConversationComposerSelection,
  withUpdatedModelPreference,
  normalizePreferredModelsByMode,
} from './conversation-preferences.mjs';
import { isLikelyLiveDuplicateMessage } from './live-message-dedupe.mjs';

const MODEL_STORAGE_KEY = 'copilot_selected_model';
const MODE_STORAGE_KEY = 'copilot_selected_mode';
const MODELS_BY_MODE_STORAGE_KEY = 'copilot_selected_models_by_mode';
const FALLBACK_MODEL = 'gpt-5.4-mini';
const FALLBACK_MODE = 'agent';
const THEME_COLOR_BASE = '#0d1117';
const THEME_COLOR_IMMERSIVE = '#161b22';
const MODEL_LABELS = {
  'gpt-5.4': 'GPT-5.4',
  'gpt-5.4-mini': 'GPT-5.4 Mini',
  'gpt-5.3-codex': 'GPT-5.3 Codex',
  'claude-sonnet-4.6': 'Claude Sonnet 4.6',
  'claude-haiku-4.5': 'Claude Haiku 4.5',
};
const CURATED_MODELS = [
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.3-codex',
  'claude-sonnet-4.6',
  'claude-haiku-4.5',
];
const CHAT_TITLE_MAX_LENGTH = 120;

let socket = null;
let relayQuestionPollTimer = null;
let relayBoardPollTimer = null;
let sessionWorkerStatusPollTimer = null;
let viewportBaseHeight = window.innerHeight || document.documentElement.clientHeight || 0;
let deferredInstallPrompt = null;
let chatTitleEditingConversationId = null;
const INSTALLED_DISPLAY_MODE_QUERIES = ['(display-mode: standalone)', '(display-mode: fullscreen)'];
let pendingInstalledFullscreenGesture = false;
let relayQuestionRenderHash = '';
let modelCatalogState = {
  models: [FALLBACK_MODEL],
  currentModel: FALLBACK_MODEL,
  defaultModel: FALLBACK_MODEL,
  stale: false,
  warning: null,
  refreshedAt: null,
};
let activeConversationPreferredModelsByMode = {};
let suppressConversationPreferenceSync = false;
let conversationPreferenceWriteVersion = 0;
let pullRefreshState = {
  active: false,
  ready: false,
  startY: 0,
  refreshing: false,
};

function getTokenFromUrl() {
  return new URLSearchParams(window.location.search).get('token');
}

function stripTokenFromUrl() {
  const url = new URL(window.location.href);
  if (!url.searchParams.has('token')) return;
  url.searchParams.delete('token');
  history.replaceState(null, document.title, `${url.pathname}${url.search}${url.hash}`);
}

function ensureTrailingSlashPath() {
  const url = new URL(window.location.href);
  const path = url.pathname || '/';
  if (path === '/' || path.endsWith('/')) return false;
  const lastSegment = path.split('/').filter(Boolean).pop() || '';
  if (lastSegment.includes('.')) return false;
  url.pathname = `${path}/`;
  window.location.replace(url.toString());
  return true;
}

function showAuthError(msg) {
  document.getElementById('auth-error').textContent = msg;
}

function syncPwaVersionMenuEntry() {
  const chip = document.getElementById('chat-menu-pwa-version');
  if (!chip) return;
  const version = String(window.__COPILOT_PWA_VERSION || '').trim();
  chip.textContent = version ? `PWA shell version: v${version}` : 'PWA shell version: v?';
}

function updateModelCatalogState(payload) {
  const select = document.getElementById('model-select');
  if (!select) return;
  const models = Array.isArray(payload?.models)
    ? payload.models.map((m) => String(m || '').trim()).filter(Boolean)
    : [];
  const currentModel = String(payload?.currentModel || '').trim();
  const defaultModel = String(payload?.defaultModel || '').trim();
  const deduped = Array.from(new Set([...CURATED_MODELS, currentModel, defaultModel, ...models].filter(Boolean)));
  const nextModels = deduped.length ? deduped : [FALLBACK_MODEL];

  modelCatalogState = {
    models: nextModels,
    currentModel: currentModel || nextModels[0] || FALLBACK_MODEL,
    defaultModel: defaultModel || nextModels[0] || FALLBACK_MODEL,
    stale: !!payload?.stale,
    warning: payload?.warning ? String(payload.warning) : null,
    refreshedAt: payload?.refreshedAt || null,
  };

  const selectedBefore = select.value;
  const selectedMode = String(document.getElementById('mode-select')?.value || '').trim();
  const preferredForMode = String(activeConversationPreferredModelsByMode?.[selectedMode] || '').trim();
  select.innerHTML = '';
  for (const modelId of nextModels) {
    const opt = document.createElement('option');
    opt.value = modelId;
    opt.textContent = MODEL_LABELS[modelId] || modelId;
    select.appendChild(opt);
  }

  const preferred = [preferredForMode, selectedBefore, localStorage.getItem(MODEL_STORAGE_KEY), modelCatalogState.currentModel, modelCatalogState.defaultModel, nextModels[0]]
    .find((value) => value && nextModels.includes(value)) || nextModels[0];
  select.value = preferred;
  localStorage.setItem(MODEL_STORAGE_KEY, preferred);
  if (selectedMode) {
    activeConversationPreferredModelsByMode = withUpdatedModelPreference({
      preferredModelsByMode: activeConversationPreferredModelsByMode,
      mode: selectedMode,
      model: preferred,
      supportedModes: Array.from(document.getElementById('mode-select')?.options || []).map((option) => option.value),
    });
    localStorage.setItem(MODELS_BY_MODE_STORAGE_KEY, JSON.stringify(activeConversationPreferredModelsByMode));
  }

  if (modelCatalogState.warning) {
    setModelBanner(`⚠️ ${modelCatalogState.warning}`);
  } else if (modelCatalogState.stale) {
    setModelBanner('⚠️ Model list is cached from CLI; selection may be stale.');
  } else {
    setModelBanner('');
  }
}

function selectedModelValue() {
  const select = document.getElementById('model-select');
  const value = String(select?.value || '').trim();
  if (value) return value;
  return modelCatalogState.currentModel || modelCatalogState.defaultModel || FALLBACK_MODEL;
}

function readStoredModelsByMode() {
  const raw = String(localStorage.getItem(MODELS_BY_MODE_STORAGE_KEY) || '').trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    return {};
  }
}

function modeOptions() {
  return Array.from(document.getElementById('mode-select')?.options || []).map((option) => option.value);
}

function modelOptions() {
  return Array.from(document.getElementById('model-select')?.options || []).map((option) => option.value);
}

async function persistCurrentConversationPreferences() {
  const convId = String(currentConvId || '').trim();
  if (!convId || suppressConversationPreferenceSync) return;
  const modeSelect = document.getElementById('mode-select');
  const modelSelect = document.getElementById('model-select');
  if (!modeSelect || !modelSelect) return;
  const mode = String(modeSelect.value || '').trim() || FALLBACK_MODE;
  const model = String(modelSelect.value || '').trim();
  const supportedModes = modeOptions();
  activeConversationPreferredModelsByMode = withUpdatedModelPreference({
    preferredModelsByMode: activeConversationPreferredModelsByMode,
    mode,
    model,
    supportedModes,
  });
  localStorage.setItem(MODELS_BY_MODE_STORAGE_KEY, JSON.stringify(activeConversationPreferredModelsByMode));
  localStorage.setItem(MODE_STORAGE_KEY, mode);
  if (model) localStorage.setItem(MODEL_STORAGE_KEY, model);

  const writeVersion = ++conversationPreferenceWriteVersion;
  const response = await updateConversationPreferences(convId, {
    clientId: CLIENT_ID,
    preferredRelayMode: mode,
    preferredModelsByMode: activeConversationPreferredModelsByMode,
  });
  if (!response || writeVersion !== conversationPreferenceWriteVersion) return;
  if (conversations[convId]) {
    conversations[convId] = {
      ...conversations[convId],
      preferredRelayMode: response.preferredRelayMode,
      preferredModelsByMode: response.preferredModelsByMode,
    };
  }
}

function applyConversationPreferences({
  preferredRelayMode = '',
  preferredModelsByMode = {},
} = {}) {
  const modeSelect = document.getElementById('mode-select');
  const modelSelect = document.getElementById('model-select');
  if (!modeSelect || !modelSelect) return;

  const supportedModes = modeOptions();
  const supportedModels = modelOptions().length ? modelOptions() : modelCatalogState.models;
  const selection = resolveConversationComposerSelection({
    preferredRelayMode,
    preferredModelsByMode: normalizePreferredModelsByMode(preferredModelsByMode, { supportedModes }),
    selectedMode: modeSelect.value || localStorage.getItem(MODE_STORAGE_KEY) || FALLBACK_MODE,
    selectedModel: modelSelect.value || localStorage.getItem(MODEL_STORAGE_KEY) || FALLBACK_MODEL,
    supportedModes,
    supportedModels,
    fallbackMode: FALLBACK_MODE,
    fallbackModel: FALLBACK_MODEL,
  });
  suppressConversationPreferenceSync = true;
  modeSelect.value = selection.mode;
  if (selection.model) modelSelect.value = selection.model;
  suppressConversationPreferenceSync = false;

  activeConversationPreferredModelsByMode = {
    ...readStoredModelsByMode(),
    ...selection.preferredModelsByMode,
  };
  localStorage.setItem(MODELS_BY_MODE_STORAGE_KEY, JSON.stringify(activeConversationPreferredModelsByMode));
  localStorage.setItem(MODE_STORAGE_KEY, selection.mode);
  if (selection.model) localStorage.setItem(MODEL_STORAGE_KEY, selection.model);
}

function applyConversationPreferencesForConversation(conversationId, payload = {}) {
  const convId = String(conversationId || currentConvId || '').trim();
  const conversation = convId ? conversations[convId] : null;
  const preferredRelayMode = payload?.preferredRelayMode
    ?? conversation?.preferredRelayMode
    ?? localStorage.getItem(MODE_STORAGE_KEY)
    ?? FALLBACK_MODE;
  const preferredModelsByMode = payload?.preferredModelsByMode
    ?? conversation?.preferredModelsByMode
    ?? readStoredModelsByMode();
  applyConversationPreferences({
    preferredRelayMode,
    preferredModelsByMode,
  });
}

function initModelSelector() {
  const select = document.getElementById('model-select');
  if (!select) return;
  if (!select.dataset.bound) {
    select.dataset.bound = '1';
    select.addEventListener('change', () => {
      if (suppressConversationPreferenceSync) return;
      const mode = String(document.getElementById('mode-select')?.value || '').trim();
      activeConversationPreferredModelsByMode = withUpdatedModelPreference({
        preferredModelsByMode: activeConversationPreferredModelsByMode,
        mode,
        model: select.value,
        supportedModes: modeOptions(),
      });
      void persistCurrentConversationPreferences().catch(() => {});
    });
  }
}

function initModeSelector() {
  const select = document.getElementById('mode-select');
  if (!select) return;
  const saved = localStorage.getItem(MODE_STORAGE_KEY);
  const available = Array.from(select.options).map(o => o.value);
  if (saved && available.includes(saved)) {
    select.value = saved;
  } else if (!saved && available.includes(FALLBACK_MODE)) {
    select.value = FALLBACK_MODE;
  }
  if (select.dataset.bound === '1') return;
  select.dataset.bound = '1';
  select.addEventListener('change', () => {
    if (suppressConversationPreferenceSync) return;
    const modelSelect = document.getElementById('model-select');
    if (modelSelect) {
      const mode = String(select.value || '').trim();
      const modeModel = String(activeConversationPreferredModelsByMode?.[mode] || '').trim();
      if (modeModel && modelOptions().includes(modeModel)) {
        suppressConversationPreferenceSync = true;
        modelSelect.value = modeModel;
        suppressConversationPreferenceSync = false;
      }
    }
    void persistCurrentConversationPreferences().catch(() => {});
  });
}

function refreshModelCatalog(force = false) {
  return loadModelCatalog().then((r) => {
    if (!r) {
      if (force) setModelBanner('⚠️ Could not refresh live model list; using current selection.');
      return;
    }
    updateModelCatalogState(r);
  });
}

async function loadUsageSummaryAndRender() {
  const d = await loadUsageSummary();
  if (!d) throw new Error('Unable to load usage data');
  const pct = d.premiumInteractions.percentRemaining != null
    ? ` (${d.premiumInteractions.percentRemaining.toFixed(1)}% left)`
    : '';
  const msg = `Chat/Completions: ${d.chat.unlimited ? 'Unlimited ✅' : `${d.chat.remaining} remaining`}\n` +
    `Premium interactions: ${d.premiumInteractions.remaining} / ${d.premiumInteractions.entitlement} remaining${pct}`;
  renderSummaryModalContent({
    title: 'Copilot Usage',
    subtitle: `Resets ${d.resetDate || 'unknown'}`,
    bodyHtml: `<pre>${escHtml(msg)}</pre>`,
    refresh: loadUsageSummaryAndRender,
    kind: 'usage',
  });
}

async function loadContextSummaryAndRender(convId) {
  const trimmedConvId = String(convId || '').trim();
  const payload = await loadContextSummary(trimmedConvId);
  if (!payload) throw new Error('Unable to load context');
  const copilotSessionId = String(payload.copilotSessionId || payload.snapshot?.copilot_session_id || '').trim();
  const refreshLookupId = copilotSessionId || trimmedConvId || null;
  const title = trimmedConvId ? 'Current Context' : 'Latest Context';
  const subtitle = copilotSessionId
    ? `Copilot session ${copilotSessionId.slice(0, 8)}`
    : (trimmedConvId ? `Conversation ${trimmedConvId.slice(0, 8)}` : 'Latest runtime session');
  renderSummaryModalContent({
    title,
    subtitle,
    bodyHtml: `<pre>${escHtml(payload.text || 'No context data available.')}</pre>`,
    refresh: () => loadContextSummaryAndRender(refreshLookupId),
    kind: 'context',
  });
}

async function showUsage() {
  const btn = document.getElementById('chat-menu-usage') || document.getElementById('usage-btn');
  if (btn) {
    btn.textContent = '⏳';
    btn.disabled = true;
  }
  openSummaryModal({
    title: 'Copilot Usage',
    subtitle: 'Loading…',
    bodyHtml: '<div class="summary-loading">Fetching usage snapshot…</div>',
    refresh: loadUsageSummaryAndRender,
    kind: 'usage',
  });
  setSummaryModalLoading(true);
  try {
    await loadUsageSummaryAndRender();
  } catch (e) {
    renderSummaryModalContent({
      title: 'Copilot Usage',
      subtitle: 'Unable to load',
      bodyHtml: `<div class="summary-error">Failed to fetch usage: ${escHtml(e.message || 'Unknown error')}</div>`,
      refresh: loadUsageSummaryAndRender,
      kind: 'usage',
    });
  } finally {
    if (btn) {
      btn.textContent = btn.id === 'chat-menu-usage' ? '📊 Check Usage' : '📊';
      btn.disabled = false;
    }
  }
}

async function showContext() {
  const btn = document.getElementById('context-btn');
  const convId = String(currentConvId || '').trim();
  if (btn) {
    btn.textContent = '⏳';
    btn.disabled = true;
  }
  openSummaryModal({
    title: 'Current Context',
    subtitle: convId ? `Conversation ${convId.slice(0, 8)}` : 'Latest runtime session',
    bodyHtml: '<div class="summary-loading">Fetching context snapshot…</div>',
    refresh: () => loadContextSummaryAndRender(convId || null),
    kind: 'context',
  });
  setSummaryModalLoading(true);
  try {
    await loadContextSummaryAndRender(convId);
  } catch (e) {
    renderSummaryModalContent({
      title: 'Current Context',
      subtitle: 'Unable to load',
      bodyHtml: `<div class="summary-error">Failed to fetch context: ${escHtml(e.message || 'Unknown error')}</div>`,
      refresh: () => loadContextSummaryAndRender(convId || null),
      kind: 'context',
    });
  } finally {
    if (btn) {
      btn.textContent = '🧠';
      btn.disabled = false;
    }
  }
}

function renderSessionInstructionDocs(docs) {
  const items = Array.isArray(docs) ? docs : [];
  if (!items.length) {
    return '<div class="summary-loading">No session instruction files were found.</div>';
  }

  return `<div style="display:flex;flex-direction:column;gap:12px">${
    items.map((doc) => {
      const title = String(doc?.title || doc?.sessionId || 'Session instructions').trim();
      const name = String(doc?.name || '').trim();
      const gender = String(doc?.gender || '').trim();
      const summary = [name, gender].filter(Boolean).join(' · ');
      const sessionId = String(doc?.sessionId || '').trim();
      const updatedAt = String(doc?.updatedAt || '').trim();
      const content = escHtml(String(doc?.content || '').trim());
      return `
        <details open style="border:1px solid var(--border);border-radius:10px;background:var(--bg3);padding:10px 12px">
          <summary style="cursor:pointer;font-weight:600;outline:none">${escHtml(title)}</summary>
          <div style="margin-top:6px;font-size:0.78rem;color:var(--muted)">
            ${escHtml(summary || sessionId)}
            ${updatedAt ? ` · ${escHtml(updatedAt)}` : ''}
          </div>
          <pre style="margin-top:10px;white-space:pre-wrap;word-break:break-word">${content}</pre>
        </details>
      `;
    }).join('')
  }</div>`;
}


function matchesDisplayMode(query) {
  try {
    return !!window.matchMedia(query).matches;
  } catch {
    return false;
  }
}

function isInstalledAppMode() {
  const standalone = matchesDisplayMode('(display-mode: standalone)');
  const minimalUi = matchesDisplayMode('(display-mode: minimal-ui)');
  const launchedFromAndroidApp = String(document.referrer || '').startsWith('android-app://');
  return (
    window.navigator.standalone === true
    || launchedFromAndroidApp
    || standalone
    || minimalUi
  );
}

function isDisplayModeFullscreen() {
  return matchesDisplayMode('(display-mode: fullscreen)');
}

function isBrowserFullscreenMode() {
  return !!document.fullscreenElement;
}

function shouldUseImmersiveTopLayout() {
  return isDisplayModeFullscreen() || isBrowserFullscreenMode();
}

function syncThemeColor(immersive) {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) return;
  meta.setAttribute('content', immersive ? THEME_COLOR_IMMERSIVE : THEME_COLOR_BASE);
}

function syncInstalledAppUiState() {
  const installed = isInstalledAppMode();
  const immersive = shouldUseImmersiveTopLayout();
  document.body.classList.toggle('installed-app', installed);
  document.body.classList.toggle('immersive-top', immersive);
  syncThemeColor(immersive);
}

function canToggleFullscreen() {
  return !!document.documentElement.requestFullscreen || !!document.fullscreenElement;
}

async function ensureInstalledAppFullscreen(options = {}) {
  syncInstalledAppUiState();
  if (!isInstalledAppMode()) {
    return false;
  }
  if (isDisplayModeFullscreen() || document.fullscreenElement) {
    return true;
  }
  if (!canToggleFullscreen()) return false;
  if (!options.userGesture) return false;
  try {
    await document.documentElement.requestFullscreen();
    return true;
  } catch {
    return false;
  } finally {
    updateInstallButton();
    updateFullscreenButton();
  }
}

function shouldQueueInstalledFullscreen() {
  return isInstalledAppMode()
    && window.matchMedia('(max-width: 680px)').matches
    && canToggleFullscreen()
    && !document.fullscreenElement;
}

function queueInstalledFullscreenGesture() {
  pendingInstalledFullscreenGesture = shouldQueueInstalledFullscreen();
}

function consumeInstalledFullscreenGesture() {
  if (!pendingInstalledFullscreenGesture || !shouldQueueInstalledFullscreen()) return;
  pendingInstalledFullscreenGesture = false;
  ensureInstalledAppFullscreen({ userGesture: true }).catch(() => {
    pendingInstalledFullscreenGesture = true;
  });
}

function initInstalledFullscreenGestureBridge() {
  if (window.__installedFullscreenGestureBridgeBound) return;
  window.__installedFullscreenGestureBridgeBound = true;
  const consume = () => consumeInstalledFullscreenGesture();
  document.addEventListener('pointerdown', consume, true);
  document.addEventListener('keydown', consume, true);
  window.addEventListener('pageshow', () => {
    queueInstalledFullscreenGesture();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      queueInstalledFullscreenGesture();
    }
  });
}

function getInstallHelpMessage() {
  const ua = String(navigator.userAgent || '').toLowerCase();
  if (/iphone|ipad|ipod/.test(ua)) {
    return 'To install on iPhone/iPad: open this page in Safari, tap Share, then choose "Add to Home Screen".';
  }
  if (/android/.test(ua)) {
    return 'To install on Android: open the browser menu (⋮) and choose "Install app" or "Add to Home screen". If Chrome says the app is already installed, open it from your launcher or uninstall the old copy first.';
  }
  return 'To install: open your browser menu and choose "Install app" or "Add to Home screen".';
}

function updateInstallButton() {
  const btn = document.getElementById('install-btn');
  if (!btn) return;
  syncInstalledAppUiState();

  if (isInstalledAppMode()) {
    btn.style.display = 'none';
    return;
  }

  const title = deferredInstallPrompt ? 'Install app to home screen' : 'Show install instructions';
  btn.textContent = '⬇';
  btn.style.display = 'inline-flex';
  btn.title = title;
}

async function promptInstallApp() {
  if (!deferredInstallPrompt) {
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  if (deferredInstallPrompt) {
    try {
      deferredInstallPrompt.prompt();
      const choice = await deferredInstallPrompt.userChoice.catch(() => null);
      if (choice?.outcome === 'accepted') {
        showTransientRelayNotice('Install accepted. The app will appear on your home screen.');
      }
    } finally {
      deferredInstallPrompt = null;
      updateInstallButton();
    }
    return;
  }

  alert(getInstallHelpMessage());
}

function initInstallButton() {
  if (window.__installButtonBound) {
    updateInstallButton();
    initInstalledFullscreenGestureBridge();
    queueInstalledFullscreenGesture();
    ensureInstalledAppFullscreen().catch(() => {});
    return;
  }
  window.__installButtonBound = true;
  initInstalledFullscreenGestureBridge();

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    updateInstallButton();
    updateFullscreenButton();
  });

  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    updateInstallButton();
    updateFullscreenButton();
    queueInstalledFullscreenGesture();
    ensureInstalledAppFullscreen().catch(() => {});
    showTransientRelayNotice('App installed.');
  });

  window.addEventListener('resize', () => {
    updateInstallButton();
    updateFullscreenButton();
  }, { passive: true });

  for (const query of INSTALLED_DISPLAY_MODE_QUERIES) {
    const media = window.matchMedia(query);
    if (media && typeof media.addEventListener === 'function') {
      media.addEventListener('change', () => {
        updateInstallButton();
        updateFullscreenButton();
        queueInstalledFullscreenGesture();
        ensureInstalledAppFullscreen().catch(() => {});
      });
    }
  }

  updateInstallButton();
  updateFullscreenButton();
  queueInstalledFullscreenGesture();
  ensureInstalledAppFullscreen().catch(() => {});
}

async function toggleFullscreen() {
  if (isInstalledAppMode()) {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else {
      ensureInstalledAppFullscreen({ userGesture: true }).catch(() => {});
    }
    return;
  }
  if (!canToggleFullscreen()) return;
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else {
      await document.documentElement.requestFullscreen();
    }
  } catch {
  } finally {
    updateInstallButton();
    updateFullscreenButton();
  }
}

function updateFullscreenButton() {
  const btn = document.getElementById('fullscreen-btn');
  if (!btn) return;
  syncInstalledAppUiState();
  if (isInstalledAppMode() || isDisplayModeFullscreen()) {
    btn.style.display = 'none';
    return;
  }

  const mobile = window.matchMedia('(max-width: 680px)').matches;
  if (!mobile) {
    btn.style.display = 'none';
    return;
  }

  const full = !!document.fullscreenElement;
  const supported = canToggleFullscreen();
  btn.style.display = 'inline-flex';
  btn.disabled = !supported;

  if (full) {
    btn.textContent = '⤢';
    btn.title = 'Exit fullscreen';
  } else {
    btn.textContent = '⛶';
    btn.title = isInstalledAppMode()
      ? (supported ? 'Enter fullscreen (recommended for installed app)' : 'Fullscreen not supported on this browser')
      : (supported ? 'Enter fullscreen' : 'Fullscreen not supported on this browser');
  }
}

function startRelayQuestionPolling() {
  if (relayQuestionPollTimer) return;
  relayQuestionPollTimer = setInterval(() => {
    loadRelayQuestions(currentConvId).catch(() => {});
  }, 3000);
}

function startRelayBoardPolling() {
  if (relayBoardPollTimer) return;
  relayBoardPollTimer = setInterval(() => {
    loadRelayBoards().catch(() => {});
  }, 3000);
}

async function refreshSessionWorkerStatus() {
  const status = await refreshWorkspaceRootHints();
  if (!status) return;
  if (setSessionWorkerStatesFromStatusPayload(status.sessionWorker)) {
    renderConvList();
  }
  updateCliStatus();
}

function startSessionWorkerStatusPolling() {
  if (sessionWorkerStatusPollTimer) return;
  sessionWorkerStatusPollTimer = setInterval(() => {
    refreshSessionWorkerStatus().catch(() => {});
  }, 4000);
}

function setupViewportTracking() {
  syncViewportMetrics();
  const update = () => syncViewportMetrics();
  window.addEventListener('resize', update, { passive: true });
  window.addEventListener('orientationchange', update, { passive: true });
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', update, { passive: true });
    window.visualViewport.addEventListener('scroll', update, { passive: true });
  }

  const input = document.getElementById('msg-input');
  if (input && input.dataset.viewportBound !== '1') {
    input.dataset.viewportBound = '1';
    input.addEventListener('input', () => {
      syncComposerControlState();
    }, { passive: true });
    input.addEventListener('focus', () => {
      document.body.classList.add('keyboard-open');
      syncViewportMetrics();
    }, { passive: true });
    input.addEventListener('blur', () => {
      document.body.classList.remove('keyboard-open');
      syncViewportMetrics();
    }, { passive: true });
  }
}

function initPullToRefresh() {
  const el = document.getElementById('messages');
  if (!el || el.dataset.pullRefreshBound === '1') return;
  el.dataset.pullRefreshBound = '1';
  el.addEventListener('touchstart', onMessagesTouchStart, { passive: true });
  el.addEventListener('touchmove', onMessagesTouchMove, { passive: false });
  el.addEventListener('touchend', onMessagesTouchEnd, { passive: true });
  el.addEventListener('touchcancel', onMessagesTouchEnd, { passive: true });
}

function initMessageScrollPersistence() {
  const el = document.getElementById('messages');
  if (!el || el.dataset.scrollPersistenceBound === '1') return;
  el.dataset.scrollPersistenceBound = '1';
  el.addEventListener('scroll', () => {
    const convId = String(currentConvId || '').trim();
    if (!convId) return;
    saveConversationScrollTop(convId, el.scrollTop);
  }, { passive: true });
}

function onMessagesTouchStart(event) {
  const el = event.currentTarget;
  if (!el || el.scrollTop > 0 || pullRefreshState.refreshing) return;
  const touch = event.touches?.[0];
  if (!touch) return;

  pullRefreshState = {
    active: true,
    ready: false,
    startY: touch.clientY,
    refreshing: pullRefreshState.refreshing,
  };
  setPullRefreshIndicator(0, 'Pull down to refresh');
}

function onMessagesTouchMove(event) {
  if (!pullRefreshState.active) return;
  const el = event.currentTarget;
  if (!el || el.scrollTop > 0) {
    resetPullRefreshIndicator();
    return;
  }
  const touch = event.touches?.[0];
  if (!touch) return;
  const delta = touch.clientY - pullRefreshState.startY;
  if (delta <= 0) {
    resetPullRefreshIndicator();
    return;
  }
  const distance = Math.min(delta, 120);
  const ready = distance >= 72;
  pullRefreshState.ready = ready;
  setPullRefreshIndicator(distance, ready ? 'Release to refresh' : 'Pull down to refresh', ready);
  if (delta > 6) event.preventDefault();
}

async function onMessagesTouchEnd() {
  if (!pullRefreshState.active) return;
  const shouldRefresh = pullRefreshState.ready && !pullRefreshState.refreshing;
  pullRefreshState.active = false;
  pullRefreshState.ready = false;
  if (!shouldRefresh) {
    resetPullRefreshIndicator();
    return;
  }
  pullRefreshState.refreshing = true;
  setPullRefreshIndicator(72, 'Refreshing…', true);
  try {
    await refreshCurrentView();
  } finally {
    pullRefreshState.refreshing = false;
    resetPullRefreshIndicator();
  }
}

let refreshViewVersion = 0;

async function refreshCurrentView() {
  const capturedVersion = ++refreshViewVersion;
  const messagesEl = document.getElementById('messages');
  const scrollTop = messagesEl?.scrollTop || 0;

  await refreshConversations();

  const currentId = String(currentConvId || '').trim();
  if (!currentId) {
    setRepoBrowserSessionInfo('', '');
    renderMessages([]);
    restoreInFlightThinking(null);
    scheduleContextUsageRefresh(null);
    return;
  }

  const savedLoadedCount = loadConversationLoadedMessageCount(currentId);
  const requestLimit = Math.max(20, getConversationLoadedMessageCount() || 0, savedLoadedCount || 0);
  const r = await loadConversation(currentId, { limit: requestLimit });
  if (capturedVersion < refreshViewVersion) return;
  if (String(currentConvId || '').trim() !== currentId) return;
  if (r) {
    applyLoadedConversationState(currentId, r, { restoreScroll: false });
  } else {
    setRepoBrowserSessionInfo('', '');
    restoreInFlightThinking(null);
  }
  await loadRelayQuestions(currentId);
  await loadRelayBoards();
  scheduleContextUsageRefresh(currentId, 0);
  if (messagesEl && String(currentConvId || '').trim() === currentId) {
    const savedScrollTop = loadConversationScrollTop(currentId);
    const nextScrollTop = Number.isFinite(savedScrollTop) ? savedScrollTop : scrollTop;
    messagesEl.scrollTop = nextScrollTop;
    if (Number.isFinite(nextScrollTop) && nextScrollTop >= 0) {
      saveConversationScrollTop(currentId, nextScrollTop);
    }
  }
}

async function copyTextToClipboard(text) {
  const value = String(text || '').trim();
  if (!value) return false;
  if (navigator?.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {}
  }
  try {
    const el = document.createElement('textarea');
    el.value = value;
    el.setAttribute('readonly', 'readonly');
    el.style.position = 'fixed';
    el.style.opacity = '0';
    document.body.appendChild(el);
    el.focus();
    el.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(el);
    return !!ok;
  } catch {
    return false;
  }
}

function initChatTitleCopy() {
  const title = document.getElementById('chat-title');
  if (!title || title.dataset.copyBound === '1') return;
  title.dataset.copyBound = '1';
  if (title.dataset.fullscreenBound) delete title.dataset.fullscreenBound;

  title.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    const sessionId = String(title.dataset.copilotSessionId || '').trim();
    if (!sessionId) return;
    copyTextToClipboard(sessionId).then((ok) => {
      if (ok) {
        showTransientRelayNotice(`Copied Copilot session ID: ${sessionId.slice(0, 8)}…`);
      } else {
        showTransientRelayNotice('Could not copy session ID.');
      }
    }).catch(() => {});
  }, true);
}

function getChatTitleElements() {
  return {
    wrap: document.getElementById('chat-title-wrap'),
    title: document.getElementById('chat-title'),
    editBtn: document.getElementById('chat-actions-menu-btn'),
    editor: document.getElementById('chat-title-editor'),
    input: document.getElementById('chat-title-input'),
    saveBtn: document.getElementById('chat-title-save-btn'),
    cancelBtn: document.getElementById('chat-title-cancel-btn'),
  };
}

function closeChatActionsMenu() {
  const menu = document.getElementById('chat-actions-menu');
  const trigger = document.getElementById('chat-actions-menu-btn');
  const backdrop = document.getElementById('chat-actions-menu-backdrop');
  if (menu) menu.hidden = true;
  if (trigger) trigger.setAttribute('aria-expanded', 'false');
  if (backdrop && !window.__chatActionsMenuShieldTimer) backdrop.classList.remove('visible');
}

function toggleChatActionsMenu() {
  const menu = document.getElementById('chat-actions-menu');
  const trigger = document.getElementById('chat-actions-menu-btn');
  if (!menu || !trigger || trigger.hidden || trigger.disabled) return;
  const willOpen = !!menu.hidden;
  menu.hidden = !willOpen;
  trigger.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
}

function lockChatActionsMenuShield(ms = 300) {
  const backdrop = document.getElementById('chat-actions-menu-backdrop');
  if (!backdrop) return;
  if (window.__chatActionsMenuShieldTimer) {
    window.clearTimeout(window.__chatActionsMenuShieldTimer);
  }
  backdrop.classList.add('visible');
  window.__chatActionsMenuShieldTimer = window.setTimeout(() => {
    window.__chatActionsMenuShieldTimer = null;
    const menu = document.getElementById('chat-actions-menu');
    if (menu?.hidden) backdrop.classList.remove('visible');
  }, Math.max(150, Number(ms) || 300));
}

function bindTapAction(element, handler) {
  if (!element || element.dataset.tapBound === '1') return;
  element.dataset.tapBound = '1';
  let suppressClickUntil = 0;
  const markSuppressed = (ms = 450) => {
    suppressClickUntil = Date.now() + Math.max(200, Number(ms) || 450);
  };
  element.addEventListener('pointerup', (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    markSuppressed();
    handler(event);
  });
  element.addEventListener('click', (event) => {
    if (Date.now() < suppressClickUntil) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    handler(event);
  });
}

function bindMenuAction(element, handler) {
  if (!element || element.dataset.menuTapBound === '1') return;
  element.dataset.menuTapBound = '1';
  let suppressClickUntil = 0;
  const markSuppressed = (ms = 450) => {
    suppressClickUntil = Date.now() + Math.max(200, Number(ms) || 450);
  };
  element.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    markSuppressed();
    handler(event);
  }, true);
  element.addEventListener('click', (event) => {
    if (Date.now() < suppressClickUntil) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      return;
    }
    handler(event);
  }, true);
}

function syncChatTitleControls() {
  const { title, editBtn, editor, input } = getChatTitleElements();
  const convId = String(currentConvId || '').trim();
  const killBtn = document.getElementById('chat-menu-kill-session');
  const sdkSessionId = String(conversations[convId]?.sdkSessionId || '').trim();
  if (chatTitleEditingConversationId && chatTitleEditingConversationId !== convId) {
    chatTitleEditingConversationId = null;
  }
  const editing = convId && chatTitleEditingConversationId === convId;
  document.body.classList.toggle('chat-title-editing', !!editing);
  if (title) title.hidden = editing;
  if (editBtn) {
    editBtn.hidden = !convId;
    editBtn.disabled = !convId || editing;
  }
  if (killBtn) {
    killBtn.disabled = !convId || !sdkSessionId;
    killBtn.hidden = !convId;
  }
  if (editor) {
    editor.hidden = !editing;
  }
  if (input) {
    input.maxLength = CHAT_TITLE_MAX_LENGTH;
  }
  if (!convId && chatTitleEditingConversationId) {
    chatTitleEditingConversationId = null;
  }
  if (!editing && editor && !editor.hidden) {
    editor.hidden = true;
  }
}

function openChatTitleEditor() {
  const convId = String(currentConvId || '').trim();
  if (!convId) return;
  const { title, editBtn, editor, input } = getChatTitleElements();
  closeChatActionsMenu();
  const currentTitle = String(conversations[convId]?.title || title?.textContent || convId).trim() || convId;
  chatTitleEditingConversationId = convId;
  document.body.classList.add('chat-title-editing');
  if (title) title.hidden = true;
  if (editBtn) editBtn.disabled = true;
  if (editor) editor.hidden = false;
  if (input) {
    input.maxLength = CHAT_TITLE_MAX_LENGTH;
    input.value = currentTitle;
    requestAnimationFrame(() => {
      if (chatTitleEditingConversationId !== convId) return;
      window.setTimeout(() => {
        if (chatTitleEditingConversationId !== convId) return;
        input.focus({ preventScroll: true });
        input.select();
      }, 50);
    });
  }
}

function closeChatTitleEditor() {
  chatTitleEditingConversationId = null;
  document.body.classList.remove('chat-title-editing');
  const { title, editBtn, editor, input } = getChatTitleElements();
  closeChatActionsMenu();
  if (editor) editor.hidden = true;
  if (title) title.hidden = !String(currentConvId || '').trim();
  if (editBtn) editBtn.disabled = !String(currentConvId || '').trim();
  if (input) {
    const convId = String(currentConvId || '').trim();
    input.value = convId ? String(conversations[convId]?.title || title?.textContent || convId) : '';
  }
  syncChatTitleControls();
}

function applyConversationTitleUpdate(conversationId, title, updatedAt) {
  const id = String(conversationId || '').trim();
  const nextTitle = String(title || '').trim();
  if (!id || !nextTitle) return;
  const existing = conversations[id] || { id, archived: false, messageCount: 0 };
  conversations[id] = {
    ...existing,
    title: nextTitle,
    updatedAt: String(updatedAt || existing.updatedAt || new Date().toISOString()),
  };
  if (currentConvId === id) {
    const titleEl = document.getElementById('chat-title');
    if (titleEl) titleEl.textContent = nextTitle;
  }
  renderConvList();
}

function getCurrentConversationSessionInfo() {
  const convId = String(currentConvId || '').trim();
  if (!convId) return null;
  const conversation = conversations[convId] || {};
  const sdkSessionId = String(conversation.sdkSessionId || '').trim();
  if (!sdkSessionId) return null;
  const title = String(conversation.title || document.getElementById('chat-title')?.textContent || convId).trim() || convId;
  return {
    conversationId: convId,
    sdkSessionId,
    title,
  };
}

function openKillSessionConfirmation() {
  const info = getCurrentConversationSessionInfo();
  if (!info) {
    showTransientRelayNotice('No active session is bound to this conversation.');
    return;
  }
  const escapedTitle = escHtml(info.title);
  openSummaryModal({
    title: 'Kill session',
    subtitle: info.sdkSessionId,
    kind: 'kill-session',
    bodyHtml: `
      <p>Kill the session for <strong>${escapedTitle}</strong>?</p>
      <p>This stops the current worker and any active turn will need a manual retry or a new message.</p>
      <div class="summary-modal-actions">
        <button class="chat-title-action-btn danger-btn" type="button" onclick="confirmKillCurrentSession()">☠️ Kill session</button>
        <button class="chat-title-action-btn" type="button" onclick="closeSummaryModal()">Cancel</button>
      </div>
    `,
  });
}

let killSessionInFlight = false;

async function confirmKillCurrentSession() {
  if (killSessionInFlight) return;
  const info = getCurrentConversationSessionInfo();
  if (!info) {
    closeSummaryModal();
    showTransientRelayNotice('No active session is bound to this conversation.');
    return;
  }
  killSessionInFlight = true;
  setSummaryModalLoading(true);
  try {
    const result = await killSessionWorker(info.sdkSessionId, {
      conversationId: info.conversationId,
      title: info.title,
    });
    closeSummaryModal();
    if (!result?.ok) {
      alert('Failed to kill session');
      return;
    }
    const statusText = result.processStatus === 'killed'
      ? 'Session killed.'
      : 'Session state cleared; no live worker process was found.';
    showTransientRelayNotice(statusText);
    await refreshSessionWorkerStatus().catch(() => {});
  } finally {
    killSessionInFlight = false;
    setSummaryModalLoading(false);
  }
}

async function submitChatTitleEditor() {
  const convId = String(chatTitleEditingConversationId || currentConvId || '').trim();
  if (!convId) return;
  const { input } = getChatTitleElements();
  const nextTitle = String(input?.value || '').replace(/[\r\n]+/g, ' ').trim();
  if (!nextTitle) {
    setModelBanner('⚠️ Conversation title cannot be empty.');
    input?.focus();
    return;
  }
  if (nextTitle.length > CHAT_TITLE_MAX_LENGTH) {
    setModelBanner(`⚠️ Conversation title must be ${CHAT_TITLE_MAX_LENGTH} characters or fewer.`);
    input?.focus();
    return;
  }

  const result = await updateConversationTitle(convId, nextTitle);
  if (!result) {
    alert('Failed to update conversation title');
    return;
  }

  applyConversationTitleUpdate(result.conversationId || convId, result.title || nextTitle, result.updatedAt);
  closeChatTitleEditor();
}

function initFullscreenButton() {
  const syncFullscreenUi = () => {
    updateInstallButton();
    updateFullscreenButton();
    queueInstalledFullscreenGesture();
    ensureInstalledAppFullscreen().catch(() => {});
  };
  document.addEventListener('fullscreenchange', syncFullscreenUi);
  window.addEventListener('resize', syncFullscreenUi);
  for (const query of INSTALLED_DISPLAY_MODE_QUERIES) {
    const media = window.matchMedia(query);
    if (media && typeof media.addEventListener === 'function') {
      media.addEventListener('change', syncFullscreenUi);
    }
  }
  updateFullscreenButton();
  ensureInstalledAppFullscreen().catch(() => {});
}

async function connectSocket() {
  socket = io({ path: `${window.location.pathname.replace(/\/+$/, '')}/socket.io/`, auth: TOKEN ? { token: TOKEN, clientId: CLIENT_ID } : { clientId: CLIENT_ID } });

  socket.on('connect', () => {
    console.log('Socket connected');
    setRelayOnline(true);
    setCliOnline(true);
    renderConvList();
    refreshCurrentView().catch(() => {});
    refreshSessionWorkerStatus().catch(() => {});
    refreshModelCatalog().catch(() => {});
  });
  socket.on('connect_error', (e) => {
    setRelayOnline(false);
    console.error('Socket error:', e.message);
  });
  socket.on('disconnect', () => {
    setRelayOnline(false);
  });
  socket.on('cli_status', ({ online }) => {
    setCliOnline(online);
    renderConvList();
    if (online) refreshCurrentView().catch(() => {});
    refreshSessionWorkerStatus().catch(() => {});
    if (online) refreshModelCatalog().catch(() => {});
  });
  socket.on('models_updated', (payload) => {
    updateModelCatalogState(payload || {});
  });
  socket.on('workspace_root_changed', (payload) => {
    updateWorkspaceRootHints(payload || {});
    if (repoBrowserState.activeRoot !== 'workspace') return;
    repoBrowserState.currentPath = '';
    if (repoBrowserState.open) {
      void loadRepoBrowserTree();
    }
  });
  socket.on('user_message', ({ conversationId, messageId, senderClientId, message }) => {
    if (senderClientId && senderClientId === CLIENT_ID) {
      pendingUserMessageIds.delete(messageId);
      return;
    }
    if (messageId && (pendingUserMessageIds.has(messageId) || seenMessageIds?.has(messageId))) {
      pendingUserMessageIds.delete(messageId);
      return;
    }
    if (conversationId === currentConvId) {
      const renderedMessages = getRenderedConversationMessageFingerprints(24);
      const hasPendingTextMatch = hasPendingUserMessageDuplicate(conversationId, message?.text);
      if (isLikelyLiveDuplicateMessage({
        incomingMessageId: messageId,
        incomingMessage: message,
        existingMessages: renderedMessages,
        hasPendingTextMatch,
      })) {
        return;
      }
      appendMessage(message, true, messageId);
    }
  });
  socket.on('assistant_message', ({ conversationId, message, messageId, sourceMessageId }) => {
    removeThinking();
    if ((!message?.activities || !message.activities.length) && sourceMessageId) {
      const cached = relayActivities.get(sourceMessageId) || [];
      if (cached.length) message.activities = cached.slice(0, 48);
    }
    if (messageId && seenMessageIds?.has(messageId)) return;
    if (conversationId === currentConvId) {
      appendMessage(message, true, messageId || null, false, sourceMessageId || null);
      scheduleContextUsageRefresh(conversationId, 120);
    }
    if (sourceMessageId) relayActivities.delete(sourceMessageId);
    if (sourceMessageId) clearRelayStreamStateForMessage(sourceMessageId);
    refreshSessionWorkerStatus().catch(() => {});
  });
  socket.on('relay_question', ({ question }) => upsertRelayQuestion(question));
  socket.on('relay_question_updated', ({ question }) => upsertRelayQuestion(question));
  socket.on('relay_question_changed', () => {
    loadRelayQuestions(currentConvId);
  });
  socket.on('relay_board', ({ board }) => upsertRelayBoard(board));
  socket.on('relay_board_updated', ({ board }) => upsertRelayBoard(board));
  socket.on('relay_board_changed', () => {
    loadRelayBoards();
  });
  socket.on('relay_activity', ({ conversationId, messageId, text }) => {
    if (!messageId || !text) return;
    const items = relayActivities.get(messageId) || [];
    const last = items[items.length - 1];
    if (last !== text) relayActivities.set(messageId, items.concat(text).slice(-24));
    if (conversationId === currentConvId) appendThinkingActivity(text);
  });
  socket.on('relay_stream', ({ conversationId, messageId, text, done, seq }) => {
    if (!messageId) return;
    if (conversationId !== currentConvId) return;
    applyRelayStreamEvent({
      messageId,
      text: String(text || ''),
      done: !!done,
      seq,
    });
  });
  socket.on('conversation_compacted', async ({ sourceConversationId, targetConversationId }) => {
    if (!sourceConversationId || !targetConversationId) return;
    await refreshConversations();
    if (currentConvId === sourceConversationId) {
      await openConversation(targetConversationId);
    } else {
      updateCompactButton();
    }
  });
  socket.on('conversation_title_updated', ({ conversationId, title, updatedAt }) => {
    applyConversationTitleUpdate(conversationId, title, updatedAt);
    syncChatTitleControls();
  });
  socket.on('conversation_preferences_updated', ({ conversationId, preferredRelayMode, preferredModelsByMode, senderClientId }) => {
    if (senderClientId && senderClientId === CLIENT_ID) return;
    const id = String(conversationId || '').trim();
    if (!id || !conversations[id]) return;
    conversations[id] = {
      ...conversations[id],
      preferredRelayMode: preferredRelayMode || conversations[id].preferredRelayMode || FALLBACK_MODE,
      preferredModelsByMode: preferredModelsByMode || conversations[id].preferredModelsByMode || {},
    };
    if (String(currentConvId || '').trim() === id) {
      applyConversationPreferencesForConversation(id, {
        preferredRelayMode,
        preferredModelsByMode,
      });
    }
  });
  socket.on('conversation_session_bound', async ({ conversationId, sdkSessionId, runtimeSessionId }) => {
    const id = String(conversationId || '').trim();
    if (!id) return;
    if (conversations[id]) {
      conversations[id] = {
        ...conversations[id],
        sdkSessionId: String(sdkSessionId || conversations[id].sdkSessionId || '').trim() || null,
        runtimeSessionId: String(runtimeSessionId || conversations[id].runtimeSessionId || '').trim() || null,
      };
    }
    await refreshConversations();
    if (currentConvId === id) {
      await openConversation(id);
    }
  });
  socket.on('message_status', ({ messageId, conversationId, status }) => {
    applyConversationTurnStatus({ conversationId, messageId, status });
    if (conversationId && conversations[conversationId]) {
      if (status === 'processing') {
        conversations[conversationId].runtimeSessionStatus = 'processing';
      } else if (status === 'done' || status === 'failed' || status === 'dropped') {
        delete conversations[conversationId].runtimeSessionStatus;
      }
    }
    if (conversationId === currentConvId && status === 'processing') {
      showThinking(messageId || null);
      renderThinkingActivities();
    }
    if (status === 'done' || status === 'failed' || status === 'dropped') {
      clearPendingUserMessage(messageId);
      if (messageId) clearRelayStreamStateForMessage(messageId);
    }
    if (conversationId === currentConvId && (status === 'done' || status === 'failed' || status === 'dropped')) {
      removeThinking();
      void refreshCurrentView().catch(() => {});
      scheduleContextUsageRefresh(conversationId, 220);
      refreshSessionWorkerStatus().catch(() => {});
    }
    renderConvList();
  });
  socket.on('conversation_deleted', ({ conversationId }) => {
    delete conversations[conversationId];
    for (const [id, question] of relayQuestions.entries()) {
      if (question?.conversationId === conversationId) relayQuestions.delete(id);
    }
    for (const [id, board] of relayBoards.entries()) {
      if (board?.conversationId === conversationId) relayBoards.delete(id);
    }
    for (const id of relayQuestionDrafts.keys()) {
      const q = relayQuestionDrafts.get(id);
      if (!q || q.conversationId === conversationId) relayQuestionDrafts.delete(id);
    }
    updatePendingQuestionBanner();
    renderRelayBoards();
    renderConvList();
    if (currentConvId === conversationId) {
      setCurrentConv(null);
      renderMessages([]);
      document.getElementById('chat-title').textContent = 'Select or start a conversation';
      syncChatTitleControls();
      updateSessionPill(null, null);
      updateCompactButton();
      scheduleContextUsageRefresh(null);
    } else {
      updateCompactButton();
    }
  });
}

function showAuthGate() {
  document.getElementById('auth-gate').style.display = 'flex';
  document.getElementById('app').classList.remove('visible');
}

async function initApp() {
  syncPwaVersionMenuEntry();
  setupViewportTracking();
  document.getElementById('auth-gate').style.display = 'none';
  document.getElementById('app').classList.add('visible');
  initSidebarLayout();
  const chatActionsMenuBtn = document.getElementById('chat-actions-menu-btn');
  bindTapAction(chatActionsMenuBtn, (event) => {
    event.preventDefault();
    event.stopPropagation();
    toggleChatActionsMenu();
  });
  const chatMenuEditBtn = document.getElementById('chat-menu-edit-title');
  const chatMenuUsageBtn = document.getElementById('chat-menu-usage');
  bindMenuAction(chatMenuUsageBtn, (event) => {
    event.preventDefault();
    event.stopPropagation();
    lockChatActionsMenuShield(350);
    closeChatActionsMenu();
    showUsage().catch((error) => {
      alert(error?.message || 'Failed to load usage');
    });
  });
  bindMenuAction(chatMenuEditBtn, (event) => {
    event.preventDefault();
    event.stopPropagation();
    lockChatActionsMenuShield(350);
    closeChatActionsMenu();
    openChatTitleEditor();
  });
  const chatMenuCompactBtn = document.getElementById('chat-menu-compact');
  bindMenuAction(chatMenuCompactBtn, (event) => {
    event.preventDefault();
    event.stopPropagation();
    lockChatActionsMenuShield(350);
    closeChatActionsMenu();
    compactCurrentConversation().catch((error) => {
      alert(error?.message || 'Failed to compact conversation');
    });
  });
  const chatMenuKillBtn = document.getElementById('chat-menu-kill-session');
  bindMenuAction(chatMenuKillBtn, (event) => {
    event.preventDefault();
    event.stopPropagation();
    lockChatActionsMenuShield(350);
    closeChatActionsMenu();
    openKillSessionConfirmation();
  });
  const sidebarToggleBtn = document.getElementById('sidebar-toggle');
  bindTapAction(sidebarToggleBtn, (event) => {
    event.preventDefault();
    event.stopPropagation();
    toggleSidebar();
  });
  if (!window.__chatActionsMenuBound) {
    window.__chatActionsMenuBound = true;
    document.addEventListener('click', (event) => {
      const menuWrap = document.getElementById('chat-actions-menu-wrap');
      if (!menuWrap) return;
      if (menuWrap.contains(event.target)) return;
      closeChatActionsMenu();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      closeChatActionsMenu();
    });
  }
  const chatTitleEditor = document.getElementById('chat-title-editor');
  if (chatTitleEditor && chatTitleEditor.dataset.bound !== '1') {
    chatTitleEditor.dataset.bound = '1';
    chatTitleEditor.addEventListener('submit', (event) => {
      event.preventDefault();
      submitChatTitleEditor().catch((error) => {
        alert(error?.message || 'Failed to update conversation title');
      });
    });
  }
  const chatTitleInput = document.getElementById('chat-title-input');
  if (chatTitleInput && chatTitleInput.dataset.bound !== '1') {
    chatTitleInput.dataset.bound = '1';
    chatTitleInput.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeChatTitleEditor();
      }
    });
  }
  const chatTitleCancelBtn = document.getElementById('chat-title-cancel-btn');
  if (chatTitleCancelBtn && chatTitleCancelBtn.dataset.bound !== '1') {
    chatTitleCancelBtn.dataset.bound = '1';
    chatTitleCancelBtn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      closeChatTitleEditor();
    });
  }
  initModeSelector();
  initModelSelector();
  const status = await refreshWorkspaceRootHints();
  setSessionWorkerStatesFromStatusPayload(status?.sessionWorker || null);
  await refreshModelCatalog(true);
  initFullscreenButton();
  initInstallButton();
  initPullToRefresh();
  initChatTitleCopy();
  initEmojiPicker();
  initMessageScrollPersistence();
  syncChatTitleControls();
  connectSocket();
  startRelayQuestionPolling();
  startRelayBoardPolling();
  startSessionWorkerStatusPolling();
  await loadConversations();
  await loadRelayQuestions(currentConvId);
  await loadRelayBoards();
  updateCompactButton();
  document.getElementById('msg-input').focus();
}

async function doAuth() {
  const val = document.getElementById('token-input').value.trim() || getTokenFromUrl();
  if (!val) return showAuthError('Please enter a token');
  const ok = await verifyToken(val);
  if (ok) {
    setToken(val);
    initApp();
  } else {
    showAuthError('Invalid token');
  }
}

function registerPwaShell() {
  if (!('serviceWorker' in navigator)) return;
  const scopeBase = window.location.pathname.replace(/\/+$/, '');
  const scopeRoot = `${scopeBase}/`;
  return navigator.serviceWorker.register(`${scopeBase}/sw.js?v=10`, { scope: scopeRoot, updateViaCache: 'none' }).catch(() => {});
}

async function bootstrap() {
  if (ensureTrailingSlashPath()) return;
  registerPwaShell();
  initInstallButton();
  const urlToken = getTokenFromUrl();
  if (urlToken) stripTokenFromUrl();
  if (await verifyExistingSession()) {
    await initApp();
    return;
  }
  if (urlToken) {
    const ok = await verifyToken(urlToken);
    if (ok) {
      setToken(urlToken);
      await initApp();
      return;
    }
  }
  if (urlToken) document.getElementById('token-input').value = urlToken;
  showAuthGate();
}

window.doAuth = doAuth;
window.initApp = initApp;
window.connectSocket = connectSocket;
window.openSidebar = openSidebar;
window.closeSidebar = closeSidebar;
window.toggleSidebar = toggleSidebar;
window.showUsage = showUsage;
window.showContext = showContext;
window.promptInstallApp = promptInstallApp;
window.toggleFullscreen = toggleFullscreen;
window.openRepoBrowser = openRepoBrowser;
window.closeRepoBrowser = closeRepoBrowser;
window.loadRepoBrowserTree = loadRepoBrowserTree;
window.refreshRepoBrowser = refreshRepoBrowser;
window.initModeSelector = initModeSelector;
window.initModelSelector = initModelSelector;
window.refreshModelCatalog = refreshModelCatalog;
window.selectedModelValue = selectedModelValue;
window.getPreferredModelSelection = () => selectedModelValue();
window.applyConversationPreferences = applyConversationPreferencesForConversation;
window.applyModelCatalogState = updateModelCatalogState;
window.updateCliStatus = updateCliStatus;
window.showAuthError = showAuthError;
window.registerPwaShell = registerPwaShell;
window.newConversation = newConversation;
window.deleteConv = deleteConv;
window.openConversation = openConversation;
window.refreshConversations = refreshConversations;
window.renderConvList = renderConvList;
window.handleAttachmentInput = handleAttachmentInput;
window.removeAttachment = removeAttachment;
window.clearAttachments = clearAttachments;
window.openUploadedAttachmentViewer = openUploadedAttachmentViewer;
window.setFilePreviewMode = setFilePreviewMode;
window.toggleFilePreviewHtml = toggleFilePreviewHtml;
window.closeFilePreview = closeFilePreview;
window.openWorkspaceFilePreview = openWorkspaceFilePreview;
window.openWorkspaceFilePreviewFromRepo = openWorkspaceFilePreviewFromRepo;
window.setRepoBrowserRoot = setRepoBrowserRoot;
window.setRepoBrowserViewMode = setRepoBrowserViewMode;
window.toggleRepoBrowserHidden = toggleRepoBrowserHidden;
window.toggleRepoBrowserHeavy = toggleRepoBrowserHeavy;
window.focusRepoTree = focusRepoTree;
window.setRepoCurrentPath = setRepoCurrentPath;
window.toggleEmojiPicker = toggleEmojiPicker;
window.submitRelayQuestionChoice = submitRelayQuestionChoice;
window.submitRelayQuestionAnswer = submitRelayQuestionAnswer;
window.onRelayQuestionDraftInput = onRelayQuestionDraftInput;
window.handleRelayQuestionKey = handleRelayQuestionKey;
window.openPendingQuestionFromBanner = openPendingQuestionFromBanner;
window.submitRelayBoardAction = submitRelayBoardAction;
window.compactCurrentConversation = compactCurrentConversation;
window.sendMessage = sendMessage;
window.syncComposerControlState = syncComposerControlState;
window.appendMessage = appendMessage;
window.loadOlderConversationMessages = loadOlderConversationMessages;
window.handleKey = handleKey;
window.autoResize = autoResize;
window.closeSummaryModal = closeSummaryModal;
window.refreshSummaryModal = refreshSummaryModal;
window.renderSummaryModalContent = renderSummaryModalContent;
window.setSummaryModalLoading = setSummaryModalLoading;
window.openSummaryModal = openSummaryModal;
window.syncChatTitleControls = syncChatTitleControls;
window.closeChatActionsMenu = closeChatActionsMenu;
window.confirmKillCurrentSession = confirmKillCurrentSession;

bootstrap();
