import {
  CLIENT_ID,
  currentConvId,
  conversations,
  repoBrowserState,
  workspaceRootPath,
  defaultSessionWorkspaceRootPath,
  defaultSessionWorkspaceRootWarning,
  getConversationWorkspaceState,
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
  setHistoryRefreshInFlight,
  isHistoryRefreshInFlight,
  setSummaryModalLoading,
  renderSummaryModalContent,
  openSummaryModal,
  closeSummaryModal,
  refreshSummaryModal,
  syncViewportMetrics,
  isMobileComposerViewport,
  releaseComposerFocusAfterSend,
  autoResize,
  initSidebarLayout,
  toggleSidebar,
  loadConversationScrollTop,
  loadConversationLoadedMessageCount,
  saveConversationScrollTop,
  getSessionWorkerState,
  resolveConversationUiState,
  summaryModalState,
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
  refreshConversationHistory,
  updateConversationTitle,
  updateConversationPreferences,
  updateDefaultSessionWorkspaceRoot,
  scheduleContextUsageRefresh,
} from './api-client.js';
import { loadConversations, refreshConversations, openConversation, renderConvList, applyLoadedConversationState, initConversationListLazyLoading } from './journal-view.js';
import { newConversation, deleteConv } from './journal-view.js';
import {
  loadRelayQuestions,
  getPendingQuestionCountsByConversation,
} from './ask-user-view.js';
import { openPendingQuestionFromBanner, submitRelayQuestionChoice, submitRelayQuestionAnswer, submitRelayStructuredAnswer, onRelayQuestionDraftInput, handleRelayQuestionKey } from './ask-user-view.js';
import { loadRelayBoards, submitRelayBoardAction } from './relay-board-view.js';
import {
  restoreInFlightThinking,
  renderMessages,
  appendMessage,
  compactCurrentConversation,
  sendMessage,
  handleKey,
  getConversationLoadedMessageCount,
  loadOlderConversationMessages,
  syncComposerControlState,
  setConversationDraftPersistenceEnabled,
  flushConversationDraft,
  initConversationHistoryLazyLoading,
  initBubbleActionHandlers,
  isSendInFlight,
} from './conversation-view.js';
import { loadRepoBrowserTree, openRepoBrowser, closeRepoBrowser, setRepoBrowserSessionInfo } from './attachments-view.js';
import { handleAttachmentInput, removeAttachment, clearAttachments, openUploadedAttachmentViewer, setFilePreviewMode, toggleFilePreviewHtml, closeFilePreview, openWorkspaceFilePreview, openWorkspaceFilePreviewFromRepo, setRepoBrowserRoot, setRepoBrowserViewMode, toggleRepoBrowserHidden, toggleRepoBrowserHeavy, refreshRepoBrowser, focusRepoTree, setRepoCurrentPath } from './attachments-view.js';
import { initEmojiPicker, toggleEmojiPicker } from './emoji-view.js';
import {
  resolveConversationComposerSelection,
  withUpdatedModelPreference,
  normalizePreferredModelsByMode,
} from './conversation-preferences.mjs';
import {
  initMessageSearchView,
  openMessageSearchModal,
  closeMessageSearchModal,
} from './message-search-view.js';

import { initSocketHandlers, connectSocket } from './socket-handlers.js';
import {
  initInstallButton,
  initFullscreenButton,
  promptInstallApp,
  toggleFullscreen,
  applyPwaManifestFromSettings,
  registerPwaShell,
  updatePwaAppName,
} from './pwa-install.js';
import { initFontScaling, updateFontScaleFromSelect } from './font-scaling.js';
import {
  initCwdPicker,
  openChangeCwdModal,
  confirmChangeCwd,
  confirmChangeCwdAndLaunch,
  syncChatHeaderWorkspaceLabel,
  normalizeKnownCwdPath,
  clearLegacyKnownCwdHistoryStorage,
  bindTapAction,
  bindMenuAction,
} from './cwd-picker.js';
import { initTmuxInspectorView, closeTmuxInspectorView } from './tmux-inspector-view.js';
import {
  initTheme,
  updateTheme,
  openSettingsModal,
  closeSettingsModal,
  syncSuspendHostVisibility,
  updateShowSuspendHostSetting,
  syncDefaultSessionWorkspaceRootInput,
  updateDefaultSessionWorkspaceRootSetting,
} from './settings-modal.js';
import {
  initActionConfirmations,
  openKillSessionConfirmation,
  confirmKillCurrentSession,
  openRestartRelayConfirmation,
  confirmRestartWebRelay,
  openEmptyQueueConfirmation,
  confirmEmptyQueue,
  openSuspendHostConfirmation,
  confirmSuspendHost,
} from './action-confirmations.js';

