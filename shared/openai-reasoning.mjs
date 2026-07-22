export function openAIReasoningEffortsForModel(model = '') {
  const normalized = String(model || '').trim().toLowerCase().replace(/^openai\//, '');
  if (/^gpt-5(?:[.-]|$)/.test(normalized) || /^codex(?:[.-]|$)/.test(normalized)) {
    return ['none', 'low', 'medium', 'high', 'xhigh'];
  }
  if (/^(?:o1|o3|o4)(?:[.-]|$)/.test(normalized)) {
    return ['low', 'medium', 'high'];
  }
  return ['none'];
}
