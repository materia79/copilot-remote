import {
  defaultSessionWorkspaceRootPath,
  defaultSessionWorkspaceRootWarning,
  showTransientRelayNotice,
} from './store.js';
import { updateDefaultSessionWorkspaceRoot } from './api-client.js';
import { syncFontScaleSelect } from './font-scaling.js';
import { syncPwaAppNameInput } from './pwa-install.js';
import { normalizeKnownCwdPath } from './cwd-picker.js';

const THEME_STORAGE_KEY = 'copilot_theme';
const SHOW_SUSPEND_HOST_STORAGE_KEY = 'copilot_show_suspend_host';

let defaultSessionWorkspaceRootUpdateInFlight = false;

function closeChatActionsMenu() {
  const menu = document.getElementById('chat-actions-menu');
  const trigger = document.getElementById('chat-actions-menu-btn');
  const backdrop = document.getElementById('chat-actions-menu-backdrop');
  if (menu) menu.hidden = true;
  if (trigger) trigger.setAttribute('aria-expanded', 'false');
  if (backdrop && !window.__chatActionsMenuShieldTimer) backdrop.classList.remove('visible');
}

export function syncDefaultSessionWorkspaceRootInput() {
  const input = document.getElementById('default-session-workspace-root-input');
  if (!input) return;
  input.value = normalizeKnownCwdPath(defaultSessionWorkspaceRootPath || '');
  if (defaultSessionWorkspaceRootWarning) {
    input.title = defaultSessionWorkspaceRootWarning;
  } else {
    input.removeAttribute('title');
  }
}

function readShowSuspendHostSetting() {
  const stored = String(localStorage.getItem(SHOW_SUSPEND_HOST_STORAGE_KEY) || '').trim().toLowerCase();
  if (!stored) return true;
  return stored !== '0' && stored !== 'false';
}

function setShowSuspendHostSetting(show, { persist = true } = {}) {
  const next = !!show;
  if (persist) localStorage.setItem(SHOW_SUSPEND_HOST_STORAGE_KEY, next ? '1' : '0');
  return next;
}

export function isSuspendHostActionVisible() {
  return readShowSuspendHostSetting();
}

export function syncSuspendHostVisibility() {
  const show = isSuspendHostActionVisible();
  const menuBtn = document.getElementById('chat-menu-suspend-host');
  const checkbox = document.getElementById('show-suspend-host-toggle');
  if (menuBtn) {
    menuBtn.hidden = !show;
    menuBtn.disabled = !show;
    menuBtn.tabIndex = show ? 0 : -1;
    menuBtn.setAttribute('aria-hidden', show ? 'false' : 'true');
  }
  if (checkbox instanceof HTMLInputElement) {
    checkbox.checked = show;
  }
}

export function initTheme() {
  const saved = localStorage.getItem(THEME_STORAGE_KEY);
  if (saved === 'light') {
    document.documentElement.setAttribute('data-theme', 'light');
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
}

export function updateTheme(theme) {
  if (theme === 'light') {
    document.documentElement.setAttribute('data-theme', 'light');
    localStorage.setItem(THEME_STORAGE_KEY, 'light');
  } else {
    document.documentElement.removeAttribute('data-theme');
    localStorage.setItem(THEME_STORAGE_KEY, 'dark');
  }
}

export function updateShowSuspendHostSetting(next) {
  setShowSuspendHostSetting(next, { persist: true });
  syncSuspendHostVisibility();
}

export async function updateDefaultSessionWorkspaceRootSetting(rawValue) {
  if (defaultSessionWorkspaceRootUpdateInFlight) {
    syncDefaultSessionWorkspaceRootInput();
    return;
  }
  const normalizedPath = normalizeKnownCwdPath(rawValue);
  defaultSessionWorkspaceRootUpdateInFlight = true;
  try {
    const result = await updateDefaultSessionWorkspaceRoot(normalizedPath, {
      clear: !normalizedPath,
    });
    if (!result) {
      alert('Failed to update the default CWD for new sessions.');
      syncDefaultSessionWorkspaceRootInput();
      return;
    }
    syncDefaultSessionWorkspaceRootInput();
    if (result.defaultSessionWorkspaceRootWarning) {
      showTransientRelayNotice(String(result.defaultSessionWorkspaceRootWarning), 7000);
    }
    if (normalizedPath) {
      const savedPath = String(result.defaultSessionWorkspaceRootPath || normalizedPath).trim();
      showTransientRelayNotice(`Default CWD for new sessions saved as ${savedPath}.`);
    } else {
      showTransientRelayNotice('Default CWD reset. New sessions will use relay workspace root.');
    }
  } catch (error) {
    alert(error?.message || 'Failed to update the default CWD for new sessions.');
    syncDefaultSessionWorkspaceRootInput();
  } finally {
    defaultSessionWorkspaceRootUpdateInFlight = false;
  }
}

export function openSettingsModal() {
  closeChatActionsMenu();
  const modal = document.getElementById('settings-modal');
  const themeSelect = document.getElementById('theme-select');
  if (themeSelect) {
    themeSelect.value = localStorage.getItem(THEME_STORAGE_KEY) === 'light' ? 'light' : 'dark';
  }
  syncSuspendHostVisibility();
  syncFontScaleSelect();
  syncPwaAppNameInput();
  syncDefaultSessionWorkspaceRootInput();
  modal?.classList.add('visible');
  modal?.setAttribute('aria-hidden', 'false');
}

export function closeSettingsModal() {
  const modal = document.getElementById('settings-modal');
  modal?.classList.remove('visible');
  modal?.setAttribute('aria-hidden', 'true');
}
