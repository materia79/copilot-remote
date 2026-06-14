import {
  cliOnline,
  compactInFlight,
  conversations,
  CLIENT_ID,
  currentConvId,
  escHtml,
  fmtDate,
  generateId,
  hasPendingUserMessageDuplicate,
  clearPendingUserMessage,
  pendingUserMessageIds,
  trackPendingUserMessage,
  seenMessageIds,
  relayActivities,
  relayThoughts,
  selectedAttachments,
  setCompactInFlight,
  setCurrentConv,
  updateCompactButton,
  updateSessionPill,
  updateWorkspaceRootHints,
  applyContextUsageBar,
  scrollBottom,
  scrollBottomAfterSend,
  isMobileComposerViewport,
  releaseComposerFocusAfterSend,
  autoResize,
  setModelBanner,
  showTransientRelayNotice,
  repoBrowserState,
  saveConversationLoadedMessageCount,
} from './store.js';
import { sendMessage as sendMessageApi, cancelConversationTurn, compactConversation as compactConversationApi, scheduleContextUsageRefresh, loadConversation as loadConversationApi } from './api-client.js';
import { linkifyWorkspaceMentionsInNode, renderMarkdownPreview, rewriteLocalAssetUrlsInNode } from './router.js';
import { renderAttachmentMarkup, clearAttachments, uploadAttachments, setRepoBrowserSessionInfo } from './attachments-view.js';
import { renderRelayQuestions } from './ask-user-view.js';
import { renderRelayBoards } from './relay-board-view.js';
import { getMessageThreadAnchor, sortConversationMessages } from './thread-order.mjs';
import { normalizeStreamSeq, deriveLatestInFlightStreamEvent, computeNextRelayStreamState } from './stream-state.mjs';
import { mergeRelayActivityTexts } from './activity-replay-state.mjs';
import { deriveComposerControlState, hasComposerDraft } from './composer-control-state.mjs';
import { buildLiveMessageFingerprint } from './live-message-dedupe.mjs';
import { createInfiniteLoader } from './infinite-loader.js';

const CONVERSATION_HISTORY_PAGE_SIZE = 20;
const HISTORY_LOAD_MORE_ID = 'history-load-more';
const OPAQUE_RELAY_TEXT_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

let thinkingMessageId = null;
let thinkingText = '';
const relayStreamStateByMessageId = new Map();
const completedMessageIds = new Set();
let sendInFlight = false;
const activeTurnsByConversation = new Map();
let conversationHistoryState = {
  conversationId: '',
  hasMoreOlder: false,
  hasMoreNewer: false,
  oldestMessageId: '',
  oldestMessageTimestamp: '',
  newestMessageId: '',
  newestMessageTimestamp: '',
  loadedMessageCount: 0,
  loadingOlder: false,
  loadingNewer: false,
};

const conversationHistoryLoader = createInfiniteLoader({
  fetchPage: async (cursor) => {
    const conversationId = String(currentConvId || '').trim();
    if (!conversationId) {
      return {
        items: [],
        hasMore: false,
        nextCursor: null,
      };
    }
    const response = await loadConversationApi(conversationId, {
      limit: CONVERSATION_HISTORY_PAGE_SIZE,
      beforeMessageId: String(cursor?.beforeMessageId || '').trim(),
      beforeTimestamp: String(cursor?.beforeTimestamp || '').trim(),
    });
    if (String(currentConvId || '').trim() !== conversationId) return null;
    if (!response) throw new Error('Could not load older messages. Please try again.');
    return {
      items: response.messages || [],
      hasMore: !!response.pageInfo?.hasMore,
      nextCursor: response.pageInfo?.nextCursor || null,
    };
  },
  applyPage: async (page) => {
    const currentId = String(currentConvId || '').trim();
    const el = getMessagesElement();
    if (!currentId || !el) return;
    const previousScrollTop = el.scrollTop;
    const previousScrollHeight = el.scrollHeight;
    const inserted = prependMessageNodes(page.items || []);
    setConversationHistoryState({
      conversationId: currentId,
      hasMoreOlder: page.hasMore,
      hasMoreNewer: conversationHistoryState.hasMoreNewer,
      oldestMessageId: String(page.nextCursor?.beforeMessageId || conversationHistoryState.oldestMessageId || '').trim(),
      oldestMessageTimestamp: String(page.nextCursor?.beforeTimestamp || conversationHistoryState.oldestMessageTimestamp || '').trim(),
      newestMessageId: String(conversationHistoryState.newestMessageId || '').trim(),
      newestMessageTimestamp: String(conversationHistoryState.newestMessageTimestamp || '').trim(),
      loadedMessageCount: getConversationLoadedMessageCount() + inserted.inserted,
      loadingOlder: false,
      loadingNewer: conversationHistoryState.loadingNewer,
    });
    renderRelayQuestions();
    renderRelayBoards();
    requestAnimationFrame(() => {
      if (!el || String(currentConvId || '').trim() !== currentId) return;
      const nextScrollHeight = el.scrollHeight;
      el.scrollTop = previousScrollTop + (nextScrollHeight - previousScrollHeight);
      void conversationHistoryLoader.handleBoundaryDistance(el.scrollTop);
    });
  },
  onError: (error, { mode }) => {
    if (mode === 'load') {
      showTransientRelayNotice(error?.message || 'Could not load older messages. Please try again.');
    }
  },
  onStateChange: (state) => {
    conversationHistoryState = {
      ...conversationHistoryState,
      hasMoreOlder: state.hasMore,
      loadingOlder: state.isLoading,
    };
    syncHistoryLoadMoreControl();
  },
});