const MODEL_STORAGE_KEY = 'copilot_selected_model';
const REASONING_STORAGE_KEY = 'copilot_selected_reasoning_effort';
const MODE_STORAGE_KEY = 'copilot_selected_mode';
const MODELS_BY_MODE_STORAGE_KEY = 'copilot_selected_models_by_mode';
const REASONING_BY_MODE_STORAGE_KEY = 'copilot_selected_reasoning_by_mode';
const AUTO_MODEL_OPTION = 'auto';
const FALLBACK_MODEL = 'gpt-5.4-mini';
const FALLBACK_REASONING_EFFORT = 'none';
const FALLBACK_MODE = 'agent';
const PROVIDER_LABELS = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google',
  microsoft: 'Microsoft',
  other: 'Other',
};
const CHAT_TITLE_MAX_LENGTH = 120;
const LOCAL_PROCESSING_STALE_MS = 5 * 60 * 1000;

let relayQuestionPollTimer = null;
let relayBoardPollTimer = null;
let sessionWorkerStatusPollTimer = null;
let viewportBaseHeight = window.innerHeight || document.documentElement.clientHeight || 0;
let chatTitleEditingConversationId = null;
let relayQuestionRenderHash = '';
let modelCatalogState = {
  models: [FALLBACK_MODEL],
  currentModel: FALLBACK_MODEL,
  defaultModel: FALLBACK_MODEL,
  reasoningByModel: {},
  reasoningEfforts: [],
  stale: true,
  metadataValid: false,
  reasoningMetadataValid: false,
  warning: null,
  error: null,
  refreshedAt: null,
};
let lastHealthyModelCatalogState = null;
let modelMetadataBlocked = true;
let modelMetadataRetryInFlight = false;
let modelVariantCatalogState = {
  variants: [],
  enabledVariantIds: [],
  reasoningByModel: {},
  source: null,
  refreshedAt: null,
  warning: null,
  error: null,
  reasoningEfforts: [],
};
let activeConversationPreferredModelsByMode = {};
let activeConversationPreferredReasoningByMode = {};
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
  if (String(modelVariantId || '').trim().toLowerCase() === AUTO_MODEL_OPTION) return 'Auto';
  const { baseModelId, reasoningEffort } = splitVariantId(modelVariantId);
  if (!baseModelId) return modelVariantId;
  const baseLabel = humanizeModelLabel(baseModelId);
  return reasoningEffort ? `${baseLabel} (${reasoningEffort})` : baseLabel;
}

function normalizeReasoningEffortList(efforts = []) {
  const values = Array.isArray(efforts)
    ? efforts.map((value) => String(value || '').trim().toLowerCase()).filter(Boolean)
    : [];
  return Array.from(new Set(values));
}

function isModelMetadataHealthy(payload = modelCatalogState) {
  if (!payload || typeof payload !== 'object') return false;
  if (payload.metadataValid === false) return false;
  if (payload.stale) return false;
  const reasoningByModel = payload.reasoningByModel && typeof payload.reasoningByModel === 'object'
    ? payload.reasoningByModel
    : {};
  const modelIds = Object.keys(reasoningByModel).filter((modelId) => modelId !== AUTO_MODEL_OPTION);
  if (!modelIds.length) return false;
  return modelIds.every((modelId) => {
    const efforts = reasoningByModel[modelId];
    return Array.isArray(efforts) && efforts.length > 0;
  });
}

function syncModelMetadataBlocker(message = '') {
  const blocker = document.getElementById('model-metadata-blocker');
  const text = document.getElementById('model-metadata-blocker-text');
  const retryBtn = document.getElementById('model-metadata-retry-btn');
  const blocked = modelMetadataBlocked || !isModelMetadataHealthy();
  if (text) {
    text.textContent = String(message || '').trim()
      || 'Model metadata is unavailable. Refresh to choose a model and reasoning effort.';
  }
  if (retryBtn) retryBtn.disabled = modelMetadataRetryInFlight;
  blocker?.classList.toggle('visible', blocked);
  const modelSelect = document.getElementById('model-select');
  const reasoningSelect = document.getElementById('reasoning-effort-select');
  if (modelSelect) {
    modelSelect.disabled = blocked;
    modelSelect.title = blocked ? 'Model metadata unavailable' : 'Model';
  }
  if (reasoningSelect) {
    reasoningSelect.disabled = blocked;
    reasoningSelect.title = blocked ? 'Reasoning metadata unavailable' : 'Reasoning effort';
  }
  window.syncComposerControlState?.();
}

function applyModelMetadataHardFail(message = '') {
  modelMetadataBlocked = true;
  syncModelMetadataBlocker(message);
  setModelBanner(`⚠️ ${String(message || 'Model metadata is unavailable.').trim()}`);
}

function clearModelMetadataHardFail() {
  modelMetadataBlocked = false;
  syncModelMetadataBlocker('');
  if (!modelCatalogState.warning && !modelCatalogState.stale) {
    setModelBanner('');
  }
}

function readStoredReasoningByMode() {
  const raw = String(localStorage.getItem(REASONING_BY_MODE_STORAGE_KEY) || '').trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out = {};
    for (const [mode, effort] of Object.entries(parsed)) {
      const modeKey = String(mode || '').trim();
      const effortValue = String(effort || '').trim().toLowerCase();
      if (!modeKey || !effortValue) continue;
      out[modeKey] = effortValue;
    }
    return out;
  } catch {
    return {};
  }
}

