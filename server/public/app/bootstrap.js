import {
  BASE,
  TOKEN,
  CLIENT_ID,
  currentConvId,
  conversations,
  seenMessageIds,
  relayQuestions,
  relayBoards,
  relayQuestionDrafts,
  relayActivities,
  relayThoughts,
  repoBrowserState,
  workspaceRootPath,
  getConversationWorkspaceState,
  getConversationCurrentWorkspaceRootPath,
  pendingUserMessageIds,
  escHtml,
  setToken,
  setCliOnline,
  setRelayOnline,
  setSessionWorkerStatesFromStatusPayload,
  setCurrentConv,
  updateWorkspaceRootHints,
  updateCliStatus,
  cliOnline,
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
  getRecentWorkspaceRoots,
  getSessionWorkerState,
  resolveConversationUiState,
} from './store.js';
import {
  verifyExistingSession,
  verifyToken,
  refreshWorkspaceRootHints,
  loadUsageSummary,
  loadContextSummary,
  loadModelCatalog,
  loadModelVariantCatalog,
  refreshModelVariantCatalog,
  saveEnabledModelVariants,
  loadConversation,
  updateConversationTitle,
  updateConversationPreferences,
  killSessionWorker,
  requestRelayRestart,
  requestHostSuspend,
  requestQueueEmpty,
  updateWorkspaceRoot,
  launchSessionWorker,
  scheduleContextUsageRefresh,
} from './api-client.js';
import { loadConversations, refreshConversations, openConversation, renderConvList, applyLoadedConversationState, initConversationListLazyLoading } from './journal-view.js';
import { newConversation, deleteConv } from './journal-view.js';
import {
  loadRelayQuestions,
  renderRelayQuestions,
  upsertRelayQuestion,
  updatePendingQuestionBanner,
  getPendingQuestionCountsByConversation,
} from './ask-user-view.js';
import { openPendingQuestionFromBanner, submitRelayQuestionChoice, submitRelayQuestionAnswer, submitRelayStructuredAnswer, onRelayQuestionDraftInput, handleRelayQuestionKey } from './ask-user-view.js';
import { loadRelayBoards, renderRelayBoards, upsertRelayBoard, submitRelayBoardAction } from './relay-board-view.js';
import { showThinking, removeThinking, renderThinkingActivities, appendThinkingActivity, appendThinkingThought, applyRelayStreamEvent, clearRelayStreamStateForMessage, restoreInFlightThinking, applyConversationTurnStatus, renderMessages, appendMessage, compactCurrentConversation, sendMessage, handleKey, getConversationLoadedMessageCount, loadOlderConversationMessages, syncComposerControlState, getRenderedConversationMessageFingerprints, initConversationHistoryLazyLoading,
} from './conversation-view.js';
import { loadRepoBrowserTree, openRepoBrowser, closeRepoBrowser, setRepoBrowserSessionInfo } from './attachments-view.js';
import { handleAttachmentInput, removeAttachment, clearAttachments, openUploadedAttachmentViewer, setFilePreviewMode, toggleFilePreviewHtml, closeFilePreview, openWorkspaceFilePreview, openWorkspaceFilePreviewFromRepo, setRepoBrowserRoot, setRepoBrowserViewMode, toggleRepoBrowserHidden, toggleRepoBrowserHeavy, refreshRepoBrowser, focusRepoTree, setRepoCurrentPath } from './attachments-view.js';
import { getRepoBrowserLaunchCwdPath } from './attachments-view.js';
import { initEmojiPicker, toggleEmojiPicker } from './emoji-view.js';
import {
  resolveConversationComposerSelection,
  withUpdatedModelPreference,
  normalizePreferredModelsByMode,
} from './conversation-preferences.mjs';
import { isLikelyLiveDuplicateMessage } from './live-message-dedupe.mjs';
import { stripRelayPromptContext } from './relay-prompt-sanitizer.mjs';
import {
  initMessageSearchView,
  openMessageSearchModal,
  closeMessageSearchModal,
  clearMessageSearchRuntimeState,
} from './message-search-view.js';

const MODEL_STORAGE_KEY = 'copilot_selected_model';
const MODE_STORAGE_KEY = 'copilot_selected_mode';
const MODELS_BY_MODE_STORAGE_KEY = 'copilot_selected_models_by_mode';
const FALLBACK_MODEL = 'gpt-5.4-mini';
const FALLBACK_MODE = 'agent';
const THEME_COLOR_BASE = '#0d1117';
const THEME_COLOR_IMMERSIVE = '#161b22';
const LEGACY_KNOWN_CWD_HISTORY_KEY = 'copilot_known_cwds';
const PROVIDER_LABELS = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google',
  microsoft: 'Microsoft',
  other: 'Other',
};
const CHAT_TITLE_MAX_LENGTH = 120;
const FONT_SCALE_STORAGE_KEY = 'copilot_font_scale';
const PWA_APP_NAME_STORAGE_KEY = 'copilot_pwa_app_name';
const SHOW_SUSPEND_HOST_STORAGE_KEY = 'copilot_show_suspend_host';
const PWA_APP_NAME_DEFAULT = 'Copilot Remote';
const PWA_APP_NAME_MAX_LENGTH = 60;
const FONT_SCALE_MIN = 0.5;
const FONT_SCALE_MAX = 1.5;
const FONT_SCALE_DEFAULT = 1;
const FONT_SCALE_WHEEL_STEP_BASE = 0.05;

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
let changeCwdInFlight = false;
let modelCatalogState = {
  models: [FALLBACK_MODEL],
  currentModel: FALLBACK_MODEL,
  defaultModel: FALLBACK_MODEL,
  stale: false,
  warning: null,
  refreshedAt: null,
};
let modelVariantCatalogState = {
  variants: [],
  enabledVariantIds: [],
  source: null,
  refreshedAt: null,
  warning: null,
  error: null,
  reasoningEfforts: [],
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
let latestQueueStatus = {
  pendingCount: 0,
  processingCount: 0,
  parkedCount: 0,
};
let fontScaleValue = FONT_SCALE_DEFAULT;
let fontScalePinchState = {
  active: false,
  startDistance: 0,
  startScale: FONT_SCALE_DEFAULT,
};
let manifestTemplateCache = null;
let customManifestUrl = null;

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
  const value = document.getElementById('chat-menu-pwa-version-value');
  if (!chip) return;
  const version = String(window.__COPILOT_PWA_VERSION || '').trim();
  if (value) {
    value.textContent = version ? `v${version}` : 'v?';
    return;
  }
  chip.textContent = version ? `PWA shell version: v${version}` : 'PWA shell version: v?';
}

function normalizeQueueCount(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : 0;
}

function updateQueueStatusFromPayload(payload = null) {
  if (!payload || typeof payload !== 'object') return;
  latestQueueStatus = {
    pendingCount: normalizeQueueCount(payload.pendingCount ?? payload.queue?.pendingCount),
    processingCount: normalizeQueueCount(payload.processingCount ?? payload.queue?.processingCount),
    parkedCount: normalizeQueueCount(payload.parkedCount ?? payload.queue?.parkedCount),
  };
}

function syncQueueStatusMenuEntry(payload = null) {
  if (payload) updateQueueStatusFromPayload(payload);
  const chip = document.getElementById('chat-menu-queue-status');
  const value = document.getElementById('chat-menu-queue-status-value');
  if (!chip) return;
  const statusText = `pending=${latestQueueStatus.pendingCount}, processing=${latestQueueStatus.processingCount}, parked=${latestQueueStatus.parkedCount}`;
  if (value) {
    value.textContent = statusText;
    return;
  }
  chip.textContent = `Queue: ${statusText}`;
}

function readShowSuspendHostSetting() {
  const stored = String(localStorage.getItem(SHOW_SUSPEND_HOST_STORAGE_KEY) || '').trim().toLowerCase();
  if (!stored) return true;
  return stored !== '0' && stored !== 'false';
}

