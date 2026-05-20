'use strict';

export function createSessionDiscoveryService({ fs, path, resolveSessionStateRoot }) {
  const DISCOVERY_CACHE_TTL_MS = 3000;
  let discoveryCache = {
    at: 0,
    sessions: [],
  };

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
      const statTarget = fs.existsSync(eventsPath) ? eventsPath : sessionDir;

      let updatedAtIso = null;
      try {
        const st = fs.statSync(statTarget);
        updatedAtIso = new Date(st.mtimeMs || st.mtime || Date.now()).toISOString();
      } catch {
        updatedAtIso = new Date().toISOString();
      }

      sessions.push({
        sdkSessionId: sessionId,
        updatedAt: updatedAtIso,
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
