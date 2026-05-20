/**
 * web-relay — Copilot CLI Extension
 *
 * Bridges the web server (localhost:3333) to this CLI session.
 * Polls for queued messages from the browser and submits them to
 * the Copilot agent. Captures responses, forwards clarification
 * questions back to the browser, and posts replies back.
 */
import { joinSession } from "@github/copilot-sdk/extension";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { generateHighEntropyToken } from "./utils/token-generation.mjs";
import { delay, killProcessTree, sleep } from "./utils/process-utils.mjs";
import { resolveRelayPaths, loadTokenFromConfig, loadRelayInstructionsFromFile } from "./runtime/config-loader.mjs";
import { createDebugLogger } from "./runtime/debug-log.mjs";
import { createApiClient } from "./runtime/api-client.mjs";
import {
  formatToolActivity,
  isAskUserTool,
  normalizeActivityText,
  extractQuestionChoices,
  extractQuestionPrompt,
  serializeRequest,
} from "./skills/tool-activity.mjs";
import { buildPromptWithMode } from "./skills/prompt-context.mjs";
import { createQuestionBridge } from "./skills/question-bridge.mjs";
import { createQuestionRoutingHooks } from "./skills/question-routing-hooks.mjs";
import { createHeartbeatController } from "./polling/heartbeat.mjs";
import { createPollingLoop } from "./polling/polling-loop.mjs";
import { createManagedServerLifecycle } from "./server-lifecycle/managed-server.mjs";
import { createModelSwitchingService } from "./model-api/model-switching.mjs";
import { createSessionIoHelpers } from "./runtime/session-io.mjs";
import { createBannerStateStore } from "./runtime/banner-state.mjs";
import { clearSession, registerSession } from "./runtime/session-registry.mjs";
import { syncSessionToServer } from "./runtime/session-sync-bridge.mjs";

const SERVER_URL   = "http://localhost:3333";
const POLL_MS      = 2000;

const TOKEN_FALLBACK = generateHighEntropyToken();

const {
  CONFIG_PATH,
  RELAY_TOOLS_PATH,
  SERVER_DIR,
  LOG_DIR,
  SERVER_LOG_PATH,
  SERVER_ERR_PATH,
} = resolveRelayPaths(import.meta.url);
const SERVER_START_TIMEOUT_MS = 20_000;
const NODE_BIN = process.env.COPILOT_WEB_RELAY_NODE || "node";

const CONFIG_TOKEN = loadTokenFromConfig(CONFIG_PATH);
const TOKEN = CONFIG_TOKEN || TOKEN_FALLBACK;
const TOKEN_WAS_GENERATED = !CONFIG_TOKEN;
const RELAY_TOOL_INSTRUCTIONS = loadRelayInstructionsFromFile(RELAY_TOOLS_PATH);
const QUESTION_WAIT_TIMEOUT_MS = 5 * 60 * 1000;
const QUESTION_POLL_MS = 1500;
const MAX_TOOL_DETAIL_LENGTH = 140;

const MODEL_SNAPSHOT_MIN_INTERVAL_MS = 30_000;
const BANNER_DEDUPE_TTL_MS = 6 * 60 * 60 * 1000;
const BANNER_DEDUPE_COOLDOWN_MS = 15 * 1000;
const { dbg } = createDebugLogger({ logDir: LOG_DIR });
const api = createApiClient({ serverUrl: SERVER_URL, token: TOKEN });
const bannerStateStore = createBannerStateStore({
  stateFilePath: path.resolve(LOG_DIR, "relay-banner-state.json"),
  dbg,
  ttlMs: BANNER_DEDUPE_TTL_MS,
  cooldownMs: BANNER_DEDUPE_COOLDOWN_MS,
});
const buildPromptWithRelayContext = (message) => buildPromptWithMode(message, RELAY_TOOL_INSTRUCTIONS);