const conversationFutureLoader = createInfiniteLoader({
  fetchPage: async (cursor) => {
    const conversationId = String(currentConvId || '').trim();
    if (!conversationId) {
      return {
        items: [],
        hasMore: false,
        nextCursor: null,
      };
    }
    const response = await loadConversationApi(conversationId, {
      limit: CONVERSATION_HISTORY_PAGE_SIZE,
      afterMessageId: String(cursor?.afterMessageId || '').trim(),
      afterTimestamp: String(cursor?.afterTimestamp || '').trim(),
    });
    if (String(currentConvId || '').trim() !== conversationId) return null;
    if (!response) throw new Error('Could not load newer messages. Please try again.');
    return {
      items: response.messages || [],
      hasMore: !!response.pageInfo?.hasMoreNewer,
      nextCursor: response.pageInfo?.newerCursor || null,
    };
  },
  applyPage: async (page) => {
    const currentId = String(currentConvId || '').trim();
    const ordered = sortConversationMessages(page.items || []);
    let inserted = 0;
    for (const m of ordered) {
      const msgId = String(m?.id || '').trim() || null;
      const node = appendMessage(m, false, msgId, true, null, false);
      if (node) inserted += 1;
    }
    setConversationHistoryState({
      conversationId: currentId,
      hasMoreOlder: conversationHistoryState.hasMoreOlder,
      hasMoreNewer: page.hasMore,
      oldestMessageId: String(conversationHistoryState.oldestMessageId || '').trim(),
      oldestMessageTimestamp: String(conversationHistoryState.oldestMessageTimestamp || '').trim(),
      newestMessageId: String(page.nextCursor?.afterMessageId || conversationHistoryState.newestMessageId || '').trim(),
      newestMessageTimestamp: String(page.nextCursor?.afterTimestamp || conversationHistoryState.newestMessageTimestamp || '').trim(),
      loadedMessageCount: getConversationLoadedMessageCount() + inserted,
      loadingOlder: conversationHistoryState.loadingOlder,
      loadingNewer: false,
    });
  },
  onError: (error, { mode }) => {
    if (mode === 'load') {
      showTransientRelayNotice(error?.message || 'Could not load newer messages. Please try again.');
    }
  },
  onStateChange: (state) => {
    conversationHistoryState = {
      ...conversationHistoryState,
      hasMoreNewer: state.hasMore,
      loadingNewer: state.isLoading,
    };
  },
});

function isOpaqueRelayText(value) {
  const text = String(value || '').trim();
  return !!text && OPAQUE_RELAY_TEXT_PATTERN.test(text);
}

function setSendInFlight(value) {
  sendInFlight = !!value;
  syncSendButtonState();
}

function getActiveTurnForConversation(conversationId) {
  const conversationKey = String(conversationId || '').trim();
  if (!conversationKey) return null;
  return activeTurnsByConversation.get(conversationKey) || null;
}

function syncSendButtonState() {
  const btn = document.getElementById('send-btn');
  if (!btn) return;
  const currentTurn = getActiveTurnForConversation(currentConvId);
  const state = deriveComposerControlState({
    hasActiveTurn: !!currentTurn,
    cancelRequested: currentTurn?.cancelRequested === true,
    hasDraft: hasComposerDraft({
      text: document.getElementById('msg-input')?.value || '',
      attachmentCount: selectedAttachments.length,
    }),
    sendInFlight,
  });
  btn.disabled = state.disabled;
  btn.dataset.action = state.action;
  btn.textContent = state.label;
  btn.title = state.title;
}

export function syncComposerControlState() {
  syncSendButtonState();
}

function setConversationTurnState(conversationId, state = null) {
  const conversationKey = String(conversationId || '').trim();
  if (!conversationKey) {
    syncSendButtonState();
    return;
  }
  if (!state || !String(state.messageId || '').trim()) {
    activeTurnsByConversation.delete(conversationKey);
    syncSendButtonState();
    return;
  }
  activeTurnsByConversation.set(conversationKey, {
    messageId: String(state.messageId || '').trim(),
    status: String(state.status || 'processing').trim().toLowerCase() || 'processing',
    cancelRequested: state.cancelRequested === true,
  });
  syncSendButtonState();
}

function getMessagesElement() {
  return document.getElementById('messages');
}

function resetConversationHistoryState() {
  const conversationId = String(currentConvId || '').trim();
  conversationHistoryState = {
    conversationId,
    hasMoreOlder: false,
    hasMoreNewer: false,
    oldestMessageId: '',
    oldestMessageTimestamp: '',
    newestMessageId: '',
    newestMessageTimestamp: '',
    loadedMessageCount: 0,
    loadingOlder: false,
    loadingNewer: false,
  };
  conversationHistoryLoader.reset({ hasMore: false, nextCursor: null });
  conversationFutureLoader.reset({ hasMore: false, nextCursor: null });
  saveConversationLoadedMessageCount(conversationId, 0);
  syncHistoryLoadMoreControl();
}

function setConversationHistoryState(next = {}) {
  conversationHistoryState = {
    conversationId: String(next.conversationId || currentConvId || '').trim(),
    hasMoreOlder: !!next.hasMoreOlder,
    hasMoreNewer: !!next.hasMoreNewer,
    oldestMessageId: String(next.oldestMessageId || '').trim(),
    oldestMessageTimestamp: String(next.oldestMessageTimestamp || '').trim(),
    newestMessageId: String(next.newestMessageId || '').trim(),
    newestMessageTimestamp: String(next.newestMessageTimestamp || '').trim(),
    loadedMessageCount: Math.max(0, Number(next.loadedMessageCount) || 0),
    loadingOlder: !!next.loadingOlder,
    loadingNewer: !!next.loadingNewer,
  };
  saveConversationLoadedMessageCount(
    conversationHistoryState.conversationId,
    conversationHistoryState.loadedMessageCount,
  );
  syncHistoryLoadMoreControl();
}

function getConversationHistoryCursor() {
  return String(conversationHistoryState.oldestMessageId || '').trim();
}

function getConversationFutureCursor() {
  return String(conversationHistoryState.newestMessageId || '').trim();
}

export function getConversationLoadedMessageCount() {
  return Math.max(0, Number(conversationHistoryState.loadedMessageCount) || 0);
}

export function initConversationHistoryLazyLoading() {
  const el = getMessagesElement();
  if (!el || el.dataset.historyLazyLoadBound === '1') return;
  el.dataset.historyLazyLoadBound = '1';
  el.addEventListener('scroll', () => {
    void conversationHistoryLoader.handleBoundaryDistance(el.scrollTop);
    const forwardDistance = Math.max(0, el.scrollHeight - el.clientHeight - el.scrollTop);
    void conversationFutureLoader.handleBoundaryDistance(forwardDistance);
  }, { passive: true });
}