function setShowSuspendHostSetting(show, { persist = true } = {}) {
  const next = !!show;
  if (persist) localStorage.setItem(SHOW_SUSPEND_HOST_STORAGE_KEY, next ? '1' : '0');
  return next;
}

function isSuspendHostActionVisible() {
  return readShowSuspendHostSetting();
}

function syncSuspendHostVisibility() {
  const show = isSuspendHostActionVisible();
  const menuBtn = document.getElementById('chat-menu-suspend-host');
  const checkbox = document.getElementById('show-suspend-host-toggle');
  if (menuBtn) {
    menuBtn.hidden = !show;
    menuBtn.disabled = !show;
    menuBtn.tabIndex = show ? 0 : -1;
    menuBtn.setAttribute('aria-hidden', show ? 'false' : 'true');
  }
  if (checkbox instanceof HTMLInputElement) {
    checkbox.checked = show;
  }
}

function splitVariantId(modelVariantId = '') {
  const value = String(modelVariantId || '').trim();
  if (!value) return { baseModelId: '', reasoningEffort: null };
  const match = value.match(/^(.*)-(none|low|medium|high|xhigh|max)$/i);
  if (!match) return { baseModelId: value, reasoningEffort: null };
  return {
    baseModelId: String(match[1] || '').trim(),
    reasoningEffort: String(match[2] || '').trim().toLowerCase(),
  };
}

function humanizeModelLabel(modelId = '') {
  const text = String(modelId || '').trim();
  if (!text) return '';
  if (/^gpt-/i.test(text)) {
    return text
      .replace(/^gpt-/i, 'GPT-')
      .replace(/-codex$/i, ' Codex')
      .replace(/-mini$/i, ' Mini');
  }
  if (/^claude-/i.test(text)) {
    return text
      .replace(/^claude-/i, 'Claude ')
      .split('-')
      .map((part) => (/^\d+(\.\d+)?$/.test(part) ? part : (part.charAt(0).toUpperCase() + part.slice(1))))
      .join(' ');
  }
  if (/^gemini-/i.test(text)) {
    return text
      .replace(/^gemini-/i, 'Gemini ')
      .split('-')
      .map((part) => (/^\d+(\.\d+)?$/.test(part) ? part : (part.charAt(0).toUpperCase() + part.slice(1))))
      .join(' ');
  }
  return text;
}

function modelOptionLabel(modelVariantId = '') {
  const { baseModelId, reasoningEffort } = splitVariantId(modelVariantId);
  if (!baseModelId) return modelVariantId;
  const baseLabel = humanizeModelLabel(baseModelId);
  return reasoningEffort ? `${baseLabel} (${reasoningEffort})` : baseLabel;
}

