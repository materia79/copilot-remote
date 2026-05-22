import {
  conversations,
  currentConvId,
  fmtDate,
  escHtml,
  getSessionWorkerState,
  resolveConversationUiState,
  setCurrentConv,
  updateSessionPill,
  updateCompactButton,
  closeSidebar,
  applyContextUsageBar,
  isMobileComposerViewport,
  releaseComposerFocusAfterSend,
} from './store.js';
import {
  loadConversations as loadConversationsApi,
  loadConversation,
  deleteConversation as deleteConversationApi,
  scheduleContextUsageRefresh,
} from './api-client.js';
import { renderMessages, restoreInFlightThinking } from './conversation-view.js';
import { loadRelayQuestions, getPendingQuestionCountsByConversation } from './ask-user-view.js';
import { clearAttachments, setRepoBrowserSessionInfo } from './attachments-view.js';

const PROCESSING_DOT_FRAMES = ['', '.', '..', '...'];
const PROCESSING_DOT_INTERVAL_MS = 450;
let processingDotFrame = 0;
let processingDotTimer = null;

function isConversationProcessing(conversation, workerState) {
  const workerStatus = String(workerState?.status || '').trim().toLowerCase();
  if (workerStatus === 'processing') return true;
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
  if (lastId && conversations[lastId]) await openConversation(lastId);
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
      <div class="conv-meta">${fmtDate(c.updatedAt)} · ${c.messageCount} msg${c.messageCount !== 1 ? 's' : ''}${c.runtimeSessionId ? ` · S:${escHtml(String(c.runtimeSessionId).slice(0, 8))}` : ''}</div>
      <button class="conv-delete" onclick="deleteConv(event,'${c.id}')" title="Delete">🗑</button>
    </div>`;
  }).join('');
  ensureProcessingDotTimer(hasProcessingConversation);
}

export async function openConversation(id) {
  setCurrentConv(id);
  closeSidebar();
  clearAttachments();
  document.getElementById('chat-title').textContent = conversations[id]?.title || id;
  window.syncChatTitleControls?.();
  updateSessionPill(conversations[id], null);
  updateCompactButton();
  renderConvList();

  const r = await loadConversation(id, { limit: 20 });
  if (r) {
    setRepoBrowserSessionInfo(r.sessionRootPath || '', r.sessionRootName || r.title || '');
    renderMessages(r.messages, true, r);
    restoreInFlightThinking(r.inFlight || null);
    updateSessionPill(conversations[id], r.runtimeSession || null);
  } else {
    setRepoBrowserSessionInfo('', '');
    restoreInFlightThinking(null);
    renderMessages([]);
  }
  await loadRelayQuestions(id);
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
  renderMessages([]);
  renderConvList();
  scheduleContextUsageRefresh(null);
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
    renderMessages([]);
    document.getElementById('chat-title').textContent = 'Select or start a conversation';
    window.syncChatTitleControls?.();
    updateSessionPill(null, null);
    updateCompactButton();
    scheduleContextUsageRefresh(null);
  }
}

