const DEFAULT_FALLBACK_MODE = 'agent';

function normalizeModeList(modes = []) {
  return Array.isArray(modes)
    ? modes.map((mode) => String(mode || '').trim()).filter(Boolean)
    : [];
}

function normalizeModelList(models = []) {
  return Array.isArray(models)
    ? models.map((model) => String(model || '').trim()).filter(Boolean)
    : [];
}

export function normalizePreferredModelsByMode(value, { supportedModes = [] } = {}) {
  const allowedModes = normalizeModeList(supportedModes);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const normalized = {};
  for (const mode of allowedModes) {
    const model = String(value[mode] || '').trim();
    if (!model) continue;
    normalized[mode] = model;
  }
  return normalized;
}

export function resolveConversationComposerSelection({
  preferredRelayMode = '',
  preferredModelsByMode = {},
  selectedMode = '',
  selectedModel = '',
  supportedModes = [],
  supportedModels = [],
  fallbackMode = DEFAULT_FALLBACK_MODE,
  fallbackModel = '',
} = {}) {
  const allowedModes = normalizeModeList(supportedModes);
  const allowedModels = normalizeModelList(supportedModels);
  const modeFallback = allowedModes.includes(fallbackMode)
    ? fallbackMode
    : (allowedModes[0] || DEFAULT_FALLBACK_MODE);
  const preferredMode = String(preferredRelayMode || '').trim();
  const nextMode = allowedModes.includes(preferredMode)
    ? preferredMode
    : (allowedModes.includes(String(selectedMode || '').trim())
      ? String(selectedMode || '').trim()
      : modeFallback);

  const normalizedMap = normalizePreferredModelsByMode(preferredModelsByMode, {
    supportedModes: allowedModes,
  });
  const modelCandidates = [
    normalizedMap[nextMode],
    String(selectedModel || '').trim(),
    String(fallbackModel || '').trim(),
    allowedModels[0] || '',
  ].filter(Boolean);
  const nextModel = allowedModels.length
    ? (modelCandidates.find((candidate) => allowedModels.includes(candidate)) || allowedModels[0])
    : (modelCandidates[0] || '');

  if (nextModel) normalizedMap[nextMode] = nextModel;

  return {
    mode: nextMode,
    model: nextModel,
    preferredModelsByMode: normalizedMap,
  };
}

export function withUpdatedModelPreference({
  preferredModelsByMode = {},
  mode = '',
  model = '',
  supportedModes = [],
} = {}) {
  const allowedModes = normalizeModeList(supportedModes);
  const nextMode = String(mode || '').trim();
  const nextModel = String(model || '').trim();
  const normalizedMap = normalizePreferredModelsByMode(preferredModelsByMode, {
    supportedModes: allowedModes,
  });
  if (!allowedModes.includes(nextMode) || !nextModel) return normalizedMap;
  normalizedMap[nextMode] = nextModel;
  return normalizedMap;
}