function updateModelCatalogState(payload) {
  const select = document.getElementById('model-select');
  if (!select) return;
  const models = Array.isArray(payload?.models)
    ? payload.models.map((m) => String(m || '').trim()).filter(Boolean)
    : [];
  const currentModel = String(payload?.currentModel || models[0] || '').trim();
  const defaultModel = String(payload?.defaultModel || models[0] || '').trim();
  const nextModels = Array.from(new Set(models.filter(Boolean)));
  if (!nextModels.length) nextModels.push(FALLBACK_MODEL);

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
    opt.textContent = modelOptionLabel(modelId);
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

function applyModelVariantCatalogState(payload) {
  const variants = Array.isArray(payload?.variants)
    ? payload.variants.map((entry) => ({
      variantId: String(entry?.variantId || '').trim(),
      baseModelId: String(entry?.baseModelId || '').trim(),
      provider: String(entry?.provider || 'other').trim().toLowerCase() || 'other',
      label: String(entry?.label || '').trim(),
      reasoningEffort: String(entry?.reasoningEffort || '').trim().toLowerCase() || null,
      enabled: !!entry?.enabled,
      sortOrder: Number.isFinite(Number(entry?.sortOrder)) ? Math.max(0, Math.trunc(Number(entry.sortOrder))) : 0,
    })).filter((entry) => entry.variantId && entry.baseModelId)
    : [];
  const enabledVariantIds = new Set(
    Array.isArray(payload?.enabledVariantIds)
      ? payload.enabledVariantIds.map((value) => String(value || '').trim()).filter(Boolean)
      : variants.filter((entry) => entry.enabled).map((entry) => entry.variantId),
  );
  modelVariantCatalogState = {
    variants,
    enabledVariantIds: Array.from(enabledVariantIds),
    source: String(payload?.source || '').trim() || null,
    refreshedAt: payload?.refreshedAt || null,
    warning: payload?.warning ? String(payload.warning) : null,
    error: payload?.error ? String(payload.error) : null,
    reasoningEfforts: Array.isArray(payload?.reasoningEfforts)
      ? payload.reasoningEfforts.map((value) => String(value || '').trim().toLowerCase()).filter(Boolean)
      : [],
  };
}

function renderModelVariantCatalogBody() {
  const grouped = new Map();
  for (const entry of modelVariantCatalogState.variants) {
    const providerKey = String(entry.provider || 'other').trim().toLowerCase() || 'other';
    if (!grouped.has(providerKey)) grouped.set(providerKey, []);
    grouped.get(providerKey).push(entry);
  }
  const providerOrder = Array.from(grouped.keys()).sort((a, b) => {
    const aLabel = PROVIDER_LABELS[a] || a;
    const bLabel = PROVIDER_LABELS[b] || b;
    return aLabel.localeCompare(bLabel);
  });
  const refreshedLabel = modelVariantCatalogState.refreshedAt
    ? new Date(modelVariantCatalogState.refreshedAt).toLocaleString()
    : 'Never';
  const selected = new Set(modelVariantCatalogState.enabledVariantIds);
  const warnings = [
    modelVariantCatalogState.warning ? `⚠️ ${escHtml(modelVariantCatalogState.warning)}` : '',
    modelVariantCatalogState.error ? `⚠️ ${escHtml(modelVariantCatalogState.error)}` : '',
  ].filter(Boolean);
  const groupsHtml = providerOrder.map((providerKey) => {
    const providerLabel = PROVIDER_LABELS[providerKey] || providerKey;
    const rows = grouped.get(providerKey) || [];
    rows.sort((a, b) => (a.sortOrder - b.sortOrder) || a.variantId.localeCompare(b.variantId));
    const rowsHtml = rows.map((row) => {
      const checked = selected.has(row.variantId);
      const label = row.label || humanizeModelLabel(row.baseModelId) || row.baseModelId;
      const effortChip = row.reasoningEffort ? ` <span style="font-size:0.72rem;color:var(--muted)">(${escHtml(row.reasoningEffort)})</span>` : '';
      return `
        <label style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px dashed var(--border);font-size:0.84rem">
          <input class="model-variant-checkbox" type="checkbox" data-variant-id="${escHtml(row.variantId)}" ${checked ? 'checked' : ''}>
          <span style="display:flex;flex-direction:column;gap:2px">
            <span>${escHtml(label)}${effortChip}</span>
            <code style="font-size:0.72rem;color:var(--muted)">${escHtml(row.variantId)}</code>
          </span>
        </label>
      `;
    }).join('');
    return `
      <section style="border:1px solid var(--border);border-radius:10px;padding:10px 12px;background:var(--bg3);display:flex;flex-direction:column;gap:6px">
        <div style="font-weight:600">${escHtml(providerLabel)}</div>
        ${rowsHtml || '<div style="color:var(--muted);font-size:0.82rem">No models</div>'}
      </section>
    `;
  }).join('');
  const bodyHtml = `
    <div style="display:flex;flex-direction:column;gap:10px">
      <div style="font-size:0.8rem;color:var(--muted)">
        Saved globally for this relay. Refreshed: <strong>${escHtml(refreshedLabel)}</strong>
      </div>
      ${warnings.map((line) => `<div style="font-size:0.78rem;color:var(--warn,#f7c873)">${line}</div>`).join('')}
      <div style="display:grid;gap:10px">${groupsHtml || '<div style="color:var(--muted)">No models discovered yet. Click Refresh.</div>'}</div>
      <div class="summary-modal-actions">
        <button class="summary-btn" type="button" onclick="saveSelectedModelsFromModal()">💾 Save enabled models</button>
        <button class="summary-close" type="button" onclick="closeSummaryModal()">Cancel</button>
      </div>
    </div>
  `;
  renderSummaryModalContent({
    title: '🤗 Select Models',
    subtitle: 'Choose model variants shown in the composer selector',
    bodyHtml,
    refresh: async () => {
      const refreshed = await refreshModelVariantCatalog();
      if (!refreshed) throw new Error('Failed to refresh model variants');
      applyModelVariantCatalogState(refreshed);
      renderModelVariantCatalogBody();
      await refreshModelCatalog(true);
    },
    kind: 'select-models',
  });
}

async function openSelectModelsModal() {
  openSummaryModal({
    title: '🤗 Select Models',
    subtitle: 'Loading…',
    bodyHtml: '<div class="summary-loading">Loading saved model variants…</div>',
    kind: 'select-models',
  });
  setSummaryModalLoading(true);
  try {
    const payload = await loadModelVariantCatalog();
    if (!payload) throw new Error('Failed to load model variants');
    applyModelVariantCatalogState(payload);
    renderModelVariantCatalogBody();
  } catch (error) {
    renderSummaryModalContent({
      title: '🤗 Select Models',
      subtitle: 'Unable to load',
      bodyHtml: `<div class="summary-error">Failed to load model variants: ${escHtml(error?.message || 'Unknown error')}</div>`,
      kind: 'select-models',
    });
  } finally {
    setSummaryModalLoading(false);
  }
}

async function saveSelectedModelsFromModal() {
  const body = document.getElementById('summary-modal-body');
  if (!body) return;
  const selectedVariantIds = Array.from(body.querySelectorAll('.model-variant-checkbox:checked'))
    .map((input) => String(input.getAttribute('data-variant-id') || '').trim())
    .filter(Boolean);
  if (!selectedVariantIds.length) {
    alert('Select at least one model variant.');
    return;
  }
  setSummaryModalLoading(true);
  try {
    const saved = await saveEnabledModelVariants(selectedVariantIds);
    if (!saved) throw new Error('Failed to save model selection');
    applyModelVariantCatalogState(saved);
    renderModelVariantCatalogBody();
    await refreshModelCatalog(true);
    showTransientRelayNotice('Saved model selector variants.');
  } catch (error) {
    alert(error?.message || 'Failed to save model selection');
  } finally {
    setSummaryModalLoading(false);
  }
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
  syncQueueStatusMenuEntry(status);
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

function normalizeKnownCwdPath(value) {
  const stripped = String(value || '').trim().replace(/[\\/]+$/, '');
  // Always restore the trailing backslash for Windows drive roots ("D:" → "D:\").
  // Without it, sending "D:" to the server causes path.resolve("D:") to return the
  // server's remembered CWD for drive D, not the drive root.
  if (/^[A-Za-z]:$/.test(stripped)) return `${stripped}\\`;
  return stripped;
}

function clearLegacyKnownCwdHistoryStorage() {
  localStorage.removeItem(LEGACY_KNOWN_CWD_HISTORY_KEY);
}

function buildKnownCwdOptions() {
  const options = [];
  const seen = new Set();
  const add = (label, value, note = '') => {
    const pathValue = normalizeKnownCwdPath(value);
    if (!pathValue) return;
    const key = pathValue.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    options.push({ label, path: pathValue, note });
  };

  const selectedCurrentCwd = getSelectedConversationCurrentCwd();
  add('Current session CWD', selectedCurrentCwd, 'Selected session');
  add('Relay workspace', workspaceRootPath, 'Relay host cwd');
  const browserCwd = normalizeKnownCwdPath(getRepoBrowserLaunchCwdPath());
  if (browserCwd && browserCwd.toLowerCase() !== normalizeKnownCwdPath(selectedCurrentCwd).toLowerCase()) {
    add('Current browser folder', browserCwd, 'From file explorer');
  }
  const history = getRecentWorkspaceRoots();
  history.forEach((pathValue, index) => {
    add(`Recent CWD ${index + 1}`, pathValue, 'Relay history');
  });
  return options;
}

function renderKnownCwdMenuItems(options, selectedPath) {
  if (!options.length) {
    return '<div class="change-cwd-menu-empty">No known CWDs available</div>';
  }
  const selectedKey = normalizeKnownCwdPath(selectedPath).toLowerCase();
  return options.map((option) => {
    const optionPath = normalizeKnownCwdPath(option.path);
    const selected = optionPath.toLowerCase() === selectedKey;
    return `
      <button class="change-cwd-menu-item${selected ? ' selected' : ''}" type="button" role="menuitemradio" aria-checked="${selected ? 'true' : 'false'}" data-path="${escHtml(optionPath)}" data-label="${escHtml(option.label || '')}" data-note="${escHtml(option.note || '')}" title="${escHtml(optionPath)}">
        <span class="change-cwd-menu-item-primary">${escHtml(option.label || 'Known CWD')}</span>
        <span class="change-cwd-menu-item-secondary">${escHtml(optionPath)}</span>
      </button>
    `;
  }).join('');
}

function getSelectedChangeCwdPath() {
  const input = document.getElementById('change-cwd-selected-path');
  return normalizeKnownCwdPath(input?.value || '');
}

function getManualChangeCwdPath() {
  const input = document.getElementById('change-cwd-manual-path');
  return normalizeKnownCwdPath(input?.value || '');
}

function getEffectiveChangeCwdPath() {
  return getManualChangeCwdPath() || getSelectedChangeCwdPath();
}

function closeChangeCwdMenu() {
  const menu = document.getElementById('change-cwd-menu');
  const trigger = document.getElementById('change-cwd-menu-trigger');
  if (menu) menu.hidden = true;
  if (trigger) trigger.setAttribute('aria-expanded', 'false');
}

function syncChangeCwdPickerView() {
  const trigger = document.getElementById('change-cwd-menu-trigger');
  const details = document.getElementById('change-cwd-details');
  const menu = document.getElementById('change-cwd-menu');
  const manualPath = getManualChangeCwdPath();
  const selectedPath = getSelectedChangeCwdPath();
  const itemNodes = Array.from(menu?.querySelectorAll('.change-cwd-menu-item[data-path]') || []);
  let selectedItem = null;
  for (const item of itemNodes) {
    const itemPath = normalizeKnownCwdPath(item.getAttribute('data-path') || '');
    const selected = itemPath && itemPath.toLowerCase() === selectedPath.toLowerCase();
    item.classList.toggle('selected', selected);
    item.setAttribute('aria-checked', selected ? 'true' : 'false');
    if (selected) selectedItem = item;
  }
  if (trigger) {
    if (selectedPath) {
      trigger.textContent = selectedPath;
      trigger.title = selectedPath;
    } else {
      trigger.textContent = 'Select a known CWD';
      trigger.title = 'Select a known CWD';
    }
  }
  if (details) {
    const label = String(selectedItem?.getAttribute('data-label') || '').trim();
    const note = String(selectedItem?.getAttribute('data-note') || '').trim();
    if (manualPath) {
      details.textContent = `Manual path: ${manualPath}`;
      return;
    }
    if (!selectedPath) {
      details.textContent = 'No known CWDs are available yet.';
      return;
    }
    const labelPrefix = label ? `${label}: ` : '';
    const noteSuffix = note ? ` (${note})` : '';
    details.textContent = `${labelPrefix}${selectedPath}${noteSuffix}`;
  }
}

function bindChangeCwdPicker() {
  const modalBody = document.getElementById('summary-modal-body');
  const manualInput = document.getElementById('change-cwd-manual-path');
  const trigger = document.getElementById('change-cwd-menu-trigger');
  const menu = document.getElementById('change-cwd-menu');
  const selectionInput = document.getElementById('change-cwd-selected-path');
  if (!modalBody || !trigger || !menu || !selectionInput) return;
  if (modalBody.dataset.changeCwdPickerModalBound !== '1') {
    modalBody.dataset.changeCwdPickerModalBound = '1';
    modalBody.addEventListener('click', (event) => {
      const picker = document.getElementById('change-cwd-picker');
      if (!picker || picker.contains(event.target)) return;
      closeChangeCwdMenu();
    });
    modalBody.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      const activeMenu = document.getElementById('change-cwd-menu');
      if (!activeMenu || activeMenu.hidden) return;
      event.preventDefault();
      event.stopPropagation();
      closeChangeCwdMenu();
    });
  }
  bindTapAction(trigger, (event) => {
    event.preventDefault();
    event.stopPropagation();
    const willOpen = !!menu.hidden;
    menu.hidden = !willOpen;
    trigger.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
  });
  for (const item of menu.querySelectorAll('.change-cwd-menu-item[data-path]')) {
    bindMenuAction(item, (event) => {
      event.preventDefault();
      event.stopPropagation();
      const pathValue = normalizeKnownCwdPath(item.getAttribute('data-path') || '');
      selectionInput.value = pathValue;
      syncChangeCwdPickerView();
      closeChangeCwdMenu();
    });
  }
  if (manualInput && manualInput.dataset.changeCwdInputBound !== '1') {
    manualInput.dataset.changeCwdInputBound = '1';
    manualInput.addEventListener('input', () => {
      syncChangeCwdPickerView();
    });
  }
  syncChangeCwdPickerView();
}

