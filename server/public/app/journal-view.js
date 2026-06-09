import {
  conversations,
  currentConvId,
  fmtDate,
  parseTimestampMs,
  escHtml,
  repoBrowserState,
  getSessionWorkerState,
  resolveConversationUiState,
  setCurrentConv,
  updateSessionPill,
  updateCompactButton,
  closeSidebar,
  applyContextUsageBar,
  isMobileComposerViewport,
  releaseComposerFocusAfterSend,
  loadConversationScrollTop,
  loadConversationLoadedMessageCount,
  saveConversationScrollTop,
} from './store.js';
import {
  loadConversations as loadConversationsApi,
  loadConversation,
  deleteConversation as deleteConversationApi,
  scheduleContextUsageRefresh,
} from './api-client.js';
import { renderMessages, restoreInFlightThinking, focusConversationMessageById } from './conversation-view.js';
import { loadRelayQuestions, getPendingQuestionCountsByConversation } from './ask-user-view.js';
import { loadRelayBoards } from './relay-board-view.js';
import { clearAttachments, setRepoBrowserSessionInfo, loadRepoBrowserTree } from './attachments-view.js';
import { shouldApplyConversationLoad } from './activity-replay-state.mjs';
import { createInfiniteLoader } from './infinite-loader.js';

const PROCESSING_DOT_FRAMES = ['   ', '.  ', '.. ', '...'];
const PROCESSING_DOT_INTERVAL_MS = 1000;
const LOCAL_PROCESSING_STALE_MS = 5 * 60 * 1000;
const CONVERSATION_LIST_PAGE_SIZE = 40;
let processingDotFrame = 0;
let processingDotTimer = null;
let openConversationVersion = 0;
let conversationListBoundaryCheckFrame = 0;
let conversationListAutoLoadBlockedUntil = 0;
let conversationListPaginationState = {
  hasMore: false,
  nextCursor: null,
  hasPrefetchedPage: false,
  isLoading: false,
  isPrefetching: false,
  hasLoadedOlderPages: false,
};

function mergeConversationRecord(current, next) {
  return {
    ...(current && typeof current === 'object' ? current : {}),
    ...(next && typeof next === 'object' ? next : {}),
  };
}

function upsertConversationRecord(record) {
  const id = String(record?.id || '').trim();
  if (!id) return false;
  const hadExistingRecord = !!conversations[id];
  conversations[id] = mergeConversationRecord(conversations[id], record);
  return !hadExistingRecord;
}

function getConversationListElement() {
  return document.getElementById('conv-list');
}

function getConversationListBoundaryDistance() {
  const el = getConversationListElement();
  if (!el) return Number.POSITIVE_INFINITY;
  return Math.max(0, el.scrollHeight - el.clientHeight - el.scrollTop);
}

function scheduleConversationListBoundaryCheck() {
  if (conversationListBoundaryCheckFrame) return;
  conversationListBoundaryCheckFrame = requestAnimationFrame(() => {
    conversationListBoundaryCheckFrame = 0;
    if (Date.now() < conversationListAutoLoadBlockedUntil) return;
    void conversationListLoader.handleBoundaryDistance(getConversationListBoundaryDistance());
  });
}

function applyConversationPage(items = []) {
  for (const conversation of Array.isArray(items) ? items : []) {
    upsertConversationRecord(conversation);
  }
  renderConvList();
  updateCompactButton();
  scheduleConversationListBoundaryCheck();
}

const conversationListLoader = createInfiniteLoader({
  fetchPage: async (cursor) => {
    const response = await loadConversationsApi({
      limit: CONVERSATION_LIST_PAGE_SIZE,
      beforeConversationId: String(cursor?.beforeConversationId || '').trim(),
      beforeUpdatedAt: String(cursor?.beforeUpdatedAt || '').trim(),
    });
    if (!response) throw new Error('Could not load conversations');
    return {
      items: response.conversations || [],
      hasMore: !!response.pageInfo?.hasMore,
      nextCursor: response.pageInfo?.nextCursor || null,
    };
  },
  applyPage: async (page) => {
    applyConversationPage(page.items);
    conversationListPaginationState.hasLoadedOlderPages = true;
  },
  onError: (error) => {
    conversationListAutoLoadBlockedUntil = Date.now() + 2000;
    console.error('Conversation list paging failed:', error);
  },
  onStateChange: (state) => {
    conversationListPaginationState = {
      ...conversationListPaginationState,
      ...state,
    };
    renderConvList();
  },
});