function reasoningOptionsForModel(modelId = '') {
  if (!isModelMetadataHealthy()) return [];
  const key = String(modelId || '').trim().toLowerCase();
  return normalizeReasoningEffortList(modelCatalogState.reasoningByModel?.[key] || []);
}

function selectedReasoningEffortValue() {
  const select = document.getElementById('reasoning-effort-select');
  const value = String(select?.value || '').trim().toLowerCase();
  if (value) return value;
  return FALLBACK_REASONING_EFFORT;
}

function updateReasoningSelectorForModel(modelId, preferredEffort = '') {
  const select = document.getElementById('reasoning-effort-select');
  if (!select) return;
  const options = reasoningOptionsForModel(modelId);
  const selectedBefore = String(select.value || '').trim().toLowerCase();
  select.innerHTML = '';
  if (!options.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'Unavailable';
    select.appendChild(opt);
    select.value = '';
    return;
  }
  for (const effort of options) {
    const opt = document.createElement('option');
    opt.value = effort;
    opt.textContent = effort;
    select.appendChild(opt);
  }
  const preferred = String(preferredEffort || '').trim().toLowerCase();
  const resolved = [preferred, selectedBefore, localStorage.getItem(REASONING_STORAGE_KEY)]
    .map((value) => String(value || '').trim().toLowerCase())
    .find((value) => value && options.includes(value))
    || options[0];
  select.value = resolved;
  localStorage.setItem(REASONING_STORAGE_KEY, resolved);
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
  if (!nextModels.includes(AUTO_MODEL_OPTION)) nextModels.unshift(AUTO_MODEL_OPTION);
  if (!nextModels.length) nextModels.push(FALLBACK_MODEL);

  const nextState = {
    models: nextModels,
    currentModel: currentModel || nextModels[0] || FALLBACK_MODEL,
    defaultModel: defaultModel || nextModels[0] || FALLBACK_MODEL,
    reasoningByModel: payload?.reasoningByModel && typeof payload.reasoningByModel === 'object'
      ? Object.fromEntries(Object.entries(payload.reasoningByModel).map(([modelId, efforts]) => [
        String(modelId || '').trim().toLowerCase(),
        normalizeReasoningEffortList(efforts),
      ]))
      : {},
    reasoningEfforts: normalizeReasoningEffortList(payload?.reasoningEfforts || []),
    stale: !!payload?.stale,
    metadataValid: payload?.metadataValid === true,
    reasoningMetadataValid: payload?.reasoningMetadataValid === true,
    warning: payload?.warning ? String(payload.warning) : null,
    error: payload?.error ? String(payload.error) : null,
    refreshedAt: payload?.refreshedAt || null,
  };

  const nextHealthy = isModelMetadataHealthy(nextState);
  const currentlyHealthy = isModelMetadataHealthy(modelCatalogState);
  if (!nextHealthy && !currentlyHealthy && isModelMetadataHealthy(lastHealthyModelCatalogState)) {
    modelCatalogState = { ...lastHealthyModelCatalogState };
    clearModelMetadataHardFail();
    setModelBanner('⚠️ Model metadata refresh failed; restored last known good catalog.');
    syncModelMetadataBlocker();
    return;
  }
  if (!nextHealthy && currentlyHealthy) {
    setModelBanner('⚠️ Model metadata refresh failed; keeping last known good catalog.');
    syncModelMetadataBlocker();
    return;
  }

  modelCatalogState = nextState;

  if (!nextHealthy) {
    applyModelMetadataHardFail(
      modelCatalogState.error
        ? `Model metadata error: ${modelCatalogState.error}`
        : (modelCatalogState.warning || 'Model metadata is stale or incomplete.'),
    );
  } else {
    lastHealthyModelCatalogState = modelCatalogState;
    clearModelMetadataHardFail();
  }

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
  const preferredReasoningForMode = String(activeConversationPreferredReasoningByMode?.[selectedMode] || '').trim().toLowerCase();
  updateReasoningSelectorForModel(preferred, preferredReasoningForMode);
  if (selectedMode) {
    activeConversationPreferredModelsByMode = withUpdatedModelPreference({
      preferredModelsByMode: activeConversationPreferredModelsByMode,
      mode: selectedMode,
      model: preferred,
      supportedModes: Array.from(document.getElementById('mode-select')?.options || []).map((option) => option.value),
    });
    localStorage.setItem(MODELS_BY_MODE_STORAGE_KEY, JSON.stringify(activeConversationPreferredModelsByMode));
    activeConversationPreferredReasoningByMode = {
      ...activeConversationPreferredReasoningByMode,
      [selectedMode]: selectedReasoningEffortValue(),
    };
    localStorage.setItem(REASONING_BY_MODE_STORAGE_KEY, JSON.stringify(activeConversationPreferredReasoningByMode));
  }

  if (modelCatalogState.warning && isModelMetadataHealthy(modelCatalogState)) {
    setModelBanner(`⚠️ ${modelCatalogState.warning}`);
  } else if (modelCatalogState.stale && isModelMetadataHealthy(modelCatalogState)) {
    setModelBanner('⚠️ Model list is cached from CLI; selection may be stale.');
  } else if (isModelMetadataHealthy(modelCatalogState)) {
    setModelBanner('');
  }
  syncModelMetadataBlocker();
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
  const reasoningEffort = selectedReasoningEffortValue();
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
  if (reasoningEffort) localStorage.setItem(REASONING_STORAGE_KEY, reasoningEffort);
  activeConversationPreferredReasoningByMode = {
    ...activeConversationPreferredReasoningByMode,
    [mode]: reasoningEffort || FALLBACK_REASONING_EFFORT,
  };
  localStorage.setItem(REASONING_BY_MODE_STORAGE_KEY, JSON.stringify(activeConversationPreferredReasoningByMode));

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
  const modeReasoning = String(activeConversationPreferredReasoningByMode?.[selection.mode] || '').trim().toLowerCase();
  updateReasoningSelectorForModel(selection.model || modelSelect.value, modeReasoning);
  suppressConversationPreferenceSync = false;

  activeConversationPreferredModelsByMode = {
    ...readStoredModelsByMode(),
    ...selection.preferredModelsByMode,
  };
  activeConversationPreferredReasoningByMode = {
    ...readStoredReasoningByMode(),
    ...activeConversationPreferredReasoningByMode,
  };
  localStorage.setItem(MODELS_BY_MODE_STORAGE_KEY, JSON.stringify(activeConversationPreferredModelsByMode));
  localStorage.setItem(REASONING_BY_MODE_STORAGE_KEY, JSON.stringify(activeConversationPreferredReasoningByMode));
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
      const preferredReasoning = String(activeConversationPreferredReasoningByMode?.[mode] || '').trim().toLowerCase();
      updateReasoningSelectorForModel(select.value, preferredReasoning);
      void persistCurrentConversationPreferences().catch(() => {});
    });
  }
}

