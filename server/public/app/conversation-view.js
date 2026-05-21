import {
  cliOnline,
  compactInFlight,
  conversations,
  CLIENT_ID,
  currentConvId,
  escHtml,
  fmtDate,
  generateId,
  pendingUserMessageIds,
  seenMessageIds,
  relayActivities,
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
} from './store.js';
import { sendMessage as sendMessageApi, compactConversation as compactConversationApi, scheduleContextUsageRefresh, loadConversation } from './api-client.js';
import { linkifyWorkspaceMentionsInNode } from './router.js';
import { renderAttachmentMarkup, clearAttachments, uploadAttachments } from './attachments-view.js';
import { renderRelayQuestions } from './ask-user-view.js';

let thinkingMessageId = null;
let thinkingText = '';

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
  if (messageId) thinkingMessageId = messageId;
  removeThinking();
  const el = document.getElementById('messages');
  const div = document.createElement('div');
  div.className = 'msg assistant';
  div.id = 'thinking-indicator';
  div.innerHTML = `
    <div class="thinking-bubble">
      <div id="thinking-text" class="thinking-text"></div>
      <div class="dots"><span></span><span></span><span></span></div>
      <div id="thinking-activity" class="thinking-activity"></div>
    </div>
    <div class="msg-label">Copilot</div>`;
  el.appendChild(div);
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

export function renderThinkingActivities() {
  const items = thinkingMessageId ? (relayActivities.get(thinkingMessageId) || []) : [];
  const box = document.getElementById('thinking-activity');
  if (!box) return;
  box.innerHTML = '';
  for (const item of items) appendThinkingActivity(item, false);
}

