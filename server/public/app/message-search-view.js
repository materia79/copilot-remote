import { escHtml } from './store.js';
import { searchMessages } from './api-client.js';

const SEARCH_PAGE_SIZE = 40;
const SEARCH_DEBOUNCE_MS = 220;

const searchState = {
  query: '',
  results: [],
  offset: 0,
  hasMore: false,
  loading: false,
  error: '',
  selectedKey: '',
  scrollTop: 0,
  requestSeq: 0,
  debounceTimer: null,
};

let handlers = {
  openConversation: null,
};

function getSearchElements() {
  return {
    modal: document.getElementById('message-search-modal'),
    input: document.getElementById('message-search-input'),
    list: document.getElementById('message-search-results'),
    status: document.getElementById('message-search-status'),
    closeBtn: document.getElementById('message-search-close'),
    clearBtn: document.getElementById('message-search-clear'),
  };
}

function resultKey(result) {
  const conversationId = String(result?.conversationId || '').trim();
  const messageId = String(result?.messageId || '').trim();
  return `${conversationId}:${messageId}`;
}

function renderSearchResults() {
  const { list, status } = getSearchElements();
  if (!list || !status) return;
  status.textContent = searchState.error
    || (searchState.loading ? 'Searching…' : (searchState.results.length ? `${searchState.results.length} result${searchState.results.length === 1 ? '' : 's'}` : 'No results'));
  if (!searchState.results.length) {
    list.innerHTML = `<div class="message-search-empty">${escHtml(searchState.query.length < 2 ? 'Type at least 2 characters to search message history.' : (searchState.error || 'No matches found.'))}</div>`;
    return;
  }
  list.innerHTML = searchState.results.map((item) => {
    const key = resultKey(item);
    const activeClass = key === searchState.selectedKey ? ' active' : '';
    const title = String(item.conversationTitle || 'Conversation').trim();
    const snippet = String(item.snippet || '').trim() || '(no text)';
    const snippetHtml = escHtml(snippet)
      .replaceAll('&lt;mark&gt;', '<mark>')
      .replaceAll('&lt;/mark&gt;', '</mark>');
    const role = String(item.role || '').trim() || 'message';
    const when = String(item.timestamp || '').trim() || '';
    return `
      <button type="button" class="message-search-result${activeClass}" data-search-key="${escHtml(key)}" data-search-conversation="${escHtml(item.conversationId)}" data-search-message="${escHtml(item.messageId)}">
        <div class="message-search-result-title">${escHtml(title)}</div>
        <div class="message-search-result-meta">${escHtml(role)}${when ? ` · ${escHtml(new Date(when).toLocaleString())}` : ''}</div>
        <div class="message-search-result-snippet">${snippetHtml}</div>
      </button>
    `;
  }).join('');
  if (searchState.hasMore) {
    list.insertAdjacentHTML('beforeend', '<div class="message-search-loading-more">Scroll for more…</div>');
  }
}

async function runMessageSearch({ reset = false } = {}) {
  const { input } = getSearchElements();
  const query = String(input?.value || searchState.query || '').trim();
  if (reset) {
    searchState.query = query;
    searchState.offset = 0;
    searchState.results = [];
    searchState.hasMore = false;
    searchState.error = '';
    searchState.selectedKey = '';
    renderSearchResults();
  }
  if (query.length < 2) {
    searchState.loading = false;
    renderSearchResults();
    return;
  }
  if (searchState.loading) return;
  searchState.loading = true;
  renderSearchResults();
  const reqId = ++searchState.requestSeq;
  const result = await searchMessages({
    query,
    limit: SEARCH_PAGE_SIZE,
    offset: reset ? 0 : searchState.offset,
  });
  if (reqId !== searchState.requestSeq) return;
  searchState.loading = false;
  if (!result) {
    searchState.error = 'Search failed.';
    renderSearchResults();
    return;
  }
  const incoming = Array.isArray(result.results) ? result.results : [];
  if (reset) {
    searchState.results = incoming;
  } else {
    const seen = new Set(searchState.results.map((item) => resultKey(item)));
    for (const row of incoming) {
      const key = resultKey(row);
      if (!seen.has(key)) {
        seen.add(key);
        searchState.results.push(row);
      }
    }
  }
  searchState.offset = Number(result?.pageInfo?.nextOffset ?? (searchState.results.length));
  searchState.hasMore = !!result?.pageInfo?.hasMore;
  searchState.error = '';
  renderSearchResults();
}