function buildHistoryLoadMoreMarkup(loading = false) {
  const text = loading ? 'Loading older…' : 'Load older messages';
  return `
    <div id="${HISTORY_LOAD_MORE_ID}" class="history-load-more">
      <button type="button" class="history-load-more-btn" onclick="loadOlderConversationMessages()" ${loading ? 'disabled' : ''}>${text}</button>
    </div>`;
}

function syncHistoryLoadMoreControl() {
  const el = getMessagesElement();
  if (!el) return;
  let box = document.getElementById(HISTORY_LOAD_MORE_ID);
  if (!conversationHistoryState.hasMoreOlder) {
    box?.remove();
    return;
  }
  if (!box) {
    const marker = el.querySelector('.msg');
    if (!marker) {
      el.insertAdjacentHTML('beforeend', buildHistoryLoadMoreMarkup(conversationHistoryState.loadingOlder));
      return;
    }
    marker.insertAdjacentHTML('beforebegin', buildHistoryLoadMoreMarkup(conversationHistoryState.loadingOlder));
    return;
  }
  const btn = box.querySelector('button');
  if (!btn) return;
  btn.disabled = conversationHistoryState.loadingOlder;
  btn.textContent = conversationHistoryState.loadingOlder ? 'Loading older…' : 'Load older messages';
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

function createMessageNode(msg, msgId = null, force = false) {
  const el = getMessagesElement();
  if (!el) return null;

  if (msgId) {
    const existing = el.querySelector(`[data-message-id="${msgId}"]`);
    if (existing) return existing;
    if (!force && seenMessageIds.has(msgId)) return null;
    seenMessageIds.add(msgId);
  }

  const div = document.createElement('div');
  div.className = `msg ${msg.role}`;
  if (msgId) div.dataset.messageId = msgId;
  const fingerprint = buildLiveMessageFingerprint({
    ...(msg && typeof msg === 'object' ? msg : {}),
    id: msgId || msg?.id || '',
  });
  div.dataset.messageRole = fingerprint.role || '';
  div.dataset.messageTextFingerprint = fingerprint.text || '';
  div.dataset.messageTimestamp = String(msg?.timestamp || '').trim();
  if (fingerprint.sourceMessageId) div.dataset.sourceMessageId = fingerprint.sourceMessageId;

  const label = msg.role === 'user' ? 'You' : 'Copilot';
  const { baseModelId, reasoningEffort } = splitVariantId(msg.model);
  const explicitReasoningEffort = String(msg?.reasoningEffort || '').trim().toLowerCase() || null;
  const resolvedReasoningEffort = explicitReasoningEffort || reasoningEffort;
  const modelTag = (msg.role === 'assistant' && baseModelId)
    ? ` <span class="msg-model">${escHtml(baseModelId)}</span>` : '';
  const reasoningTag = (msg.role === 'assistant' && resolvedReasoningEffort && resolvedReasoningEffort !== 'none')
    ? ` <span class="msg-reasoning">${escHtml(resolvedReasoningEffort)}</span>` : '';
  const modeTag = msg.mode
    ? ` <span class="msg-mode">${escHtml(msg.mode)}</span>` : '';
  const content = msg.role === 'assistant'
    ? marked.parse(msg.text || '')
    : renderMarkdownPreview(msg.text || '', false);
  const attachments = Array.isArray(msg.attachments) ? msg.attachments : [];
  const activities = Array.isArray(msg.activities) ? msg.activities.filter(Boolean).slice(0, 48) : [];
  const thoughts = Array.isArray(msg.thoughts) ? msg.thoughts.filter((t) => t && String(t.text || '').trim()) : [];
  const attachmentHtml = attachments.length ? renderAttachmentMarkup(attachments) : '';
  const activityHtml = activities.length ? renderActivityMarkup(activities) : '';
  const thoughtsHtml = thoughts.length ? renderThoughtsMarkup(thoughts) : '';
  const hasVisibleText = Boolean(String(msg.text || '').trim());
  const bubbleClass = (!hasVisibleText && attachments.length && !activities.length)
    ? 'msg-bubble msg-bubble-media-only'
    : 'msg-bubble';

  div.innerHTML = `
    <div class="${bubbleClass}">${content}${attachmentHtml}${thoughtsHtml}${activityHtml}</div>
    <div class="msg-label">${label}${modelTag}${reasoningTag}${modeTag} · ${fmtDate(msg.timestamp)}</div>`;

  const bubble = div.querySelector('.msg-bubble');
  rewriteLocalAssetUrlsInNode(bubble, { preferDrive: msg.role === 'assistant' });
  linkifyWorkspaceMentionsInNode(bubble);
  div.querySelectorAll('pre code').forEach((b) => hljs.highlightElement(b));
  return div;
}

function insertMessageNode(node, scroll = true, insertAfterId = null) {
  if (!node) return null;
  if (node.parentNode) return node;
  const el = getMessagesElement();
  if (!el) return null;
  const anchorId = String(insertAfterId || '').trim();
  const anchor = anchorId ? el.querySelector(`[data-message-id="${anchorId}"]`) : null;
  if (anchor && anchor.parentNode === el) {
    const next = anchor.nextSibling;
    if (next) el.insertBefore(node, next);
    else el.appendChild(node);
  } else {
    el.appendChild(node);
  }
  if (scroll) scrollBottom();
  return node;
}

function prependMessageNodes(msgs) {
  const el = getMessagesElement();
  if (!el) return { inserted: 0, firstMessageId: '' };
  const ordered = sortConversationMessages(msgs || []);
  const fragment = document.createDocumentFragment();
  let inserted = 0;
  let firstMessageId = '';
  for (const m of ordered) {
    const msgId = String(m?.id || '').trim() || null;
    const node = createMessageNode(m, msgId, true);
    if (!node || node.parentNode) continue;
    if (!firstMessageId && msgId) firstMessageId = msgId;
    fragment.appendChild(node);
    inserted += 1;
  }
  if (!inserted) return { inserted: 0, firstMessageId: '' };
  const marker = el.querySelector('.msg');
  if (marker && marker.parentNode === el) {
    el.insertBefore(fragment, marker);
  } else {
    el.appendChild(fragment);
  }
  return { inserted, firstMessageId };
}

export function decorateActivityText(text) {
  const value = String(text || '').trim();
  if (!value) return '';
  if (/^[\u{1F300}-\u{1FAFF}\u2600-\u27BF]/u.test(value)) return value;
  if (value.startsWith('● ')) return `🔄 ${value.slice(2).trim()}`;
  if (/^Model selected:/i.test(value)) return `🧠 ${value}`;
  if (/^Search \((glob|grep)\)/i.test(value)) return `🔍 ${value}`;
  if (/^Tool \(ask_user\)/i.test(value)) return `❓ ${value}`;
  if (/^Tool \(view\)/i.test(value)) return `👀 ${value}`;
  if (/^Tool \(apply_patch\)/i.test(value)) return `🪡 ${value}`;
  if (/^Tool \(powershell\)/i.test(value)) return `🪓 ${value}`;
  if (/^Tool \(edit\)/i.test(value)) return `📝 ${value}`;
  if (/^Tool \(read_file\)/i.test(value)) return `📄 ${value}`;
  if (/^Tool \((grep_search|file_search)\)/i.test(value)) return `🔎 ${value}`;
  if (/^Tool \(semantic_search\)/i.test(value)) return `🧭 ${value}`;
  if (/^Tool \(vscode_listCodeUsages\)/i.test(value)) return `🔗 ${value}`;
  if (/^Tool \(vscode_renameSymbol\)/i.test(value)) return `✏️ ${value}`;
  if (/^Tool \(list_dir\)/i.test(value)) return `📂 ${value}`;
  if (/^Tool \(create_directory\)/i.test(value)) return `📁 ${value}`;
  if (/^Tool \((delete|remove)\)/i.test(value)) return `🗑️ ${value}`;
  if (/^Tool \(execution_subagent\)/i.test(value)) return `🚀 ${value}`;
  if (/^Tool \(get_errors\)/i.test(value)) return `🚨 ${value}`;
  if (/^Tool \(debug_[^)]+\)/i.test(value)) return `🐞 ${value}`;
  if (/^Tool \(fetch_webpage\)/i.test(value)) return `🌐 ${value}`;
  if (/^Tool \(github_[^)]+\)/i.test(value)) return `🐙 ${value}`;
  if (/^Tool \(run_in_terminal\)/i.test(value)) return `🖥️ ${value}`;
  if (/^Tool \((create_file|write)\)/i.test(value)) return `🆕 ${value}`;
  if (/^Tool \((bash|shell|terminal)\)/i.test(value)) return `🔧 ${value}`;
  if (/^Tool \((sql|sqlite)\)/i.test(value)) return `🗄️ ${value}`;
  if (/^Tool \(/i.test(value)) return `🛠️ ${value}`;
  return `ℹ️ ${value}`;
}

