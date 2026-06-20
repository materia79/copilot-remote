export function resolveDefaultSessionWorkspaceRootState({
  storedPath = '',
  normalizePath = null,
} = {}) {
  const stored = String(storedPath || '').trim();
  if (!stored) return { path: null, warning: null };
  const normalized = typeof normalizePath === 'function' ? normalizePath(stored) : stored;
  const normalizedText = String(normalized || '').trim();
  if (normalizedText) {
    return {
      path: normalizedText,
      warning: null,
    };
  }
  return {
    path: null,
    warning: 'Saved default CWD is unavailable. Update it in Settings.',
  };
}

export function resolveLaunchWorkspaceRootPath({
  configuredWorkspaceRootPath = '',
  pendingSessionWorkspaceRootPath = '',
  defaultSessionWorkspaceRootPath = '',
  workspaceRootPath = '',
} = {}) {
  const configured = String(configuredWorkspaceRootPath || '').trim();
  if (configured) return configured;
  const pending = String(pendingSessionWorkspaceRootPath || '').trim();
  if (pending) return pending;
  const configuredDefault = String(defaultSessionWorkspaceRootPath || '').trim();
  if (configuredDefault) return configuredDefault;
  return String(workspaceRootPath || '').trim();
}