function initReasoningSelector() {
  const select = document.getElementById('reasoning-effort-select');
  if (!select || select.dataset.bound === '1') return;
  select.dataset.bound = '1';
  select.addEventListener('change', () => {
    if (suppressConversationPreferenceSync) return;
    const mode = String(document.getElementById('mode-select')?.value || '').trim() || FALLBACK_MODE;
    activeConversationPreferredReasoningByMode = {
      ...activeConversationPreferredReasoningByMode,
      [mode]: selectedReasoningEffortValue(),
    };
    localStorage.setItem(REASONING_BY_MODE_STORAGE_KEY, JSON.stringify(activeConversationPreferredReasoningByMode));
    void persistCurrentConversationPreferences().catch(() => {});
  });
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
      const modeReasoning = String(activeConversationPreferredReasoningByMode?.[mode] || '').trim().toLowerCase();
      updateReasoningSelectorForModel(modelSelect.value, modeReasoning);
    }
    void persistCurrentConversationPreferences().catch(() => {});
  });
}

function refreshModelCatalog(force = false) {
  return loadModelCatalog().then((r) => {
    if (!r) {
      if (isModelMetadataHealthy(modelCatalogState) || isModelMetadataHealthy(lastHealthyModelCatalogState)) {
        setModelBanner('⚠️ Could not refresh model metadata; using last known good catalog.');
        syncModelMetadataBlocker();
        return null;
      }
      applyModelMetadataHardFail(force
        ? 'Could not refresh live model metadata.'
        : 'Could not load model metadata.');
      return null;
    }
    updateModelCatalogState(r);
    return r;
  });
}

async function retryModelMetadataRefresh() {
  if (modelMetadataRetryInFlight) return;
  modelMetadataRetryInFlight = true;
  syncModelMetadataBlocker('Refreshing model metadata…');
  try {
    const refreshed = await refreshModelVariantCatalog();
    if (!refreshed) throw new Error('Model variant refresh failed');
    await refreshModelCatalog(true);
    if (!isModelMetadataHealthy()) {
      throw new Error('Model metadata is still unavailable after refresh');
    }
    showTransientRelayNotice('Model metadata refreshed.');
  } catch (error) {
    applyModelMetadataHardFail(error?.message || 'Model metadata refresh failed.');
  } finally {
    modelMetadataRetryInFlight = false;
    syncModelMetadataBlocker();
  }
}