export function renderThoughtsMarkup(thoughts) {
  const items = (Array.isArray(thoughts) ? thoughts : [])
    .map((t) => String(t?.text || '').trim())
    .filter(Boolean);
  if (!items.length) return '';
  const blocks = items
    .map((text) => `<div class="msg-thought-item"><p>${escHtml(text).replace(/\n/g, '<br>')}</p></div>`)
    .join('');
  return `
    <details class="msg-thoughts">
      <summary>💭 Thoughts (${items.length})</summary>
      <div class="msg-thoughts-list">${blocks}</div>
    </details>`;
}

export function renderActivityMarkup(activities) {
  const progress = activities.filter((item) => String(item || '').trim().startsWith('● '));
  const tools = activities.filter((item) => !String(item || '').trim().startsWith('● '));
  const progressHtml = progress.length
    ? `<div class="msg-activity-list">${progress.map((item) => `<div class="msg-activity-item">${escHtml(decorateActivityText(item))}</div>`).join('')}</div>`
    : '';
  const toolsHtml = tools.length
    ? `
      <details class="msg-activity">
        <summary>🔧 Tool activity (${tools.length})</summary>
        <div class="msg-activity-list">${tools.map((item) => `<div class="msg-activity-item">${escHtml(decorateActivityText(item))}</div>`).join('')}</div>
      </details>`
    : '';
  return `${progressHtml}${toolsHtml}`;
}

export function showThinking(messageId = null) {
  const nextMessageId = String(messageId || '').trim();
  const shouldResetText = !nextMessageId || thinkingMessageId !== nextMessageId;
  if (shouldResetText) thinkingText = '';
  if (nextMessageId) thinkingMessageId = nextMessageId;
  document.getElementById('thinking-indicator')?.remove();
  const el = document.getElementById('messages');
  const div = document.createElement('div');
  div.className = 'msg assistant';
  div.id = 'thinking-indicator';
  if (nextMessageId) div.dataset.messageId = nextMessageId;
  div.innerHTML = `
    <div class="thinking-bubble">
      <div id="thinking-text" class="thinking-text"></div>
      <div class="dots"><span></span><span></span><span></span></div>
      <div id="thinking-activity" class="thinking-activity"></div>
    </div>
    <div class="msg-label">Copilot</div>`;
  const target = nextMessageId ? el.querySelector(`[data-message-id="${nextMessageId}"]`) : null;
  if (target && target.parentNode === el) {
    const next = target.nextSibling;
    if (next) el.insertBefore(div, next);
    else el.appendChild(div);
  } else {
    el.appendChild(div);
  }
  renderThinkingText(thinkingText);
  scrollBottom();
}

export function removeThinking() {
  thinkingText = '';
  thinkingMessageId = null;
  document.getElementById('thinking-indicator')?.remove();
}

function renderThinkingText(text) {
  const box = document.getElementById('thinking-text');
  if (!box) return;
  const value = String(text || '').trim();
  if (!value) {
    box.innerHTML = '';
    box.classList.remove('visible');
    return;
  }
  box.classList.add('visible');
  box.innerHTML = `<p>${escHtml(value).replace(/\n/g, '<br>')}</p>`;
}

