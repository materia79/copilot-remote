import { BASE, TOKEN, authHeaders, updateWorkspaceRootHints, applyContextUsageBar, readContextUsageRatio, currentConvId, conversations, setCliOnline, setActiveRuntimeSessionCount, setContextIndicatorMode, setServerPlatform } from './store.js';

export async function apiFetch(url, opts = {}) {
  try {
    const response = await fetch(`${BASE}${url}`, {
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders(),
        ...(opts.headers || {}),
      },
      ...opts,
    });
    if (!response.ok) {
      console.error('API error', response.status, url);
      return null;
    }
    return response.json();
  } catch (error) {
    console.error('Fetch error', error);
    return null;
  }
}

export async function verifyExistingSession() {
  try {
    const response = await fetch(`${BASE}/api/status`);
    if (!response.ok) return false;
    const payload = await response.json().catch(() => null);
    if (payload) updateWorkspaceRootHints(payload);
    setContextIndicatorMode(payload?.contextIndicatorMode);
    setCliOnline(!!payload?.cliOnline);
    setActiveRuntimeSessionCount(payload?.activeRuntimeSessionCount);
    if (payload?.platform) setServerPlatform(payload.platform);
    return true;
  } catch {
    return false;
  }
}

export async function verifyToken(token) {
  try {
    const response = await fetch(`${BASE}/api/status`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) return false;
    const payload = await response.json().catch(() => null);
    if (payload) updateWorkspaceRootHints(payload);
    setContextIndicatorMode(payload?.contextIndicatorMode);
    setCliOnline(!!payload?.cliOnline);
    setActiveRuntimeSessionCount(payload?.activeRuntimeSessionCount);
    if (payload?.platform) setServerPlatform(payload.platform);
    return true;
  } catch {
    return false;
  }
}

export async function refreshWorkspaceRootHints() {
  const status = await apiFetch('/api/status');
  if (status) {
    updateWorkspaceRootHints(status);
    setContextIndicatorMode(status?.contextIndicatorMode);
    setCliOnline(!!status?.cliOnline);
    setActiveRuntimeSessionCount(status?.activeRuntimeSessionCount);
    if (status?.platform) setServerPlatform(status.platform);
  }
  return status;
}

export async function updateWorkspaceRoot(rootPath, conversationId = null) {
  const pathValue = String(rootPath || '').trim();
  if (!pathValue) return null;
  const convId = String(conversationId || '').trim();
  const endpoint = convId
    ? `/api/conversation/${encodeURIComponent(convId)}/workspace-root`
    : '/api/workspace-root';
  const response = await apiFetch(endpoint, {
    method: 'POST',
    body: JSON.stringify({ rootPath: pathValue }),
  });
  if (response && !convId) updateWorkspaceRootHints(response);
  return response;
}

export async function updateDefaultSessionWorkspaceRoot(rootPath, options = {}) {
  const clear = options?.clear === true;
  const pathValue = String(rootPath || '').trim();
  const response = await apiFetch('/api/settings/default-session-workspace-root', {
    method: 'POST',
    body: JSON.stringify({
      rootPath: clear ? '' : pathValue,
      clear,
    }),
  });
  if (response) updateWorkspaceRootHints(response);
  return response;
}

export async function launchSessionWorker(sdkSessionId) {
  const sessionId = String(sdkSessionId || '').trim();
  if (!sessionId) return null;
  return apiFetch(`/api/session-worker/${encodeURIComponent(sessionId)}/launch`, {
    method: 'POST',
  });
}

export async function loadUsageSummary() {
  return apiFetch('/api/usage');
}

export async function loadContextSummary(convId = null) {
  const trimmedConvId = String(convId || '').trim();
  const lookupId = resolveContextLookupId(trimmedConvId);
  const endpoint = lookupId ? `/api/context/${encodeURIComponent(lookupId)}` : '/api/context';
  return apiFetch(endpoint);
}

function resolveContextLookupId(conversationId) {
  const convId = String(conversationId || '').trim();
  if (!convId) return '';
  const conversation = conversations[convId];
  const sdkSessionId = String(conversation?.sdkSessionId || conversation?.sdk_session_id || '').trim();
  return sdkSessionId || convId;
}

export async function loadModelCatalog() {
  return apiFetch('/api/models');
}

export async function loadModelVariantCatalog() {
  return apiFetch('/api/model-variants');
}

export async function refreshModelVariantCatalog() {
  return apiFetch('/api/model-variants/refresh', { method: 'POST' });
}