function scheduleSearchDebounced() {
  if (searchState.debounceTimer) {
    window.clearTimeout(searchState.debounceTimer);
  }
  searchState.debounceTimer = window.setTimeout(() => {
    searchState.debounceTimer = null;
    void runMessageSearch({ reset: true });
  }, SEARCH_DEBOUNCE_MS);
}

function openMessageSearchModal() {
  const { modal, input, list } = getSearchElements();
  if (!modal || !input || !list) return;
  modal.classList.add('visible');
  modal.setAttribute('aria-hidden', 'false');
  input.value = searchState.query;
  renderSearchResults();
  requestAnimationFrame(() => {
    list.scrollTop = searchState.scrollTop;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  });
}

function closeMessageSearchModal() {
  const { modal, list } = getSearchElements();
  if (!modal) return;
  if (list) searchState.scrollTop = list.scrollTop;
  modal.classList.remove('visible');
  modal.setAttribute('aria-hidden', 'true');
}

function clearMessageSearchRuntimeState() {
  searchState.query = '';
  searchState.results = [];
  searchState.offset = 0;
  searchState.hasMore = false;
  searchState.loading = false;
  searchState.error = '';
  searchState.selectedKey = '';
  searchState.scrollTop = 0;
  searchState.requestSeq += 1;
  if (searchState.debounceTimer) {
    window.clearTimeout(searchState.debounceTimer);
    searchState.debounceTimer = null;
  }
  closeMessageSearchModal();
  renderSearchResults();
}

function bindMessageSearchEvents() {
  const { modal, input, list, closeBtn, clearBtn } = getSearchElements();
  if (!modal || !input || !list || !closeBtn || !clearBtn) return;
  if (modal.dataset.bound === '1') return;
  modal.dataset.bound = '1';

  closeBtn.addEventListener('click', (event) => {
    event.preventDefault();
    closeMessageSearchModal();
  });
  clearBtn.addEventListener('click', (event) => {
    event.preventDefault();
    clearMessageSearchRuntimeState();
  });
  modal.addEventListener('click', (event) => {
    if (event.target === modal) closeMessageSearchModal();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (!modal.classList.contains('visible')) return;
    closeMessageSearchModal();
  });
  input.addEventListener('input', () => {
    scheduleSearchDebounced();
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void runMessageSearch({ reset: true });
    }
  });
  list.addEventListener('scroll', () => {
    searchState.scrollTop = list.scrollTop;
    const remaining = list.scrollHeight - list.clientHeight - list.scrollTop;
    if (remaining <= 120 && searchState.hasMore && !searchState.loading) {
      void runMessageSearch({ reset: false });
    }
  }, { passive: true });
  list.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest('[data-search-conversation][data-search-message]') : null;
    if (!target) return;
    const conversationId = String(target.getAttribute('data-search-conversation') || '').trim();
    const messageId = String(target.getAttribute('data-search-message') || '').trim();
    if (!conversationId || !messageId) return;
    searchState.selectedKey = String(target.getAttribute('data-search-key') || '').trim();
    renderSearchResults();
    closeMessageSearchModal();
    void handlers.openConversation?.(conversationId, {
      aroundMessageId: messageId,
      focusMessageId: messageId,
    });
  });
}

export function initMessageSearchView({ openConversation } = {}) {
  handlers = {
    openConversation: typeof openConversation === 'function' ? openConversation : null,
  };
  bindMessageSearchEvents();
  renderSearchResults();
}

export {
  openMessageSearchModal,
  closeMessageSearchModal,
  clearMessageSearchRuntimeState,
};
