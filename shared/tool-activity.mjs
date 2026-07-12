const DEFAULT_MAX_LENGTH = 140;

export function parseToolPayload(value) {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (!text || (!text.startsWith('{') && !text.startsWith('['))) return value;
  try {
    return JSON.parse(text);
  } catch {
    return value;
  }
}

export function normalizeToolActivityText(value, maxLength = DEFAULT_MAX_LENGTH) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.slice(0, Math.max(1, Number(maxLength) || DEFAULT_MAX_LENGTH));
}

function formatToolFieldValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return '';
    }
  }
  return String(value);
}

export function formatStoreMemoryActivity(toolName, args) {
  const parsedArgs = parseToolPayload(args);
  if (!parsedArgs || typeof parsedArgs !== 'object' || Array.isArray(parsedArgs)) return '';
  const fields = ['subject', 'fact', 'citations', 'reason', 'scope']
    .map((key) => {
      const value = formatToolFieldValue(parsedArgs[key]).replace(/\s+/g, ' ').trim();
      return value ? `${key}="${value.replace(/"/g, "'")}"` : '';
    })
    .filter(Boolean);
  if (!fields.length) return `Tool (${String(toolName || 'store_memory').trim() || 'store_memory'})`;
  return `Tool (${String(toolName || 'store_memory').trim() || 'store_memory'}):\n${fields.join('\n')}`;
}

export function formatVoteMemoryActivity(toolName, args) {
  const parsedArgs = parseToolPayload(args);
  if (!parsedArgs || typeof parsedArgs !== 'object' || Array.isArray(parsedArgs)) return '';
  const fields = ['fact', 'direction', 'reason', 'scope']
    .map((key) => {
      const value = formatToolFieldValue(parsedArgs[key]).replace(/\s+/g, ' ').trim();
      return value ? `${key}="${value.replace(/"/g, "'")}"` : '';
    })
    .filter(Boolean);
  if (!fields.length) return `Tool (${String(toolName || 'vote_memory').trim() || 'vote_memory'})`;
  return `Tool (${String(toolName || 'vote_memory').trim() || 'vote_memory'}):\n${fields.join('\n')}`;
}

export function extractToolResultText(value, maxLength = DEFAULT_MAX_LENGTH) {
  const seen = new WeakSet();
  const candidates = [];
  function collect(input) {
    const parsed = parseToolPayload(input);
    if (parsed === null || parsed === undefined) return;
    if (typeof parsed === 'string') {
      const text = normalizeToolActivityText(parsed, maxLength);
      if (text) candidates.push(text);
      return;
    }
    if (typeof parsed !== 'object') return;
    if (seen.has(parsed)) return;
    seen.add(parsed);
    for (const key of ['value', 'text', 'content', 'output_text', 'outputText', 'summary', 'title', 'url']) {
      if (parsed[key] !== undefined) collect(parsed[key]);
    }
    if (Array.isArray(parsed)) {
      for (const item of parsed) collect(item);
    }
  }
  collect(value);
  return candidates.find(Boolean) || '';
}

export function formatToolResultActivity(toolName, result, maxLength = DEFAULT_MAX_LENGTH) {
  const name = String(toolName || '').trim();
  if (!name) return '';
  const lower = name.toLowerCase();
  const text = extractToolResultText(result, maxLength);
  if (!text) return '';
  if (lower.includes('web_search') || lower.includes('web search')) {
    return `Tool (${name}): output="${text.replace(/"/g, "'")}"`;
  }
  if (lower.includes('web_fetch') || lower.includes('web fetch')) {
    return `Tool (${name}): output="${text.replace(/"/g, "'")}"`;
  }
  return '';
}
