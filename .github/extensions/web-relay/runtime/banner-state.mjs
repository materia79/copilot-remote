import fs from "fs";
import path from "path";

function normalizePositiveMs(value, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return Math.max(1000, Math.floor(num));
}

function stableHash(text) {
  const input = String(text || "");
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function nowMs() {
  return Date.now();
}

export function createBannerStateStore({
  stateFilePath,
  dbg = () => {},
  ttlMs = 6 * 60 * 60 * 1000,
  cooldownMs = 15 * 1000,
} = {}) {
  const ttl = normalizePositiveMs(ttlMs, 6 * 60 * 60 * 1000);
  const cooldown = normalizePositiveMs(cooldownMs, 15 * 1000);
  const inMemorySeen = new Map();
  let loaded = false;
  let persistedState = { version: 1, entries: {}, updatedAt: 0 };

  function tokenFingerprint(token) {
    return stableHash(String(token || ""));
  }

  function buildEntryKey({ sessionId, bannerKey, token }) {
    const sessionPart = String(sessionId || "unknown");
    const bannerPart = stableHash(String(bannerKey || ""));
    const tokenPart = tokenFingerprint(token);
    return `${sessionPart}|${tokenPart}|${bannerPart}`;
  }

  function pruneEntries(state, currentNow = nowMs()) {
    const entries = state?.entries && typeof state.entries === "object" ? state.entries : {};
    let changed = false;
    for (const [key, seenAt] of Object.entries(entries)) {
      const ts = Number(seenAt);
      if (!Number.isFinite(ts) || ts <= 0 || (currentNow - ts) > ttl) {
        delete entries[key];
        changed = true;
      }
    }
    state.entries = entries;
    if (changed) state.updatedAt = currentNow;
    return changed;
  }

  function loadState() {
    if (loaded) return;
    loaded = true;
    try {
      const raw = fs.readFileSync(stateFilePath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        persistedState = {
          version: Number(parsed.version) || 1,
          entries: parsed.entries && typeof parsed.entries === "object" ? parsed.entries : {},
          updatedAt: Number(parsed.updatedAt) || 0,
        };
      }
      pruneEntries(persistedState);
    } catch {
      persistedState = { version: 1, entries: {}, updatedAt: 0 };
    }
  }

  function saveState() {
    try {
      const dir = path.dirname(String(stateFilePath || ""));
      if (dir) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(stateFilePath, JSON.stringify(persistedState, null, 2), "utf8");
    } catch (error) {
      dbg("banner dedupe state write failed:", error?.message || String(error));
    }
  }

  function shouldSuppress({ sessionId, bannerKey, token, force = false } = {}) {
    if (force) return { suppress: false, reason: "forced" };
    const key = buildEntryKey({ sessionId, bannerKey, token });
    const currentNow = nowMs();
    const memSeenAt = Number(inMemorySeen.get(key));
    if (Number.isFinite(memSeenAt) && (currentNow - memSeenAt) < cooldown) {
      return { suppress: true, reason: "cooldown", key };
    }

    loadState();
    pruneEntries(persistedState, currentNow);
    const persistedSeenAt = Number(persistedState.entries[key]);
    if (Number.isFinite(persistedSeenAt) && (currentNow - persistedSeenAt) < ttl) {
      inMemorySeen.set(key, persistedSeenAt);
      return { suppress: true, reason: "persisted", key };
    }

    return { suppress: false, reason: "new", key };
  }

  function markShown({ sessionId, bannerKey, token } = {}) {
    const key = buildEntryKey({ sessionId, bannerKey, token });
    const currentNow = nowMs();
    inMemorySeen.set(key, currentNow);
    loadState();
    persistedState.entries[key] = currentNow;
    persistedState.updatedAt = currentNow;
    pruneEntries(persistedState, currentNow);
    saveState();
  }

  return {
    shouldSuppress,
    markShown,
  };
}