function resetConversationListPageState(pageInfo = null, { preserveProgress = false } = {}) {
  const currentState = conversationListLoader.getState();
  const nextState = preserveProgress && conversationListPaginationState.hasLoadedOlderPages
    ? currentState
    : {
        hasMore: !!pageInfo?.hasMore,
        nextCursor: pageInfo?.nextCursor || null,
      };
  if (!preserveProgress) {
    conversationListPaginationState.hasLoadedOlderPages = false;
  }
  conversationListAutoLoadBlockedUntil = 0;
  conversationListLoader.reset(nextState);
  scheduleConversationListBoundaryCheck();
}

function isConversationProcessing(conversation, workerState) {
  const workerStatus = String(workerState?.status || '').trim().toLowerCase();
  if (workerStatus === 'processing') return true;
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

function ensureProcessingDotTimer(enabled) {
  if (enabled) {
    if (processingDotTimer) return;
    processingDotTimer = setInterval(() => {
      processingDotFrame = (processingDotFrame + 1) % PROCESSING_DOT_FRAMES.length;
      renderConvList();
    }, PROCESSING_DOT_INTERVAL_MS);
    return;
  }
  if (processingDotTimer) {
    clearInterval(processingDotTimer);
    processingDotTimer = null;
  }
  processingDotFrame = 0;
}

export async function loadConversations() {
  await refreshConversations({ preservePagination: false });
  const lastId = localStorage.getItem('copilot_last_conv');
  if (lastId) await openConversation(lastId, { restoreScroll: true });
}

export async function refreshConversations(options = {}) {
  const preservePagination = options?.preservePagination !== false;
  const r = await loadConversationsApi({ limit: CONVERSATION_LIST_PAGE_SIZE });
  if (!r) return;
  if (Array.isArray(r.knownConversationIds)) {
    const knownConversationIds = new Set(
      r.knownConversationIds
        .map((id) => String(id || '').trim())
        .filter(Boolean),
    );
    for (const id of Object.keys(conversations)) {
      if (!knownConversationIds.has(id)) delete conversations[id];
    }
  }
  applyConversationPage(r.conversations || []);
  resetConversationListPageState(r.pageInfo || null, {
    preserveProgress: preservePagination,
  });
  renderConvList();
  updateCompactButton();
}

export function renderConvList() {
  const list = document.getElementById('conv-list');
  const sorted = Object.values(conversations).sort((a, b) => {
    const updatedAtDelta = parseTimestampMs(b.updatedAt) - parseTimestampMs(a.updatedAt);
    if (updatedAtDelta !== 0) return updatedAtDelta;
    return String(b?.id || '').trim().localeCompare(String(a?.id || '').trim());
  });
  const pendingByConversation = getPendingQuestionCountsByConversation();
  let hasProcessingConversation = false;
  const footerHtml = (() => {
    if (conversationListPaginationState.isLoading) {
      return '<div class="conv-list-footer">Loading older conversations…</div>';
    }
    if (conversationListPaginationState.hasMore || conversationListPaginationState.isPrefetching) {
      return '<div class="conv-list-footer">Scroll for older conversations</div>';
    }
    return '';
  })();
  if (sorted.length === 0) {
    ensureProcessingDotTimer(false);
    list.innerHTML = '<div style="padding:12px;color:var(--muted);font-size:0.85rem;text-align:center">No conversations yet</div>';
    return;
  }
  const conversationView = (conversation) => {
    const pendingCount = Number(pendingByConversation[conversation?.id] || 0);
    const sdkSessionId = String(conversation?.sdkSessionId || '').trim();
    const workerState = sdkSessionId ? getSessionWorkerState(sdkSessionId) : null;
    const visualState = resolveConversationUiState({
      conversation,
      workerState,
      hasPendingQuestion: pendingCount > 0,
    });
    const processing = isConversationProcessing(conversation, workerState);
    if (processing) hasProcessingConversation = true;
    return { visualState, processing };
  };
  list.innerHTML = `${sorted.map((c) => {
    const view = conversationView(c);
    const processingDots = view.processing ? PROCESSING_DOT_FRAMES[processingDotFrame] : '';
    return `
    <div class="conv-item worker-ui-${view.visualState}${c.id === currentConvId ? ' active' : ''}" onclick="openConversation('${c.id}')">
      <div class="conv-title">${escHtml(c.title)}${processingDots ? `<span class="conv-processing-dots">${escHtml(` ${processingDots}`)}</span>` : ''}${c.archived ? ' <span style="font-size:0.68rem;color:var(--muted)">(archived)</span>' : ''}${pendingByConversation[c.id] ? ` <span class="conv-open-questions">${pendingByConversation[c.id]} open</span>` : ''}</div>
      <div class="conv-meta">${fmtDate(c.updatedAt)} · ${c.messageCount} msg${c.messageCount !== 1 ? 's' : ''}</div>
      <button class="conv-delete" onclick="deleteConv(event,'${c.id}')" title="Delete">🗑</button>
    </div>`;
  }).join('')}${footerHtml}`;
  ensureProcessingDotTimer(hasProcessingConversation);
  window.syncChatTitleControls?.();
  scheduleConversationListBoundaryCheck();
}

export function applyLoadedConversationState(id, response, { restoreScroll = false, savedScrollTop = null } = {}) {
  if (!response) {
    setRepoBrowserSessionInfo('', '');
    restoreInFlightThinking(null);
    renderMessages([]);
    window.syncChatTitleControls?.();
    return;
  }
  const existingConversation = conversations[id] || {};
  upsertConversationRecord({
    ...existingConversation,
    id: id,
    sdkSessionId: response.sdkSessionId ?? existingConversation.sdkSessionId ?? null,
    title: response.title ?? existingConversation.title ?? id,
    archived: response.archived ?? existingConversation.archived ?? false,
    compactedInto: response.compactedInto ?? existingConversation.compactedInto ?? null,
    compactedFrom: response.compactedFrom ?? existingConversation.compactedFrom ?? null,
    updatedAt: response.updatedAt ?? existingConversation.updatedAt ?? new Date().toISOString(),
    preferredRelayMode: response.preferredRelayMode ?? existingConversation.preferredRelayMode,
    preferredModelsByMode: response.preferredModelsByMode ?? existingConversation.preferredModelsByMode,
    configuredWorkspaceRootPath: response.configuredWorkspaceRootPath ?? existingConversation.configuredWorkspaceRootPath ?? null,
    configuredWorkspaceRootName: response.configuredWorkspaceRootName ?? existingConversation.configuredWorkspaceRootName ?? null,
    runtimeWorkspaceRootPath: response.runtimeWorkspaceRootPath ?? existingConversation.runtimeWorkspaceRootPath ?? null,
    runtimeWorkspaceRootName: response.runtimeWorkspaceRootName ?? existingConversation.runtimeWorkspaceRootName ?? null,
    currentWorkspaceRootPath: response.currentWorkspaceRootPath ?? existingConversation.currentWorkspaceRootPath ?? null,
    currentWorkspaceRootName: response.currentWorkspaceRootName ?? existingConversation.currentWorkspaceRootName ?? null,
    messageCount: Array.isArray(response.messages)
      ? Math.max(existingConversation.messageCount || 0, response.messages.length)
      : (existingConversation.messageCount || 0),
  });
  renderConvList();
  window.applyConversationPreferences?.(id, {
    preferredRelayMode: response.preferredRelayMode,
    preferredModelsByMode: response.preferredModelsByMode,
  });
  setRepoBrowserSessionInfo(response.sessionRootPath || '', response.sessionRootName || response.title || '');
  if (repoBrowserState.open && repoBrowserState.activeRoot === 'workspace') {
    void loadRepoBrowserTree();
  }
  renderMessages(response.messages, !restoreScroll, response);
  restoreInFlightThinking(response.inFlight || null);
  updateSessionPill(conversations[id], response.runtimeSession || null);
  window.syncChatTitleControls?.();
  if (!restoreScroll) return;
  const el = document.getElementById('messages');
  if (!el) return;
  if (Number.isFinite(savedScrollTop)) {
    el.scrollTop = savedScrollTop;
    saveConversationScrollTop(id, el.scrollTop);
    return;
  }
  el.scrollTop = el.scrollHeight;
  saveConversationScrollTop(id, el.scrollTop);
}

export async function openConversation(id, options = {}) {
  const capturedVersion = ++openConversationVersion;
  setCurrentConv(id);
  if (repoBrowserState.activeRoot === 'workspace') {
    repoBrowserState.tree = null;
    repoBrowserState.nodeMap = new Map();
    repoBrowserState.currentPath = '';
    repoBrowserState.truncated = false;
    repoBrowserState.nodeCount = 0;
    repoBrowserState.maxNodes = 0;
    repoBrowserState.loadingPath = '';
    repoBrowserState.error = '';
  }
  closeSidebar();
  clearAttachments();
  document.getElementById('chat-title').textContent = conversations[id]?.title || id;
  window.syncChatTitleControls?.();
  updateSessionPill(conversations[id], null);
  updateCompactButton();
  renderConvList();
  if (repoBrowserState.open && repoBrowserState.activeRoot === 'workspace') {
    void loadRepoBrowserTree();
  }

  const focusMessageId = String(options.focusMessageId || '').trim();
  const aroundMessageId = String(options.aroundMessageId || focusMessageId || '').trim();
  const forceFreshWindow = !!aroundMessageId;
  const savedScrollTop = loadConversationScrollTop(id);
  const restoreScroll = !forceFreshWindow && Number.isFinite(savedScrollTop);
  const savedLoadedCount = loadConversationLoadedMessageCount(id);
  const requestLimit = forceFreshWindow
    ? 40
    : (Number.isFinite(savedLoadedCount)
      ? Math.max(20, savedLoadedCount)
      : 20);
  const r = await loadConversation(id, {
    limit: requestLimit,
    aroundMessageId: aroundMessageId || undefined,
  });
  if (!shouldApplyConversationLoad({
    requestedConversationId: id,
    activeConversationId: currentConvId,
    capturedVersion,
    currentVersion: openConversationVersion,
  })) {
    return;
  }
  if (r) {
    applyLoadedConversationState(id, r, { restoreScroll, savedScrollTop });
    if (focusMessageId) {
      requestAnimationFrame(() => {
        focusConversationMessageById(focusMessageId, { behavior: 'smooth', block: 'center' });
      });
    }
  } else {
    setRepoBrowserSessionInfo('', '');
    restoreInFlightThinking(null);
    renderMessages([]);
  }
  await loadRelayQuestions(id);
  await loadRelayBoards();
  if (!shouldApplyConversationLoad({
    requestedConversationId: id,
    activeConversationId: currentConvId,
    capturedVersion,
    currentVersion: openConversationVersion,
  })) {
    return;
  }
  applyContextUsageBar(null);
  scheduleContextUsageRefresh(id, 0);
  const composer = document.getElementById('msg-input');
  if (isMobileComposerViewport()) {
    releaseComposerFocusAfterSend(composer);
  } else {
    composer.focus();
  }
}

export async function newConversation() {
  setCurrentConv(null);
  closeSidebar();
  clearAttachments();
  setRepoBrowserSessionInfo('', '');
  document.getElementById('chat-title').textContent = 'New Conversation';
  window.syncChatTitleControls?.();
  updateSessionPill(null, null);
  updateCompactButton();
  restoreInFlightThinking(null);
  renderMessages([]);
  renderConvList();
  scheduleContextUsageRefresh(null);
  window.applyConversationPreferences?.(null, null);
  document.getElementById('msg-input').focus();
}

export function initConversationListLazyLoading() {
  const el = getConversationListElement();
  if (!el || el.dataset.lazyLoadBound === '1') return;
  el.dataset.lazyLoadBound = '1';
  el.addEventListener('scroll', () => {
    conversationListAutoLoadBlockedUntil = 0;
    void conversationListLoader.handleBoundaryDistance(getConversationListBoundaryDistance());
  }, { passive: true });
  scheduleConversationListBoundaryCheck();
}

export async function deleteConv(e, id) {
  e.stopPropagation();
  if (!confirm('Delete this conversation?')) return;
  const result = await deleteConversationApi(id);
  if (!result) return;
  delete conversations[id];
  renderConvList();
  if (currentConvId === id) {
    setCurrentConv(null);
    clearAttachments();
    setRepoBrowserSessionInfo('', '');
    restoreInFlightThinking(null);
    renderMessages([]);
    document.getElementById('chat-title').textContent = 'Select or start a conversation';
    window.syncChatTitleControls?.();
    updateSessionPill(null, null);
    updateCompactButton();
    scheduleContextUsageRefresh(null);
  }
}