const managedServerLifecycle = createManagedServerLifecycle({
  api,
  dbg,
  fs,
  spawn,
  killProcessTree,
  delay,
  token: TOKEN,
  logDir: LOG_DIR,
  serverDir: SERVER_DIR,
  serverLogPath: SERVER_LOG_PATH,
  serverErrPath: SERVER_ERR_PATH,
  nodeBin: NODE_BIN,
  serverStartTimeoutMs: SERVER_START_TIMEOUT_MS,
});

const ensureManagedServer = managedServerLifecycle.ensureManagedServer;
const stopManagedServer = managedServerLifecycle.stopManagedServer;

process.on("exit", () => {
  shutdownStarted = true;
  sessionReady = false;
  clearSession();
  pollingLoopController?.stopPolling?.();
  stopHeartbeat();
  managedServerLifecycle.killManagedProcessTree();
});
process.on("SIGINT", () => {
  void gracefulShutdown("SIGINT");
});
process.on("SIGTERM", () => {
  void gracefulShutdown("SIGTERM");
});

if (!TOKEN) {
  console.warn("[web-relay] No authToken found in server/config.json; API calls will fail until configured.");
}

dbg("extension.mjs loaded, TOKEN:", TOKEN ? TOKEN.slice(0,3)+"***" : "(none)");

// ─── State ────────────────────────────────────────────────────────────────────
let activeMsg       = null;   // the web message currently being processed
let waitingForAI    = false;  // true while the agent is generating a response
let relayTurnActive = false;  // true while processing a relay-originated turn
let sessionReady    = false;
const SEND_TIMEOUT  = 10 * 60_000; // allow human-in-the-loop turns (ask_user) to complete
let heartbeatTimer  = null;
let lastActivityText = "";
let pollingLoopStarted = false;
let activatingRelay = null;
let shutdownStarted = false;
let lastAskUserBridge = null;
let pendingAskUserRequest = null;
let lastRenderedRelayBannerKey = "";
let preferredConversationSessionMode = "isolated";
let warnedConversationModeFallback = false;

let session = null;
let heartbeatController = null;
let pollingLoopController = null;

function getCurrentConversationId() {
  const conversationId = String(activeMsg?.conversationId || "").trim();
  return conversationId || null;
}

function refreshSessionRegistry() {
  const sdkSessionId = String(session?.sessionId || "").trim();
  if (!sdkSessionId) {
    clearSession();
    return null;
  }

  return registerSession(sdkSessionId, getCurrentConversationId());
}

async function syncActiveSession(reason) {
  const activeSession = refreshSessionRegistry();
  if (!activeSession?.sdkSessionId) return false;

  try {
    return await syncSessionToServer(activeSession.sdkSessionId, activeSession.conversationId, api);
  } catch (e) {
    dbg("session sync failed:", reason, e?.message || String(e));
    return false;
  }
}

const sessionIo = createSessionIoHelpers({
  getSession: () => session,
  sleep,
  dbg,
});

const modelSwitchingService = createModelSwitchingService({
  api,
  dbg,
  getSession: () => session,
  modelSnapshotMinIntervalMs: MODEL_SNAPSHOT_MIN_INTERVAL_MS,
});

const getCurrentModelId = modelSwitchingService.getCurrentModelId;
const setModelForMessage = modelSwitchingService.setModelForMessage;
const publishModelSnapshot = modelSwitchingService.publishModelSnapshot;

const questionBridge = createQuestionBridge({
  api,
  dbg,
  sleep,
  questionWaitTimeoutMs: QUESTION_WAIT_TIMEOUT_MS,
  questionPollMs: QUESTION_POLL_MS,
  getActiveMessage: () => activeMsg,
  extractQuestionPrompt,
  extractQuestionChoices,
  serializeRequest,
});

function startHeartbeat() {
  if (!heartbeatController) {
    heartbeatController = createHeartbeatController({
      api,
      pollMs: POLL_MS,
      getSessionReady: () => sessionReady,
      getHeartbeatTimer: () => heartbeatTimer,
      setHeartbeatTimer: (timer) => { heartbeatTimer = timer; },
    });
  }
  heartbeatController.startHeartbeat();
}

