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
import { resolveSessionBinding } from "./runtime/session-binding.mjs";
import { createSessionRuntimeManager } from "./runtime/session-runtime-manager.mjs";
import { createBannerStateStore } from "./runtime/banner-state.mjs";
import { clearSession, registerSession } from "./runtime/session-registry.mjs";
import { syncSessionToServer } from "./runtime/session-sync-bridge.mjs";
import { joinSessionWithRetry } from "./runtime/session-join-retry.mjs";
import { evaluateRestartControlGuard } from "./runtime/restart-control-guard.mjs";

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
const RESTART_CONTROL_STARTUP_GRACE_MS = 20_000;
const RESTART_REBIND_FAST_ATTEMPTS = 12;
const RESTART_REBIND_FAST_INTERVAL_MS = 500;
const STARTUP_VERIFICATION_DELAY_MS = 1500;

const MODEL_SNAPSHOT_MIN_INTERVAL_MS = 30_000;
const BANNER_DEDUPE_TTL_MS = 6 * 60 * 60 * 1000;
const BANNER_DEDUPE_COOLDOWN_MS = 15 * 1000;
const { dbg } = createDebugLogger({ logDir: LOG_DIR });
const api = createApiClient({
  serverUrl: SERVER_URL,
  token: TOKEN,
  getHeaders: () => ({
    "X-Relay-Process-Pid": String(process.pid),
    "X-Relay-Parent-Pid": String(process.ppid),
    "X-Relay-Session-Id": String(session?.sessionId || ""),
    "X-Relay-Conversation-Id": String(getCurrentConversationId() || ""),
  }),
});
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
let pollingLoopStarted = false;
let activatingRelay = null;
let shutdownStarted = false;
let lastRenderedRelayBannerKey = "";
let preferredConversationSessionMode = "isolated";
let warnedConversationModeFallback = false;

const relayScopeState = new Map();
let activeRelayScopeKey = null;

let session = null;
let heartbeatController = null;
let pollingLoopController = null;
let restartControlPromise = null;
let startupVerificationTimer = null;
let restartControlGraceUntilMs = 0;
let aggressiveReconnectPromise = null;
const sessionRuntimeManager = createSessionRuntimeManager({
  dbg,
  getSession: () => session,
  setSession: (nextSession) => { session = nextSession || null; },
});

function getCurrentConversationId() {
  const conversationId = String(activeMsg?.conversationId || "").trim();
  return conversationId || null;
}

function normalizeRelayScopeValue(value) {
  const text = String(value || "").trim();
  return text || null;
}

function buildRelayScopeKey({ conversationId, sdkSessionId } = {}) {
  const convId = normalizeRelayScopeValue(conversationId);
  const sessionId = normalizeRelayScopeValue(sdkSessionId);
  if (sessionId && convId) return `${sessionId}::${convId}`;
  if (convId) return `conv::${convId}`;
  if (sessionId) return `sdk::${sessionId}`;
  return null;
}

function getRelayScopeKey() {
  if (activeRelayScopeKey) return activeRelayScopeKey;
  return buildRelayScopeKey({
    conversationId: activeMsg?.conversationId,
    sdkSessionId: session?.sessionId,
  });
}

function ensureRelayScopeState(scopeKey) {
  if (!scopeKey) return null;
  let state = relayScopeState.get(scopeKey);
  if (!state) {
    state = {
      lastActivityText: "",
      lastAskUserBridge: null,
      pendingAskUserRequest: null,
    };
    relayScopeState.set(scopeKey, state);
  }
  return state;
}

function getScopedRelayState() {
  const scopeKey = getRelayScopeKey();
  const state = ensureRelayScopeState(scopeKey);
  return { scopeKey, state };
}

function getScopedLastActivityText() {
  const { state } = getScopedRelayState();
  return state?.lastActivityText || "";
}

function setScopedLastActivityText(value) {
  const { state } = getScopedRelayState();
  if (!state) return;
  state.lastActivityText = String(value || "");
}

function getScopedLastAskUserBridge() {
  const { state } = getScopedRelayState();
  return state?.lastAskUserBridge || null;
}

function setScopedLastAskUserBridge(value) {
  const { state } = getScopedRelayState();
  if (!state) return;
  state.lastAskUserBridge = value || null;
}

function getScopedPendingAskUserRequest() {
  const { state } = getScopedRelayState();
  return state?.pendingAskUserRequest || null;
}

function setScopedPendingAskUserRequest(value) {
  const { state } = getScopedRelayState();
  if (!state) return;
  state.pendingAskUserRequest = value || null;
}

