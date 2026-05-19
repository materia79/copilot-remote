export function createModelSwitchingService({
  api,
  dbg,
  getSession,
  modelSnapshotMinIntervalMs,
}) {
  let lastModelSnapshotMs = 0;
  const MODEL_ALIAS_CANDIDATES = {
    "sonnet-4.6": ["sonnet-4.6", "claude-sonnet-4.6", "claude-sonnet-4-6", "anthropic/claude-sonnet-4.6"],
    "haiku-4.5": ["haiku-4.5", "claude-haiku-4.5", "claude-haiku-4-5", "anthropic/claude-haiku-4.5"],
    "gpt-5.4": ["gpt-5.4", "openai/gpt-5.4"],
    "gpt-5.4-mini": ["gpt-5.4-mini", "gpt-5-mini", "openai/gpt-5.4-mini"],
    "gpt-5.3-codex": ["gpt-5.3-codex", "codex-5.3", "codex-5", "gpt-codex-5", "openai/codex-5.3"],
  };

  function buildRequestedModelCandidates(requested) {
    const key = String(requested || "").trim();
    if (!key) return [];
    const lower = key.toLowerCase();
    const aliasList = MODEL_ALIAS_CANDIDATES[key] || MODEL_ALIAS_CANDIDATES[lower] || [];
    return [...new Set([key, ...aliasList])];
  }

  function normalizeModelId(modelInfo) {
    if (!modelInfo) return null;
    if (typeof modelInfo === "string") return modelInfo;
    return modelInfo.modelId || modelInfo.id || modelInfo.model || null;
  }

  function canonicalModelId(id) {
    return String(id || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  }

  function extractModelIds(value, out = []) {
    if (!value) return out;
    if (typeof value === "string") {
      out.push(value);
      return out;
    }
    if (Array.isArray(value)) {
      for (const item of value) extractModelIds(item, out);
      return out;
    }
    if (typeof value === "object") {
      for (const key of ["modelId", "id", "model", "name"]) {
        if (typeof value[key] === "string") out.push(value[key]);
      }
      for (const item of Object.values(value)) extractModelIds(item, out);
    }
    return out;
  }

  async function getAvailableModelIds() {
    const modelApi = getSession()?.rpc?.model;
    if (!modelApi) return [];

    const found = [];
    for (const fnName of ["list", "getAvailable", "available", "getAll"]) {
      const fn = modelApi[fnName];
      if (typeof fn !== "function") continue;
      try {
        const raw = await fn.call(modelApi);
        extractModelIds(raw, found);
      } catch {
        // Continue with other API shapes.
      }
    }
    return [...new Set(found.map((value) => String(value || "").trim()).filter(Boolean))];
  }

  async function getCurrentModelId() {
    try {
      const modelInfo = await getSession()?.rpc?.model?.getCurrent();
      return normalizeModelId(modelInfo);
    } catch {
      return null;
    }
  }

  async function publishModelSnapshot(reason = "unspecified", force = false) {
    const now = Date.now();
    if (!force && (now - lastModelSnapshotMs) < modelSnapshotMinIntervalMs) return;
    lastModelSnapshotMs = now;

    try {
      const currentModel = await getCurrentModelId();
      const models = await getAvailableModelIds();
      const modelListWarning = (!models.length && !currentModel)
        ? "CLI did not expose a usable model list."
        : null;
      const payload = {
        source: `web-relay-extension:${reason}`,
        models,
        currentModel: currentModel || null,
        defaultModel: currentModel || models[0] || null,
        error: modelListWarning,
      };
      await api("POST", "/api/models/snapshot", payload);
      dbg("model snapshot published", `reason=${reason}`, `models=${models.length}`, `current=${currentModel || "unknown"}`);
    } catch (e) {
      dbg("model snapshot publish failed", `reason=${reason}`, e?.message || String(e));
      await api("POST", "/api/models/snapshot", {
        source: `web-relay-extension:${reason}`,
        models: [],
        currentModel: null,
        defaultModel: null,
        error: e?.message || String(e),
      }).catch(() => {});
    }
  }

  function resolveRequestedModelId(requested, availableIds) {
    const target = String(requested || "").trim();
    if (!target) return null;
    const candidates = buildRequestedModelCandidates(target);
    if (!availableIds.length) return candidates[0] || target;
    for (const candidate of candidates) {
      const exact = availableIds.find((id) => id === candidate);
      if (exact) return exact;
      const canonical = canonicalModelId(candidate);
      const canonicalMatch = availableIds.find((id) => canonicalModelId(id) === canonical);
      if (canonicalMatch) return canonicalMatch;
    }
    return candidates[0] || target;
  }

  async function setModelForMessage(model) {
    const requested = String(model || "").trim();
    if (!requested) return { requested, current: await getCurrentModelId(), switched: false };

    const current = await getCurrentModelId();
    if (canonicalModelId(current) === canonicalModelId(requested)) {
      return { requested, current, switched: true, after: current, via: "already-active" };
    }

    const availableModels = await getAvailableModelIds();
    const targetModel = resolveRequestedModelId(requested, availableModels);
    if (!targetModel) {
      return { requested, current, switched: false, error: "Requested model is not available in current Copilot CLI model list" };
    }
    const errors = [];

    for (const candidate of [targetModel, requested]) {
      try {
        const result = await getSession()?.rpc?.model?.switchTo({ modelId: candidate });
        const after = normalizeModelId(result) || await getCurrentModelId();
        if (
          canonicalModelId(after) === canonicalModelId(requested) ||
          canonicalModelId(after) === canonicalModelId(targetModel)
        ) {
          return { requested, current, switched: true, after, via: `switchTo(${candidate})`, targetModel };
        }
        errors.push(`switchTo(${candidate}) returned active=${after || "unknown"}`);
      } catch (e) {
        errors.push(`switchTo(${candidate}) failed: ${e?.message || String(e)}`);
      }
    }

    const after = await getCurrentModelId();
    return { requested, current, switched: false, after, targetModel, error: errors[0] || "Unknown switch failure" };
  }

  return {
    getCurrentModelId,
    setModelForMessage,
    publishModelSnapshot,
  };
}