function stopHeartbeat() {
  heartbeatController?.stopHeartbeat();
}

async function startPolling() {
  if (!pollingLoopController) {
    pollingLoopController = createPollingLoop({
      sleep,
      pollMs: POLL_MS,
      api,
      dbg,
      session,
      sendTimeout: SEND_TIMEOUT,
      publishModelSnapshot,
      setModelForMessage,
      buildPromptWithRelayContext,
      sendAndWaitWithHardTimeout,
      extractFinalText,
      getLastActivityText: () => lastActivityText,
      getCurrentModelId,
      getPreferredConversationSessionMode: () => preferredConversationSessionMode,
      getSupportsIsolatedSessions: () => false,
      getWarnedConversationModeFallback: () => warnedConversationModeFallback,
      setWarnedConversationModeFallback: (value) => { warnedConversationModeFallback = value; },
      getPollingLoopStarted: () => pollingLoopStarted,
      setPollingLoopStarted: (value) => { pollingLoopStarted = value; },
      getSessionReady: () => sessionReady,
      getWaitingForAI: () => waitingForAI,
      getLastAskUserBridge: () => lastAskUserBridge,
      setActiveMsg: (value) => { activeMsg = value; },
      setWaitingForAI: (value) => { waitingForAI = value; },
      setRelayTurnActive: (value) => { relayTurnActive = value; },
      setLastActivityText: (value) => { lastActivityText = value; },
      setLastAskUserBridge: (value) => { lastAskUserBridge = value; },
      getPendingAskUserRequest: () => pendingAskUserRequest,
      setPendingAskUserRequest: (value) => { pendingAskUserRequest = value; },
      extractQuestionPrompt,
      extractQuestionChoices,
    });
  }

  await pollingLoopController.startPolling();
}

async function forwardRelayQuestion(request) {
  return questionBridge.forwardRelayQuestion(request);
}

const questionRoutingHooks = createQuestionRoutingHooks({
  api,
  dbg,
  forwardRelayQuestion,
  isAskUserTool,
  normalizeActivityText,
  formatToolActivity,
  extractQuestionChoices,
  maxToolDetailLength: MAX_TOOL_DETAIL_LENGTH,
  getRelayTurnActive: () => relayTurnActive,
  getActiveMessage: () => activeMsg,
  setLastAskUserBridge: (value) => {
    lastAskUserBridge = value;
  },
  getLastActivityText: () => lastActivityText,
  setLastActivityText: (value) => {
    lastActivityText = value;
  },
  setPendingAskUserRequest: (value) => {
    pendingAskUserRequest = value;
  },
});

async function requeueActiveMessage(reason) {
  if (!waitingForAI || !activeMsg?.id) return false;
  const messageId = activeMsg.id;
  dbg("re-queue active relay message", `msgId=${messageId}`, `reason=${reason}`);
  try {
    await api("POST", "/api/requeue", { messageId });
    return true;
  } catch (e) {
    dbg("re-queue active relay message failed", `msgId=${messageId}`, e?.message || String(e));
    return false;
  }
}

async function gracefulShutdown(reason) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  dbg("graceful shutdown", reason);
  pollingLoopController?.stopPolling?.();
  stopHeartbeat();
  sessionReady = false;
  clearSession();
  await Promise.race([
    requeueActiveMessage(reason),
    sleep(500).then(() => false),
  ]).catch(() => false);
  await stopManagedServer();
  await api("POST", "/api/heartbeat", {}).catch(() => {});
}

function relayBannerCacheKey(readyBanner = null) {
  if (!readyBanner || typeof readyBanner !== "object") return "";
  const parts = [
    String(readyBanner.localUrl || ""),
    String(readyBanner.networkText || ""),
    String(readyBanner.remoteUrl || ""),
    String(readyBanner.pollingUrl || ""),
    String(readyBanner.authText || ""),
    String(readyBanner.listenHost || ""),
  ];
  return parts.join("|");
}