function applyModelVariantCatalogState(payload) {
  const rawVariants = Array.isArray(payload?.variants)
    ? payload.variants.map((entry) => ({
      variantId: String(entry?.variantId || '').trim(),
      baseModelId: String(entry?.baseModelId || '').trim(),
      provider: String(entry?.provider || 'other').trim().toLowerCase() || 'other',
      label: String(entry?.label || '').trim(),
      releaseStatus: String(entry?.releaseStatus || '').trim().toLowerCase() || null,
      reasoningEffort: String(entry?.reasoningEffort || '').trim().toLowerCase() || null,
      enabled: !!entry?.enabled,
      sortOrder: Number.isFinite(Number(entry?.sortOrder)) ? Math.max(0, Math.trunc(Number(entry.sortOrder))) : 0,
    })).filter((entry) => entry.variantId && entry.baseModelId)
    : [];
  const canonicalizeId = (value) => String(value || '').trim().toLowerCase();
  const dedupedVariantsMap = new Map();
  for (const entry of rawVariants) {
    const dedupeKey = canonicalizeId(entry.variantId);
    const existing = dedupedVariantsMap.get(dedupeKey);
    if (!existing) {
      dedupedVariantsMap.set(dedupeKey, {
        ...entry,
        variantId: dedupeKey,
        baseModelId: canonicalizeId(entry.baseModelId),
      });
      continue;
    }
    dedupedVariantsMap.set(dedupeKey, {
      ...existing,
      enabled: existing.enabled || entry.enabled,
      releaseStatus: (existing.releaseStatus === null || entry.releaseStatus === null)
        ? null
        : (existing.releaseStatus || entry.releaseStatus),
      sortOrder: Math.min(existing.sortOrder, entry.sortOrder),
      label: existing.label || entry.label,
      provider: existing.provider || entry.provider,
    });
  }
  const variants = Array.from(dedupedVariantsMap.values());
  const requestedEnabledVariantIds = Array.isArray(payload?.enabledVariantIds)
    ? payload.enabledVariantIds.map((value) => canonicalizeId(value)).filter(Boolean)
    : variants.filter((entry) => entry.enabled).map((entry) => entry.variantId);
  const enabledVariantIds = new Set(requestedEnabledVariantIds.filter((value) => dedupedVariantsMap.has(value)));
  modelVariantCatalogState = {
    variants,
    enabledVariantIds: Array.from(enabledVariantIds),
    reasoningByModel: payload?.reasoningByModel && typeof payload.reasoningByModel === 'object'
      ? Object.fromEntries(Object.entries(payload.reasoningByModel).map(([modelId, efforts]) => [
        String(modelId || '').trim().toLowerCase(),
        normalizeReasoningEffortList(efforts),
      ]))
      : {},
    source: String(payload?.source || '').trim() || null,
    refreshedAt: payload?.refreshedAt || null,
    warning: payload?.warning ? String(payload.warning) : null,
    error: payload?.error ? String(payload.error) : null,
    reasoningEfforts: Array.isArray(payload?.reasoningEfforts)
      ? payload.reasoningEfforts.map((value) => String(value || '').trim().toLowerCase()).filter(Boolean)
      : [],
  };
}

function buildReasoningEffortsByBaseModel(variants = [], reasoningByModel = {}) {
  const map = new Map();
  for (const entry of variants) {
    const baseModelId = String(entry.baseModelId || '').trim().toLowerCase();
    if (!baseModelId) continue;
    if (!map.has(baseModelId)) {
      map.set(baseModelId, {
        label: entry.label,
        efforts: new Set(),
      });
    }
    const effort = String(entry.reasoningEffort || '').trim().toLowerCase();
    if (effort) map.get(baseModelId).efforts.add(effort);
  }
  for (const [baseModelId, efforts] of Object.entries(reasoningByModel || {})) {
    const key = String(baseModelId || '').trim().toLowerCase();
    if (!key) continue;
    if (!map.has(key)) {
      map.set(key, { label: humanizeModelLabel(key), efforts: new Set() });
    }
    for (const effort of Array.isArray(efforts) ? efforts : []) {
      const normalized = String(effort || '').trim().toLowerCase();
      if (normalized) map.get(key).efforts.add(normalized);
    }
  }
  return map;
}

function renderReasoningEffortChipRow(efforts = []) {
  const list = Array.from(efforts).sort();
  if (!list.length) {
    return '<span class="model-reasoning-chip model-reasoning-chip-muted">standard</span>';
  }
  return list.map((effort) => `<span class="model-reasoning-chip">${escHtml(effort)}</span>`).join('');
}

async function reconcileOpenModelVariantModal() {
  const modal = document.getElementById('summary-modal');
  if (!modal?.classList.contains('visible')) return;
  if (summaryModalState.kind !== 'select-models') return;
  const payload = await loadModelVariantCatalog();
  if (!payload) return;
  applyModelVariantCatalogState(payload);
  renderModelVariantCatalogBody();
}