function getSelectedConversationWorkspaceState() {
  return getConversationWorkspaceState(currentConvId) || null;
}

function getSelectedConversationCurrentCwd() {
  return normalizeKnownCwdPath(getConversationCurrentWorkspaceRootPath(currentConvId) || '');
}

function syncChatHeaderWorkspaceLabel() {
  const labelEl = document.getElementById('chat-title-cwd');
  if (!labelEl) return;
  const convId = String(currentConvId || '').trim();
  const cwd = getSelectedConversationCurrentCwd();
  if (!convId || !cwd) {
    labelEl.hidden = true;
    labelEl.textContent = '';
    labelEl.removeAttribute('title');
    return;
  }
  labelEl.hidden = false;
  labelEl.textContent = cwd;
  labelEl.title = cwd;
}

function getCurrentLaunchableSessionId() {
  const conversation = conversations?.[currentConvId] || null;
  return String(conversation?.sdkSessionId || conversation?.sdk_session_id || '').trim();
}

function isSelectedSessionRunning() {
  const conversation = conversations?.[currentConvId] || null;
  const status = String(conversation?.runtimeSessionStatus || conversation?.runtime_session_status || '').trim().toLowerCase();
  return ['starting', 'ready', 'processing'].includes(status);
}

function openChangeCwdModal() {
  const options = buildKnownCwdOptions();
  const workspaceState = getSelectedConversationWorkspaceState();
  const currentCwd = normalizeKnownCwdPath(workspaceState?.currentWorkspaceRootPath || '');
  const nextLaunchCwd = normalizeKnownCwdPath(workspaceState?.configuredWorkspaceRootPath || '');
  const defaultPath = nextLaunchCwd || normalizeKnownCwdPath(getRepoBrowserLaunchCwdPath()) || currentCwd || normalizeKnownCwdPath(workspaceRootPath) || options[0]?.path || '';
  const menuItemsHtml = renderKnownCwdMenuItems(options, defaultPath);
  const launchableSessionId = getCurrentLaunchableSessionId();
  const launchDisabledReason = !launchableSessionId
    ? 'Open a conversation with a bound session before launching.'
    : (isSelectedSessionRunning() ? 'Selected CLI is already running.' : '');
  openSummaryModal({
    title: 'Change CWD',
    subtitle: 'Select a known launch directory',
    kind: 'change-cwd',
    bodyHtml: `
      <p style="margin-bottom:10px;color:var(--muted);line-height:1.45">
        Pick the selected session's persisted next-launch directory. Running CLIs keep their current CWD until the next launch.
      </p>
      <div style="display:grid;gap:4px;margin-bottom:10px;font-size:0.78rem;color:var(--muted)">
        <div><strong style="color:var(--text)">Current CWD:</strong> ${escHtml(currentCwd || 'Unknown')}</div>
        <div><strong style="color:var(--text)">Next launch:</strong> ${escHtml(nextLaunchCwd || currentCwd || 'Unknown')}</div>
      </div>
      <label class="change-cwd-picker" style="margin-bottom:10px;font-size:0.84rem;color:var(--muted)">
        <span>Manual path</span>
        <input id="change-cwd-manual-path" class="change-cwd-manual-input" type="text" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="Manual path">
      </label>
      <label id="change-cwd-picker" class="change-cwd-picker" style="font-size:0.84rem;color:var(--muted)">
        <span>Known CWDs</span>
        <input id="change-cwd-selected-path" type="hidden" value="${escHtml(defaultPath)}">
        <button id="change-cwd-menu-trigger" class="change-cwd-menu-trigger" type="button" aria-haspopup="menu" aria-expanded="false" aria-controls="change-cwd-menu">Select a known CWD</button>
        <div id="change-cwd-menu" class="change-cwd-menu-panel" role="menu" hidden>
          ${menuItemsHtml}
        </div>
      </label>
      <div id="change-cwd-details" style="margin-top:10px;font-size:0.78rem;color:var(--muted);line-height:1.45;word-break:break-word"></div>
      <div class="summary-modal-actions" id="change-cwd-actions">
        <button class="summary-btn" type="button" onclick="confirmChangeCwd()">🗂️ Save next-launch CWD</button>
        <button class="summary-btn" type="button" ${launchableSessionId ? 'onclick="confirmChangeCwdAndLaunch()"' : 'disabled'} title="${escHtml(launchDisabledReason || 'Set the CWD and launch the current session worker')}">🚀 Set new CWD and launch</button>
        <button class="summary-close" type="button" onclick="closeSummaryModal()">Cancel</button>
      </div>
    `,
  });
  // Shield the action buttons from stray click events that arrive just after the
  // modal opens (e.g. click fires after pointerup-triggered modal in some browsers,
  // or the 300ms synthetic touch-click lands on a button at the same coordinates).
  const cwdActionsEl = document.getElementById('change-cwd-actions');
  if (cwdActionsEl) cwdActionsEl.style.pointerEvents = 'none';
  window.setTimeout(() => {
    bindChangeCwdPicker();
    const el = document.getElementById('change-cwd-actions');
    if (el) el.style.pointerEvents = '';
  }, 350);
}

async function confirmChangeCwd() {
  await submitChangeCwd(false);
}

async function confirmChangeCwdAndLaunch() {
  await submitChangeCwd(true);
}