function summarizeRelayConnection(status, readyBanner) {
  const localUrl = String(readyBanner?.localUrl || `${SERVER_URL}/`).trim();
  const networkText = String(
    readyBanner?.networkText
    || (status?.localhostOnly ? "disabled (localhost only)" : `enabled (${String(status?.listenHost || "0.0.0.0")})`)
    || "unavailable"
  ).trim();
  const remoteUrl = String(readyBanner?.remoteUrl || "").trim();
  const authText = `token=${TOKEN}`;
  const pollingUrl = String(readyBanner?.pollingUrl || `${SERVER_URL}/api/pending`).trim();
  return {
    localUrl,
    networkText,
    remoteUrl,
    authText,
    pollingUrl,
  };
}

function buildFallbackReadyBannerFromStatus(status = null) {
  const localUrl = `${SERVER_URL}/`;
  const pollingUrl = `${SERVER_URL}/api/pending`;
  const localhostOnly = status?.localhostOnly === true || String(status?.localhostOnly || "").toLowerCase() === "true";
  const listenHost = String(status?.listenHost || "").trim();
  const networkText = localhostOnly
    ? "disabled (localhost only)"
    : `enabled (${listenHost || "0.0.0.0"})`;

  const tunnelEnabled = status?.sshTunnel?.enabled === true;
  const tunnelHost = String(status?.sshTunnel?.host || "").trim();
  const remoteUrl = tunnelEnabled && tunnelHost ? `https://${tunnelHost.slice(0, 30)}/` : null;
  const authText = `token=${TOKEN}`;

  const fmt = (label, value) => `║  ${String(label || "").padEnd(11)}${String(value || "").padEnd(46)}║`;
  return {
    title: "Copilot Web Proxy  -  Ready",
    localUrl,
    networkUrl: localhostOnly ? null : "(computed from status)",
    networkText,
    remoteUrl,
    authText,
    pollingUrl,
    localhostOnly,
    listenHost: listenHost || (localhostOnly ? "127.0.0.1" : "0.0.0.0"),
    lines: [
      "╔══════════════════════════════════════════════════════════════╗",
      "║         Copilot Web Proxy  -  Ready                         ║",
      "╠══════════════════════════════════════════════════════════════╣",
      fmt("Local:", localUrl),
      fmt("Network:", networkText),
      ...(remoteUrl ? [fmt("Remote:", remoteUrl)] : []),
      fmt("Auth:", authText),
      "╠══════════════════════════════════════════════════════════════╣",
      "║  CLI polling URL (for monitoring mode):                      ║",
      fmt("GET:", pollingUrl),
      "╚══════════════════════════════════════════════════════════════╝",
    ],
  };
}

async function renderRelayReadyBannerFromStatus(status, { force = false } = {}) {
  if (!session) return;
  const readyBanner = status?.readyBanner && typeof status.readyBanner === "object"
    ? status.readyBanner
    : (status && typeof status === "object" ? buildFallbackReadyBannerFromStatus(status) : null);
  if (!readyBanner) {
    await session.log("🌐 Web relay connected (status banner unavailable)", { ephemeral: true });
    return;
  }

  const nextKey = relayBannerCacheKey(readyBanner);
  if (!force && nextKey && nextKey === lastRenderedRelayBannerKey) {
    dbg("relay banner suppressed: in-memory cache key match");
    return;
  }

  const suppress = bannerStateStore.shouldSuppress({
    sessionId: String(session?.sessionId || "").trim() || "unknown",
    bannerKey: nextKey || "fallback-banner",
    token: TOKEN,
    force,
  });
  if (suppress.suppress) {
    dbg("relay banner suppressed:", suppress.reason);
    if (nextKey) lastRenderedRelayBannerKey = nextKey;
    return;
  }

  const info = summarizeRelayConnection(status, readyBanner);
  await session.log("🌐 Web relay connected", { ephemeral: true });
  await session.log(`🏠 Local: ${info.localUrl}`, { ephemeral: true });
  await session.log(`🖧 Network: ${info.networkText}`, { ephemeral: true });
  if (info.remoteUrl) {
    await session.log(`🌍 Remote: ${info.remoteUrl}`, { ephemeral: true });
  }
  await session.log(`🔐 Auth: ${info.authText}`, { ephemeral: true });
  await session.log(`📡 Pending: ${info.pollingUrl}`, { ephemeral: true });

  if (nextKey) {
    lastRenderedRelayBannerKey = nextKey;
  }
  bannerStateStore.markShown({
    sessionId: String(session?.sessionId || "").trim() || "unknown",
    bannerKey: nextKey || "fallback-banner",
    token: TOKEN,
  });
}

