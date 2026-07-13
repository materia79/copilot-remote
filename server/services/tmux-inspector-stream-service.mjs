'use strict';

import { execFileSync, spawn } from 'child_process';
import {
  isTmuxAvailable,
  normalizeTmuxSessionName,
  tmuxSessionExists,
} from './session-worker-launch-service.mjs';

function normalizeSessionId(value) {
  const text = String(value || '').trim();
  return text || '';
}

function normalizeWatcherId(value) {
  const text = String(value || '').trim();
  return text || '';
}

function normalizeLineCount(value, fallback = 1000) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const whole = Math.trunc(n);
  if (whole < 50) return 50;
  if (whole > 20_000) return 20_000;
  return whole;
}

function normalizeIntervalMs(value, fallback = 700) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const whole = Math.trunc(n);
  if (whole < 200) return 200;
  if (whole > 5_000) return 5_000;
  return whole;
}

function normalizeCols(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const whole = Math.trunc(n);
  if (whole < 80 || whole > 400) return null;
  return whole;
}

function normalizeRows(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const whole = Math.trunc(n);
  if (whole < 24 || whole > 120) return null;
  return whole;
}

function computeChunk(previousText, nextText) {
  const previous = String(previousText || '');
  const next = String(nextText || '');
  if (next === previous) return null;
  if (!previous) return { kind: 'snapshot', data: next };
  if (next.startsWith(previous)) {
    return { kind: 'delta', data: next.slice(previous.length) };
  }
  return { kind: 'reset', data: next };
}

