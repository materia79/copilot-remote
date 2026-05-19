import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.resolve(__dirname, "../../../../server/config.json");

let sessionSyncFeatureEnabled = null;
let lastSyncedKey = "";

function normalizeId(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function readConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function isSessionSourceOfTruthEnabled() {
  if (sessionSyncFeatureEnabled !== null) return sessionSyncFeatureEnabled;

  const config = readConfig();
  const features = config?.features || config?.FEATURES || {};
  sessionSyncFeatureEnabled = Boolean(features?.sdkSessionSourceOfTruth);
  return sessionSyncFeatureEnabled;
}

export async function syncSessionToServer(sdkSessionId, conversationId, apiClient) {
  if (!isSessionSourceOfTruthEnabled()) {
    return false;
  }

  const sessionId = normalizeId(sdkSessionId);
  if (!sessionId || typeof apiClient !== "function") {
    return false;
  }

  const nextConversationId = normalizeId(conversationId);
  const syncKey = `${sessionId}::${nextConversationId || ""}`;
  if (syncKey === lastSyncedKey) {
    return true;
  }

  await apiClient("POST", "/api/session-sync", {
    sdk_session_id: sessionId,
    conversation_id: nextConversationId,
  });

  lastSyncedKey = syncKey;
  return true;
}
