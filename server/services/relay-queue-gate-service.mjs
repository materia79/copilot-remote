'use strict';

export function shouldParkForRestart(state) {
  const value = String(state?.state || '').trim();
  return value === 'draining' || value === 'restarting' || value === 'awaiting_rebind';
}

export function parkPendingQueueForRestart({ stmts, state, parkedAt = null } = {}) {
  if (!stmts || !shouldParkForRestart(state)) return 0;
  const result = stmts.parkPendingQueueForRestart.run({
    parkedAt: parkedAt || new Date().toISOString(),
    targetSessionId: state?.targetSessionId || null,
    transactionId: state?.transactionId || null,
    reason: state?.lastError || null,
  });
  return Number(result?.changes || 0);
}

export function releaseParkedQueueForReadyState({ db, stmts, state } = {}) {
  const value = String(state?.state || '').trim();
  const terminalIdle = value === 'idle' && String(state?.terminalOutcomeCode || '').trim();
  if (!db || !stmts || (value !== 'ready' && !terminalIdle)) return [];
  const rows = terminalIdle
    ? stmts.listAllParkedQueueForRelease.all()
    : stmts.listParkedQueueForRelease.all(
      state?.transactionId || null,
      state?.targetSessionId || null,
    );
  if (!rows.length) return [];
  const tx = db.transaction(() => {
    for (const row of rows) {
      stmts.releaseParkedQueueByIds.run(row.id);
    }
  });
  tx();
  return rows;
}