function createTmuxCaptureReader({
  execFileSyncImpl = execFileSync,
} = {}) {
  return function readCapture(sessionName, {
    historyLines = 1000,
  } = {}) {
    const output = execFileSyncImpl('tmux', [
      'capture-pane',
      '-p',
      '-e',
      '-J',
      '-S',
      `-${normalizeLineCount(historyLines, 1000)}`,
      '-t',
      sessionName,
    ], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return String(output || '');
  };
}

export function createTmuxInspectorStreamService({
  platform = process.platform,
  execFileSyncImpl = execFileSync,
  spawnImpl = spawn,
  tmuxAvailable = null,
  historyLines = 1200,
  pollIntervalMs = 700,
  watchdogIntervalMs = 1000,
  preferByteStream = platform !== 'win32',
  isSessionAllowed = () => ({ ok: true }),
  nowIso = () => new Date().toISOString(),
} = {}) {
  const readCapture = createTmuxCaptureReader({ execFileSyncImpl });
  const watchersBySession = new Map();
  const sessionByWatcher = new Map();
  const streamBySession = new Map();
  const lines = normalizeLineCount(historyLines, 1200);
  const intervalMs = normalizeIntervalMs(pollIntervalMs, 700);
  const watchdogMs = normalizeIntervalMs(watchdogIntervalMs, 1000);

  const tmuxReady = tmuxAvailable === null
    ? isTmuxAvailable({ platform, execFileSyncImpl })
    : (tmuxAvailable === true);

  function emitStatusToSession(sdkSessionId, payload = {}) {
    const sid = normalizeSessionId(sdkSessionId);
    if (!sid) return;
    const watcherMap = watchersBySession.get(sid);
    if (!watcherMap || watcherMap.size === 0) return;
    for (const watcher of watcherMap.values()) {
      try {
        watcher?.onStatus?.({
          type: 'tmux_inspector_status',
          sdkSessionId: sid,
          timestamp: nowIso(),
          ...payload,
        });
      } catch {
        // watcher callbacks are isolated
      }
    }
  }

  function emitChunkToSession(sdkSessionId, payload = {}) {
    const sid = normalizeSessionId(sdkSessionId);
    if (!sid) return;
    const watcherMap = watchersBySession.get(sid);
    if (!watcherMap || watcherMap.size === 0) return;
    for (const watcher of watcherMap.values()) {
      try {
        watcher?.onChunk?.({
          type: 'tmux_inspector_chunk',
          sdkSessionId: sid,
          timestamp: nowIso(),
          ...payload,
        });
      } catch {
        // watcher callbacks are isolated
      }
    }
  }

  function clearStream(sdkSessionId) {
    const sid = normalizeSessionId(sdkSessionId);
    if (!sid) return;
    const stream = streamBySession.get(sid);
    if (stream?.watchdogTimer) {
      clearInterval(stream.watchdogTimer);
    }
    if (stream?.timer) {
      clearInterval(stream.timer);
    }
    if (stream?.process && typeof stream.process.kill === 'function') {
      stream.closing = true;
      try {
        stream.process.kill('SIGTERM');
      } catch {}
    }
    streamBySession.delete(sid);
  }

  function stopWatchingSession(sdkSessionId, { reason = 'watch-stopped', code = null } = {}) {
    const sid = normalizeSessionId(sdkSessionId);
    if (!sid) return;
    clearStream(sid);
    const watcherMap = watchersBySession.get(sid);
    if (!watcherMap || watcherMap.size === 0) return;
    emitStatusToSession(sid, {
      state: 'ended',
      reason,
      code,
    });
  }

  function pollSession(sdkSessionId) {
    const sid = normalizeSessionId(sdkSessionId);
    if (!sid) return;
    const watcherMap = watchersBySession.get(sid);
    if (!watcherMap || watcherMap.size === 0) {
      clearStream(sid);
      return;
    }

    const allowed = isSessionAllowed(sid);
    if (!allowed?.ok) {
      stopWatchingSession(sid, {
        reason: allowed?.reason || 'session-not-allowed',
        code: allowed?.code || 'session-not-allowed',
      });
      return;
    }

    const sessionName = normalizeTmuxSessionName(sid);
    if (!tmuxSessionExists(sessionName, { execFileSyncImpl })) {
      stopWatchingSession(sid, {
        reason: 'tmux-session-not-found',
        code: 'tmux-session-not-found',
      });
      return;
    }

    const stream = streamBySession.get(sid);
    if (!stream) return;

    let nextSnapshot = '';
    try {
      nextSnapshot = readCapture(sessionName, { historyLines: lines });
    } catch {
      stopWatchingSession(sid, {
        reason: 'tmux-capture-failed',
        code: 'tmux-capture-failed',
      });
      return;
    }

    const chunk = computeChunk(stream.lastSnapshot, nextSnapshot);
    stream.lastSnapshot = nextSnapshot;
    if (!chunk?.data) return;
    emitChunkToSession(sid, {
      chunkKind: chunk.kind,
      data: chunk.data,
    });
  }

  function watchSessionHealth(sdkSessionId) {
    const sid = normalizeSessionId(sdkSessionId);
    if (!sid) return false;
    const watcherMap = watchersBySession.get(sid);
    if (!watcherMap || watcherMap.size === 0) {
      clearStream(sid);
      return false;
    }
    const allowed = isSessionAllowed(sid);
    if (!allowed?.ok) {
      stopWatchingSession(sid, {
        reason: allowed?.reason || 'session-not-allowed',
        code: allowed?.code || 'session-not-allowed',
      });
      return false;
    }
    const sessionName = normalizeTmuxSessionName(sid);
    if (!tmuxSessionExists(sessionName, { execFileSyncImpl })) {
      stopWatchingSession(sid, {
        reason: 'tmux-session-not-found',
        code: 'tmux-session-not-found',
      });
      return false;
    }
    return true;
  }

  function ensureWatchdog(sdkSessionId) {
    const sid = normalizeSessionId(sdkSessionId);
    if (!sid) return;
    const stream = streamBySession.get(sid);
    if (!stream || stream.watchdogTimer) return;
    const watchdogTimer = setInterval(() => {
      watchSessionHealth(sid);
    }, watchdogMs);
    if (typeof watchdogTimer.unref === 'function') watchdogTimer.unref();
    stream.watchdogTimer = watchdogTimer;
  }

  function ensureSessionByteStream(sdkSessionId, sessionName) {
    const sid = normalizeSessionId(sdkSessionId);
    if (!sid) return false;
    if (streamBySession.has(sid)) return true;
    if (!preferByteStream || platform === 'win32') return false;
    const child = spawnImpl('script', [
      '-q',
      '-f',
      '/dev/null',
      'tmux',
      'attach-session',
      '-r',
      '-t',
      sessionName,
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stream = {
      mode: 'byte',
      process: child,
      closing: false,
      watchdogTimer: null,
    };
    streamBySession.set(sid, stream);
    ensureWatchdog(sid);

    if (child.stdout) {
      child.stdout.on('data', (chunk) => {
        const data = String(chunk || '');
        if (!data) return;
        emitChunkToSession(sid, {
          chunkKind: 'byte',
          data,
        });
      });
    }

    const onByteStreamEnded = () => {
      const current = streamBySession.get(sid);
      if (!current || current !== stream) return;
      const hadWatchers = (watchersBySession.get(sid)?.size || 0) > 0;
      clearStream(sid);
      if (!hadWatchers) return;
      const sessionStillHealthy = watchSessionHealth(sid);
      if (!sessionStillHealthy) return;
      // Byte stream failed while session remains healthy; degrade to snapshot polling.
      ensureSessionPolling(sid);
      emitStatusToSession(sid, {
        state: 'stream-fallback',
        reason: 'byte-stream-ended-falling-back-to-snapshot',
        code: 'byte-stream-ended',
      });
    };

    child.on('error', onByteStreamEnded);
    child.on('exit', () => {
      if (stream.closing) return;
      onByteStreamEnded();
    });
    return true;
  }

  function ensureSessionPolling(sdkSessionId) {
    const sid = normalizeSessionId(sdkSessionId);
    if (!sid) return;
    if (streamBySession.has(sid)) return;
    const timer = setInterval(() => pollSession(sid), intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
    streamBySession.set(sid, {
      mode: 'snapshot',
      timer,
      lastSnapshot: '',
      watchdogTimer: null,
    });
    ensureWatchdog(sid);
  }

  function attach({
    sdkSessionId,
    watcherId,
    onChunk = () => {},
    onStatus = () => {},
  } = {}) {
    const sid = normalizeSessionId(sdkSessionId);
    const wid = normalizeWatcherId(watcherId);
    if (!sid) return { ok: false, code: 'missing-session-id', reason: 'Missing sdkSessionId' };
    if (!wid) return { ok: false, code: 'missing-watcher-id', reason: 'Missing watcher id' };
    if (!tmuxReady) {
      return { ok: false, code: 'tmux-unavailable', reason: 'tmux is unavailable on this relay host' };
    }

    const allowed = isSessionAllowed(sid);
    if (!allowed?.ok) {
      return {
        ok: false,
        code: allowed?.code || 'session-not-allowed',
        reason: allowed?.reason || 'Session is not active in the relay',
      };
    }

    const sessionName = normalizeTmuxSessionName(sid);
    if (!tmuxSessionExists(sessionName, { execFileSyncImpl })) {
      return {
        ok: false,
        code: 'tmux-session-not-found',
        reason: `tmux session "${sid}" was not found`,
      };
    }

    let snapshot = '';
    try {
      snapshot = readCapture(sessionName, { historyLines: lines });
    } catch (error) {
      return {
        ok: false,
        code: 'tmux-capture-failed',
        reason: String(error?.message || 'Failed to capture tmux pane'),
      };
    }

    const existingSessionId = sessionByWatcher.get(wid);
    if (existingSessionId && existingSessionId !== sid) {
      detach({ sdkSessionId: existingSessionId, watcherId: wid });
    }

    let watcherMap = watchersBySession.get(sid);
    if (!watcherMap) {
      watcherMap = new Map();
      watchersBySession.set(sid, watcherMap);
    }
    watcherMap.set(wid, { onChunk, onStatus });
    sessionByWatcher.set(wid, sid);
    if (!ensureSessionByteStream(sid, sessionName)) {
      ensureSessionPolling(sid);
    }

    const stream = streamBySession.get(sid);
    if (stream?.mode === 'snapshot') {
      stream.lastSnapshot = snapshot;
    }

    return {
      ok: true,
      sdkSessionId: sid,
      snapshot,
      watcherCount: watcherMap.size,
      code: 'attached',
    };
  }

  function detach({
    sdkSessionId,
    watcherId,
  } = {}) {
    const sid = normalizeSessionId(sdkSessionId);
    const wid = normalizeWatcherId(watcherId);
    if (!sid || !wid) return { ok: false, removed: false };
    const watcherMap = watchersBySession.get(sid);
    if (!watcherMap) return { ok: true, removed: false };
    const removed = watcherMap.delete(wid);
    if (sessionByWatcher.get(wid) === sid) {
      sessionByWatcher.delete(wid);
    }
    if (watcherMap.size === 0) {
      watchersBySession.delete(sid);
      clearStream(sid);
    }
    return {
      ok: true,
      removed,
      watcherCount: watcherMap.size,
    };
  }

  function detachWatcher(watcherId) {
    const wid = normalizeWatcherId(watcherId);
    if (!wid) return 0;
    const sid = sessionByWatcher.get(wid);
    if (!sid) return 0;
    const result = detach({ sdkSessionId: sid, watcherId: wid });
    return result?.removed ? 1 : 0;
  }

  function isWatcherAttached({ sdkSessionId, watcherId } = {}) {
    const sid = normalizeSessionId(sdkSessionId);
    const wid = normalizeWatcherId(watcherId);
    if (!sid || !wid) return false;
    const watcherMap = watchersBySession.get(sid);
    return watcherMap instanceof Map && watcherMap.has(wid);
  }

  function resizeSession({
    sdkSessionId,
    watcherId,
    cols,
    rows,
  } = {}) {
    const sid = normalizeSessionId(sdkSessionId);
    const wid = normalizeWatcherId(watcherId);
    const nextCols = normalizeCols(cols);
    const nextRows = normalizeRows(rows);
    if (!sid) return { ok: false, code: 'missing-session-id', reason: 'Missing sdkSessionId' };
    if (!wid) return { ok: false, code: 'missing-watcher-id', reason: 'Missing watcher id' };
    if (!nextCols || !nextRows) {
      return { ok: false, code: 'invalid-size', reason: 'Invalid terminal size' };
    }
    if (!isWatcherAttached({ sdkSessionId: sid, watcherId: wid })) {
      return { ok: false, code: 'not-attached', reason: 'Watcher is not attached to session' };
    }
    if (!tmuxReady) {
      return { ok: false, code: 'tmux-unavailable', reason: 'tmux unavailable' };
    }
    const sessionName = normalizeTmuxSessionName(sid);
    if (!tmuxSessionExists(sessionName, { execFileSyncImpl })) {
      return { ok: false, code: 'tmux-session-not-found', reason: 'tmux session not found' };
    }
    try {
      execFileSyncImpl('tmux', [
        'resize-window',
        '-t',
        sessionName,
        '-x',
        String(nextCols),
        '-y',
        String(nextRows),
      ], {
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      return {
        ok: true,
        code: 'resized',
        cols: nextCols,
        rows: nextRows,
      };
    } catch (error) {
      return {
        ok: false,
        code: 'tmux-resize-failed',
        reason: String(error?.message || 'tmux resize failed'),
      };
    }
  }

  function stopAll() {
    for (const sid of streamBySession.keys()) {
      clearStream(sid);
    }
    streamBySession.clear();
    watchersBySession.clear();
    sessionByWatcher.clear();
  }

  function status() {
    const sessions = [];
    let watcherCount = 0;
    for (const [sdkSessionId, watchers] of watchersBySession.entries()) {
      const count = watchers.size;
      watcherCount += count;
      sessions.push({
        sdkSessionId,
        watcherCount: count,
      });
    }
    return {
      enabled: tmuxReady,
      watchedSessionCount: sessions.length,
      watcherCount,
      sessions,
    };
  }

  return {
    attach,
    detach,
    detachWatcher,
    isWatcherAttached,
    resizeSession,
    stopWatchingSession,
    pollNow: (sdkSessionId) => pollSession(sdkSessionId),
    stopAll,
    status,
  };
}