function renderModelVariantCatalogBody() {
  const grouped = new Map();
  for (const entry of modelVariantCatalogState.variants) {
    const providerKey = String(entry.provider || 'other').trim().toLowerCase() || 'other';
    if (!grouped.has(providerKey)) grouped.set(providerKey, []);
    grouped.get(providerKey).push(entry);
  }
  const selected = new Set(modelVariantCatalogState.enabledVariantIds);
  const selectedOrder = new Map(
    modelVariantCatalogState.enabledVariantIds.map((variantId, index) => [variantId, index]),
  );
  const providerSortMeta = (providerKey) => {
    const rows = grouped.get(providerKey) || [];
    const selectedPositions = rows
      .filter((row) => selected.has(row.variantId))
      .map((row) => selectedOrder.get(row.variantId))
      .filter((value) => Number.isFinite(value));
    const hasSelected = selectedPositions.length > 0;
    const firstSelectedPos = hasSelected ? Math.min(...selectedPositions) : Number.POSITIVE_INFINITY;
    return { hasSelected, firstSelectedPos };
  };
  const providerOrder = Array.from(grouped.keys()).sort((a, b) => {
    const aMeta = providerSortMeta(a);
    const bMeta = providerSortMeta(b);
    if (aMeta.hasSelected !== bMeta.hasSelected) return aMeta.hasSelected ? -1 : 1;
    if (aMeta.firstSelectedPos !== bMeta.firstSelectedPos) return aMeta.firstSelectedPos - bMeta.firstSelectedPos;
    const aLabel = PROVIDER_LABELS[a] || a;
    const bLabel = PROVIDER_LABELS[b] || b;
    return aLabel.localeCompare(bLabel);
  });
  const refreshedLabel = modelVariantCatalogState.refreshedAt
    ? new Date(modelVariantCatalogState.refreshedAt).toLocaleString()
    : 'Never';
  const warnings = [
    modelVariantCatalogState.warning ? `⚠️ ${escHtml(modelVariantCatalogState.warning)}` : '',
    modelVariantCatalogState.error ? `⚠️ ${escHtml(modelVariantCatalogState.error)}` : '',
  ].filter(Boolean);
  const reasoningByBaseModel = buildReasoningEffortsByBaseModel(
    modelVariantCatalogState.variants,
    modelVariantCatalogState.reasoningByModel,
  );
  const groupsHtml = providerOrder.map((providerKey) => {
    const providerLabel = PROVIDER_LABELS[providerKey] || providerKey;
    const rows = grouped.get(providerKey) || [];
    rows.sort((a, b) => {
      const aSelected = selected.has(a.variantId);
      const bSelected = selected.has(b.variantId);
      if (aSelected !== bSelected) return aSelected ? -1 : 1;

      const aSelectedPos = selectedOrder.has(a.variantId)
        ? selectedOrder.get(a.variantId)
        : Number.POSITIVE_INFINITY;
      const bSelectedPos = selectedOrder.has(b.variantId)
        ? selectedOrder.get(b.variantId)
        : Number.POSITIVE_INFINITY;
      if (aSelectedPos !== bSelectedPos) return aSelectedPos - bSelectedPos;

      if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
      return a.variantId.localeCompare(b.variantId);
    });
    const byBaseModel = new Map();
    for (const row of rows) {
      const baseModelId = String(row.baseModelId || '').trim().toLowerCase();
      if (!byBaseModel.has(baseModelId)) byBaseModel.set(baseModelId, []);
      byBaseModel.get(baseModelId).push(row);
    }
    const baseModelBlocks = Array.from(byBaseModel.entries()).map(([baseModelId, variantRows]) => {
      const meta = reasoningByBaseModel.get(baseModelId) || { label: humanizeModelLabel(baseModelId), efforts: new Set() };
      const label = meta.label || humanizeModelLabel(baseModelId) || baseModelId;
      const variantRowsHtml = variantRows.map((row) => {
        const checked = selected.has(row.variantId);
        const effortChip = row.reasoningEffort
          ? ` <span class="model-reasoning-chip">${escHtml(row.reasoningEffort)}</span>`
          : '';
        const unavailable = row.releaseStatus === 'unavailable';
        const statusChip = unavailable
          ? ' <span class="model-reasoning-chip model-reasoning-chip-warn">unavailable</span>'
          : '';
        return `
          <label class="model-variant-row">
            <input class="model-variant-checkbox" type="checkbox" data-variant-id="${escHtml(row.variantId)}" ${checked ? 'checked' : ''}>
            <span class="model-variant-row-copy">
              <span class="model-variant-row-title">${escHtml(row.variantId)}${effortChip}${statusChip}</span>
            </span>
          </label>
        `;
      }).join('');
      return `
        <div class="model-base-group">
          <div class="model-base-header">
            <div class="model-base-title">${escHtml(label)}</div>
            <div class="model-base-reasoning">
              <span class="model-base-reasoning-label">Reasoning</span>
              ${renderReasoningEffortChipRow(meta.efforts)}
            </div>
            <code class="model-base-id">${escHtml(baseModelId)}</code>
          </div>
          <div class="model-variant-list">${variantRowsHtml}</div>
        </div>
      `;
    }).join('');
    return `
      <section class="model-provider-group">
        <div class="model-provider-title">${escHtml(providerLabel)}</div>
        ${baseModelBlocks || '<div class="model-provider-empty">No models</div>'}
      </section>
    `;
  }).join('');
  const bodyHtml = `
    <div style="display:flex;flex-direction:column;gap:10px">
      <div style="font-size:0.8rem;color:var(--muted)">
        Saved globally for this relay. Refreshed: <strong>${escHtml(refreshedLabel)}</strong>
      </div>
      <div style="font-size:0.78rem;color:var(--muted)">
        Variants marked unavailable are preserved from earlier selections so updates do not reset your models.
      </div>
      <div style="font-size:0.78rem;color:var(--muted)">
        Each model shows all supported reasoning efforts above its selectable variants.
      </div>
      ${warnings.map((line) => `<div style="font-size:0.78rem;color:var(--warn,#f7c873)">${line}</div>`).join('')}
      <div style="display:grid;gap:10px">${groupsHtml || '<div style="color:var(--muted)">No models discovered yet. Click Refresh.</div>'}</div>
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
  const headerActions = document.querySelector('#summary-modal .summary-header-actions');
  const refreshBtn = document.getElementById('summary-modal-refresh');
  if (headerActions && refreshBtn && !document.getElementById('summary-modal-save-models')) {
    const saveBtn = document.createElement('button');
    saveBtn.id = 'summary-modal-save-models';
    saveBtn.className = 'summary-btn';
    saveBtn.type = 'button';
    saveBtn.textContent = '💾 Save enabled models';
    saveBtn.onclick = () => saveSelectedModelsFromModal();
    headerActions.insertBefore(saveBtn, refreshBtn);
  }
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
  const currentId = String(currentConvId || '').trim();
  const currentConversation = currentId ? conversations[currentId] : null;
  const currentSdkSessionId = String(currentConversation?.sdkSessionId || currentConversation?.sdk_session_id || '').trim();
  const previousWorkerState = currentSdkSessionId ? getSessionWorkerState(currentSdkSessionId) : null;
  const previousWorkerStatus = String(previousWorkerState?.status || '').trim().toLowerCase();
  const status = await refreshWorkspaceRootHints();
  if (!status) return;
  setConversationDraftPersistenceEnabled(status?.features?.CONVERSATION_DRAFT_PERSISTENCE_ENABLED === true);
  syncQueueStatusMenuEntry(status);
  if (setSessionWorkerStatesFromStatusPayload(status.sessionWorker)) {
    renderConvList();
  }
  updateCliStatus();
  const nextWorkerState = currentSdkSessionId ? getSessionWorkerState(currentSdkSessionId) : null;
  const transitionedToOffline = (
    ['starting', 'ready', 'processing'].includes(previousWorkerStatus)
    && !nextWorkerState
  );
  const hasSessionUsageSummary = !!(
    currentConversation?.sessionUsageSummary
    || currentConversation?.session_usage_summary
  );
  if (transitionedToOffline && currentId && !hasSessionUsageSummary) {
    refreshCurrentView().catch(() => {});
  }
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
      void flushConversationDraft(currentConvId);
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

async function runConversationHistoryRefresh({ source = 'menu' } = {}) {
  const currentId = String(currentConvId || '').trim();
  if (!currentId) {
    if (source !== 'pull') showTransientRelayNotice('Select a conversation first.');
    return false;
  }
  const eligibility = canRefreshConversationHistory(currentId);
  if (!eligibility.ok) {
    showTransientRelayNotice(eligibility.reason);
    return false;
  }

  const messagesEl = document.getElementById('messages');
  const scrollTop = messagesEl?.scrollTop || 0;
  const savedLoadedCount = loadConversationLoadedMessageCount(currentId);
  const requestLimit = Math.max(20, getConversationLoadedMessageCount() || 0, savedLoadedCount || 0);

  setHistoryRefreshInFlight(true);
  syncRefreshHistoryMenuState();
  try {
    const refreshed = await refreshConversationHistory(currentId, { limit: requestLimit });
    if (!refreshed) {
      throw new Error('History refresh request failed.');
    }
    if (String(currentConvId || '').trim() === currentId) {
      applyLoadedConversationState(currentId, refreshed, { restoreScroll: false });
    }
    await refreshConversations();
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
    showTransientRelayNotice('Conversation history refreshed.');
    return true;
  } catch (error) {
    const message = String(error?.message || '').trim() || 'Could not refresh conversation history.';
    showTransientRelayNotice(message);
    return false;
  } finally {
    setHistoryRefreshInFlight(false);
    syncRefreshHistoryMenuState();
  }
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
    const refreshed = await runConversationHistoryRefresh({ source: 'pull' });
    if (!refreshed) {
      await refreshCurrentView();
    }
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
    syncRefreshHistoryMenuState();
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
  syncRefreshHistoryMenuState();
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
  syncRefreshHistoryMenuState();
  const willOpen = !!menu.hidden;
  menu.hidden = !willOpen;
  trigger.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
}

function isConversationLocallyProcessing(conversation) {
  if (!conversation || typeof conversation !== 'object') return false;
  const localTurnStatus = String(conversation?.localTurnStatus || '').trim().toLowerCase();
  if (localTurnStatus === 'processing') {
    const updatedAtMs = Number(conversation?.localTurnStatusUpdatedAt || 0);
    if (!Number.isFinite(updatedAtMs) || updatedAtMs <= 0 || (Date.now() - updatedAtMs) < LOCAL_PROCESSING_STALE_MS) {
      return true;
    }
  }
  const runtimeStatus = String(
    conversation?.runtimeSessionStatus
    || conversation?.runtime_session_status
    || conversation?.status
    || '',
  ).trim().toLowerCase();
  return runtimeStatus === 'processing';
}

function canRefreshConversationHistory(conversationId) {
  const currentId = String(conversationId || '').trim();
  if (!currentId) {
    return { ok: false, reason: 'Select a conversation first.' };
  }
  if (isHistoryRefreshInFlight()) {
    return { ok: false, reason: 'History refresh is already running.' };
  }
  if (isSendInFlight()) {
    return { ok: false, reason: 'Wait for the current send to finish before refreshing history.' };
  }
  const conversation = conversations[currentId] || null;
  if (isConversationLocallyProcessing(conversation)) {
    return { ok: false, reason: 'Wait for the current turn to finish before refreshing history.' };
  }
  return { ok: true };
}

function syncRefreshHistoryMenuState() {
  const button = document.getElementById('chat-menu-refresh-history');
  if (!button) return;
  if (isHistoryRefreshInFlight()) {
    button.disabled = true;
    button.title = 'Refreshing conversation history';
    return;
  }
  const eligibility = canRefreshConversationHistory(currentConvId);
  button.disabled = !eligibility.ok;
  button.title = eligibility.ok ? 'Rebuild this conversation history from SDK events.' : eligibility.reason;
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


initSocketHandlers({
  refreshCurrentView,
  refreshSessionWorkerStatus,
  refreshModelCatalog,
  updateModelCatalogState,
  reconcileOpenModelVariantModal,
  applyConversationWorkspaceRootUpdate,
  applyConversationTitleUpdate,
  syncChatTitleControls,
  applyConversationPreferencesForConversation,
});

initCwdPicker({
  applyConversationWorkspaceRootUpdate,
  refreshSessionWorkerStatus,
});

initActionConfirmations({
  lockChatActionsMenuShield,
  closeChatActionsMenu,
  syncQueueStatusMenuEntry,
  refreshSessionWorkerStatus,
  exposeOnWindow: false,
});
initTmuxInspectorView({
  bindMenuAction,
  lockChatActionsMenuShield,
  closeChatActionsMenu,
});

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
  activeConversationPreferredReasoningByMode = readStoredReasoningByMode();
  setupViewportTracking();
  window.addEventListener('pagehide', () => {
    void flushConversationDraft(currentConvId);
    closeTmuxInspectorView();
  });
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
  const chatMenuRefreshHistoryBtn = document.getElementById('chat-menu-refresh-history');
  bindMenuAction(chatMenuRefreshHistoryBtn, (event) => {
    event.preventDefault();
    event.stopPropagation();
    lockChatActionsMenuShield(350);
    closeChatActionsMenu();
    runConversationHistoryRefresh({ source: 'menu' }).catch(() => {});
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
  initReasoningSelector();
  const modelMetadataRetryBtn = document.getElementById('model-metadata-retry-btn');
  if (modelMetadataRetryBtn && modelMetadataRetryBtn.dataset.bound !== '1') {
    modelMetadataRetryBtn.dataset.bound = '1';
    modelMetadataRetryBtn.addEventListener('click', () => {
      void retryModelMetadataRefresh();
    });
  }
  syncModelMetadataBlocker();
  const status = await refreshWorkspaceRootHints();
  syncQueueStatusMenuEntry(status);
  setSessionWorkerStatesFromStatusPayload(status?.sessionWorker || null);
  await refreshModelCatalog(true);
  initFullscreenButton();
  initInstallButton();
  initPullToRefresh();
  syncRefreshHistoryMenuState();
  initChatTitleCopy();
  initEmojiPicker();
  initConversationListLazyLoading();
  initConversationHistoryLazyLoading();
  initBubbleActionHandlers();
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

window.updateTheme = updateTheme;
window.updateFontScaleFromSelect = updateFontScaleFromSelect;
window.updatePwaAppName = updatePwaAppName;
window.updateDefaultSessionWorkspaceRootSetting = updateDefaultSessionWorkspaceRootSetting;
window.updateShowSuspendHostSetting = updateShowSuspendHostSetting;
window.openSettingsModal = openSettingsModal;
window.closeSettingsModal = closeSettingsModal;
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
window.retryModelMetadataRefresh = retryModelMetadataRefresh;
window.isModelMetadataBlocked = () => modelMetadataBlocked || !isModelMetadataHealthy();
window.saveSelectedModelsFromModal = saveSelectedModelsFromModal;
window.selectedModelValue = selectedModelValue;
window.selectedReasoningEffortValue = selectedReasoningEffortValue;
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