function clearRelayStreamState(messageId = null) {
  const id = String(messageId || '').trim();
  if (!id) {
    relayStreamStateByMessageId.clear();
    return;
  }
  relayStreamStateByMessageId.delete(id);
}

function rememberRelayStreamState(messageId, seq, done = false) {
  const id = String(messageId || '').trim();
  if (!id) return null;
  const normalizedSeq = normalizeStreamSeq(seq);
  const prev = relayStreamStateByMessageId.get(id) || { seq: 0, done: false };
  const next = {
    seq: normalizedSeq === null ? prev.seq : normalizedSeq,
    done: prev.done || !!done,
  };
  relayStreamStateByMessageId.set(id, next);
  return next;
}

export function renderThinkingActivities() {
  const items = thinkingMessageId ? (relayActivities.get(thinkingMessageId) || []) : [];
  const box = document.getElementById('thinking-activity');
  if (!box) return;
  box.innerHTML = '';
  for (const item of items) appendThinkingActivity(item, false);
}

export function restoreInFlightThinking(inFlight) {
  clearRelayStreamState();
  const messageId = String(inFlight?.messageId || '').trim();
  const status = String(inFlight?.status || '').trim().toLowerCase();
  if (!messageId || status !== 'processing') {
    setConversationTurnState(currentConvId, null);
    thinkingMessageId = null;
    removeThinking();
    return;
  }
  setConversationTurnState(currentConvId, { messageId, status: 'processing' });
  const activities = mergeRelayActivityTexts(
    relayActivities.get(messageId) || [],
    Array.isArray(inFlight.activities) ? inFlight.activities : [],
  );
  relayActivities.set(messageId, activities);
  const inFlightThoughts = Array.isArray(inFlight.thoughts) ? inFlight.thoughts : [];
  if (inFlightThoughts.length) {
    const thoughtMap = relayThoughts.get(messageId) || new Map();
    for (const entry of inFlightThoughts) {
      const key = String(entry?.reasoningId || `seq-${entry?.seq || thoughtMap.size}`);
      thoughtMap.set(key, { reasoningId: key, text: String(entry?.text || ''), done: !!entry?.done });
    }
    relayThoughts.set(messageId, thoughtMap);
  }
  thinkingText = '';
  showThinking(messageId);
  renderThinkingActivities();
  renderThinkingThoughts();
  const streamState = deriveLatestInFlightStreamEvent(inFlight);
  if (streamState) {
    rememberRelayStreamState(messageId, streamState.seq, streamState.done || !!inFlight?.streamDone);
    if (!isOpaqueRelayText(streamState.text)) {
      updateThinkingText(streamState.text, messageId, streamState.done || !!inFlight?.streamDone);
    }
    return;
  }
  const fallbackSeq = normalizeStreamSeq(inFlight?.lastStreamSeq);
  if (fallbackSeq !== null || inFlight?.streamDone) {
    rememberRelayStreamState(messageId, fallbackSeq === null ? 0 : fallbackSeq, !!inFlight?.streamDone);
  }
}

export function appendThinkingActivity(text, autoScroll = true) {
  const box = document.getElementById('thinking-activity');
  if (!box || !text) return;
  const last = box.lastElementChild?.textContent || '';
  const decorated = decorateActivityText(text);
  if (last === decorated) return;
  const row = document.createElement('div');
  row.className = 'thinking-activity-item';
  row.textContent = decorated;
  box.appendChild(row);
  if (autoScroll) scrollBottom();
}

function thoughtSummaryText(text) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (!value) return 'Thinking…';
  return value.length > 80 ? `${value.slice(0, 80)}…` : value;
}

export function appendThinkingThought(reasoningId, text, done = false, autoScroll = true) {
  const box = document.getElementById('thinking-activity');
  if (!box) return;
  const key = String(reasoningId || 'reasoning');
  const value = String(text || '');
  let row = box.querySelector(`.thinking-thought[data-reasoning-id="${CSS.escape(key)}"]`);
  if (!row) {
    row = document.createElement('details');
    row.className = 'thinking-thought';
    row.dataset.reasoningId = key;
    const summary = document.createElement('summary');
    const body = document.createElement('div');
    body.className = 'thinking-thought-body';
    row.appendChild(summary);
    row.appendChild(body);
    box.appendChild(row);
  }
  const summaryEl = row.querySelector('summary');
  const bodyEl = row.querySelector('.thinking-thought-body');
  if (summaryEl) summaryEl.textContent = `💭 ${thoughtSummaryText(value)}`;
  if (bodyEl) bodyEl.innerHTML = `<p>${escHtml(value).replace(/\n/g, '<br>')}</p>`;
  row.dataset.done = done ? '1' : '0';
  if (autoScroll) scrollBottom();
}

export function renderThinkingThoughts() {
  const box = document.getElementById('thinking-activity');
  if (!box) return;
  const thoughtMap = thinkingMessageId ? relayThoughts.get(thinkingMessageId) : null;
  if (!thoughtMap || !thoughtMap.size) return;
  for (const entry of thoughtMap.values()) {
    appendThinkingThought(entry.reasoningId, entry.text, entry.done, false);
  }
}

export function updateThinkingText(text, messageId = null, done = false) {
  if (messageId) {
    if (thinkingMessageId && thinkingMessageId !== messageId) return;
    thinkingMessageId = messageId;
  }
  if (!document.getElementById('thinking-indicator')) {
    if (done) return;
    showThinking(thinkingMessageId);
  }
  thinkingText = String(text || '');
  renderThinkingText(thinkingText);
  if (done) {
    const dots = document.querySelector('#thinking-indicator .dots');
    if (dots) dots.style.display = 'none';
  }
  scrollBottom();
}

