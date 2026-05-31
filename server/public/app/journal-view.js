import {
  conversations,
  currentConvId,
  fmtDate,
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
import { renderMessages, restoreInFlightThinking } from './conversation-view.js';
import { loadRelayQuestions, getPendingQuestionCountsByConversation } from './ask-user-view.js';
import { loadRelayBoards } from './relay-board-view.js';
import { clearAttachments, setRepoBrowserSessionInfo, loadRepoBrowserTree } from './attachments-view.js';
import { shouldApplyConversationLoad } from './activity-replay-state.mjs';

const PROCESSING_DOT_FRAMES = ['   ', '.  ', '.. ', '...'];
const PROCESSING_DOT_INTERVAL_MS = 1000;
const LOCAL_PROCESSING_STALE_MS = 5 * 60 * 1000;
let processingDotFrame = 0;
let processingDotTimer = null;
let openConversationVersion = 0;

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
  await refreshConversations();
  const lastId = localStorage.getItem('copilot_last_conv');
  if (lastId && conversations[lastId]) await openConversation(lastId, { restoreScroll: true });
}

export async function refreshConversations() {
  const r = await loadConversationsApi();
  if (!r) return;
  for (const key of Object.keys(conversations)) delete conversations[key];
  for (const c of r.conversations) conversations[c.id] = c;
  renderConvList();
  updateCompactButton();
}

export function renderConvList() {
  const list = document.getElementById('conv-list');
  const sorted = Object.values(conversations).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  const pendingByConversation = getPendingQuestionCountsByConversation();
  let hasProcessingConversation = false;
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
  list.innerHTML = sorted.map((c) => {
    const view = conversationView(c);
    const processingDots = view.processing ? PROCESSING_DOT_FRAMES[processingDotFrame] : '';
    return `
    <div class="conv-item worker-ui-${view.visualState}${c.id === currentConvId ? ' active' : ''}" onclick="openConversation('${c.id}')">
      <div class="conv-title">${escHtml(c.title)}${processingDots ? `<span class="conv-processing-dots">${escHtml(` ${processingDots}`)}</span>` : ''}${c.archived ? ' <span style="font-size:0.68rem;color:var(--muted)">(archived)</span>' : ''}${pendingByConversation[c.id] ? ` <span class="conv-open-questions">${pendingByConversation[c.id]} open</span>` : ''}</div>
      <div class="conv-meta">${fmtDate(c.updatedAt)} · ${c.messageCount} msg${c.messageCount !== 1 ? 's' : ''}</div>
      <button class="conv-delete" onclick="deleteConv(event,'${c.id}')" title="Delete">🗑</button>
    </div>`;
  }).join('');
  ensureProcessingDotTimer(hasProcessingConversation);
  window.syncChatTitleControls?.();
}

export function applyLoadedConversationState(id, response, { restoreScroll = false, savedScrollTop = null } = {}) {
  if (!response) {
    setRepoBrowserSessionInfo('', '');
    restoreInFlightThinking(null);
    renderMessages([]);
    window.syncChatTitleControls?.();
    return;
  }
  if (conversations[id]) {
    conversations[id] = {
      ...conversations[id],
      preferredRelayMode: response.preferredRelayMode ?? conversations[id].preferredRelayMode,
      preferredModelsByMode: response.preferredModelsByMode ?? conversations[id].preferredModelsByMode,
      configuredWorkspaceRootPath: response.configuredWorkspaceRootPath ?? conversations[id].configuredWorkspaceRootPath ?? null,
      configuredWorkspaceRootName: response.configuredWorkspaceRootName ?? conversations[id].configuredWorkspaceRootName ?? null,
      runtimeWorkspaceRootPath: response.runtimeWorkspaceRootPath ?? conversations[id].runtimeWorkspaceRootPath ?? null,
      runtimeWorkspaceRootName: response.runtimeWorkspaceRootName ?? conversations[id].runtimeWorkspaceRootName ?? null,
      currentWorkspaceRootPath: response.currentWorkspaceRootPath ?? conversations[id].currentWorkspaceRootPath ?? null,
      currentWorkspaceRootName: response.currentWorkspaceRootName ?? conversations[id].currentWorkspaceRootName ?? null,
    };
  }
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
  // #region agent log
  fetch('http://127.0.0.1:7611/ingest/41e205ad-83bf-40b2-b2ab-5040e785036c',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'0e20dd'},body:JSON.stringify({sessionId:'0e20dd',id:`log_${Date.now()}_${Math.random().toString(36).slice(2,10)}`,runId:'ui-regressions-baseline',hypothesisId:'H12-scroll-restore',location:'server/public/app/journal-view.js:applyLoadedConversationState.before-restore',message:'attempting to restore conversation scroll position',data:{conversationId:String(id||'').trim()||null,restoreScroll,savedScrollTop:Number.isFinite(savedScrollTop)?savedScrollTop:null,currentScrollTop:el.scrollTop,scrollHeight:el.scrollHeight,clientHeight:el.clientHeight},timestamp:Date.now()})}).catch(()=>{});
  // #endregion
  if (Number.isFinite(savedScrollTop)) {
    el.scrollTop = savedScrollTop;
    saveConversationScrollTop(id, el.scrollTop);
    // #region agent log
    fetch('http://127.0.0.1:7611/ingest/41e205ad-83bf-40b2-b2ab-5040e785036c',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'0e20dd'},body:JSON.stringify({sessionId:'0e20dd',id:`log_${Date.now()}_${Math.random().toString(36).slice(2,10)}`,runId:'ui-regressions-baseline',hypothesisId:'H13-scroll-overwrite',location:'server/public/app/journal-view.js:applyLoadedConversationState.after-restore',message:'restored conversation scroll position from saved value',data:{conversationId:String(id||'').trim()||null,restoredScrollTop:el.scrollTop,scrollHeight:el.scrollHeight,clientHeight:el.clientHeight},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
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

  const savedScrollTop = loadConversationScrollTop(id);
  const restoreScroll = Number.isFinite(savedScrollTop);
  const savedLoadedCount = loadConversationLoadedMessageCount(id);
  // #region agent log
  fetch('http://127.0.0.1:7611/ingest/41e205ad-83bf-40b2-b2ab-5040e785036c',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'0e20dd'},body:JSON.stringify({sessionId:'0e20dd',id:`log_${Date.now()}_${Math.random().toString(36).slice(2,10)}`,runId:'ui-regressions-baseline',hypothesisId:'H12-scroll-restore',location:'server/public/app/journal-view.js:openConversation.saved-scroll',message:'open conversation loaded saved view state',data:{conversationId:String(id||'').trim()||null,savedScrollTop:Number.isFinite(savedScrollTop)?savedScrollTop:null,savedLoadedCount:Number.isFinite(savedLoadedCount)?savedLoadedCount:null},timestamp:Date.now()})}).catch(()=>{});
  // #endregion
  const requestLimit = Number.isFinite(savedLoadedCount)
    ? Math.max(20, savedLoadedCount)
    : 20;
  const r = await loadConversation(id, { limit: requestLimit });
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