// Start the web server as soon as the extension loads so users get relay availability
// even before the SDK session emits onSessionStart.
try {
  await ensureManagedServer();
} catch (e) {
  dbg("managed web server bootstrap failed:", e?.message || String(e));
}

// ─── Join the session ─────────────────────────────────────────────────────────
session = await joinSession({
  // onUserInputRequest must be a TOP-LEVEL property (not inside hooks) so the SDK calls
  // session.registerUserInputHandler() and sends requestUserInput: true to the CLI runtime.
  // When inside hooks it is silently ignored, causing the CLI to show its own terminal prompt.
  onUserInputRequest: async (request) => {
    return questionRoutingHooks.onUserInputRequest(request);
  },
  hooks: {
    onSessionStart: async () => {
      dbg("onSessionStart fired");
      try {
        await ensureRelayActive("onSessionStart");
      } catch (e) {
        await session.log(`⚠️ Web relay activation failed: ${e?.message || String(e)}`, { ephemeral: true });
        dbg("onSessionStart activation failed:", e?.message || String(e));
      }
      try {
        await session.log(`🔐 Web relay token: ${TOKEN}`, { ephemeral: true });
        await session.log(
          TOKEN_WAS_GENERATED
            ? "🔐 Token source: generated for this CLI session"
            : "🔐 Token source: server/config.json",
          { ephemeral: true }
        );
        await session.log("🌐 Web relay loaded — polling http://localhost:3333 every 2 s", { ephemeral: true });
      } catch (e) { dbg("session.log error:", e.message); }
    },
    onPreToolUse: async (request) => {
      return questionRoutingHooks.onPreToolUse(request);
    },
    onSessionEnd: async () => {
      dbg("onSessionEnd fired");
      await gracefulShutdown("onSessionEnd");
    },
  },
});

refreshSessionRegistry();
dbg("copilot session id:", session?.sessionId || "(none)");
dbg("joinSession resolved");
setTimeout(() => {
  ensureRelayActive("post-join-fallback").catch((e) => {
    dbg("post-join fallback activation failed:", e?.message || String(e));
  });
}, 1000);

// ─── Polling loop ─────────────────────────────────────────────────────────────
async function ensureRelayActive(reason) {
  if (shutdownStarted) {
    dbg("ensureRelayActive skipped: shutdown in progress", reason);
    return;
  }
  if (activatingRelay) return activatingRelay;
  activatingRelay = (async () => {
    dbg("ensureRelayActive", reason);
    await ensureManagedServer();
    sessionReady = true;
    await syncActiveSession(reason);
    const status = await api("GET", "/api/status").catch(() => null);
    await renderRelayReadyBannerFromStatus(status, { force: false }).catch((e) => {
      dbg("render relay banner failed:", e?.message || String(e));
    });
    const requestedMode = String(status?.conversationSessionMode || "").trim().toLowerCase();
    preferredConversationSessionMode = requestedMode || "isolated";
    warnedConversationModeFallback = false;
    await api("POST", "/api/relay/recover-processing", { maxAgeMs: status?.processingTimeoutMs || (10 * 60 * 1000) }).catch(() => {});
    await publishModelSnapshot("relay-active", true);
    startHeartbeat();
    startPolling();
    dbg("relay active", reason);
  })().finally(() => {
    activatingRelay = null;
  });
  return activatingRelay;
}

const extractFinalText = sessionIo.extractFinalText;
const sendAndWaitWithHardTimeout = sessionIo.sendAndWaitWithHardTimeout;