export function applyRelayStreamEvent({ messageId, text, done = false, seq = null } = {}) {
  const id = String(messageId || '').trim();
  if (!id) return false;
  if (completedMessageIds.has(id)) return false;
  const previous = relayStreamStateByMessageId.get(id) || { seq: 0, done: false };
  const transition = computeNextRelayStreamState(previous, { seq, done });
  if (!transition.accept) return false;
  rememberRelayStreamState(id, transition.state.seq, transition.state.done);
  if (isOpaqueRelayText(text)) return true;
  updateThinkingText(String(text || ''), id, !!done);
  return true;
}

export function clearRelayStreamStateForMessage(messageId) {
  const id = String(messageId || '').trim();
  if (id) {
    completedMessageIds.add(id);
    if (completedMessageIds.size > 100) {
      completedMessageIds.delete(completedMessageIds.values().next().value);
    }
  }
  clearRelayStreamState(messageId);
}

export function applyConversationTurnStatus({ conversationId, messageId, status }) {
  const conversationKey = String(conversationId || '').trim();
  const messageKey = String(messageId || '').trim();
  const normalizedStatus = String(status || '').trim().toLowerCase();
  if (!conversationKey) {
    syncSendButtonState();
    return;
  }
  if (normalizedStatus === 'processing' && messageKey) {
    const previous = getActiveTurnForConversation(conversationKey);
    setConversationTurnState(conversationKey, {
      messageId: messageKey,
      status: normalizedStatus,
      cancelRequested: previous?.messageId === messageKey ? previous.cancelRequested === true : false,
    });
    return;
  }
  if (['done', 'failed', 'dropped', 'pending', 'parked', 'cancelled'].includes(normalizedStatus)) {
    const previous = getActiveTurnForConversation(conversationKey);
    if (!previous || !messageKey || previous.messageId === messageKey) {
      setConversationTurnState(conversationKey, null);
      return;
    }
  }
  syncSendButtonState();
}

async function stopCurrentConversationTurn(conversationId) {
  const conversationKey = String(conversationId || '').trim();
  const activeTurn = getActiveTurnForConversation(conversationKey);
  if (!conversationKey || !activeTurn?.messageId) return;
  if (activeTurn.cancelRequested) return;
  if (isMobileComposerViewport() && !confirm('Stop the current turn?')) return;
  setConversationTurnState(conversationKey, {
    messageId: activeTurn.messageId,
    status: activeTurn.status || 'processing',
    cancelRequested: true,
  });
  const expectedMessageId = activeTurn.messageId;
  const result = await cancelConversationTurn(conversationKey, {
    clientId: CLIENT_ID,
    messageId: expectedMessageId,
  });
  if (!result?.ok) {
    setConversationTurnState(conversationKey, {
      messageId: expectedMessageId,
      status: activeTurn.status || 'processing',
      cancelRequested: false,
    });
    showTransientRelayNotice('Could not stop the current turn.');
    return;
  }
  if (
    result.acknowledgement === 'already-finished'
    || result.acknowledgement === 'no-active-turn'
    || result.acknowledgement === 'message-mismatch'
  ) {
    const latestTurn = getActiveTurnForConversation(conversationKey);
    if (latestTurn?.messageId === expectedMessageId) {
      setConversationTurnState(conversationKey, null);
    }
    showTransientRelayNotice('That turn already finished.');
    return;
  }
  if (result.acknowledgement === 'active-turn-unbound') {
    const latestTurn = getActiveTurnForConversation(conversationKey);
    if (latestTurn?.messageId === expectedMessageId) {
      setConversationTurnState(conversationKey, {
        messageId: expectedMessageId,
        status: activeTurn.status || 'processing',
        cancelRequested: false,
      });
    }
    showTransientRelayNotice('The active turn is not bound to a live SDK session.');
    return;
  }
  showTransientRelayNotice('Stopping the current turn…');
}

export function appendMessage(msg, scroll = true, msgId = null, force = false, insertAfterId = null, trackHistory = true) {
  const el = getMessagesElement();
  if (!el) return null;
  const empty = el.querySelector('.empty-state');
  if (empty) empty.remove();
  const node = createMessageNode(msg, msgId, force);
  const isNewNode = !!node && !node.parentNode;
  const insertedNode = insertMessageNode(node, scroll, insertAfterId);
  if (trackHistory && isNewNode && insertedNode) {
    const messageId = String(msgId || msg?.id || '').trim();
    const messageTimestamp = String(msg?.timestamp || '').trim();
    setConversationHistoryState({
      ...conversationHistoryState,
      newestMessageId: messageId || conversationHistoryState.newestMessageId,
      newestMessageTimestamp: messageTimestamp || conversationHistoryState.newestMessageTimestamp,
      loadedMessageCount: getConversationLoadedMessageCount() + 1,
    });
    if (conversationHistoryState.hasMoreNewer) {
      conversationFutureLoader.reset({
        hasMore: conversationHistoryState.hasMoreNewer,
        nextCursor: {
          afterMessageId: messageId || getConversationFutureCursor() || null,
          afterTimestamp: messageTimestamp || conversationHistoryState.newestMessageTimestamp || null,
        },
      });
    }
  }
  return insertedNode;
}

export function getRenderedConversationMessageFingerprints(limit = 24) {
  const el = getMessagesElement();
  if (!el) return [];
  const rows = Array.from(el.querySelectorAll('.msg'));
  const tail = rows.slice(-Math.max(1, Number(limit) || 24));
  return tail.map((node) => ({
    id: String(node.dataset.messageId || '').trim(),
    role: String(node.dataset.messageRole || '').trim(),
    text: String(node.dataset.messageTextFingerprint || '').trim(),
    timestamp: String(node.dataset.messageTimestamp || '').trim(),
    sourceMessageId: String(node.dataset.sourceMessageId || '').trim(),
  }));
}

