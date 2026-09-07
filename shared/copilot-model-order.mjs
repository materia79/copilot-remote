// The canonical order of the Copilot model catalog.
//
// The runtime's `rpc.model.list()` comes back in no useful order (the live
// 2026-09-07 list interleaves gpt-6-astra after kimi-k2.7-code), and the
// relay's model_variants rows used to be numbered per ingest, restarting at 0
// for each batch of new ids — so pickers showed models in arrival order. This
// module is the single definition of "the order a Copilot picker shows":
//
//   1. `auto` first;
//   2. vendor rank: OpenAI, Anthropic, Google, xAI, Microsoft, Azure OpenAI,
//      Moonshot AI, then any other vendor alphabetically;
//   3. within a vendor, newest version first — the first dotted number in the
//      id (gpt-5.6-terra → 5.6, gpt-6-astra → 6, claude-opus-4.8-fast → 4.8,
//      kimi-k3 → 3, mai-code-1.1-flash → 1.1), compared segment-wise;
//   4. ties: picker category powerful → versatile → lightweight → unknown;
//   5. preview after non-preview;
//   6. display name, natural-alpha.
//
// Pure: takes descriptors (any object with modelId|id and optional vendor,
// pickerCategory, preview, displayName|name), returns a new array. Browser
// and server neutral.

export const COPILOT_VENDOR_ORDER = Object.freeze([
  'OpenAI',
  'Anthropic',
  'Google',
  'xAI',
  'Microsoft',
  'Azure OpenAI',
  'Moonshot AI',
]);

const PICKER_CATEGORY_ORDER = Object.freeze(['powerful', 'versatile', 'lightweight']);

export const AUTO_MODEL_ID = 'auto';

const VENDOR_BY_PREFIX = [
  ['gpt-', 'OpenAI'],
  ['chatgpt-', 'OpenAI'],
  ['o1-', 'OpenAI'],
  ['o3-', 'OpenAI'],
  ['o4-', 'OpenAI'],
  ['codex-', 'OpenAI'],
  ['openai/', 'OpenAI'],
  ['claude-', 'Anthropic'],
  ['anthropic/', 'Anthropic'],
  ['gemini-', 'Google'],
  ['google/', 'Google'],
  ['grok-', 'xAI'],
  ['mai-', 'Microsoft'],
  ['microsoft/', 'Microsoft'],
  ['kimi-', 'Moonshot AI'],
];

function modelIdOf(descriptor) {
  if (typeof descriptor === 'string') return descriptor.trim();
  return String(descriptor?.modelId ?? descriptor?.id ?? descriptor?.model ?? '').trim();
}

function displayNameOf(descriptor) {
  if (typeof descriptor === 'string') return '';
  return String(descriptor?.displayName ?? descriptor?.name ?? descriptor?.label ?? '').trim();
}

/**
 * The vendor a bare model id implies, for rows that carry no runtime vendor
 * (curated seeds, help-text ids, pre-metadata snapshots). A runtime-reported
 * vendor always wins over this — `gpt-5-mini` is served by "Azure OpenAI".
 */
export function inferCopilotVendor(modelId) {
  const lower = String(modelId || '').trim().toLowerCase();
  if (!lower) return null;
  if (lower === 'o1' || lower === 'o3') return 'OpenAI';
  for (const [prefix, vendor] of VENDOR_BY_PREFIX) {
    if (lower.startsWith(prefix)) return vendor;
  }
  return null;
}

function vendorOf(descriptor) {
  const explicit = typeof descriptor === 'string' ? '' : String(descriptor?.vendor ?? '').trim();
  return explicit || inferCopilotVendor(modelIdOf(descriptor)) || '';
}

function vendorRank(vendor) {
  if (!vendor) return COPILOT_VENDOR_ORDER.length + 1;
  const index = COPILOT_VENDOR_ORDER.findIndex((name) => name.toLowerCase() === vendor.toLowerCase());
  return index === -1 ? COPILOT_VENDOR_ORDER.length : index;
}

/** The first dotted number in an id, as numeric segments; null when none. */
export function parseModelVersion(modelId) {
  const match = /(\d+(?:\.\d+)*)/.exec(String(modelId || ''));
  if (!match) return null;
  return match[1].split('.').map((segment) => Number(segment));
}

// Newest first: a missing segment is "older" than any present one (5 < 5.1),
// and an absent version sorts after every versioned id.
function compareVersionsDesc(a, b) {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const left = a[index] ?? -1;
    const right = b[index] ?? -1;
    if (left !== right) return right - left;
  }
  return 0;
}

function categoryRank(descriptor) {
  const category = typeof descriptor === 'string' ? '' : String(descriptor?.pickerCategory ?? '').trim().toLowerCase();
  const index = PICKER_CATEGORY_ORDER.indexOf(category);
  return index === -1 ? PICKER_CATEGORY_ORDER.length : index;
}

const naturalCollator = typeof Intl !== 'undefined' && typeof Intl.Collator === 'function'
  ? new Intl.Collator('en', { numeric: true, sensitivity: 'base' })
  : null;

function compareNatural(a, b) {
  if (naturalCollator) return naturalCollator.compare(a, b);
  return a.localeCompare(b);
}

/** The comparable key of one descriptor; exported for tests and debugging. */
export function copilotModelSortKey(descriptor) {
  const modelId = modelIdOf(descriptor);
  const vendor = vendorOf(descriptor);
  return {
    modelId,
    auto: modelId.toLowerCase() === AUTO_MODEL_ID,
    vendor,
    vendorRank: vendorRank(vendor),
    version: parseModelVersion(modelId),
    categoryRank: categoryRank(descriptor),
    preview: typeof descriptor !== 'string' && descriptor?.preview === true,
    displayName: displayNameOf(descriptor) || modelId,
  };
}

export function compareCopilotModels(a, b) {
  const left = copilotModelSortKey(a);
  const right = copilotModelSortKey(b);
  if (left.auto !== right.auto) return left.auto ? -1 : 1;
  if (left.vendorRank !== right.vendorRank) return left.vendorRank - right.vendorRank;
  if (left.vendorRank >= COPILOT_VENDOR_ORDER.length) {
    const byVendor = compareNatural(left.vendor, right.vendor);
    if (byVendor !== 0) return byVendor;
  }
  const byVersion = compareVersionsDesc(left.version, right.version);
  if (byVersion !== 0) return byVersion;
  if (left.categoryRank !== right.categoryRank) return left.categoryRank - right.categoryRank;
  if (left.preview !== right.preview) return left.preview ? 1 : -1;
  const byName = compareNatural(left.displayName, right.displayName);
  if (byName !== 0) return byName;
  return compareNatural(left.modelId, right.modelId);
}

/** A new array of the descriptors in canonical order (stable). */
export function sortCopilotModels(descriptors = []) {
  const list = Array.isArray(descriptors) ? descriptors.filter((entry) => modelIdOf(entry)) : [];
  return list
    .map((descriptor, index) => ({ descriptor, index }))
    .sort((a, b) => compareCopilotModels(a.descriptor, b.descriptor) || a.index - b.index)
    .map((entry) => entry.descriptor);
}

/**
 * `modelId → catalogIndex` over the canonical order. Duplicate ids keep the
 * first position; the map is what a relay writes into sort_order.
 */
export function copilotCatalogIndexByModel(descriptors = []) {
  const indexByModel = new Map();
  for (const descriptor of sortCopilotModels(descriptors)) {
    const modelId = modelIdOf(descriptor);
    if (!indexByModel.has(modelId)) indexByModel.set(modelId, indexByModel.size);
  }
  return indexByModel;
}
