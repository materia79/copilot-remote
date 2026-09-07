// Cursor models without a 'thinking' parameter (or an 'effort' value of 'none')
// cannot be told to stop reasoning. The relay still sends 'none' on the wire —
// the SDK just receives no reasoning parameter and the model runs its default —
// so the option is labelled for what it does instead of promising an off switch.
export const PROVIDER_DEFAULT_EFFORT_LABEL = 'default';

export function normalizeProviderKey(providerType = '') {
  const key = String(providerType || '').trim().toLowerCase();
  if (key === 'openai-byok') return 'openai';
  if (key === 'openai-image' || key === 'openai-image-byok') return 'openai';
  if (key === 'github-copilot') return 'github';
  return key;
}

export function isReasoningOffUnsupported(catalog = null, providerType = '', modelId = '') {
  const provider = normalizeProviderKey(providerType);
  const model = String(modelId || '').trim().toLowerCase();
  if (!provider || !model) return false;
  return catalog?.reasoningOffUnsupportedByProvider?.[provider]?.[model] === true;
}

// Claude's top tier is a mode, not just more thinking: the session fans out
// multi-agent workflows. It gets a display name and a tooltip so the ladder
// jump in cost/behavior is visible before it is selected.
export const CLAUDE_ULTRACODE_EFFORT = 'ultracode';
export const ULTRACODE_EFFORT_LABEL = 'Ultracode';
export const ULTRACODE_EFFORT_OPTION_TITLE =
  'xhigh effort plus multi-agent workflow orchestration — expect much higher token use';

// Gemini and some OpenAI models offer a rung under "low". It reads like the
// other plain tiers (lowercase, no rename): an "Off"-style label would promise
// a switch the runtime does not have, and Title Case would single it out from
// its neighbours. The tooltip explains the rung instead.
export const MINIMAL_EFFORT = 'minimal';
export const MINIMAL_EFFORT_LABEL = 'minimal';
export const MINIMAL_EFFORT_OPTION_TITLE = 'Lowest reasoning tier this model offers — faster and cheaper than low';

export function reasoningEffortOptionLabel(effort, { reasoningOffUnsupported = false } = {}) {
  const value = String(effort || '').trim().toLowerCase();
  if (!value) return '';
  if (value === 'none' && reasoningOffUnsupported) return PROVIDER_DEFAULT_EFFORT_LABEL;
  if (value === CLAUDE_ULTRACODE_EFFORT) return ULTRACODE_EFFORT_LABEL;
  if (value === MINIMAL_EFFORT) return MINIMAL_EFFORT_LABEL;
  return value;
}

export function reasoningEffortOptionTitle(effort) {
  const value = String(effort || '').trim().toLowerCase();
  if (value === CLAUDE_ULTRACODE_EFFORT) return ULTRACODE_EFFORT_OPTION_TITLE;
  if (value === MINIMAL_EFFORT) return MINIMAL_EFFORT_OPTION_TITLE;
  return '';
}
