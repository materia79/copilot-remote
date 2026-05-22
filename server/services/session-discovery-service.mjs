'use strict';

export function createSessionDiscoveryService({ fs, path, resolveSessionStateRoot }) {
  const DISCOVERY_CACHE_TTL_MS = 3000;
  let discoveryCache = {
    at: 0,
    sessions: [],
  };

  function toIsoOrNull(value) {
    const text = String(value || '').trim();
    if (!text) return null;
    const parsed = new Date(text);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }

  function pickLatestIso(...candidates) {
    let latest = null;
    let latestMs = null;
    for (const candidate of candidates) {
      const iso = toIsoOrNull(candidate);
      if (!iso) continue;
      const ms = Date.parse(iso);
      if (!Number.isFinite(ms)) continue;
      if (latestMs === null || ms > latestMs) {
        latest = iso;
        latestMs = ms;
      }
    }
    return latest;
  }

  function parseWorkspaceYamlMeta(workspaceYamlPath) {
    let content = '';
    try {
      content = String(fs.readFileSync(workspaceYamlPath, 'utf8') || '');
    } catch {
      return { title: null, updatedAt: null };
    }
    if (!content) return { title: null, updatedAt: null };

    const summaryMatch = content.match(/^\s*summary\s*:\s*(.+)\s*$/im);
    const nameMatch = content.match(/^\s*name\s*:\s*(.+)\s*$/im);
    const modifiedMatch = content.match(/^\s*modified\s*:\s*(.+)\s*$/im);
    const updatedAtMatch = content.match(/^\s*updated_at\s*:\s*(.+)\s*$/im);
    const updatedAtCamelMatch = content.match(/^\s*updatedAt\s*:\s*(.+)\s*$/im);
    const raw = String(summaryMatch?.[1] || nameMatch?.[1] || '').trim();
    const rawUpdatedAt = String(modifiedMatch?.[1] || updatedAtMatch?.[1] || updatedAtCamelMatch?.[1] || '').trim();

    const unquoted = raw
      .replace(/^['"]+|['"]+$/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    const unquotedUpdatedAt = rawUpdatedAt
      .replace(/^['"]+|['"]+$/g, '')
      .trim();
    const parsedUpdatedAt = toIsoOrNull(unquotedUpdatedAt);

    return {
      title: unquoted || null,
      updatedAt: parsedUpdatedAt,
    };
  }

  function discoverSessionStateConversations(limit = 200) {
    const now = Date.now();
    const normalizedLimit = Math.max(1, Number(limit) || 200);
    if (discoveryCache.sessions.length > 0 && (now - discoveryCache.at) <= DISCOVERY_CACHE_TTL_MS) {
      return discoveryCache.sessions.slice(0, normalizedLimit);
    }

    const root = resolveSessionStateRoot();
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return [];
    }

    const sessions = [];
    for (const entry of entries) {
      if (!entry?.isDirectory?.()) continue;
      const sessionId = String(entry.name || '').trim();
      if (!sessionId) continue;

      const sessionDir = path.join(root, sessionId);
      const eventsPath = path.join(sessionDir, 'events.jsonl');
      const workspaceYamlPath = path.join(sessionDir, 'workspace.yaml');
      const statTarget = fs.existsSync(eventsPath) ? eventsPath : sessionDir;
      const workspaceMeta = fs.existsSync(workspaceYamlPath)
        ? parseWorkspaceYamlMeta(workspaceYamlPath)
        : { title: null, updatedAt: null };

      let updatedAtIso = null;
      try {
        const st = fs.statSync(statTarget);
        updatedAtIso = new Date(st.mtimeMs || st.mtime || Date.now()).toISOString();
      } catch {
        updatedAtIso = new Date().toISOString();
      }

      sessions.push({
        sdkSessionId: sessionId,
        updatedAt: pickLatestIso(workspaceMeta.updatedAt, updatedAtIso) || new Date().toISOString(),
        title: workspaceMeta.title || 'Session',
      });
    }

    sessions.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    discoveryCache = {
      at: now,
      sessions,
    };
    return sessions.slice(0, normalizedLimit);
  }

  return {
    discoverSessionStateConversations,
  };
}