async function submitChangeCwd(launchAfterChange = false) {
  if (changeCwdInFlight) return;
  const targetPath = getEffectiveChangeCwdPath();
  if (!targetPath) {
    alert('Enter a manual path or select a known CWD first.');
    return;
  }
  const launchableSessionId = launchAfterChange ? getCurrentLaunchableSessionId() : '';
  if (launchAfterChange && !launchableSessionId) {
    alert('Open a conversation with a bound session before launching.');
    return;
  }
  if (launchAfterChange && isSelectedSessionRunning()) {
    alert('Selected CLI is already running.');
    return;
  }
  changeCwdInFlight = true;
  setSummaryModalLoading(true);
  try {
    const result = await updateWorkspaceRoot(targetPath, currentConvId);
    if (!result) {
      alert('Failed to update the launch CWD');
      return;
    }
    applyConversationWorkspaceRootUpdate({
      conversationId: currentConvId,
      ...result,
    });
    const updatedPath = result.configuredWorkspaceRootPath || result.currentWorkspaceRootPath || result.workspaceRootPath || targetPath;
    if (launchAfterChange) {
      const launchResult = await launchSessionWorker(launchableSessionId);
      if (!launchResult) {
        alert('Launch CWD updated, but the CLI launch request failed.');
        return;
      }
      closeSummaryModal();
      showTransientRelayNotice(`Next launch CWD saved as ${updatedPath} and CLI launch requested.`);
      await refreshSessionWorkerStatus().catch(() => {});
      return;
    }
    closeSummaryModal();
    showTransientRelayNotice(isSelectedSessionRunning()
      ? `Next launch CWD saved as ${updatedPath}. The running CLI keeps its current CWD.`
      : `Next launch CWD saved as ${updatedPath}.`);
  } catch (error) {
    alert(error?.message || 'Failed to update the launch CWD');
  } finally {
    changeCwdInFlight = false;
    setSummaryModalLoading(false);
  }
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
  element.addEventListener('pointerup', (event) => {
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
  const conversation = convId ? (conversations[convId] || null) : null;
  const sdkSessionId = String(conversation?.sdkSessionId || '').trim();
  if (title) {
    if (!convId || !conversation) {
      delete title.dataset.uiState;
    } else {
      const pendingByConversation = getPendingQuestionCountsByConversation();
      const pendingCount = Number(pendingByConversation[convId] || 0);
      const workerState = sdkSessionId ? getSessionWorkerState(sdkSessionId) : null;
      const uiState = resolveConversationUiState({
        conversation,
        workerState,
        hasPendingQuestion: pendingCount > 0,
      });
      title.dataset.uiState = uiState;
    }
  }
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
  syncChatHeaderWorkspaceLabel();
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

function applyConversationWorkspaceRootUpdate(payload = {}) {
  const conversationId = String(payload.conversationId || '').trim();
  if (!conversationId) return;
  const existing = conversations[conversationId] || { id: conversationId, archived: false, messageCount: 0 };
  conversations[conversationId] = {
    ...existing,
    configuredWorkspaceRootPath: String(payload.configuredWorkspaceRootPath || existing.configuredWorkspaceRootPath || '').trim() || null,
    configuredWorkspaceRootName: String(payload.configuredWorkspaceRootName || existing.configuredWorkspaceRootName || '').trim() || null,
    runtimeWorkspaceRootPath: String(payload.runtimeWorkspaceRootPath || existing.runtimeWorkspaceRootPath || '').trim() || null,
    runtimeWorkspaceRootName: String(payload.runtimeWorkspaceRootName || existing.runtimeWorkspaceRootName || '').trim() || null,
    currentWorkspaceRootPath: String(payload.currentWorkspaceRootPath || existing.currentWorkspaceRootPath || '').trim() || null,
    currentWorkspaceRootName: String(payload.currentWorkspaceRootName || existing.currentWorkspaceRootName || '').trim() || null,
  };
  if (currentConvId === conversationId) {
    syncChatHeaderWorkspaceLabel();
    if (repoBrowserState.activeRoot === 'workspace' && repoBrowserState.open) {
      void loadRepoBrowserTree();
    }
  }
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
let restartRelayInFlight = false;
let suspendHostInFlight = false;
let emptyQueueInFlight = false;

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

function openRestartRelayConfirmation() {
  openSummaryModal({
    title: 'Restart web relay',
    subtitle: 'Queues restart via /api/relay/shutdown',
    kind: 'restart-relay',
    bodyHtml: `
      <p>Queue a manual relay restart now?</p>
      <p>The restart waits until the current turn is idle, so it does not interrupt an in-flight turn immediately.</p>
      <div class="summary-modal-actions">
        <button class="chat-title-action-btn" type="button" onclick="confirmRestartWebRelay()">🌄 Restart web relay</button>
        <button class="chat-title-action-btn" type="button" onclick="closeSummaryModal()">Cancel</button>
      </div>
    `,
  });
}

function openEmptyQueueConfirmation() {
  lockChatActionsMenuShield(350);
  closeChatActionsMenu();
  openSummaryModal({
    title: 'Empty queue',
    subtitle: 'Calls localhost /api/queue/empty',
    kind: 'empty-queue',
    bodyHtml: `
      <p>Drop all queue rows in pending, processing, and parked states?</p>
      <p>This is a local maintenance action and cannot be undone.</p>
      <div class="summary-modal-actions">
        <button class="chat-title-action-btn danger-btn" type="button" onclick="confirmEmptyQueue()">🚮 Empty queue</button>
        <button class="chat-title-action-btn" type="button" onclick="closeSummaryModal()">Cancel</button>
      </div>
    `,
  });
}

function openSuspendHostConfirmation() {
  if (!isSuspendHostActionVisible()) return;
  lockChatActionsMenuShield(350);
  closeChatActionsMenu();
  openSummaryModal({
    title: 'Suspend host',
    subtitle: 'Requests suspend-to-RAM',
    kind: 'suspend-host',
    bodyHtml: `
      <p>Put this PC to sleep now?</p>
      <p>This requests suspend-to-RAM immediately.</p>
      <div class="summary-modal-actions">
        <button class="chat-title-action-btn" type="button" onclick="confirmSuspendHost()">💤 Suspend host</button>
        <button class="chat-title-action-btn" type="button" onclick="closeSummaryModal()">Cancel</button>
      </div>
    `,
  });
  window.setTimeout(() => {
    const modal = document.getElementById('summary-modal');
    const classVisible = !!modal?.classList?.contains('visible');
    const ariaVisible = String(modal?.getAttribute('aria-hidden') || 'true') === 'false';
    const displayVisible = modal ? window.getComputedStyle(modal).display !== 'none' : false;
    if (classVisible && ariaVisible && displayVisible) return;
    const confirmed = window.confirm('Put this PC to sleep now?\n\nThis requests suspend-to-RAM.');
    if (!confirmed) return;
    confirmSuspendHost().catch(() => {});
  }, 90);
}

async function confirmSuspendHost() {
  if (!isSuspendHostActionVisible()) return;
  if (suspendHostInFlight) return;
  suspendHostInFlight = true;
  setSummaryModalLoading(true);
  try {
    const result = await requestHostSuspend({
      reason: 'manual-suspend',
      requestedBy: 'localhost-api',
    });
    closeSummaryModal();
    if (!result?.ok) {
      alert('Failed to suspend host');
      return;
    }
  } finally {
    suspendHostInFlight = false;
    setSummaryModalLoading(false);
  }
}

async function confirmEmptyQueue() {
  if (emptyQueueInFlight) return;
  emptyQueueInFlight = true;
  setSummaryModalLoading(true);
  try {
    const result = await requestQueueEmpty({
      reason: 'manual-empty-queue',
      requestedBy: 'localhost-api',
    });
    closeSummaryModal();
    if (!result?.ok) {
      alert('Failed to empty queue');
      return;
    }
    const droppedCount = Number(result.droppedCount || 0);
    if (droppedCount <= 0) {
      showTransientRelayNotice('Queue is already empty.');
    } else {
      showTransientRelayNotice(`Queue emptied: dropped ${droppedCount} row${droppedCount === 1 ? '' : 's'}.`, 6000);
    }
    const status = await refreshWorkspaceRootHints();
    syncQueueStatusMenuEntry(status);
  } finally {
    emptyQueueInFlight = false;
    setSummaryModalLoading(false);
  }
}

async function confirmRestartWebRelay() {
  if (restartRelayInFlight) return;
  restartRelayInFlight = true;
  setSummaryModalLoading(true);
  try {
    const result = await requestRelayRestart({
      reason: 'manual-restart',
      requestedBy: 'localhost-api',
      restart: true,
    });
    closeSummaryModal();
    // Restart can close the connection before the browser receives JSON.
    if (!result) {
      showTransientRelayNotice('Relay restart requested. Connection may briefly drop while it restarts.', 7000);
      return;
    }
    if (!result.ok) {
      alert('Failed to queue relay restart');
      return;
    }
    if (result.accepted === false) {
      showTransientRelayNotice('Relay is already shutting down/restarting.', 7000);
      return;
    }
    const queue = result.queue || {};
    showTransientRelayNotice(
      `Relay restart queued (pending=${Number(queue.pendingCount || 0)}, processing=${Number(queue.processingCount || 0)}).`,
      7000,
    );
  } finally {
    restartRelayInFlight = false;
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
}

async function connectSocket() {
  socket = io({ path: `${BASE}/socket.io/`, auth: TOKEN ? { token: TOKEN, clientId: CLIENT_ID } : { clientId: CLIENT_ID } });

  socket.on('connect', () => {
    console.log('Socket connected');
    clearMessageSearchRuntimeState();
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
  socket.on('conversation_workspace_root_updated', (payload) => {
    updateWorkspaceRootHints(payload || {});
    applyConversationWorkspaceRootUpdate(payload || {});
  });
  socket.on('user_message', ({ conversationId, messageId, senderClientId, message }) => {
    const normalizedMessage = {
      ...(message && typeof message === 'object' ? message : {}),
      text: stripRelayPromptContext(message?.text, message?.mode),
    };
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
      const hasPendingTextMatch = hasPendingUserMessageDuplicate(conversationId, normalizedMessage.text);
      if (isLikelyLiveDuplicateMessage({
        incomingMessageId: messageId,
        incomingMessage: normalizedMessage,
        existingMessages: renderedMessages,
        hasPendingTextMatch,
      })) {
        return;
      }
      appendMessage(normalizedMessage, true, messageId);
    }
  });
  socket.on('assistant_message', ({ conversationId, message, messageId, sourceMessageId }) => {
    removeThinking();
    if ((!message?.activities || !message.activities.length) && sourceMessageId) {
      const cached = relayActivities.get(sourceMessageId) || [];
      if (cached.length) message.activities = cached.slice(0, 48);
    }
    if ((!message?.thoughts || !message.thoughts.length) && sourceMessageId) {
      const cachedThoughts = relayThoughts.get(sourceMessageId);
      if (cachedThoughts && cachedThoughts.size) {
        message.thoughts = Array.from(cachedThoughts.values());
      }
    }
    if (messageId && seenMessageIds?.has(messageId)) return;
    if (conversationId === currentConvId) {
      appendMessage(message, true, messageId || null, false, sourceMessageId || null);
      scheduleContextUsageRefresh(conversationId, 120);
    }
    if (sourceMessageId) relayActivities.delete(sourceMessageId);
    if (sourceMessageId) relayThoughts.delete(sourceMessageId);
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
  socket.on('relay_thought', ({ conversationId, messageId, reasoningId, text, done }) => {
    if (!messageId) return;
    const key = String(reasoningId || 'reasoning');
    const thoughtMap = relayThoughts.get(messageId) || new Map();
    thoughtMap.set(key, { reasoningId: key, text: String(text || ''), done: !!done });
    relayThoughts.set(messageId, thoughtMap);
    if (conversationId === currentConvId) {
      appendThinkingThought(key, String(text || ''), !!done);
    }
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
    const normalizedStatus = String(status || '').trim().toLowerCase();
    const clearsProcessingStatus = ['done', 'failed', 'dropped', 'pending', 'parked', 'cancelled'].includes(normalizedStatus);
    applyConversationTurnStatus({ conversationId, messageId, status });
    if (conversationId && conversations[conversationId]) {
      const conversation = conversations[conversationId];
      if (normalizedStatus === 'processing') {
        conversation.localTurnStatus = 'processing';
        conversation.localTurnStatusUpdatedAt = Date.now();
        conversation.localTurnMessageId = String(messageId || '').trim() || null;
      } else if (clearsProcessingStatus) {
        const trackedMessageId = String(conversation.localTurnMessageId || '').trim();
        const incomingMessageId = String(messageId || '').trim();
        if (!trackedMessageId || !incomingMessageId || trackedMessageId === incomingMessageId) {
          delete conversation.localTurnStatus;
          delete conversation.localTurnStatusUpdatedAt;
          delete conversation.localTurnMessageId;
        }
      }
    }
    if (conversationId === currentConvId && normalizedStatus === 'processing') {
      showThinking(messageId || null);
      renderThinkingActivities();
    }
    if (clearsProcessingStatus) {
      clearPendingUserMessage(messageId);
      if (messageId) clearRelayStreamStateForMessage(messageId);
    }
    if (conversationId === currentConvId && clearsProcessingStatus) {
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

const THEME_STORAGE_KEY = 'copilot_theme';

function normalizePwaAppName(rawValue, { allowEmpty = true } = {}) {
  const normalized = String(rawValue || '').replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return allowEmpty
      ? { value: '', error: null }
      : { value: '', error: 'App name cannot be empty.' };
  }
  if (normalized.length > PWA_APP_NAME_MAX_LENGTH) {
    return { value: '', error: `App name must be ${PWA_APP_NAME_MAX_LENGTH} characters or fewer.` };
  }
  return { value: normalized, error: null };
}

function derivePwaShortName(name) {
  const text = String(name || '').trim();
  if (!text) return 'Copilot';
  const firstWord = text.split(/\s+/)[0] || text;
  if (firstWord.length <= 12) return firstWord;
  return text.slice(0, 12).trim() || 'Copilot';
}

function resolveManifestUrlValue(rawValue, baseHref) {
  const value = String(rawValue || '').trim();
  if (!value || value.startsWith('data:') || value.startsWith('blob:')) return value;
  try {
    return new URL(value, baseHref).href;
  } catch {
    return value;
  }
}

function normalizeManifestForBlob(manifest, defaultHref) {
  const baseHref = new URL(String(defaultHref || '').trim(), window.location.href).href;
  const next = { ...(manifest || {}) };
  next.id = resolveManifestUrlValue(next.id, baseHref);
  next.start_url = resolveManifestUrlValue(next.start_url, baseHref);
  next.scope = resolveManifestUrlValue(next.scope, baseHref);
  if (Array.isArray(next.icons)) {
    next.icons = next.icons.map((icon) => {
      if (!icon || typeof icon !== 'object') return icon;
      const source = resolveManifestUrlValue(icon.src, baseHref);
      return { ...icon, src: source };
    });
  }
  return next;
}

function readStoredPwaAppName() {
  const { value } = normalizePwaAppName(localStorage.getItem(PWA_APP_NAME_STORAGE_KEY), { allowEmpty: true });
  return value;
}

function syncPwaAppNameInput() {
  const input = document.getElementById('pwa-app-name-input');
  if (!input) return;
  input.value = readStoredPwaAppName();
}

async function loadManifestTemplate(defaultHref) {
  if (manifestTemplateCache) return { ...manifestTemplateCache };
  const fallback = {
    name: PWA_APP_NAME_DEFAULT,
    short_name: derivePwaShortName(PWA_APP_NAME_DEFAULT),
    description: 'Installable Copilot Remote web app with standalone launcher support.',
    id: './',
    start_url: './',
    scope: './',
    display_override: ['standalone'],
    display: 'standalone',
    background_color: '#161b22',
    theme_color: '#161b22',
    icons: [
      { src: 'app-icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
      { src: 'app-icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: 'app-icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    ],
  };
  try {
    const response = await fetch(defaultHref, { cache: 'no-store' });
    const manifest = response.ok ? await response.json() : null;
    if (manifest && typeof manifest === 'object' && !Array.isArray(manifest)) {
      manifestTemplateCache = manifest;
      return { ...manifestTemplateCache };
    }
  } catch (error) {
    console.warn('Failed to load manifest template; using fallback.', error);
  }
  manifestTemplateCache = fallback;
  return { ...manifestTemplateCache };
}

async function applyPwaManifestFromSettings() {
  const manifestLink = document.querySelector('link[rel="manifest"]');
  if (!manifestLink) return;

  const defaultHref = String(manifestLink.dataset.defaultHref || manifestLink.getAttribute('href') || '').trim();
  if (!defaultHref) return;
  if (!manifestLink.dataset.defaultHref) manifestLink.dataset.defaultHref = defaultHref;

  const customName = readStoredPwaAppName();
  if (!customName) {
    if (customManifestUrl) {
      URL.revokeObjectURL(customManifestUrl);
      customManifestUrl = null;
    }
    manifestLink.setAttribute('href', defaultHref);
    return;
  }

  const baseManifest = await loadManifestTemplate(defaultHref);
  const nextManifest = {
    ...baseManifest,
    name: customName,
    short_name: derivePwaShortName(customName),
  };
  const normalizedManifest = normalizeManifestForBlob(nextManifest, defaultHref);
  const manifestBlob = new Blob([JSON.stringify(normalizedManifest, null, 2)], { type: 'application/manifest+json' });
  const objectUrl = URL.createObjectURL(manifestBlob);
  if (customManifestUrl) URL.revokeObjectURL(customManifestUrl);
  customManifestUrl = objectUrl;
  manifestLink.setAttribute('href', objectUrl);
}

function updatePwaAppName(rawValue) {
  const normalized = normalizePwaAppName(rawValue, { allowEmpty: true });
  if (normalized.error) {
    alert(normalized.error);
    syncPwaAppNameInput();
    return;
  }
  if (normalized.value) {
    localStorage.setItem(PWA_APP_NAME_STORAGE_KEY, normalized.value);
  } else {
    localStorage.removeItem(PWA_APP_NAME_STORAGE_KEY);
  }
  applyPwaManifestFromSettings()
    .then(() => {
      syncPwaAppNameInput();
      showTransientRelayNotice(normalized.value
        ? `Install app name updated to "${normalized.value}".`
        : 'Install app name reset to default.');
    })
    .catch((error) => {
      alert(error?.message || 'Failed to apply install app name');
      syncPwaAppNameInput();
    });
}

function initTheme() {
  const saved = localStorage.getItem(THEME_STORAGE_KEY);
  if (saved === 'light') {
    document.documentElement.setAttribute('data-theme', 'light');
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
}

function clampFontScale(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return FONT_SCALE_DEFAULT;
  return Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, numeric));
}

function readStoredFontScale() {
  return clampFontScale(localStorage.getItem(FONT_SCALE_STORAGE_KEY));
}

function normalizeFontScaleSelectValue(raw = '') {
  const text = String(raw || '').trim();
  if (!text) return null;
  const numeric = Number(text);
  if (!Number.isFinite(numeric)) return null;
  if (numeric > 3) return clampFontScale(numeric / 100);
  return clampFontScale(numeric);
}

function getMessageViewportAnchor() {
  const container = document.getElementById('messages');
  if (!container) return null;
  const containerRect = container.getBoundingClientRect();
  const messages = Array.from(container.querySelectorAll('.msg[data-message-id]'));
  for (const message of messages) {
    const rect = message.getBoundingClientRect();
    if (rect.bottom <= containerRect.top || rect.top >= containerRect.bottom) continue;
    const messageId = String(message.dataset.messageId || '').trim();
    if (!messageId) continue;
    return {
      messageId,
      offsetTop: rect.top - containerRect.top,
    };
  }
  return null;
}

function restoreMessageViewportAnchor(anchor) {
  if (!anchor?.messageId) return;
  const container = document.getElementById('messages');
  if (!container) return;
  const messageId = String(anchor.messageId || '').trim();
  if (!messageId) return;
  const message = Array.from(container.querySelectorAll('.msg[data-message-id]'))
    .find((node) => String(node?.dataset?.messageId || '').trim() === messageId);
  if (!message) return;
  const containerRect = container.getBoundingClientRect();
  const rect = message.getBoundingClientRect();
  const delta = rect.top - containerRect.top - Number(anchor.offsetTop || 0);
  if (Math.abs(delta) > 0.5) {
    container.scrollTop += delta;
  }
}

function syncFontScaleSelect() {
  const select = document.getElementById('font-scale-select');
  if (!select) return;
  const currentPercent = Math.round(clampFontScale(fontScaleValue) * 100);
  const candidate = String(currentPercent);
  if (Array.from(select.options).some((option) => option.value === candidate)) {
    select.value = candidate;
    return;
  }
  const dynamicValue = String(currentPercent);
  const dynamicLabel = `${currentPercent}%`;
  let dynamicOption = select.querySelector('option[data-dynamic-font-scale="1"]');
  if (!dynamicOption) {
    dynamicOption = document.createElement('option');
    dynamicOption.setAttribute('data-dynamic-font-scale', '1');
    select.appendChild(dynamicOption);
  }
  dynamicOption.value = dynamicValue;
  dynamicOption.textContent = dynamicLabel;
  select.value = dynamicValue;
}

function setFontScale(nextScale, { persist = true, preserveMessageAnchor = true } = {}) {
  const normalized = clampFontScale(nextScale);
  if (Math.abs(normalized - fontScaleValue) <= 0.0001) {
    if (persist) localStorage.setItem(FONT_SCALE_STORAGE_KEY, String(normalized));
    syncFontScaleSelect();
    return normalized;
  }
  const anchor = preserveMessageAnchor ? getMessageViewportAnchor() : null;
  fontScaleValue = normalized;
  document.documentElement.style.setProperty('--font-scale', normalized.toFixed(4));
  document.documentElement.style.setProperty('--font-scale-percent', `${Math.round(normalized * 100)}%`);
  if (persist) localStorage.setItem(FONT_SCALE_STORAGE_KEY, String(normalized));
  syncFontScaleSelect();
  if (anchor) {
    requestAnimationFrame(() => {
      restoreMessageViewportAnchor(anchor);
    });
  }
  return normalized;
}

function isImageZoomGestureTarget(target) {
  if (!(target instanceof Element)) return false;
  return !!target.closest('#file-preview-body.image-zoom-mode');
}

function pinchDistance(touchA, touchB) {
  return Math.hypot(touchA.clientX - touchB.clientX, touchA.clientY - touchB.clientY);
}

function onGlobalFontScaleWheel(event) {
  if (!(event.ctrlKey || event.metaKey)) return;
  if (isImageZoomGestureTarget(event.target)) return;
  event.preventDefault();
  const deltaY = Number(event.deltaY);
  if (!Number.isFinite(deltaY) || deltaY === 0) return;
  const direction = deltaY < 0 ? 1 : -1;
  const magnitude = Math.min(0.2, Math.max(FONT_SCALE_WHEEL_STEP_BASE, Math.abs(deltaY) / 400));
  setFontScale(fontScaleValue + (direction * magnitude), { persist: true, preserveMessageAnchor: true });
}

function onGlobalFontScaleTouchStart(event) {
  if (event.touches.length !== 2) return;
  if (isImageZoomGestureTarget(event.target)) {
    fontScalePinchState.active = false;
    return;
  }
  const t0 = event.touches[0];
  const t1 = event.touches[1];
  fontScalePinchState = {
    active: true,
    startDistance: pinchDistance(t0, t1),
    startScale: fontScaleValue,
  };
  event.preventDefault();
}

function onGlobalFontScaleTouchMove(event) {
  if (!fontScalePinchState.active) return;
  if (event.touches.length !== 2) {
    fontScalePinchState.active = false;
    return;
  }
  if (isImageZoomGestureTarget(event.target)) {
    fontScalePinchState.active = false;
    return;
  }
  event.preventDefault();
  const t0 = event.touches[0];
  const t1 = event.touches[1];
  const distance = pinchDistance(t0, t1);
  if (!fontScalePinchState.startDistance || !Number.isFinite(distance) || distance <= 0) return;
  const ratio = distance / fontScalePinchState.startDistance;
  const nextScale = fontScalePinchState.startScale * ratio;
  setFontScale(nextScale, { persist: true, preserveMessageAnchor: true });
}

function onGlobalFontScaleTouchEnd(event) {
  if (event.touches.length < 2) {
    fontScalePinchState.active = false;
  }
}

function populateFontScaleSelect() {
  const select = document.getElementById('font-scale-select');
  if (!select || select.dataset.populated === '1') return;
  select.dataset.populated = '1';
  for (let value = 50; value <= 150; value += 10) {
    const option = document.createElement('option');
    option.value = String(value);
    option.textContent = `${value}%`;
    select.appendChild(option);
  }
}

function initFontScaling() {
  populateFontScaleSelect();
  const inlineScale = Number(document.documentElement.style.getPropertyValue('--font-scale'));
  const initialScale = Number.isFinite(inlineScale) ? clampFontScale(inlineScale) : readStoredFontScale();
  setFontScale(initialScale, { persist: false, preserveMessageAnchor: false });
  if (!window.__fontScaleGestureHandlersBound) {
    window.__fontScaleGestureHandlersBound = true;
    window.addEventListener('wheel', onGlobalFontScaleWheel, { passive: false, capture: true });
    window.addEventListener('touchstart', onGlobalFontScaleTouchStart, { passive: false, capture: true });
    window.addEventListener('touchmove', onGlobalFontScaleTouchMove, { passive: false, capture: true });
    window.addEventListener('touchend', onGlobalFontScaleTouchEnd, { passive: true, capture: true });
    window.addEventListener('touchcancel', onGlobalFontScaleTouchEnd, { passive: true, capture: true });
  }
}

function updateFontScaleFromSelect(rawValue) {
  const next = normalizeFontScaleSelectValue(rawValue);
  if (next == null) {
    syncFontScaleSelect();
    return;
  }
  setFontScale(next, { persist: true, preserveMessageAnchor: true });
}

function updateTheme(theme) {
  if (theme === 'light') {
    document.documentElement.setAttribute('data-theme', 'light');
    localStorage.setItem(THEME_STORAGE_KEY, 'light');
  } else {
    document.documentElement.removeAttribute('data-theme');
    localStorage.setItem(THEME_STORAGE_KEY, 'dark');
  }
}

function updateShowSuspendHostSetting(next) {
  setShowSuspendHostSetting(next, { persist: true });
  syncSuspendHostVisibility();
}

function openSettingsModal() {
  closeChatActionsMenu();
  const modal = document.getElementById('settings-modal');
  const themeSelect = document.getElementById('theme-select');
  if (themeSelect) {
    themeSelect.value = localStorage.getItem(THEME_STORAGE_KEY) === 'light' ? 'light' : 'dark';
  }
  syncSuspendHostVisibility();
  syncFontScaleSelect();
  syncPwaAppNameInput();
  modal?.classList.add('visible');
  modal?.setAttribute('aria-hidden', 'false');
}

function closeSettingsModal() {
  const modal = document.getElementById('settings-modal');
  modal?.classList.remove('visible');
  modal?.setAttribute('aria-hidden', 'true');
}

window.updateTheme = updateTheme;
window.updateFontScaleFromSelect = updateFontScaleFromSelect;
window.updatePwaAppName = updatePwaAppName;
window.updateShowSuspendHostSetting = updateShowSuspendHostSetting;
window.openSettingsModal = openSettingsModal;
window.closeSettingsModal = closeSettingsModal;

function showAuthGate() {
  document.getElementById('auth-gate').style.display = 'flex';
  document.getElementById('app').classList.remove('visible');
}

async function initApp() {
  initTheme();
  initFontScaling();
  clearLegacyKnownCwdHistoryStorage();
  syncPwaVersionMenuEntry();
  syncQueueStatusMenuEntry();
  syncSuspendHostVisibility();
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
  const chatMenuSelectModelsBtn = document.getElementById('chat-menu-select-models');
  bindMenuAction(chatMenuSelectModelsBtn, (event) => {
    event.preventDefault();
    event.stopPropagation();
    lockChatActionsMenuShield(350);
    closeChatActionsMenu();
    openSelectModelsModal().catch((error) => {
      alert(error?.message || 'Failed to open model selector');
    });
  });
  const chatMenuChangeCwdBtn = document.getElementById('chat-menu-change-cwd');
  bindMenuAction(chatMenuChangeCwdBtn, (event) => {
    event.preventDefault();
    event.stopPropagation();
    lockChatActionsMenuShield(350);
    closeChatActionsMenu();
    openChangeCwdModal();
  });
  const chatMenuSettingsBtn = document.getElementById('chat-menu-settings');
  bindMenuAction(chatMenuSettingsBtn, (event) => {
    event.preventDefault();
    event.stopPropagation();
    lockChatActionsMenuShield(350);
    closeChatActionsMenu();
    openSettingsModal();
  });
  const chatMenuRestartRelayBtn = document.getElementById('chat-menu-restart-relay');
  bindMenuAction(chatMenuRestartRelayBtn, (event) => {
    event.preventDefault();
    event.stopPropagation();
    lockChatActionsMenuShield(350);
    closeChatActionsMenu();
    openRestartRelayConfirmation();
  });
  const chatMenuEmptyQueueBtn = document.getElementById('chat-menu-empty-queue');
  bindMenuAction(chatMenuEmptyQueueBtn, (event) => {
    event.preventDefault();
    event.stopPropagation();
    openEmptyQueueConfirmation();
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
  syncQueueStatusMenuEntry(status);
  setSessionWorkerStatesFromStatusPayload(status?.sessionWorker || null);
  await refreshModelCatalog(true);
  initFullscreenButton();
  initInstallButton();
  initPullToRefresh();
  initChatTitleCopy();
  initEmojiPicker();
  initConversationListLazyLoading();
  initConversationHistoryLazyLoading();
  initMessageScrollPersistence();
  initMessageSearchView({ openConversation });
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
  const scopeBase = BASE;
  const scopeRoot = `${scopeBase}/`;
  const pwaVersion = String(window.__COPILOT_PWA_VERSION || '0').trim() || '0';
  return navigator.serviceWorker.register(`${scopeBase}/sw.js?v=${encodeURIComponent(pwaVersion)}`, { scope: scopeRoot, updateViaCache: 'none' }).catch(() => {});
}

async function bootstrap() {
  if (ensureTrailingSlashPath()) return;
  await applyPwaManifestFromSettings();
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
window.openChangeCwdModal = openChangeCwdModal;
window.confirmChangeCwd = confirmChangeCwd;
window.confirmChangeCwdAndLaunch = confirmChangeCwdAndLaunch;
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
window.saveSelectedModelsFromModal = saveSelectedModelsFromModal;
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
window.submitRelayStructuredAnswer = submitRelayStructuredAnswer;
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
window.openSuspendHostConfirmation = openSuspendHostConfirmation;
window.confirmKillCurrentSession = confirmKillCurrentSession;
window.confirmRestartWebRelay = confirmRestartWebRelay;
window.confirmSuspendHost = confirmSuspendHost;
window.confirmEmptyQueue = confirmEmptyQueue;
window.openMessageSearchModal = openMessageSearchModal;
window.closeMessageSearchModal = closeMessageSearchModal;

bootstrap();