function clearScopedRelayState() {
  const { scopeKey } = getScopedRelayState();
  if (!scopeKey) return;
  relayScopeState.delete(scopeKey);
}

function refreshSessionRegistry() {
  const sdkSessionId = String(session?.sessionId || "").trim();
  if (!sdkSessionId) {
    clearSession();
    return null;
  }

  return registerSession(sdkSessionId, getCurrentConversationId());
}

async function syncActiveSession(reason, forceSync = false) {
  const activeSession = refreshSessionRegistry();
  if (!activeSession?.sdkSessionId || !activeSession?.conversationId) return false;

  try {
    let syncOptions = null;
    const status = await api("GET", "/api/status").catch(() => null);
    const orchestrator = status?.restartOrchestrator || null;
    const orchestratorState = String(orchestrator?.state || "").trim().toLowerCase();
    const orchestratorTargetSessionId = String(orchestrator?.targetSessionId || "").trim();
    const orchestratorTransactionId = String(orchestrator?.transactionId || "").trim();
    if (orchestratorState || orchestratorTargetSessionId || orchestratorTransactionId) {
      const shouldSignalRebind = orchestratorState === "awaiting_rebind"
        && !!orchestratorTargetSessionId
        && orchestratorTargetSessionId === activeSession.sdkSessionId;
      syncOptions = {
        orchestrator: {
          transactionId: orchestratorTransactionId || null,
          targetSessionId: orchestratorTargetSessionId || null,
          rebindCompleted: shouldSignalRebind,
          rebindState: shouldSignalRebind ? "completed" : "observed",
          rebindSignal: shouldSignalRebind ? "extension-session-sync" : `extension-sync-${reason}`,
        },
      };
    }
    return await syncSessionToServer(activeSession.sdkSessionId, activeSession.conversationId, api, forceSync, syncOptions);
  } catch (e) {
    dbg("session sync failed:", reason, e?.message || String(e));
    return false;
  }
}