export async function saveEnabledModelVariants(enabledVariantIds = []) {
  return apiFetch('/api/model-variants', {
    method: 'PATCH',
    body: JSON.stringify({
      enabledVariantIds: Array.isArray(enabledVariantIds)
        ? enabledVariantIds.map((value) => String(value || '').trim()).filter(Boolean)
        : [],
    }),
  });
}

export async function loadConversations(options = {}) {
  const params = new URLSearchParams();
  const limit = Math.max(1, Math.trunc(Number(options.limit) || 0));
  if (limit) params.set('limit', String(limit));
  const beforeConversationId = String(options.beforeConversationId || options.beforeId || '').trim();
  if (beforeConversationId) params.set('beforeConversationId', beforeConversationId);
  const beforeUpdatedAt = String(options.beforeUpdatedAt || '').trim();
  if (beforeUpdatedAt) params.set('beforeUpdatedAt', beforeUpdatedAt);
  const includeArchived = String(options.archived || '').trim().toLowerCase();
  if (includeArchived === 'true') params.set('archived', 'true');
  const query = params.toString();
  return apiFetch(`/api/conversations${query ? `?${query}` : ''}`);
}

export async function loadConversation(id, options = {}) {
  const convId = String(id || '').trim();
  if (!convId) return null;
  const params = new URLSearchParams();
  const limit = Math.max(1, Math.trunc(Number(options.limit) || 0));
  if (limit) params.set('limit', String(limit));
  const beforeMessageId = String(options.beforeMessageId || options.before || '').trim();
  if (beforeMessageId) params.set('beforeMessageId', beforeMessageId);
  const beforeTimestamp = String(options.beforeTimestamp || '').trim();
  if (beforeTimestamp) params.set('beforeTimestamp', beforeTimestamp);
  const afterMessageId = String(options.afterMessageId || options.after || '').trim();
  if (afterMessageId) params.set('afterMessageId', afterMessageId);
  const afterTimestamp = String(options.afterTimestamp || '').trim();
  if (afterTimestamp) params.set('afterTimestamp', afterTimestamp);
  const aroundMessageId = String(options.aroundMessageId || '').trim();
  if (aroundMessageId) params.set('aroundMessageId', aroundMessageId);
  const query = params.toString();
  return apiFetch(`/api/conversation/${convId}${query ? `?${query}` : ''}`);
}

export async function refreshConversationHistory(id, options = {}) {
  const convId = String(id || '').trim();
  if (!convId) return null;
  const params = new URLSearchParams();
  const limit = Math.max(1, Math.trunc(Number(options.limit) || 0));
  if (limit) params.set('limit', String(limit));
  const query = params.toString();
  return apiFetch(`/api/conversation/${convId}/refresh-history${query ? `?${query}` : ''}`, {
    method: 'POST',
  });
}

export async function searchMessages(options = {}) {
  const query = String(options.query || options.q || '').trim();
  if (!query) return null;
  const params = new URLSearchParams();
  params.set('q', query);
  const limit = Math.max(1, Math.trunc(Number(options.limit) || 0));
  if (limit) params.set('limit', String(limit));
  const offset = Math.max(0, Math.trunc(Number(options.offset) || 0));
  if (offset) params.set('offset', String(offset));
  return apiFetch(`/api/search/messages?${params.toString()}`);
}

export async function deleteConversation(id) {
  const convId = String(id || '').trim();
  if (!convId) return null;
  return apiFetch(`/api/conversation/${convId}`, { method: 'DELETE' });
}

export async function updateConversationTitle(id, title) {
  const convId = String(id || '').trim();
  if (!convId) return null;
  return apiFetch(`/api/conversation/${convId}`, {
    method: 'PATCH',
    body: JSON.stringify({ title }),
  });
}

export async function updateConversationPreferences(id, preferences = {}) {
  const convId = String(id || '').trim();
  if (!convId) return null;
  return apiFetch(`/api/conversation/${convId}/preferences`, {
    method: 'PATCH',
    body: JSON.stringify(preferences || {}),
  });
}

export async function updateConversationDraft(id, draft = {}) {
  const convId = String(id || '').trim();
  if (!convId) return null;
  try {
    const response = await fetch(`${BASE}/api/conversation/${convId}/draft`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders(),
      },
      body: JSON.stringify(draft || {}),
    });
    const payload = await response.json().catch(() => null);
    if (response.ok) return payload;
    return {
      ok: false,
      status: response.status,
      ...(payload && typeof payload === 'object' ? payload : {}),
    };
  } catch (error) {
    console.error('Fetch error', error);
    return { ok: false, error: error?.message || 'Network error' };
  }
}