export function restoreInFlightThinking(inFlight) {
  const messageId = String(inFlight?.messageId || '').trim();
  const status = String(inFlight?.status || '').trim().toLowerCase();
  if (!messageId || status !== 'processing') {
    thinkingMessageId = null;
    removeThinking();
    return;
  }
  const activities = Array.isArray(inFlight.activities)
    ? inFlight.activities.map((entry) => String(entry || '').trim()).filter(Boolean).slice(-24)
    : [];
  relayActivities.set(messageId, activities);
  thinkingMessageId = messageId;
  showThinking(messageId);
  renderThinkingActivities();
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

export function appendMessage(msg, scroll = true, msgId = null, force = false) {
  const el = document.getElementById('messages');
  const empty = el.querySelector('.empty-state');
  if (empty) empty.remove();

  if (msgId) {
    const existing = el.querySelector(`[data-message-id="${msgId}"]`);
    if (existing) return existing;
    if (!force && seenMessageIds.has(msgId)) return;
    seenMessageIds.add(msgId);
  }

  const div = document.createElement('div');
  div.className = `msg ${msg.role}`;
  if (msgId) div.dataset.messageId = msgId;

  const label = msg.role === 'user' ? 'You' : 'Copilot';
  const modelTag = (msg.role === 'assistant' && msg.model)
    ? ` <span class="msg-model">${escHtml(msg.model)}</span>` : '';
  const modeTag = msg.mode
    ? ` <span class="msg-mode">${escHtml(msg.mode)}</span>` : '';
  const content = msg.role === 'assistant'
    ? marked.parse(msg.text || '')
    : (msg.text ? `<p>${escHtml(msg.text)}</p>` : '');
  const attachments = Array.isArray(msg.attachments) ? msg.attachments : [];
  const activities = Array.isArray(msg.activities) ? msg.activities.filter(Boolean).slice(0, 48) : [];
  const attachmentHtml = attachments.length ? renderAttachmentMarkup(attachments) : '';
  const activityHtml = activities.length ? renderActivityMarkup(activities) : '';
  const hasVisibleText = Boolean(String(msg.text || '').trim());
  const bubbleClass = (!hasVisibleText && attachments.length && !activities.length)
    ? 'msg-bubble msg-bubble-media-only'
    : 'msg-bubble';

  div.innerHTML = `
    <div class="${bubbleClass}">${content}${attachmentHtml}${activityHtml}</div>
    <div class="msg-label">${label}${modelTag}${modeTag} · ${fmtDate(msg.timestamp)}</div>`;

  linkifyWorkspaceMentionsInNode(div.querySelector('.msg-bubble'));
  div.querySelectorAll('pre code').forEach((b) => hljs.highlightElement(b));
  el.appendChild(div);
  if (scroll) scrollBottom();
}

export function renderMessages(msgs, scroll = true) {
  const el = document.getElementById('messages');
  if (!msgs || msgs.length === 0) {
    el.innerHTML = `<div id="pull-refresh-indicator" aria-hidden="true"><span>↻ Pull down to refresh</span></div>
      <div class="empty-state">
      <div class="icon">${currentConvId ? '💬' : '🚀'}</div>
      <h3>${currentConvId ? 'No messages yet' : 'New Conversation'}</h3>
      <p>${currentConvId ? 'Start the conversation below' : 'Type your first message below'}</p>
    </div>`;
    renderRelayQuestions();
    return;
  }
  el.innerHTML = '';
  el.insertAdjacentHTML('afterbegin', '<div id="pull-refresh-indicator" aria-hidden="true"><span>↻ Pull down to refresh</span></div>');
  for (const m of msgs) appendMessage(m, false, m.id || null, true);
  renderRelayQuestions();
  if (scroll) scrollBottom();
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
  if (!text && selectedAttachments.length === 0) return;
  const mobileSend = isMobileComposerViewport();

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

  let attachments = [];
  try {
    attachments = await uploadAttachments(selectedAttachments.slice());
  } catch (e) {
    alert(e.message || 'File upload failed');
    return;
  }

  const isNew = !targetConversationId;
  const msgTimestamp = new Date().toISOString();
  const selectedModel = document.getElementById('model-select').value || '';
  const selectedMode = document.getElementById('mode-select').value || 'agent';
  const titleSeed = text || (attachments[0]?.name || 'Attachment');
  const clientMessageId = generateId();
  input.value = '';
  autoResize(input);
  releaseComposerFocusAfterSend(input);
  document.getElementById('send-btn').disabled = true;
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
    const pendingNode = document.querySelector(`[data-message-id="${clientMessageId}"]`);
    pendingNode?.remove();
    pendingUserMessageIds.delete(clientMessageId);
    seenMessageIds.delete(clientMessageId);
    document.getElementById('send-btn').disabled = false;
    if (!mobileSend) input.focus();
    setModelBanner('⚠️ Message could not be sent. Please try again.');
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
    document.getElementById('send-btn').disabled = false;
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
    };
    document.getElementById('chat-title').textContent = titleSeed.slice(0, 60);
    updateCompactButton();
    window.renderConvList?.();
    applyContextUsageBar(null);
    scheduleContextUsageRefresh(r.conversationId, 0);
  }
  if (cliOnline) showThinking(r.messageId || null);

  document.getElementById('send-btn').disabled = false;
  clearAttachments();
  if (!mobileSend) input.focus();
  scrollBottomAfterSend();
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

  const current = await loadConversation(convId);
  if (!current) {
    setModelBanner('⚠️ Selected conversation is unavailable. Please choose another conversation.');
    await window.refreshConversations?.();
    return false;
  }

  const conversationSessionId = String(current.sdkSessionId || current.sdk_session_id || '').trim();
  const runtimeSessionSessionId = String(current.runtimeSession?.sdkSessionId || current.runtimeSession?.sdk_session_id || '').trim();
  if (!conversationSessionId || !runtimeSessionSessionId || conversationSessionId !== runtimeSessionSessionId) {
    setModelBanner('⚠️ This conversation is not session-bound yet. Please wait for the relay to sync or open another conversation.');
    return false;
  }

  conversations[convId] = {
    ...(conversations[convId] || {}),
    ...current,
    sdkSessionId: conversationSessionId,
    runtimeSessionId: current.runtimeSession?.id || null,
  };
  updateSessionPill(conversations[convId], current.runtimeSession || null);
  return true;
}

