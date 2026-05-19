import {
  conversations,
  currentConvId,
  fmtDate,
  escHtml,
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
import { clearAttachments } from './attachments-view.js';

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
  if (sorted.length === 0) {
    list.innerHTML = '<div style="padding:12px;color:var(--muted);font-size:0.85rem;text-align:center">No conversations yet</div>';
    return;
  }
  list.innerHTML = sorted.map(c => `
    <div class="conv-item${c.id === currentConvId ? ' active' : ''}" onclick="openConversation('${c.id}')">
      <div class="conv-title">${escHtml(c.title)}${c.archived ? ' <span style="font-size:0.68rem;color:var(--muted)">(archived)</span>' : ''}${pendingByConversation[c.id] ? ` <span class="conv-open-questions">${pendingByConversation[c.id]} open</span>` : ''}</div>
      <div class="conv-meta">${fmtDate(c.updatedAt)} · ${c.messageCount} msg${c.messageCount !== 1 ? 's' : ''}${c.runtimeSessionId ? ` · S:${escHtml(String(c.runtimeSessionId).slice(0, 8))}` : ''}</div>
      <button class="conv-delete" onclick="deleteConv(event,'${c.id}')" title="Delete">🗑</button>
    </div>`).join('');
}

export async function openConversation(id) {
  setCurrentConv(id);
  closeSidebar();
  clearAttachments();
  document.getElementById('chat-title').textContent = conversations[id]?.title || id;
  updateSessionPill(conversations[id], null);
  updateCompactButton();
  renderConvList();

  const r = await loadConversation(id);
  if (r) {
    renderMessages(r.messages);
    restoreInFlightThinking(r.inFlight || null);
    updateSessionPill(conversations[id], r.runtimeSession || null);
  } else {
    restoreInFlightThinking(null);
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
  document.getElementById('chat-title').textContent = 'New Conversation';
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
  await deleteConversationApi(id);
  delete conversations[id];
  renderConvList();
  if (currentConvId === id) {
    setCurrentConv(null);
    clearAttachments();
    renderMessages([]);
    document.getElementById('chat-title').textContent = 'Select or start a conversation';
    updateSessionPill(null, null);
    updateCompactButton();
    scheduleContextUsageRefresh(null);
  }
}

