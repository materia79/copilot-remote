import {
  conversations,
  currentConvId,
  fmtDate,
  escHtml,
  relayQuestions,
  relayQuestionDrafts,
} from './store.js';
import { loadRelayQuestions as loadRelayQuestionsApi, answerRelayQuestion } from './api-client.js';
import { renderLinkedPlainText } from './router.js';

let relayQuestionRenderHash = '';

export function upsertRelayQuestion(question) {
  if (!question || !question.id) return;
  relayQuestions.set(question.id, question);
  updatePendingQuestionBanner();
  window.renderConvList?.();
  renderRelayQuestions();
}

export async function loadRelayQuestions(conversationId) {
  const pendingRes = await loadRelayQuestionsApi('pending');
  if (!pendingRes) return;
  const pending = Array.isArray(pendingRes?.questions) ? pendingRes.questions.filter((q) => q && q.id) : [];
  const next = new Map(pending.map((q) => [q.id, q]));
  for (const [id, q] of relayQuestions.entries()) {
    if (q.status === 'answered' && !next.has(id)) next.set(id, q);
  }
  for (const questionId of relayQuestionDrafts.keys()) {
    const question = next.get(questionId);
    if (!question || question.status !== 'pending') {
      relayQuestionDrafts.delete(questionId);
    }
  }
  relayQuestions.clear();
  for (const [id, q] of next.entries()) relayQuestions.set(id, q);
  updatePendingQuestionBanner();
  window.renderConvList?.();

  if (!conversationId && pending.length) {
    const latest = pending
      .slice()
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))[0];
    const targetConversationId = String(latest?.conversationId || '').trim();
    if (targetConversationId && targetConversationId !== currentConvId && conversations[targetConversationId]) {
      await window.openConversation?.(targetConversationId);
      return;
    }
  }

  renderRelayQuestions();
}

export function getPendingRelayQuestions() {
  return Array.from(relayQuestions.values())
    .filter((q) => q && q.id && q.status === 'pending')
    .sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
}

export function getPendingQuestionCountsByConversation() {
  const counts = Object.create(null);
  for (const question of getPendingRelayQuestions()) {
    const conversationId = String(question?.conversationId || '').trim();
    if (!conversationId) continue;
    counts[conversationId] = (counts[conversationId] || 0) + 1;
  }
  return counts;
}

export function updatePendingQuestionBanner() {
  const banner = document.getElementById('pending-question-banner');
  if (!banner) return;
  const pending = getPendingRelayQuestions();
  if (!pending.length) {
    banner.textContent = '';
    banner.classList.remove('visible');
    banner.disabled = true;
    return;
  }

  const latest = pending[pending.length - 1];
  const targetConversationId = String(latest?.conversationId || '').trim();
  banner.dataset.targetConversationId = targetConversationId;
  banner.dataset.targetQuestionId = String(latest?.id || '').trim();
  const count = pending.length;
  const currentCount = currentConvId ? pending.filter((q) => q?.conversationId === currentConvId).length : 0;
  const convTitle = escHtml(conversations[targetConversationId]?.title || targetConversationId || 'conversation');
  banner.innerHTML = currentCount > 0
    ? `❓ ${count} open question${count === 1 ? '' : 's'}`
    : `❓ ${count} open question${count === 1 ? '' : 's'} · latest in ${convTitle}`;
  banner.classList.add('visible');
  banner.disabled = false;
}

export async function openPendingQuestionFromBanner() {
  const banner = document.getElementById('pending-question-banner');
  if (!banner) return;
  const targetConversationId = String(banner.dataset.targetConversationId || '').trim();
  const pending = getPendingRelayQuestions();
  const fallbackConversationId = String(pending[pending.length - 1]?.conversationId || '').trim();
  const nextConversationId = targetConversationId || fallbackConversationId;
  if (!nextConversationId) return;
  if (nextConversationId !== currentConvId && conversations[nextConversationId]) {
    await window.openConversation?.(nextConversationId);
    return;
  }
  renderRelayQuestions();
  window.scrollBottom?.();
}

