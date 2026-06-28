'use strict';

function normalizeSessionId(value) {
  const text = String(value || '').trim();
  return text || '';
}

function safeAck(ack, payload) {
  if (typeof ack !== 'function') return;
  try {
    ack(payload);
  } catch {
    // ignore ack failures
  }
}

export function createTmuxInspectorSocketService({
  streamService = null,
  accessPolicy = null,
  logger = console,
  nowIso = () => new Date().toISOString(),
} = {}) {
  if (!streamService) throw new Error('createTmuxInspectorSocketService requires streamService');
  if (!accessPolicy || typeof accessPolicy.evaluateSession !== 'function') {
    throw new Error('createTmuxInspectorSocketService requires accessPolicy.evaluateSession');
  }

  const noop = () => {};
  const logWarn = typeof logger?.warn === 'function' ? logger.warn.bind(logger) : noop;
  const logDebug = typeof logger?.debug === 'function' ? logger.debug.bind(logger) : noop;

  function registerSocket(socket) {
    if (!socket || typeof socket.on !== 'function') return;

    socket.on('tmux_inspector_open', (payload = {}, ack) => {
      const sdkSessionId = normalizeSessionId(payload?.sdkSessionId);
      if (!sdkSessionId) {
        safeAck(ack, {
          ok: false,
          code: 'missing-session-id',
          reason: 'Missing sdkSessionId',
          timestamp: nowIso(),
        });
        return;
      }

      const allowed = accessPolicy.evaluateSession(sdkSessionId);
      if (!allowed?.ok) {
        safeAck(ack, {
          ok: false,
          code: allowed?.code || 'session-not-allowed',
          reason: allowed?.reason || 'Session is not active in the relay',
          sdkSessionId,
          timestamp: nowIso(),
        });
        return;
      }

      const attached = streamService.attach({
        sdkSessionId,
        watcherId: socket.id,
        onChunk: (event) => {
          try {
            socket.emit('tmux_inspector_chunk', event);
          } catch {}
        },
        onStatus: (event) => {
          try {
            socket.emit('tmux_inspector_status', event);
          } catch {}
        },
      });

      if (!attached?.ok) {
        safeAck(ack, {
          ok: false,
          code: attached?.code || 'attach-failed',
          reason: attached?.reason || 'Failed to attach to tmux session',
          sdkSessionId,
          timestamp: nowIso(),
        });
        return;
      }

      logDebug(`[tmux-inspector] attached watcher=${socket.id} session=${sdkSessionId.slice(0, 8)}`);
      safeAck(ack, {
        ok: true,
        code: 'attached',
        sdkSessionId,
        snapshot: attached.snapshot || '',
        watcherCount: attached.watcherCount || 1,
        timestamp: nowIso(),
      });
    });

    socket.on('tmux_inspector_close', (payload = {}, ack) => {
      const sdkSessionId = normalizeSessionId(payload?.sdkSessionId);
      if (!sdkSessionId) {
        const removed = streamService.detachWatcher(socket.id) > 0;
        safeAck(ack, {
          ok: true,
          removed,
          timestamp: nowIso(),
        });
        return;
      }
      const result = streamService.detach({
        sdkSessionId,
        watcherId: socket.id,
      });
      safeAck(ack, {
        ok: true,
        removed: result?.removed === true,
        watcherCount: result?.watcherCount || 0,
        sdkSessionId,
        timestamp: nowIso(),
      });
    });

    socket.on('tmux_inspector_resize', (payload = {}, ack) => {
      const sdkSessionId = normalizeSessionId(payload?.sdkSessionId);
      if (!sdkSessionId) {
        safeAck(ack, {
          ok: false,
          code: 'missing-session-id',
          reason: 'Missing sdkSessionId',
          timestamp: nowIso(),
        });
        return;
      }
      const attached = streamService?.isWatcherAttached?.({
        sdkSessionId,
        watcherId: socket.id,
      }) === true;
      if (!attached) {
        safeAck(ack, {
          ok: false,
          code: 'not-attached',
          reason: 'Watcher is not attached to this tmux session',
          sdkSessionId,
          timestamp: nowIso(),
        });
        return;
      }
      const allowed = accessPolicy.evaluateSession(sdkSessionId);
      if (!allowed?.ok) {
        safeAck(ack, {
          ok: false,
          code: allowed?.code || 'session-not-allowed',
          reason: allowed?.reason || 'Session is not active in the relay',
          sdkSessionId,
          timestamp: nowIso(),
        });
        return;
      }
      const resized = streamService.resizeSession({
        sdkSessionId,
        watcherId: socket.id,
        cols: payload?.cols,
        rows: payload?.rows,
      });
      safeAck(ack, {
        ...resized,
        sdkSessionId,
        timestamp: nowIso(),
      });
    });

    socket.on('disconnect', () => {
      try {
        streamService.detachWatcher(socket.id);
      } catch (error) {
        logWarn(`[tmux-inspector] failed to detach watcher ${socket.id}: ${error?.message || error}`);
      }
    });
  }

  function status() {
    return streamService.status();
  }

  function stop() {
    streamService.stopAll();
  }

  return {
    registerSocket,
    status,
    stop,
  };
}
