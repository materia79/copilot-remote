import { isValidModelId, normalizeModelIdCandidate } from "../../../../shared/model-id.mjs";
import {
  extractModelDescriptors,
  normalizeContextLimitTokens,
} from "../../../../shared/model-descriptors.mjs";

export { extractModelDescriptors };

export function createModelSwitchingService({
  api,
  dbg,
  getSession,
  modelSnapshotMinIntervalMs,
}) {
  let lastModelSnapshotMs = 0;
  const cachedModelMetadataById = new Map();
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
    if (typeof modelInfo === "string") {
      const candidate = normalizeModelIdCandidate(modelInfo);
      return isValidModelId(candidate) ? candidate : null;
    }
    const candidate = normalizeModelIdCandidate(modelInfo.modelId || modelInfo.id || modelInfo.model || null);
    return isValidModelId(candidate) ? candidate : null;
  }

  function canonicalModelId(id) {
    return String(id || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  }

  function appendDescriptorsWithPriority(raw, found, priority) {
    const descriptors = [];
    extractModelDescriptors(raw, descriptors);
    for (const descriptor of descriptors) {
      found.push({ ...descriptor, __priority: priority });
    }
  }

  async function getAvailableModels() {
    const session = getSession();
    const modelApi = session?.rpc?.model;
    if (!modelApi && !session?.connection?.sendRequest) {
      if (!cachedModelMetadataById.size) return [];
      return [...cachedModelMetadataById.values()];
    }
    const found = [];

    const sendRequest = session?.connection?.sendRequest;
    if (typeof sendRequest === "function") {
      try {
        const raw = await sendRequest.call(session.connection, "models.list", {});
        appendDescriptorsWithPriority(raw, found, 3);
      } catch {
        // Keep going with session-scoped model APIs.
      }
    }

    if (typeof modelApi?.list === "function") {
      try {
        const raw = await modelApi.list.call(modelApi, { skipCache: true });
        appendDescriptorsWithPriority(raw, found, 2);
      } catch {
        // Continue with compatibility fallbacks below.
      }
    }

    if (modelApi) {
      for (const fnName of ["getAvailable", "available", "getAll", "list"]) {
        const fn = modelApi[fnName];
        if (typeof fn !== "function") continue;
        try {
          const raw = await fn.call(modelApi);
          appendDescriptorsWithPriority(raw, found, 1);
        } catch {
          // Continue with other API shapes.
        }
      }
    }

    found.sort((a, b) => Number(b?.__priority || 0) - Number(a?.__priority || 0));
    const byModelId = new Map();
    for (const entry of found) {
      const modelId = normalizeModelIdCandidate(entry?.modelId);
      if (!isValidModelId(modelId)) continue;
      const existing = byModelId.get(modelId);
      const cached = cachedModelMetadataById.get(modelId);
      byModelId.set(modelId, {
        modelId,
        contextLimitTokens: existing?.contextLimitTokens
          ?? normalizeContextLimitTokens(entry?.contextLimitTokens)
          ?? cached?.contextLimitTokens
          ?? null,
        longContextLimitTokens: existing?.longContextLimitTokens
          ?? normalizeContextLimitTokens(entry?.longContextLimitTokens)
          ?? cached?.longContextLimitTokens
          ?? null,
        pricing: existing?.pricing || entry?.pricing || cached?.pricing || null,
      });
    }
    const models = byModelId.size ? [...byModelId.values()] : [...cachedModelMetadataById.values()];
    for (const entry of models) cachedModelMetadataById.set(entry.modelId, entry);
    return models;
  }

  async function getAvailableModelIds() {
    const models = await getAvailableModels();
    return models.map((entry) => entry.modelId);
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
      const availableModels = await getAvailableModels();
      const models = availableModels.map((entry) => entry.modelId);
      const contextLimitsByModel = Object.fromEntries(
        availableModels
          .filter((entry) => entry.contextLimitTokens !== null)
          .map((entry) => [entry.modelId, entry.contextLimitTokens]),
      );
      const modelMetadataByModel = Object.fromEntries(
        availableModels.map((entry) => [entry.modelId, {
          defaultContextLimitTokens: entry.contextLimitTokens,
          longContextLimitTokens: entry.longContextLimitTokens,
          pricing: entry.pricing,
        }]),
      );
      const modelListWarning = (!models.length && !currentModel)
        ? "CLI did not expose a usable model list."
        : null;
      const payload = {
        source: `web-relay-extension:${reason}`,
        models,
        contextLimitsByModel,
        modelMetadataByModel,
        currentModel: currentModel || null,
        defaultModel: currentModel || models[0] || null,
        error: modelListWarning,
      };
      await api("POST", "/api/models/snapshot", payload);
      dbg("model snapshot published", `reason=${reason}`, `models=${models.length}`, `contextLimits=${Object.keys(contextLimitsByModel).length}`, `current=${currentModel || "unknown"}`);
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

  async function setModelForMessage(model, contextTier = 'default') {
    const requested = String(model || "").trim();
    if (!requested) return { requested, current: await getCurrentModelId(), switched: false };
    if (requested.toLowerCase() === "auto") {
      return {
        requested,
        current: await getCurrentModelId(),
        switched: false,
        requiresSessionBoundary: true,
        error: "Auto model selection is only available when a new SDK session is created",
      };
    }

    const current = await getCurrentModelId();
    if (canonicalModelId(current) === canonicalModelId(requested) && contextTier === 'default') {
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
        const result = await getSession()?.rpc?.model?.switchTo({ modelId: candidate, contextTier });
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
    getAvailableModels,
    getCurrentModelId,
    setModelForMessage,
    publishModelSnapshot,
  };
}
