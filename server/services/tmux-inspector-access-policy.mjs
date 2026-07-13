'use strict';

function normalizeSessionId(value) {
  const text = String(value || '').trim();
  return text || '';
}

function normalizeStatus(value) {
  return String(value || '').trim().toLowerCase();
}

const ACTIVE_WORKER_STATUSES = new Set(['starting', 'ready', 'processing']);

export function isActiveWorkerStatus(value) {
  return ACTIVE_WORKER_STATUSES.has(normalizeStatus(value));
}

export function createTmuxInspectorAccessPolicy({
  sessionWorkerRegistry = null,
  sessionWorkerSupervisor = null,
} = {}) {
  function getWorkerState(sdkSessionId) {
    const sid = normalizeSessionId(sdkSessionId);
    if (!sid) return null;
    return sessionWorkerRegistry?.getWorker?.(sid)
      || sessionWorkerSupervisor?.getWorkerState?.(sid)
      || null;
  }

  function evaluateSession(sdkSessionId) {
    const sid = normalizeSessionId(sdkSessionId);
    if (!sid) {
      return {
        ok: false,
        code: 'missing-session-id',
        reason: 'Missing sdkSessionId',
        sdkSessionId: '',
        worker: null,
      };
    }

    const worker = getWorkerState(sid);
    if (!worker) {
      return {
        ok: false,
        code: 'session-worker-not-found',
        reason: 'Session worker not found',
        sdkSessionId: sid,
        worker: null,
      };
    }

    const status = normalizeStatus(worker.status);
    if (!isActiveWorkerStatus(status)) {
      return {
        ok: false,
        code: 'session-worker-inactive',
        reason: `Session worker is not active (${status || 'unknown'})`,
        sdkSessionId: sid,
        worker,
      };
    }

    return {
      ok: true,
      code: 'ok',
      reason: null,
      sdkSessionId: sid,
      worker,
    };
  }

  return {
    evaluateSession,
  };
}

