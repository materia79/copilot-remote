import {
  BASE,
  escHtml,
  workspaceRootName,
  workspaceRootEntrySet,
  WORKSPACE_FILE_EXTENSIONS,
  serverPlatform,
} from './store.js';

export function workspaceMentionRegex() {
  return /(?:[A-Za-z]:[\\/])?(?:\.{1,2}[\\/])?(?:[A-Za-z0-9._-]+[\\/])*[A-Za-z0-9._-]+\.[A-Za-z0-9]{1,16}/g;
}

export function normalizeWorkspaceMentionPath(rawText) {
  const original = String(rawText || '');
  const cleaned = original
    .trim()
    .replace(/^['"`([{<]+/, '')
    .replace(/[)\]}>:;,.!?'"`]+$/, '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+/g, '/');
  if (!cleaned) return '';
  const lowered = cleaned.toLowerCase();
  if (lowered.startsWith('http://') || lowered.startsWith('https://') || lowered.startsWith('api/')) return '';
  const hadDrivePrefix = /^[A-Za-z]:[\\/]/.test(original.trim());
  const hadLeadingSlash = /^[\\/]/.test(original.trim());
  let parts = cleaned.split('/').filter(Boolean);
  if (!parts.length) return '';
  if (/^[a-z]:$/i.test(parts[0])) {
    parts = parts.slice(1);
  }
  if (!parts.length) return '';
  if (workspaceRootName) {
    const idx = parts.findIndex((part) => part.toLowerCase() === workspaceRootName);
    if (idx >= 0) {
      parts = parts.slice(idx + 1);
    }
  }
  if (!parts.length) return '';
  if ((hadDrivePrefix || hadLeadingSlash) && !workspaceRootEntrySet.has(parts[0].toLowerCase())) {
    const firstRootIdx = parts.findIndex((part) => workspaceRootEntrySet.has(part.toLowerCase()));
    if (firstRootIdx > 0) {
      parts = parts.slice(firstRootIdx);
    }
  }
  if (!parts.length) return '';
  if (parts.some((part) => part === '.' || part === '..')) return '';
  return parts.join('/');
}

export function isLikelyWorkspaceFileMention(rawText) {
  const normalized = normalizeWorkspaceMentionPath(rawText);
  if (!normalized) return false;
  const ext = normalized.includes('.') ? normalized.slice(normalized.lastIndexOf('.') + 1).toLowerCase() : '';
  return WORKSPACE_FILE_EXTENSIONS.has(ext);
}

export function workspaceFilePathFromText(rawText) {
  if (!isLikelyWorkspaceFileMention(rawText)) return '';
  return normalizeWorkspaceMentionPath(rawText);
}

export function workspaceFileHrefFromPath(rawPath) {
  const normalized = normalizeWorkspaceMentionPath(rawPath);
  if (!normalized) return '';
  const encodedPath = normalized.split('/').map((segment) => encodeURIComponent(segment)).join('/');
  if (!encodedPath) return '';
  return `${BASE}/api/files/${encodedPath}`;
}

export function workspaceFileHref(rawText) {
  const normalized = workspaceFilePathFromText(rawText);
  return normalized ? workspaceFileHrefFromPath(normalized) : '';
}

export function workspacePreviewApiPath(rawPath) {
  const normalized = normalizeWorkspaceMentionPath(rawPath);
  if (!normalized) return '';
  const encodedPath = normalized.split('/').map((segment) => encodeURIComponent(segment)).join('/');
  return `/api/files-preview/${encodedPath}`;
}

export function normalizeDriveBrowserPath(rawPath) {
  const value = String(rawPath || '').trim();
  if (!value) return '';
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return '';
  }
  const withoutNulls = decoded.replace(/\0/g, '');

  if (serverPlatform !== 'win32') {
    const linuxNorm = withoutNulls
      .replace(/\\/g, '/')
      .replace(/\/+/g, '/')
      .trimEnd()
      .replace(/(.)\/$/, '$1');
    if (!linuxNorm.startsWith('/')) return '';
    if (linuxNorm.includes('/../') || linuxNorm.endsWith('/..')) return '';
    return linuxNorm || '/';
  }

  const normalized = withoutNulls
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .trim()
    .replace(/\/+$/, '');
  if (!normalized) return '';
  if (!/^[A-Za-z]:(?:\/.*)?$/.test(normalized)) return '';
  const drive = `${normalized.slice(0, 1).toUpperCase()}:`;
  const rest = normalized.slice(2).replace(/^\/+/, '');
  return rest ? `${drive}/${rest}` : drive;
}