export async function compactConversation(id) {
  const convId = String(id || '').trim();
  if (!convId) return null;
  return apiFetch(`/api/conversation/${convId}/compact`, { method: 'POST' });
}

export async function killSessionWorker(sdkSessionId, body = {}) {
  const sessionId = String(sdkSessionId || '').trim();
  if (!sessionId) return null;
  return apiFetch(`/api/session-worker/${encodeURIComponent(sessionId)}/kill`, {
    method: 'POST',
    body: JSON.stringify(body || {}),
  });
}

export async function requestRelayRestart(body = {}) {
  return apiFetch('/api/relay/shutdown', {
    method: 'POST',
    body: JSON.stringify({
      reason: 'manual-restart',
      requestedBy: 'localhost-api',
      restart: true,
      ...(body || {}),
    }),
  });
}

export async function requestHostSuspend(body = {}) {
  return apiFetch('/api/host/suspend', {
    method: 'POST',
    body: JSON.stringify({
      reason: 'manual-suspend',
      requestedBy: 'localhost-api',
      ...(body || {}),
    }),
  });
}

export async function requestQueueEmpty(body = {}) {
  return apiFetch('/api/queue/empty', {
    method: 'POST',
    body: JSON.stringify({
      reason: 'manual-empty-queue',
      requestedBy: 'localhost-api',
      ...(body || {}),
    }),
  });
}

export async function sendMessage(body) {
  return apiFetch('/api/message', { method: 'POST', body: JSON.stringify(body) });
}

export async function bootstrapConversationSession(body = {}) {
  return apiFetch('/api/conversation/bootstrap', {
    method: 'POST',
    body: JSON.stringify(body || {}),
  });
}

export async function cancelConversationTurn(conversationId, body = {}) {
  const convId = String(conversationId || '').trim();
  if (!convId) return null;
  return apiFetch(`/api/conversation/${encodeURIComponent(convId)}/cancel-turn`, {
    method: 'POST',
    body: JSON.stringify(body || {}),
  });
}

export async function cancelQueuedConversationTurn(conversationId, body = {}) {
  const convId = String(conversationId || '').trim();
  if (!convId) return null;
  return apiFetch(`/api/conversation/${encodeURIComponent(convId)}/cancel-queued-turn`, {
    method: 'POST',
    body: JSON.stringify(body || {}),
  });
}

export async function cancelSubagentRun(conversationId, subagentRunId, body = {}) {
  const convId = String(conversationId || '').trim();
  const runId = String(subagentRunId || '').trim();
  if (!convId || !runId) return null;
  return apiFetch(`/api/conversation/${encodeURIComponent(convId)}/subagent/${encodeURIComponent(runId)}/cancel`, {
    method: 'POST',
    body: JSON.stringify(body || {}),
  });
}

export async function loadRelayQuestions(status = 'pending') {
  return apiFetch(`/api/relay-questions?status=${encodeURIComponent(status)}`);
}

export async function loadRelayQuestion(questionId) {
  const id = String(questionId || '').trim();
  if (!id) return null;
  return apiFetch(`/api/relay-question/${encodeURIComponent(id)}`);
}

export async function answerRelayQuestion(questionId, answer, sdkSessionId = null) {
  const id = String(questionId || '').trim();
  if (!id) return null;
  const sessionId = String(sdkSessionId || '').trim();
  return apiFetch(`/api/relay-question/${encodeURIComponent(id)}/answer`, {
    method: 'POST',
    body: JSON.stringify({ answer, sdk_session_id: sessionId || undefined }),
  });
}

