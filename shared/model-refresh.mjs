import { filterValidModelIds, normalizeModelIdCandidate } from './model-id.mjs';

export function selectModelIdsForVariantRefresh({
  snapshotModels = [],
  currentModel = '',
  defaultModel = '',
  helpModelIds = [],
} = {}) {
  const fromSnapshot = filterValidModelIds([
    ...(Array.isArray(snapshotModels) ? snapshotModels : []),
    normalizeModelIdCandidate(currentModel),
    normalizeModelIdCandidate(defaultModel),
  ]);
  if (fromSnapshot.length) {
    return {
      source: 'rpc-snapshot',
      modelIds: fromSnapshot,
    };
  }
  return {
    source: 'copilot-help-manual-refresh',
    modelIds: filterValidModelIds(Array.isArray(helpModelIds) ? helpModelIds : []),
  };
}
