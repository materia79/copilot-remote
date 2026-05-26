function normalizePathValue(value) {
  const text = String(value || "").trim();
  return text || null;
}

function firstPath(...candidates) {
  for (const candidate of candidates) {
    const text = normalizePathValue(candidate);
    if (text) return text;
  }
  return null;
}

function nestedValue(source, keys = []) {
  if (!source || typeof source !== "object") return null;
  let current = source;
  for (const key of keys) {
    if (!current || typeof current !== "object" || !(key in current)) return null;
    current = current[key];
  }
  return current;
}

export function resolveWorkspaceRootPath({
  session = null,
  env = process.env,
  cwd = process.cwd(),
  includeProcessCwd = true,
} = {}) {
  const resolved = firstPath(
    env?.COPILOT_WORKSPACE_ROOT,
    env?.GITHUB_COPILOT_WORKSPACE_ROOT,
    nestedValue(session, ["workspaceRootPath"]),
    nestedValue(session, ["workspace_root_path"]),
    nestedValue(session, ["cwd"]),
    nestedValue(session, ["workingDirectory"]),
    nestedValue(session, ["currentWorkingDirectory"]),
    nestedValue(session, ["context", "workspaceRootPath"]),
    nestedValue(session, ["context", "workspace_root_path"]),
    nestedValue(session, ["context", "cwd"]),
    nestedValue(session, ["context", "workingDirectory"]),
    nestedValue(session, ["context", "currentWorkingDirectory"]),
    nestedValue(session, ["state", "workspaceRootPath"]),
    nestedValue(session, ["state", "workspace_root_path"]),
    nestedValue(session, ["state", "cwd"]),
    nestedValue(session, ["state", "workingDirectory"]),
    nestedValue(session, ["state", "currentWorkingDirectory"]),
    env?.INIT_CWD,
    env?.PWD,
    env?.ORIGINAL_PWD,
  );
  if (resolved) return resolved;
  if (!includeProcessCwd) return null;
  return normalizePathValue(cwd);
}