export function driveFileHrefFromPath(rawPath) {
  const normalized = normalizeDriveBrowserPath(rawPath);
  if (!normalized) return '';
  return `${BASE}/api/drives/file?path=${encodeURIComponent(normalized)}`;
}

export function drivePreviewApiPath(rawPath) {
  const normalized = normalizeDriveBrowserPath(rawPath);
  if (!normalized) return '';
  return `/api/drives/files-preview?path=${encodeURIComponent(normalized)}`;
}

export function normalizeReferencePathForToken(kind, rawPath, source = 'workspace') {
  const tokenKind = String(kind || '').trim().toLowerCase();
  if (tokenKind !== 'file' && tokenKind !== 'folder') return '';
  const root = String(source || '').trim().toLowerCase();
  if (root === 'drives' || root === 'session') return normalizeDriveBrowserPath(rawPath);
  return normalizeWorkspaceMentionPath(rawPath);
}

export function buildReferenceToken(kind, rawPath, source = 'workspace') {
  const tokenKind = String(kind || '').trim().toLowerCase();
  if (tokenKind !== 'file' && tokenKind !== 'folder') return '';
  const normalizedPath = normalizeReferencePathForToken(tokenKind, rawPath, source);
  if (!normalizedPath) return '';
  return `@${tokenKind}:${normalizedPath}`;
}

export function buildWrappedReferenceToken(kind, rawPath, source = 'workspace') {
  const token = buildReferenceToken(kind, rawPath, source);
  if (!token) return '';
  return `\`${token}\``;
}

export async function copyTextToClipboard(value) {
  const text = String(value || '');
  if (!text) return false;
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    await navigator.clipboard.writeText(text);
    return true;
  }
  const input = document.createElement('textarea');
  input.value = text;
  input.setAttribute('readonly', 'readonly');
  input.style.position = 'fixed';
  input.style.left = '-9999px';
  document.body.appendChild(input);
  input.select();
  try {
    document.execCommand('copy');
    return true;
  } finally {
    document.body.removeChild(input);
  }
}

export async function copyReferenceTokenToClipboard(kind, rawPath, source = 'workspace') {
  const wrapped = buildWrappedReferenceToken(kind, rawPath, source);
  if (!wrapped) return false;
  try {
    await copyTextToClipboard(wrapped);
    return true;
  } catch {
    return false;
  }
}