export function renderMessages(msgs, scroll = true, meta = {}) {
  const el = getMessagesElement();
  if (!el) return;
  const ordered = sortConversationMessages(msgs || []);
  const messageById = new Map(
    ordered
      .map((item) => [String(item?.id || '').trim(), item])
      .filter(([id]) => !!id),
  );
  if (!ordered.length) {
    el.innerHTML = `<div id="pull-refresh-indicator" aria-hidden="true"><span>↻ Pull down to refresh</span></div>
      <div class="empty-state">
      <div class="icon">${currentConvId ? '💬' : '🚀'}</div>
      <h3>${currentConvId ? 'No messages yet' : 'New Conversation'}</h3>
      <p>${currentConvId ? 'Start the conversation below' : 'Type your first message below'}</p>
    </div>`;
    resetConversationHistoryState();
    renderRelayQuestions();
    renderRelayBoards();
    return;
  }
  const conversationId = String(meta.conversationId || currentConvId || '').trim();
  const pageInfo = meta.pageInfo && typeof meta.pageInfo === 'object' ? meta.pageInfo : null;
  const hasMoreOlder = typeof meta.hasMoreOlder === 'boolean'
    ? meta.hasMoreOlder
    : (typeof meta.hasMoreHistory === 'boolean' ? meta.hasMoreHistory : !!pageInfo?.hasMoreOlder || !!pageInfo?.hasMore);
  const hasMoreNewer = typeof meta.hasMoreNewer === 'boolean'
    ? meta.hasMoreNewer
    : !!pageInfo?.hasMoreNewer;
  const oldestMessageId = String(
    meta.historyCursor
    || pageInfo?.olderCursor?.beforeMessageId
    || pageInfo?.nextCursor?.beforeMessageId
    || ordered[0]?.id
    || '',
  ).trim();
  const oldestMessageTimestamp = String(
    pageInfo?.olderCursor?.beforeTimestamp
    || pageInfo?.nextCursor?.beforeTimestamp
    || ordered[0]?.timestamp
    || '',
  ).trim();
  const newestMessageId = String(meta.historyNewestMessageId || ordered[ordered.length - 1]?.id || '').trim();
  const newestMessageTimestamp = String(
    pageInfo?.newerCursor?.afterTimestamp
    || ordered[ordered.length - 1]?.timestamp
    || '',
  ).trim();
  el.innerHTML = `<div id="pull-refresh-indicator" aria-hidden="true"><span>↻ Pull down to refresh</span></div>${hasMoreOlder ? buildHistoryLoadMoreMarkup(false) : ''}`;
  setConversationHistoryState({
    conversationId,
    hasMoreOlder,
    hasMoreNewer,
    oldestMessageId,
    oldestMessageTimestamp,
    newestMessageId,
    newestMessageTimestamp,
    loadedMessageCount: ordered.length,
    loadingOlder: false,
    loadingNewer: false,
  });
  conversationHistoryLoader.reset({
    hasMore: hasMoreOlder,
    nextCursor: hasMoreOlder ? (pageInfo?.olderCursor || pageInfo?.nextCursor || {
      beforeMessageId: oldestMessageId || null,
      beforeTimestamp: null,
    }) : null,
  });
  conversationFutureLoader.reset({
    hasMore: hasMoreNewer,
    nextCursor: hasMoreNewer ? (pageInfo?.newerCursor || {
      afterMessageId: newestMessageId || null,
      afterTimestamp: newestMessageTimestamp || null,
    }) : null,
  });
  for (const m of ordered) appendMessage(m, false, m.id || null, true, getMessageThreadAnchor(m, messageById), false);
  renderRelayQuestions();
  renderRelayBoards();
  if (scroll) scrollBottom();
  requestAnimationFrame(() => {
    const box = getMessagesElement();
    if (!box) return;
    void conversationHistoryLoader.handleBoundaryDistance(box.scrollTop);
    const forwardDistance = Math.max(0, box.scrollHeight - box.clientHeight - box.scrollTop);
    void conversationFutureLoader.handleBoundaryDistance(forwardDistance);
  });
}

export async function loadOlderConversationMessages() {
  await conversationHistoryLoader.loadMore();
}

export async function loadNewerConversationMessages() {
  await conversationFutureLoader.loadMore();
}

export function focusConversationMessageById(messageId, { behavior = 'smooth', block = 'center' } = {}) {
  const id = String(messageId || '').trim();
  if (!id) return false;
  const el = getMessagesElement();
  if (!el) return false;
  const target = el.querySelector(`[data-message-id="${id}"]`);
  if (!target) return false;
  target.scrollIntoView({ behavior, block, inline: 'nearest' });
  target.classList.add('msg-search-target');
  window.setTimeout(() => {
    target.classList.remove('msg-search-target');
  }, 2200);
  return true;
}

export function compactCurrentConversation() {
  if (!currentConvId || compactInFlight) return;
  const id = currentConvId;
  const conv = conversations[id];
  if (!conv || conv.archived) return;
  if (!confirm('Compact this conversation into a new one with carry-over summary?')) return;

  setCompactInFlight(true);
  try {
    const doCompact = async () => {
      const r = await compactConversationApi(id);
      if (!r?.compactedConversationId) throw new Error('Compaction failed');
      await window.refreshConversations?.();
      await window.openConversation?.(r.compactedConversationId);
    };
    void doCompact().catch((e) => {
      alert(e.message || 'Failed to compact conversation');
    }).finally(() => {
      setCompactInFlight(false);
    });
  } catch (e) {
    setCompactInFlight(false);
    alert(e.message || 'Failed to compact conversation');
  }
}

