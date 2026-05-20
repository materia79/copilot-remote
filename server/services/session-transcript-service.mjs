'use strict';

export function createSessionTranscriptService({ fs, path, resolveSessionStateRoot }) {
  const TRANSCRIPT_CACHE_MAX = 128;
  const transcriptCache = new Map();

  function cacheTranscript(sessionId, record) {
    transcriptCache.set(sessionId, record);
    if (transcriptCache.size <= TRANSCRIPT_CACHE_MAX) return;
    let oldestKey = null;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [key, value] of transcriptCache.entries()) {
      const at = Number(value?.cachedAt || 0);
      if (at < oldestAt) {
        oldestAt = at;
        oldestKey = key;
      }
    }
    if (oldestKey) transcriptCache.delete(oldestKey);
  }

  function limitMessages(messages, limit) {
    if (messages.length <= limit) return messages;
    return messages.slice(messages.length - limit);
  }

  function appendTurnActivity(map, turnId, text) {
    const key = String(turnId || '').trim();
    const value = String(text || '').trim();
    if (!key || !value) return;
    const list = map.get(key) || [];
    if (list[list.length - 1] === value) {
      map.set(key, list);
      return;
    }
    list.push(value);
    map.set(key, list);
  }

  function parseApplyPatchTarget(rawPatch) {
    const patch = String(rawPatch || '');
    if (!patch) return '';
    const match =
      patch.match(/^\*\*\* Update File:\s+(.+)$/m)
      || patch.match(/^\*\*\* Add File:\s+(.+)$/m)
      || patch.match(/^\*\*\* Delete File:\s+(.+)$/m)
      || patch.match(/^\*\*\* Move to:\s+(.+)$/m);
    if (!match) return '';
    return String(match[1] || '').trim();
  }

  function summarizeToolDetail(toolName, args, result) {
    const name = String(toolName || '').trim();
    if (!name) return '';
    const a = args && typeof args === 'object' ? args : null;
    const r = result && typeof result === 'object' ? result : null;

    if (name === 'apply_patch') {
      if (typeof args === 'string') {
        const target = parseApplyPatchTarget(args);
        if (target) return target;
      }
      const content = String(r?.content || '').trim();
      const modified = content.match(/Modified\s+\d+\s+file\(s\):\s+(.+)$/m);
      if (modified) return String(modified[1] || '').trim();
      return '';
    }

    if (name === 'view') return String(a?.path || '').trim();
    if (name === 'powershell') return String(a?.description || a?.command || '').trim();
    if (name === 'rg') return String(a?.pattern || '').trim();
    if (name === 'glob') return String(a?.pattern || '').trim();
    if (name === 'sql') return String(a?.description || '').trim();
    if (name === 'ask_user') return String(a?.question || '').trim();
    if (name === 'report_intent') return String(a?.intent || '').trim();
    if (name === 'web_fetch') return String(a?.url || '').trim();
    if (name === 'task') return String(a?.description || '').trim();
    return '';
  }

  function readSessionTranscriptMessages(sessionId, options = {}) {
    const sid = String(sessionId || '').trim();
    if (!sid) return [];
    const limit = Math.max(1, Number(options.limit) || 300);
    const root = resolveSessionStateRoot();
    const eventsPath = path.join(root, sid, 'events.jsonl');
    if (!fs.existsSync(eventsPath)) return [];
    let stat = null;
    try {
      stat = fs.statSync(eventsPath);
    } catch {
      return [];
    }

    const mtimeMs = Number(stat?.mtimeMs || 0);
    const sizeBytes = Number(stat?.size || 0);
    const cached = transcriptCache.get(sid);
    if (cached && cached.mtimeMs === mtimeMs && cached.sizeBytes === sizeBytes) {
      cached.cachedAt = Date.now();
      return limitMessages(cached.messages, limit);
    }

    let content = '';
    try {
      content = fs.readFileSync(eventsPath, 'utf8');
    } catch {
      return [];
    }

    const messages = [];
    const toolNameByCallId = new Map();
    const toolArgsByCallId = new Map();
    const turnActivities = new Map();
    const lines = String(content || '').split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      let event = null;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      const data = event?.data && typeof event.data === 'object' ? event.data : null;
      if (!data) continue;
      const timestamp = String(event?.timestamp || '').trim() || new Date().toISOString();

      if (event.type === 'session.model_change') {
        const turnId = String(data.turnId || '').trim();
        const model = String(data.newModel || data.model || '').trim();
        if (turnId && model) {
          appendTurnActivity(turnActivities, turnId, `Model selected: ${model}`);
        }
        continue;
      }

      if (event.type === 'tool.execution_start') {
        const toolCallId = String(data.toolCallId || '').trim();
        const toolName = String(data.toolName || '').trim();
        if (toolCallId && toolName) {
          toolNameByCallId.set(toolCallId, toolName);
          if (data.arguments !== undefined) {
            toolArgsByCallId.set(toolCallId, data.arguments);
          }
        }
        continue;
      }

      if (event.type === 'tool.execution_complete') {
        const turnId = String(data.turnId || '').trim();
        const toolCallId = String(data.toolCallId || '').trim();
        const toolName = String(toolNameByCallId.get(toolCallId) || data.toolName || '').trim();
        if (!turnId || !toolName || toolName === 'report_intent') continue;
        const detail = summarizeToolDetail(toolName, toolArgsByCallId.get(toolCallId), data.result);
        appendTurnActivity(turnActivities, turnId, detail ? `Tool (${toolName}): ${detail}` : `Tool (${toolName})`);
        continue;
      }

      if (event.type === 'user.message') {
        const text = String(data.content || '').trim();
        if (!text) continue;
        messages.push({
          id: String(event?.id || data?.interactionId || `user-${messages.length + 1}`),
          role: 'user',
          text,
          timestamp,
        });
        continue;
      }

      if (event.type === 'assistant.message') {
        const text = String(data.content || '').trim();
        if (!text) continue;
        const toolRequests = Array.isArray(data.toolRequests) ? data.toolRequests : [];
        const turnId = String(data.turnId || '').trim();
        if (toolRequests.length > 0) {
          // Preserve user-visible progress notes as foldable activity lines.
          const thoughtText = text.length > 220 ? `${text.slice(0, 217).trim()}...` : text;
          if (turnId) appendTurnActivity(turnActivities, turnId, `Thought: ${thoughtText}`);
          continue;
        }
        const activities = turnId ? (turnActivities.get(turnId) || []) : [];
        messages.push({
          id: String(data.messageId || event?.id || `assistant-${messages.length + 1}`),
          role: 'assistant',
          text,
          model: String(data.model || '').trim() || undefined,
          activities,
          timestamp,
        });
      }
    }

    cacheTranscript(sid, {
      mtimeMs,
      sizeBytes,
      cachedAt: Date.now(),
      messages,
    });
    return limitMessages(messages, limit);
  }

  return {
    readSessionTranscriptMessages,
  };
}