export function renderRelayQuestions() {
  const el = document.getElementById('messages');
  if (!el) return;
  const questions = Array.from(relayQuestions.values())
    .filter((q) => q && q.conversationId === currentConvId && q.status === 'pending')
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

  const nextHash = JSON.stringify(
    questions.map((q) => ({
      id: q.id,
      status: q.status,
      prompt: q.prompt || '',
      answer: q.answer || '',
      answeredAt: q.answeredAt || '',
      createdAt: q.createdAt || '',
      choices: Array.isArray(q.choices) ? q.choices : [],
    }))
  );
  const existingCards = el.querySelectorAll('.relay-question-container');
  if (relayQuestionRenderHash === nextHash && existingCards.length === questions.length) return;
  relayQuestionRenderHash = nextHash;

  existingCards.forEach((node) => node.remove());
  if (!questions.length) return;

  for (const question of questions) {
    const wrapper = document.createElement('div');
    wrapper.className = 'msg relay-question-container';
    wrapper.dataset.questionId = question.id;

    const modeTag = question.mode ? ` <span class="msg-mode">${escHtml(question.mode)}</span>` : '';
    const contextText = String(question?.context?.rationale || '').trim();
    const contextHtml = contextText ? `<div class="relay-question-context">${renderLinkedPlainText(contextText)}</div>` : '';
    const choices = Array.isArray(question.choices) ? question.choices : [];
    const choiceHtml = choices.length
      ? (question.status === 'pending'
          ? `<div class="relay-question-choices">${
              choices.map((choice) => `<button class="relay-question-choice" data-choice="${escHtml(choice)}" onclick="submitRelayQuestionChoice('${question.id}', this.dataset.choice)">${escHtml(choice)}</button>`).join('')
            }</div>`
          : `<div class="relay-question-choices">${
              choices.map((choice) => `<button class="relay-question-choice" disabled>${escHtml(choice)}</button>`).join('')
            }</div>`)
      : '';
    const showReplyControls = question.status === 'pending';
    const draftText = String(relayQuestionDrafts.get(question.id) || '');
    const replyHtml = showReplyControls
      ? `<div class="relay-question-reply">
          <textarea id="relay-question-input-${question.id}" placeholder="Type a reply… (Ctrl/Cmd+Enter to send)" onkeydown="handleRelayQuestionKey(event, '${question.id}')" oninput="onRelayQuestionDraftInput('${question.id}', this.value)">${escHtml(draftText)}</textarea>
          <button class="relay-question-submit" onclick="submitRelayQuestionAnswer('${question.id}')">Reply</button>
        </div>`
      : '';
    const answeredHtml = question.status === 'answered' && question.answer
      ? `<div class="relay-question-context"><strong>Your answer:</strong> ${escHtml(question.answer)}</div>`
      : '';
    const statusText = question.status === 'answered'
      ? `Answered${question.answeredAt ? ` · ${fmtDate(question.answeredAt)}` : ''}`
      : `${question.expiresAt ? `Expires ${fmtDate(question.expiresAt)} · ` : ''}Waiting for your answer`;

    wrapper.innerHTML = `
      <div class="relay-question-card${question.status === 'timed_out' ? ' relay-question-timed-out' : ''}">
        <div class="relay-question-head">Copilot question${modeTag} · ${fmtDate(question.createdAt)}</div>
        <div class="relay-question-body">${renderLinkedPlainText(question.prompt || '')}</div>
        ${contextHtml}
        ${answeredHtml}
        ${choiceHtml}
        ${replyHtml}
        <div class="relay-question-status">${statusText}</div>
      </div>`;

    el.appendChild(wrapper);
  }

  window.scrollBottom?.();
}

export async function submitRelayQuestionChoice(questionId, choice) {
  await submitRelayQuestionAnswer(questionId, choice);
}

export async function submitRelayQuestionAnswer(questionId, presetAnswer = null) {
  const input = document.getElementById(`relay-question-input-${questionId}`);
  const answer = String(presetAnswer != null ? presetAnswer : (input?.value || '')).trim();
  if (!answer) return;

  const card = document.querySelector(`.relay-question-container[data-question-id="${questionId}"]`);
  const controls = card ? card.querySelectorAll('button, textarea') : [];
  controls.forEach((el) => { el.disabled = true; });

  try {
    const r = await answerRelayQuestion(questionId, answer);
    if (!r?.question) throw new Error('Failed to submit relay question answer');
    relayQuestionDrafts.delete(questionId);
    relayQuestions.set(questionId, r.question);
    updatePendingQuestionBanner();
    window.renderConvList?.();
    renderRelayQuestions();
    window.showTransientRelayNotice?.(`✅ Answer received: ${answer} · Agent continuing…`, 7000);
  } catch (e) {
    controls.forEach((el) => { el.disabled = false; });
    alert(e.message || 'Failed to submit relay question answer');
  }
}

export function onRelayQuestionDraftInput(questionId, value) {
  relayQuestionDrafts.set(String(questionId || ''), String(value || ''));
}

export function handleRelayQuestionKey(e, questionId) {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    submitRelayQuestionAnswer(questionId);
  }
}