export async function sendMessage() {
  const input = document.getElementById('msg-input');
  const text = input.value.trim();
  const mobileSend = isMobileComposerViewport();
  const activeTurn = getActiveTurnForConversation(currentConvId);
  const hasDraft = hasComposerDraft({ text, attachmentCount: selectedAttachments.length });
  if (sendInFlight) {
    showTransientRelayNotice('Please wait for the current message to finish sending.');
    return;
  }
  if (activeTurn?.messageId && !hasDraft) {
    await stopCurrentConversationTurn(currentConvId);
    return;
  }
  if (!hasDraft) return;

  if (text.toLowerCase() === '/compact' && selectedAttachments.length === 0) {
    input.value = '';
    autoResize(input);
    releaseComposerFocusAfterSend(input);
    compactCurrentConversation();
    scrollBottomAfterSend();
    return;
  }

  if (!(await validateSelectedConversationBeforeSend())) {
    return;
  }
  const targetConversationId = String(currentConvId || '').trim() || null;
  if (hasPendingUserMessageDuplicate(targetConversationId, text)) {
    showTransientRelayNotice('That message is already pending.');
    return;
  }

  setSendInFlight(true);
  let attachments = [];
  let clientMessageId = null;
  try {
    attachments = await uploadAttachments(selectedAttachments.slice());

    const isNew = !targetConversationId;
    const msgTimestamp = new Date().toISOString();
    const selectedModel = document.getElementById('model-select').value || '';
    const selectedMode = document.getElementById('mode-select').value || 'agent';
    const titleSeed = text || (attachments[0]?.name || 'Attachment');
    clientMessageId = generateId();
    trackPendingUserMessage(clientMessageId, targetConversationId, text);
    input.value = '';
    autoResize(input);
    releaseComposerFocusAfterSend(input);
    pendingUserMessageIds.add(clientMessageId);
    appendMessage({ role: 'user', text, model: selectedModel, mode: selectedMode, timestamp: msgTimestamp, attachments }, true, clientMessageId, true);
    scrollBottomAfterSend();

    const body = {
      messageId: clientMessageId,
      clientId: CLIENT_ID,
      text,
      model: selectedModel,
      relayMode: selectedMode,
      conversationId: targetConversationId || undefined,
      newConversation: isNew || undefined,
      attachments,
    };

    const r = await sendMessageApi(body);
    if (!r) {
      clearPendingUserMessage(clientMessageId);
      const pendingNode = document.querySelector(`[data-message-id="${clientMessageId}"]`);
      pendingNode?.remove();
      pendingUserMessageIds.delete(clientMessageId);
      seenMessageIds.delete(clientMessageId);
      if (!mobileSend) input.focus();
      setModelBanner('⚠️ Message could not be sent. Please try again.');
      return;
    }

    if (r.duplicate) {
      clearPendingUserMessage(clientMessageId);
      const pendingNode = document.querySelector(`[data-message-id="${clientMessageId}"]`);
      pendingNode?.remove();
      pendingUserMessageIds.delete(clientMessageId);
      seenMessageIds.delete(clientMessageId);
      if (!mobileSend) input.focus();
      showTransientRelayNotice('That message was already sent recently.');
      return;
    }

    if (r.workspaceRootName || r.workspaceRootEntries || r.workspaceRootPath) {
      updateWorkspaceRootHints(r);
      if (repoBrowserState.open && repoBrowserState.activeRoot === 'workspace') {
        repoBrowserState.currentPath = '';
        await window.loadRepoBrowserTree?.();
      }
    }
    if (r.compactedConversationId) {
      await window.refreshConversations?.();
      await window.openConversation?.(r.compactedConversationId);
      clearAttachments();
      if (!mobileSend) input.focus();
      scrollBottomAfterSend();
      return;
    }
    if (r.warning) setModelBanner(`⚠️ ${r.warning}`);
    if (r.workspaceRootWarning) setModelBanner(`⚠️ ${r.workspaceRootWarning}`);
    const skippedRefs = Array.isArray(r.skippedReferenceAttachments) ? r.skippedReferenceAttachments : [];
    if (skippedRefs.length) {
      const firstReason = String(skippedRefs[0]?.reason || 'reference skipped');
      setModelBanner(`⚠️ Some referenced images were not attached (${firstReason}).`);
    }
    if (isNew || !targetConversationId) {
      setCurrentConv(r.conversationId);
      conversations[r.conversationId] = {
        id: r.conversationId,
        title: titleSeed.slice(0, 60),
        updatedAt: new Date().toISOString(),
        messageCount: 1,
        runtimeSessionId: r.runtimeSessionId || null,
        preferredRelayMode: r.preferredRelayMode || selectedMode,
        preferredModelsByMode: r.preferredModelsByMode || { [selectedMode]: selectedModel },
      };
      document.getElementById('chat-title').textContent = titleSeed.slice(0, 60);
      window.syncChatTitleControls?.();
      updateCompactButton();
      window.renderConvList?.();
      applyContextUsageBar(null);
      scheduleContextUsageRefresh(r.conversationId, 0);
    }
    if (cliOnline) showThinking(r.messageId || null);

    clearAttachments();
    if (!mobileSend) input.focus();
    scrollBottomAfterSend();
  } catch (e) {
    if (clientMessageId) {
      clearPendingUserMessage(clientMessageId);
      const pendingNode = document.querySelector(`[data-message-id="${clientMessageId}"]`);
      pendingNode?.remove();
      pendingUserMessageIds.delete(clientMessageId);
      seenMessageIds.delete(clientMessageId);
    }
    alert(e.message || 'Failed to send message');
  } finally {
    setSendInFlight(false);
  }
}

export function handleKey(e) {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    sendMessage();
  }
}

async function validateSelectedConversationBeforeSend() {
  const convId = String(currentConvId || '').trim();
  if (!convId) return true;

  const current = await loadConversationApi(convId, { limit: 1 });
  if (!current) {
    setModelBanner('⚠️ Selected conversation is unavailable. Please choose another conversation.');
    await window.refreshConversations?.();
    return false;
  }

  const conversationSessionId = String(current.sdkSessionId || current.sdk_session_id || '').trim();
  const runtimeSessionSessionId = String(current.runtimeSession?.sdkSessionId || current.runtimeSession?.sdk_session_id || '').trim();
  if (!conversationSessionId) {
    setModelBanner('⚠️ This conversation is waiting to be claimed by the relay. Please wait, or open another conversation.');
    return false;
  }
  if (!runtimeSessionSessionId || conversationSessionId !== runtimeSessionSessionId) {
    setModelBanner('⚠️ This conversation is bound to a different relay session. Wait for the matching session to claim it, or open another conversation.');
    return false;
  }

  conversations[convId] = {
    ...(conversations[convId] || {}),
    ...current,
    sdkSessionId: conversationSessionId,
    runtimeSessionId: current.runtimeSession?.id || null,
  };
  setRepoBrowserSessionInfo(current.sessionRootPath || '', current.sessionRootName || current.title || '');
  updateSessionPill(conversations[convId], current.runtimeSession || null);
  return true;
}
