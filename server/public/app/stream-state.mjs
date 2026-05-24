export function normalizeStreamSeq(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.max(0, Math.trunc(numeric));
}

export function deriveLatestInFlightStreamEvent(inFlight) {
  const rows = Array.isArray(inFlight?.streamEvents) ? inFlight.streamEvents : [];
  if (!rows.length) return null;
  let latest = null;
  for (const row of rows) {
    const seq = normalizeStreamSeq(row?.seq);
    if (seq === null) continue;
    if (!latest || seq > latest.seq) {
      latest = {
        seq,
        text: String(row?.text || ''),
        done: !!row?.done,
      };
    }
  }
  return latest;
}

export function computeNextRelayStreamState(previousState = null, incoming = null) {
  const previous = previousState && typeof previousState === 'object'
    ? previousState
    : { seq: 0, done: false };
  const nextSeq = normalizeStreamSeq(incoming?.seq);
  const incomingDone = !!incoming?.done;
  if (nextSeq !== null && nextSeq <= Number(previous.seq || 0)) {
    return { accept: false, state: previous };
  }
  if (previous.done && !incomingDone) {
    return { accept: false, state: previous };
  }
  return {
    accept: true,
    state: {
      seq: nextSeq === null ? Number(previous.seq || 0) : nextSeq,
      done: previous.done || incomingDone,
    },
  };
}