export function isSafePreviewUrl(url, allowDataImage = false) {
  const value = String(url || '').trim();
  if (!value) return false;
  if (value.startsWith('#') || value.startsWith('/') || value.startsWith('./') || value.startsWith('../')) return true;
  try {
    const parsed = new URL(value, window.location.origin);
    const protocol = String(parsed.protocol || '').toLowerCase();
    if (protocol === 'http:' || protocol === 'https:' || protocol === 'mailto:') return true;
    if (allowDataImage && protocol === 'data:' && /^data:image\//i.test(value)) return true;
  } catch {}
  return false;
}

export function sanitizePreviewHtml(html) {
  const template = document.createElement('template');
  template.innerHTML = String(html || '');
  const blockedTags = new Set(['script', 'iframe', 'object', 'embed', 'link', 'style', 'meta', 'base', 'form', 'input', 'button', 'textarea', 'select', 'option']);
  const nodes = Array.from(template.content.querySelectorAll('*'));
  for (const el of nodes) {
    const tagName = String(el.tagName || '').toLowerCase();
    if (blockedTags.has(tagName)) {
      el.replaceWith(document.createTextNode(el.textContent || ''));
      continue;
    }
    const attrs = Array.from(el.attributes || []);
    for (const attr of attrs) {
      const name = String(attr.name || '').toLowerCase();
      const value = String(attr.value || '');
      if (name.startsWith('on') || name === 'style' || name === 'srcdoc') {
        el.removeAttribute(attr.name);
        continue;
      }
      if (name === 'href' && !isSafePreviewUrl(value, false)) {
        el.removeAttribute(attr.name);
        continue;
      }
      if (name === 'src' && !isSafePreviewUrl(value, true)) {
        el.removeAttribute(attr.name);
        continue;
      }
    }
    if (tagName === 'a') {
      el.setAttribute('target', '_blank');
      el.setAttribute('rel', 'noopener noreferrer');
    }
  }
  return template.innerHTML;
}

export function renderMarkdownPreview(source, allowEmbeddedHtml) {
  if (allowEmbeddedHtml) {
    return sanitizePreviewHtml(marked.parse(String(source || '')));
  }
  const renderer = new marked.Renderer();
  renderer.html = (html) => escHtml(html);
  return sanitizePreviewHtml(marked.parse(String(source || ''), { renderer }));
}

export function eventTargetElement(event) {
  const target = event?.target;
  if (target instanceof Element) return target;
  if (target && target.nodeType === Node.TEXT_NODE && target.parentElement) return target.parentElement;
  return null;
}

export function eventClosest(event, selector) {
  const target = eventTargetElement(event);
  if (target) {
    const closest = target.closest(selector);
    if (closest) return closest;
  }
  const path = typeof event?.composedPath === 'function' ? event.composedPath() : [];
  for (const entry of path) {
    if (entry instanceof Element && entry.matches(selector)) return entry;
  }
  return null;
}

export function buildLinkedTextFragment(text) {
  const source = String(text || '');
  const regex = workspaceMentionRegex();
  const fragment = document.createDocumentFragment();
  let lastIndex = 0;
  let changed = false;
  let match = null;
  while ((match = regex.exec(source)) !== null) {
    const mention = match[0];
    const workspacePath = workspaceFilePathFromText(mention);
    const href = workspacePath ? workspaceFileHrefFromPath(workspacePath) : '';
    if (!workspacePath || !href) continue;
    if (match.index > lastIndex) {
      fragment.appendChild(document.createTextNode(source.slice(lastIndex, match.index)));
    }
    const anchor = document.createElement('a');
    anchor.href = href;
    anchor.className = 'workspace-file-link';
    anchor.dataset.workspacePath = workspacePath;
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    anchor.textContent = mention;
    fragment.appendChild(anchor);
    lastIndex = match.index + mention.length;
    changed = true;
  }
  if (!changed) return null;
  if (lastIndex < source.length) {
    fragment.appendChild(document.createTextNode(source.slice(lastIndex)));
  }
  return fragment;
}

export function linkifyWorkspaceMentionsInNode(root) {
  if (!root) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node?.nodeValue || !String(node.nodeValue).trim()) return NodeFilter.FILTER_REJECT;
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      const tag = String(parent.tagName || '').toUpperCase();
      if (tag === 'A' || tag === 'CODE' || tag === 'PRE' || tag === 'SCRIPT' || tag === 'STYLE') {
        return NodeFilter.FILTER_REJECT;
      }
      if (parent.closest?.('.msg-attachment')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const textNodes = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode);
  for (const node of textNodes) {
    const fragment = buildLinkedTextFragment(node.nodeValue || '');
    if (fragment) node.parentNode.replaceChild(fragment, node);
  }
}

export function renderLinkedPlainText(text) {
  const source = String(text || '');
  const regex = workspaceMentionRegex();
  let html = '';
  let lastIndex = 0;
  let match = null;
  while ((match = regex.exec(source)) !== null) {
    const mention = match[0];
    const workspacePath = workspaceFilePathFromText(mention);
    const href = workspacePath ? workspaceFileHrefFromPath(workspacePath) : '';
    html += escHtml(source.slice(lastIndex, match.index));
    if (workspacePath && href) {
      html += `<a href="${escHtml(href)}" class="workspace-file-link" data-workspace-path="${escHtml(workspacePath)}" target="_blank" rel="noopener noreferrer">${escHtml(mention)}</a>`;
    } else {
      html += escHtml(mention);
    }
    lastIndex = match.index + mention.length;
  }
  html += escHtml(source.slice(lastIndex));
  return html;
}

