'use strict';

function normalizeInt(value) {
  const num = Number.parseInt(String(value || ''), 10);
  return Number.isInteger(num) && num > 0 ? num : null;
}

function normalizeText(value) {
  const text = String(value || '').trim();
  return text || null;
}

function identitiesMatch(owner, identity) {
  if (!owner || !identity) return false;
  if (owner.pid && identity.pid) return owner.pid === identity.pid;
  if (owner.sessionId && identity.sessionId) return owner.sessionId === identity.sessionId;
  return false;
}

export function createRelayBridgeOwnerService({ staleMs = 10_000, now = () => Date.now() } = {}) {
  let owner = null;

  function normalizeIdentity(raw = null) {
    if (!raw || typeof raw !== 'object') return null;
    const identity = {
      pid: normalizeInt(raw.pid),
      parentPid: normalizeInt(raw.parentPid),
      sessionId: normalizeText(raw.sessionId),
      conversationId: normalizeText(raw.conversationId),
    };
    if (!identity.pid && !identity.sessionId) return null;
    return identity;
  }

  function isOwnerStale(current = owner) {
    if (!current?.lastSeenAt) return true;
    const lastSeenMs = new Date(current.lastSeenAt).getTime();
    if (!Number.isFinite(lastSeenMs)) return true;
    return (now() - lastSeenMs) > staleMs;
  }

  function observe(rawIdentity, { allowTakeover = false } = {}) {
    const identity = normalizeIdentity(rawIdentity);
    if (!identity) {
      return { accepted: false, adopted: false, owner: owner ? { ...owner } : null };
    }

    const sameOwner = identitiesMatch(owner, identity);
    const adopt = !owner || sameOwner || allowTakeover || isOwnerStale(owner);
    if (!adopt) {
      return { accepted: false, adopted: false, owner: owner ? { ...owner } : null };
    }

    owner = {
      ...owner,
      ...identity,
      lastSeenAt: new Date(now()).toISOString(),
    };
    return { accepted: true, adopted: !sameOwner, owner: { ...owner } };
  }

  function isOwner(rawIdentity) {
    const identity = normalizeIdentity(rawIdentity);
    if (!identity || !owner) return false;
    return identitiesMatch(owner, identity);
  }

  function clearOwner() {
    owner = null;
  }

  function getOwner() {
    return owner ? { ...owner } : null;
  }

  return {
    normalizeIdentity,
    observe,
    isOwner,
    isOwnerStale,
    clearOwner,
    getOwner,
  };
}
