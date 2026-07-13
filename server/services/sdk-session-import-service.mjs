'use strict';

function text(value) {
  return String(value || '').trim();
}

function iso(value, fallback) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
}

function sessionIdOf(session) {
  return text(session?.sessionId || session?.id || session?.session_id);
}

function sessionTitle(session, messages) {
  const metadata = session?.metadata || session || {};
  const summary = text(metadata.summary || metadata.title || metadata.name);
  if (summary) return summary.slice(0, 240);
  const firstUser = (Array.isArray(messages) ? messages : []).find((message) => message?.role === 'user');
  return text(firstUser?.text).replace(/\s+/g, ' ').slice(0, 240) || 'Session';
}

async function normalizeEvents(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.sessions)) return value.sessions;
  if (Array.isArray(value?.events)) return value.events;
  if (value?.[Symbol.asyncIterator]) {
    const events = [];
    for await (const event of value) events.push(event);
    return events;
  }
  if (value?.[Symbol.iterator]) return [...value];
  return [];
}

function boundedError(error) {
  return text(error?.message || error).slice(0, 1000) || 'Unknown SDK session import failure';
}

export function createSdkSessionImportService({
  db,
  stmts,
  createClient,
  parseSessionEventsToMessages,
  replaceRetrievableHistory,
  ensureRuntimeSessionBinding,
  logger = console,
} = {}) {
  if (!db || !stmts || typeof createClient !== 'function') throw new Error('SDK session importer requires database, statements, and a client factory');
  let runtime = null;
  let activeRun = null;

  const upsertConversation = db.prepare(`
    INSERT INTO conversations (id, title, sdk_session_id, configured_workspace_root_path, runtime_workspace_root_path, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      sdk_session_id = excluded.sdk_session_id,
      title = CASE WHEN conversations.title_source = 'manual' THEN conversations.title ELSE excluded.title END,
      configured_workspace_root_path = COALESCE(conversations.configured_workspace_root_path, excluded.configured_workspace_root_path),
      runtime_workspace_root_path = COALESCE(conversations.runtime_workspace_root_path, excluded.runtime_workspace_root_path),
      updated_at = excluded.updated_at
  `);

  async function getRuntime() {
    if (!runtime) runtime = await createClient();
    return runtime;
  }

  function isTombstoned(sdkSessionId) {
    return !!stmts.getDeletedSdkSession.get(sdkSessionId);
  }

  function claim(sdkSessionId, { force = false } = {}) {
    const now = new Date().toISOString();
    return db.transaction(() => {
      const existing = stmts.getSdkSessionImport.get(sdkSessionId);
      if (!force && existing?.status === 'completed') return null;
      stmts.upsertSdkSessionImport.run(sdkSessionId, existing?.conversation_id || sdkSessionId, now);
      const claimed = stmts.claimSdkSessionImport.run(now, now, sdkSessionId, force ? 1 : 0);
      return claimed.changes > 0 ? stmts.getSdkSessionImport.get(sdkSessionId) : null;
    })();
  }

  function persistCompletedImport({ sdkSessionId, session, messages }) {
    const now = new Date().toISOString();
    const metadata = session?.metadata || session || {};
    const updatedAt = iso(
      metadata.modifiedTime
      || metadata.modified_time
      || metadata.updatedAt
      || metadata.updated_at
      || session?.modifiedTime
      || session?.updatedAt,
      now,
    );
    const createdAt = iso(
      metadata.startTime
      || metadata.start_time
      || metadata.createdAt
      || metadata.created_at
      || session?.startTime
      || session?.createdAt,
      updatedAt,
    );
    const workspaceRoot = text(metadata.workspaceRootPath || metadata.workspace_root_path || metadata.cwd) || null;
    const title = sessionTitle(session, messages);
    db.transaction(() => {
      upsertConversation.run(sdkSessionId, title, sdkSessionId, workspaceRoot, workspaceRoot, createdAt, updatedAt);
      ensureRuntimeSessionBinding(sdkSessionId, null, updatedAt, sdkSessionId);
      replaceRetrievableHistory(sdkSessionId, messages);
      stmts.completeSdkSessionImport.run(sdkSessionId, now, now, sdkSessionId);
    })();
  }

  async function importSession(session, { force = false } = {}) {
    const sdkSessionId = sessionIdOf(session);
    if (!sdkSessionId) return { status: 'skipped', reason: 'missing-session-id' };
    if (isTombstoned(sdkSessionId)) return { sdkSessionId, status: 'skipped', reason: 'tombstoned' };
    if (!claim(sdkSessionId, { force })) return { sdkSessionId, status: 'skipped', reason: 'completed-or-active' };

    let resumed = null;
    try {
      const client = await getRuntime();
      resumed = await client.client.resumeSession(sdkSessionId, {
        suppressResumeEvent: true,
      });
      const events = await normalizeEvents(await resumed.getEvents());
      const messages = Array.isArray(parseSessionEventsToMessages?.(events)) ? parseSessionEventsToMessages(events) : [];
      persistCompletedImport({ sdkSessionId, session, messages });
      return { sdkSessionId, status: 'completed', messageCount: messages.length };
    } catch (error) {
      stmts.failSdkSessionImport.run(new Date().toISOString(), boundedError(error), sdkSessionId);
      return { sdkSessionId, status: 'failed', error: boundedError(error) };
    } finally {
      try { await resumed?.stop?.(); } catch {}
      try { await resumed?.dispose?.(); } catch {}
    }
  }

  async function runStartupImport() {
    if (activeRun) return activeRun;
    activeRun = (async () => {
      const summary = { listed: 0, completed: 0, failed: 0, skipped: 0 };
      try {
        stmts.resetInterruptedSdkSessionImports.run(new Date().toISOString());
        const client = await getRuntime();
        const sessions = await normalizeEvents(await client.client.listSessions());
        summary.listed = sessions.length;
        for (const session of sessions) {
          const result = await importSession(session);
          summary[result.status] = Number(summary[result.status] || 0) + 1;
        }
      } catch (error) {
        summary.failed += 1;
        summary.error = boundedError(error);
      } finally {
        activeRun = null;
      }
      logger.info?.(`[sdk-session-import] listed=${summary.listed} completed=${summary.completed} failed=${summary.failed} skipped=${summary.skipped}`);
      return summary;
    })();
    return activeRun;
  }

  async function refreshConversation(conversation) {
    const sdkSessionId = text(conversation?.sdk_session_id || conversation?.sdkSessionId || conversation?.id);
    if (!sdkSessionId || isTombstoned(sdkSessionId)) {
      const error = new Error('Conversation not found');
      error.statusCode = 404;
      throw error;
    }
    return importSession({ sessionId: sdkSessionId, metadata: conversation }, { force: true });
  }

  return {
    runStartupImport,
    importSession,
    refreshConversation,
    async dispose() {
      const current = runtime;
      runtime = null;
      await current?.dispose?.();
    },
  };
}