async function ensureSessionForConversation(conversationId, reason = "dequeue") {
  const convId = String(conversationId || "").trim();
  if (!convId) {
    return {
      ok: false,
      reason: "conversation-id-missing",
      retryable: false,
      message: "Missing conversation id for session binding check",
      activeSessionId: String(session?.sessionId || "").trim() || null,
      targetSessionId: null,
    };
  }

  let details = null;
  try {
    details = await api("GET", `/api/conversation/${encodeURIComponent(convId)}`);
  } catch (error) {
    return {
      ok: false,
      reason: "conversation-load-failed",
      retryable: true,
      message: `Failed to load conversation binding: ${error?.message || String(error)}`,
      activeSessionId: String(session?.sessionId || "").trim() || null,
      targetSessionId: null,
    };
  }

  const binding = resolveSessionBinding({
    conversationId: convId,
    details,
    activeSessionId: String(session?.sessionId || "").trim() || null,
  });
  if (!binding?.ok) {
    if (binding?.reason === "restart-required") {
      const switchResult = await sessionRuntimeManager.activateSession(binding.targetSessionId, reason);
      if (!switchResult?.ok) {
        return switchResult;
      }
      const activeSessionId = String(session?.sessionId || "").trim() || switchResult.targetSessionId;
      registerSession(activeSessionId, convId);
      return {
        ok: true,
        switched: !!switchResult.switched,
        via: switchResult.via || "session.resumeSession",
        activeSessionId,
        targetSessionId: switchResult.targetSessionId || activeSessionId,
      };
    }
    return binding;
  }

  registerSession(binding.activeSessionId, convId);
  return {
    ok: true,
    switched: false,
    via: binding?.via || "restart-orchestrator-binding",
    activeSessionId: binding.activeSessionId,
    targetSessionId: binding.targetSessionId,
  };
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

async function pulseHeartbeat(reason = "unknown") {
  if (!heartbeatController) {
    startHeartbeat();
  }
  const ok = await heartbeatController?.pulseHeartbeat?.();
  if (!ok) {
    dbg("heartbeat pulse failed", reason);
  }
  return !!ok;
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
      getLastActivityText: () => getScopedLastActivityText(),
      getCurrentModelId,
      getPreferredConversationSessionMode: () => preferredConversationSessionMode,
      getSupportsIsolatedSessions: () => false,
      getWarnedConversationModeFallback: () => warnedConversationModeFallback,
      setWarnedConversationModeFallback: (value) => { warnedConversationModeFallback = value; },
      getPollingLoopStarted: () => pollingLoopStarted,
      setPollingLoopStarted: (value) => { pollingLoopStarted = value; },
      getSessionReady: () => sessionReady,
      getWaitingForAI: () => waitingForAI,
      getLastAskUserBridge: () => getScopedLastAskUserBridge(),
      setActiveMsg: (value) => { activeMsg = value; },
      setWaitingForAI: (value) => { waitingForAI = value; },
      setRelayTurnActive: (value, message = null) => {
        relayTurnActive = !!value;
        if (relayTurnActive) {
          activeRelayScopeKey = buildRelayScopeKey({
            conversationId: message?.conversationId || activeMsg?.conversationId,
            sdkSessionId: session?.sessionId,
          });
          ensureRelayScopeState(activeRelayScopeKey);
        } else {
          activeRelayScopeKey = null;
        }
      },
      setLastActivityText: (value) => { setScopedLastActivityText(value); },
      setLastAskUserBridge: (value) => { setScopedLastAskUserBridge(value); },
      getPendingAskUserRequest: () => getScopedPendingAskUserRequest(),
      setPendingAskUserRequest: (value) => { setScopedPendingAskUserRequest(value); },
      clearRelayScopeState: () => { clearScopedRelayState(); },
      syncActiveSession,
      ensureSessionForConversation,
      extractQuestionPrompt,
      extractQuestionChoices,
      handleControl: handleRelayControl,
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
    setScopedLastAskUserBridge(value);
  },
  getLastActivityText: () => getScopedLastActivityText(),
  setLastActivityText: (value) => {
    setScopedLastActivityText(value);
  },
  setPendingAskUserRequest: (value) => {
    setScopedPendingAskUserRequest(value);
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
  if (startupVerificationTimer) {
    clearTimeout(startupVerificationTimer);
    startupVerificationTimer = null;
  }
  pollingLoopController?.stopPolling?.();
  stopHeartbeat();
  sessionReady = false;
  clearSession();
  await Promise.race([
    requeueActiveMessage(reason),
    sleep(500).then(() => false),
  ]).catch(() => false);
  await stopManagedServer();
}

async function announceBridgeExit({ reason = "shutdown", transactionId = null, targetSessionId = null } = {}) {
  try {
    const response = await api("POST", "/api/restart-orchestrator/bridge-exit", {
      reason: String(reason || "shutdown").trim() || "shutdown",
      transactionId: String(transactionId || "").trim() || null,
      targetSessionId: String(targetSessionId || "").trim() || null,
    });
    const orchestratorState = String(response?.restartOrchestrator?.state || "").trim().toLowerCase() || "unknown";
    const launcherStatus = response?.launcher?.state?.status || "none";
    dbg(
      "bridge exit acknowledged",
      `reason=${String(reason || "shutdown").trim() || "shutdown"}`,
      `transaction=${String(transactionId || "").trim() || "none"}`,
      `target=${String(targetSessionId || "").trim() || "none"}`,
      `orchestrator=${orchestratorState}`,
      `launcher=${launcherStatus}`,
    );
    return true;
  } catch (error) {
    dbg("bridge exit announcement failed", error?.message || String(error));
    return false;
  }
}

async function acknowledgeDeferredRestartControl({ control, pendingEnvelope = null } = {}) {
  const targetSessionId = String(control?.targetSessionId || "").trim();
  const transactionId = String(control?.transactionId || "").trim();
  const activeSessionId = String(session?.sessionId || "").trim();
  if (!targetSessionId || !transactionId || !activeSessionId) return false;
  if (activeSessionId !== targetSessionId) return false;

  const conversationId = String(
    pendingEnvelope?.message?.conversationId
    || activeMsg?.conversationId
    || getCurrentConversationId()
    || "",
  ).trim();
  const rebindPayload = {
    sdk_session_id: activeSessionId,
    orchestrator_correlation_id: transactionId,
    orchestrator_target_session_id: targetSessionId,
    rebind_completed: true,
    rebind_signal: "restart-control-guard",
    rebind_state: "ready",
  };
  if (conversationId) {
    rebindPayload.conversation_id = conversationId;
  }

  try {
    const rebind = await api("POST", "/api/restart-orchestrator/rebind", rebindPayload);
    dbg(
      "deferred restart control rebind ack",
      `status=sent`,
      `target=${targetSessionId || "none"}`,
      `transaction=${transactionId || "none"}`,
      `completed=${rebind?.rebind?.completed === true ? "yes" : "no"}`,
      `state=${String(rebind?.restartOrchestrator?.state || "").trim() || "unknown"}`,
    );
    return true;
  } catch (error) {
    dbg("deferred restart control rebind ack failed", error?.message || String(error));
  }

  if (!conversationId) return false;

  try {
    const fallback = await api("POST", "/api/session-sync", rebindPayload);
    dbg(
      "deferred restart control session-sync fallback",
      `status=sent`,
      `target=${targetSessionId || "none"}`,
      `transaction=${transactionId || "none"}`,
      `completed=${fallback?.rebind?.completed === true ? "yes" : "no"}`,
      `state=${String(fallback?.restartOrchestrator?.state || "").trim() || "unknown"}`,
    );
    return true;
  } catch (error) {
    dbg("deferred restart control session-sync fallback failed", error?.message || String(error));
    return false;
  }
}

async function handleRelayControl(control, pendingEnvelope = null) {
  const type = String(control?.type || "").trim().toLowerCase();
  if (type !== "restart_cli") return false;
  const targetSessionId = String(control?.targetSessionId || "").trim();
  const transactionId = String(control?.transactionId || "").trim();
  dbg(
    "restart control ignored (in-process session switching enabled)",
    `target=${targetSessionId || "none"}`,
    `transaction=${transactionId || "none"}`,
  );
  return false;
}

function scheduleStartupVerification(reason, attemptsRemaining = 4) {
  if (shutdownStarted) return;
  if (startupVerificationTimer) {
    clearTimeout(startupVerificationTimer);
    startupVerificationTimer = null;
  }
  const remaining = Math.max(0, Number(attemptsRemaining || 0));
  if (remaining <= 0) return;
  startupVerificationTimer = setTimeout(() => {
    startupVerificationTimer = null;
    void verifyRelayStartup(reason, remaining);
  }, STARTUP_VERIFICATION_DELAY_MS);
}

async function verifyRelayStartup(reason, attemptsRemaining) {
  if (shutdownStarted || !sessionReady) return;
  const remaining = Math.max(0, Number(attemptsRemaining || 0));
  const status = await api("GET", "/api/status").catch(() => null);
  if (status?.cliOnline === true) {
    dbg("startup verification confirmed cliOnline", reason);
    return;
  }
  dbg(
    "startup verification retry",
    reason,
    `remaining=${remaining}`,
    `polling=${pollingLoopStarted ? "started" : "stopped"}`,
  );
  await syncActiveSession(`${reason}-startup-verify`, true).catch(() => false);
  await pulseHeartbeat(`${reason}-startup-verify`);
  startHeartbeat();
  startPolling().catch((error) => {
    dbg("startup verification polling restart failed", error?.message || String(error));
  });
  if (remaining > 1) {
    scheduleStartupVerification(reason, remaining - 1);
  }
}

function buildRestartRebindPayload({ activeSessionId, orchestrator, reason, attempt }) {
  const transactionId = String(orchestrator?.transactionId || "").trim();
  const targetSessionId = String(orchestrator?.targetSessionId || "").trim();
  if (!activeSessionId || !transactionId || !targetSessionId) return null;
  if (targetSessionId !== activeSessionId) return null;
  return {
    sdk_session_id: activeSessionId,
    orchestrator_correlation_id: transactionId,
    orchestrator_target_session_id: targetSessionId,
    rebind_completed: true,
    rebind_signal: `aggressive-reconnect:${reason}:${attempt}`,
    rebind_state: "ready",
  };
}

async function runAggressiveReconnectLoop(reason, initialStatus = null) {
  const activeSessionId = String(session?.sessionId || "").trim();
  if (!activeSessionId) return false;

  let status = initialStatus;
  for (let attempt = 1; attempt <= RESTART_REBIND_FAST_ATTEMPTS; attempt += 1) {
    if (shutdownStarted || !sessionReady) return false;
    if (!status) {
      status = await api("GET", "/api/status").catch(() => null);
    }
    const orchestrator = status?.restartOrchestrator || null;
    const state = String(orchestrator?.state || "").trim().toLowerCase();
    const transactionId = String(orchestrator?.transactionId || "").trim();
    const targetSessionId = String(orchestrator?.targetSessionId || "").trim();
    const inProgress = state === "draining" || state === "restarting" || state === "awaiting_rebind";
    const isTargeted = !!targetSessionId && targetSessionId === activeSessionId;
    if (!inProgress || !isTargeted || !transactionId) {
      if (attempt === 1) return false;
      if (state === "ready" || state === "idle" || !transactionId) return true;
      status = null;
      if (attempt < RESTART_REBIND_FAST_ATTEMPTS) {
        await sleep(RESTART_REBIND_FAST_INTERVAL_MS);
      }
      continue;
    }

    const payload = buildRestartRebindPayload({ activeSessionId, orchestrator, reason, attempt });
    dbg(
      "aggressive reconnect probe",
      `attempt=${attempt}/${RESTART_REBIND_FAST_ATTEMPTS}`,
      `state=${state || "unknown"}`,
      `target=${targetSessionId || "none"}`,
      `transaction=${transactionId || "none"}`,
    );
    if (payload) {
      try {
        const response = await api("POST", "/api/restart-orchestrator/rebind", payload);
        const completed = response?.rebind?.completed === true;
        const nextState = String(response?.restartOrchestrator?.state || "").trim().toLowerCase();
        dbg(
          "aggressive reconnect rebind",
          `attempt=${attempt}/${RESTART_REBIND_FAST_ATTEMPTS}`,
          `completed=${completed ? "yes" : "no"}`,
          `nextState=${nextState || "unknown"}`,
          `target=${targetSessionId || "none"}`,
          `transaction=${transactionId || "none"}`,
        );
        await syncActiveSession(`aggressive-reconnect:${reason}:${attempt}`, true).catch(() => false);
        await pulseHeartbeat(`aggressive-reconnect:${reason}:${attempt}`);
        if (completed || nextState === "ready" || nextState === "idle") return true;
      } catch (error) {
        dbg(
          "aggressive reconnect rebind failed",
          `attempt=${attempt}/${RESTART_REBIND_FAST_ATTEMPTS}`,
          `target=${targetSessionId || "none"}`,
          `transaction=${transactionId || "none"}`,
          error?.message || String(error),
        );
      }
    }

    status = null;
    if (attempt < RESTART_REBIND_FAST_ATTEMPTS) {
      await sleep(RESTART_REBIND_FAST_INTERVAL_MS);
    }
  }
  return false;
}

function scheduleAggressiveReconnect(reason, initialStatus = null) {
  if (aggressiveReconnectPromise) return aggressiveReconnectPromise;
  aggressiveReconnectPromise = (async () => {
    const ok = await runAggressiveReconnectLoop(reason, initialStatus);
    dbg(
      "aggressive reconnect completed",
      `reason=${String(reason || "").trim() || "unknown"}`,
      `result=${ok ? "ready" : "no-op-or-timeout"}`,
    );
    return ok;
  })().finally(() => {
    aggressiveReconnectPromise = null;
  });
  return aggressiveReconnectPromise;
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
session = await joinSessionWithRetry({
  joinSessionImpl: joinSession,
  dbg,
  delay: sleep,
  retries: 5,
  retryDelayMs: 1500,
  joinOptions: {
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
    const restartState = String(status?.restartOrchestrator?.state || "").trim().toLowerCase();
    const restartTx = String(status?.restartOrchestrator?.transactionId || "").trim();
    const restartTarget = String(status?.restartOrchestrator?.targetSessionId || "").trim();
    dbg(
      "relay status snapshot",
      `reason=${reason}`,
      `cliOnline=${status?.cliOnline === true ? "yes" : "no"}`,
      `orchestrator=${restartState || "none"}`,
      `transaction=${restartTx || "none"}`,
      `target=${restartTarget || "none"}`,
    );
    await renderRelayReadyBannerFromStatus(status, { force: false }).catch((e) => {
      dbg("render relay banner failed:", e?.message || String(e));
    });
    const requestedMode = String(status?.conversationSessionMode || "").trim().toLowerCase();
    preferredConversationSessionMode = requestedMode || "isolated";
    warnedConversationModeFallback = false;
    await api("POST", "/api/relay/recover-processing", { maxAgeMs: status?.processingTimeoutMs || (10 * 60 * 1000) }).catch(() => {});
    await publishModelSnapshot("relay-active", true);
    startHeartbeat();
    await pulseHeartbeat(`${reason}-initial`);
    restartControlGraceUntilMs = Date.now() + RESTART_CONTROL_STARTUP_GRACE_MS;
    startPolling().catch((error) => {
      dbg("startPolling failed", reason, error?.message || String(error));
    });
    void scheduleAggressiveReconnect(reason, status).catch((error) => {
      dbg("aggressive reconnect scheduling failed", reason, error?.message || String(error));
    });
    scheduleStartupVerification(reason);
    dbg("relay active", reason);
  })().finally(() => {
    activatingRelay = null;
  });
  return activatingRelay;
}

const extractFinalText = sessionIo.extractFinalText;
const sendAndWaitWithHardTimeout = sessionIo.sendAndWaitWithHardTimeout;