export async function answerRelayQuestionStructured(questionId, structuredAnswer, sdkSessionId = null) {
  const id = String(questionId || '').trim();
  if (!id) return { ok: false, error: 'Missing question id' };
  const sessionId = String(sdkSessionId || '').trim();
  try {
    const response = await fetch(`${BASE}/api/relay-question/${encodeURIComponent(id)}/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ structuredAnswer, sdk_session_id: sessionId || undefined }),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      return { ok: false, error: data?.error || `Request failed (${response.status})`, fields: data?.fields || null };
    }
    return { ok: true, question: data?.question || null };
  } catch (error) {
    return { ok: false, error: error?.message || 'Network error' };
  }
}

export async function loadRelayBoards(status = 'pending') {
  return apiFetch(`/api/relay-boards?status=${encodeURIComponent(status)}`);
}

export async function loadRelayBoard(boardId) {
  const id = String(boardId || '').trim();
  if (!id) return null;
  return apiFetch(`/api/relay-board/${encodeURIComponent(id)}`);
}

export async function submitRelayBoardAction(boardId, actionId) {
  const id = String(boardId || '').trim();
  const action = String(actionId || '').trim();
  if (!id || !action) return null;
  return apiFetch(`/api/relay-board/${encodeURIComponent(id)}/action`, {
    method: 'POST',
    body: JSON.stringify({ actionId: action }),
  });
}

export async function uploadAttachment(item) {
  if (!item?.file) return null;
  const response = await fetch(`${BASE}/api/upload`, {
    method: 'POST',
    headers: {
      ...authHeaders(),
      'X-File-Name': encodeURIComponent(String(item.name || item.file.name || 'upload')),
      'X-File-Type': String(item.type || item.file.type || 'application/octet-stream'),
    },
    body: item.file,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(text || `Upload failed (${response.status})`);
  }
  return response.json();
}

export async function loadRepoTree(includeHidden = false, includeHeavy = false, conversationId = null) {
  const params = new URLSearchParams({
    includeHidden: includeHidden ? '1' : '0',
    includeHeavy: includeHeavy ? '1' : '0',
  });
  const convId = String(conversationId || '').trim();
  if (convId) params.set('conversationId', convId);
  return apiFetch(`/api/repo/tree?${params.toString()}`);
}

export async function loadRepoChildren(pathValue = '', includeHidden = false, includeHeavy = false, conversationId = null) {
  const params = new URLSearchParams({
    path: String(pathValue || '').trim(),
    includeHidden: includeHidden ? '1' : '0',
    includeHeavy: includeHeavy ? '1' : '0',
  });
  const convId = String(conversationId || '').trim();
  if (convId) params.set('conversationId', convId);
  return apiFetch(`/api/repo/list?${params.toString()}`);
}

export async function loadDrivesRoots() {
  return apiFetch('/api/drives/roots');
}

export async function loadDriveChildren(pathValue, includeHidden = false) {
  const path = String(pathValue || '').trim();
  if (!path) return null;
  return apiFetch(`/api/drives/list?path=${encodeURIComponent(path)}&includeHidden=${includeHidden ? '1' : '0'}`);
}

export async function loadWorkspaceFilePreview(pathValue, conversationId = null) {
  const path = String(pathValue || '').trim();
  if (!path) return null;
  const encodedPath = path.split('/').map((segment) => encodeURIComponent(segment)).join('/');
  const convId = String(conversationId || '').trim();
  const suffix = convId ? `?conversationId=${encodeURIComponent(convId)}` : '';
  return apiFetch(`/api/files-preview/${encodedPath}${suffix}`);
}

export async function loadDriveFilePreview(pathValue) {
  const path = String(pathValue || '').trim();
  if (!path) return null;
  return apiFetch(`/api/drives/files-preview?path=${encodeURIComponent(path)}`);
}

let contextUsageRefreshTimer = null;
let contextUsageRefreshSeq = 0;

export function scheduleContextUsageRefresh(conversationId, delayMs = 0) {
  if (contextUsageRefreshTimer) {
    clearTimeout(contextUsageRefreshTimer);
    contextUsageRefreshTimer = null;
  }

  const convId = String(conversationId || '').trim();
  if (!convId) {
    contextUsageRefreshSeq += 1;
    applyContextUsageBar(null);
    return;
  }

  const seq = ++contextUsageRefreshSeq;
  const waitMs = Math.max(0, Number(delayMs) || 0);
  contextUsageRefreshTimer = setTimeout(() => {
    contextUsageRefreshTimer = null;
    void refreshContextUsageBar(convId, seq);
  }, waitMs);
}

export async function refreshContextUsageBar(conversationId, requestSeq = ++contextUsageRefreshSeq) {
  const convId = String(conversationId || '').trim();
  if (!convId) {
    applyContextUsageBar(null);
    return;
  }
  const lookupId = resolveContextLookupId(convId) || convId;
  const payload = await apiFetch(`/api/context/${encodeURIComponent(lookupId)}`);
  if (!payload) return;
  if (requestSeq !== contextUsageRefreshSeq) return;
  if (String(currentConvId || '').trim() !== convId) return;
  applyContextUsageBar(readContextUsageRatio(payload));
}
