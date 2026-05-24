import { BASE, TOKEN, authHeaders, updateWorkspaceRootHints, applyContextUsageBar, readContextUsageRatio, currentConvId, conversations } from './store.js';

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
    return true;
  } catch {
    return false;
  }
}

export async function refreshWorkspaceRootHints() {
  const status = await apiFetch('/api/status');
  if (status) updateWorkspaceRootHints(status);
  return status;
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

export async function loadConversations() {
  return apiFetch('/api/conversations');
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
  const query = params.toString();
  return apiFetch(`/api/conversation/${convId}${query ? `?${query}` : ''}`);
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

export async function sendMessage(body) {
  return apiFetch('/api/message', { method: 'POST', body: JSON.stringify(body) });
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

export async function loadRepoTree(includeHidden = false, includeHeavy = false) {
  return apiFetch(`/api/repo/tree?${new URLSearchParams({
    includeHidden: includeHidden ? '1' : '0',
    includeHeavy: includeHeavy ? '1' : '0',
  }).toString()}`);
}

export async function loadDrivesRoots() {
  return apiFetch('/api/drives/roots');
}

export async function loadDriveChildren(pathValue, includeHidden = false) {
  const path = String(pathValue || '').trim();
  if (!path) return null;
  return apiFetch(`/api/drives/list?path=${encodeURIComponent(path)}&includeHidden=${includeHidden ? '1' : '0'}`);
}

export async function loadWorkspaceFilePreview(pathValue) {
  const path = String(pathValue || '').trim();
  if (!path) return null;
  const encodedPath = path.split('/').map((segment) => encodeURIComponent(segment)).join('/');
  return apiFetch(`/api/files-preview/${encodedPath}`);
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
