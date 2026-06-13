import fs from "fs";
import {
  buildTerminalFailureText,
  isTerminalSendAndWaitError,
  normalizeTerminalSendAndWaitError,
} from "../runtime/send-and-wait-errors.mjs";
import { getActiveSession } from "../runtime/session-registry.mjs";
import { DEFAULT_QUESTION_TIMEOUT_MS } from "../../../../shared/question-timeout.mjs";
import { QUESTION_TIMEOUT_CONTINUATION_TEXT } from "../../../../shared/question-timeout.mjs";
import { stripPromptContextPrefix } from "../skills/prompt-context.mjs";
import {
  parseQuestionFromText,
  shouldForceFallbackQuestionBridge,
} from "./question-text.mjs";
import { answerCliPromptViaTmux, declineCliPromptViaTmux } from "../utils/tmux-input-bridge.mjs";
import { extractRequestedSchema, schemaFields } from "../../../../shared/question-schema.mjs";

function isImageAttachment(att) {
  const type = String(att?.type || "").toLowerCase();
  return type.startsWith("image/");
}

export function classifySwitchingFailure(input = {}) {
  const explicitRetryable = input?.retryable;
  const reason = String(input?.reason || "switch-call-failed").trim() || "switch-call-failed";
  if (typeof explicitRetryable === "boolean") {
    return { reason, retryable: explicitRetryable };
  }
  const nonRetryable = new Set([
    "switch-api-missing",
    "target-session-invalid",
  ]);
  return { reason, retryable: !nonRetryable.has(reason) };
}

export function evaluateSwitchRetry({
  retryable = false,
  attempts = 0,
  maxRetries = 2,
} = {}) {
  const safeAttempts = Math.max(0, Math.trunc(Number(attempts) || 0));
  const safeMaxRetries = Math.max(0, Math.trunc(Number(maxRetries) || 0));
  if (!retryable || safeAttempts >= safeMaxRetries) {
    return {
      shouldRetry: false,
      attempts: Math.min(safeAttempts, safeMaxRetries),
    };
  }
  return {
    shouldRetry: true,
    attempts: safeAttempts + 1,
  };
}

function readImageBlobFromDataUrl(att) {
  const dataUrl = String(att?.dataUrl || "").trim();
  if (!dataUrl.startsWith("data:")) return null;
  const match = dataUrl.match(/^data:([^;,]+);base64,(.+)$/i);
  if (!match) return null;
  const mimeType = String(match[1] || "").trim().toLowerCase();
  const data = String(match[2] || "").trim();
  if (!mimeType.startsWith("image/") || !data) return null;
  return {
    type: "blob",
    data,
    mimeType,
    displayName: String(att?.name || "image"),
  };
}

function readImageBlobFromPath(att) {
  const filePath = String(att?.path || "").trim();
  if (!filePath) return null;
  if (!fs.existsSync(filePath)) return null;
  const bytes = fs.readFileSync(filePath);
  if (!Buffer.isBuffer(bytes) || !bytes.length) return null;
  const mimeType = String(att?.type || "application/octet-stream").trim().toLowerCase();
  return {
    type: "blob",
    data: bytes.toString("base64"),
    mimeType,
    displayName: String(att?.name || "image"),
  };
}

function normalizeWorkerLivenessIssueReason(reason) {
  const normalized = String(reason || "").trim().toLowerCase();
  if (!normalized) return "worker-unavailable";
  return normalized.replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "worker-unavailable";
}

function buildWorkerLivenessTerminalFailure({ message, ownerSessionId, issueReason, detail = "" } = {}) {
  const reason = normalizeWorkerLivenessIssueReason(issueReason);
  const detailParts = [
    ownerSessionId ? `session=${ownerSessionId}` : null,
    detail ? String(detail).trim() : null,
  ].filter(Boolean);
  return {
    kind: "worker-session-unavailable",
    code: reason,
    stableCode: `relay.${reason}`,
    message: "System note: This session worker stopped responding and the relay marked the turn as unavailable.",
    guidance: "Use ☠️ Kill session from the conversation menu if you want to reset it, then retry or send a new message.",
    detail: detailParts.join(" | ") || null,
    failedAt: new Date().toISOString(),
    requesterSessionId: String(ownerSessionId || "").trim() || null,
    queueMessageId: String(message?.id || "").trim() || null,
  };
}

function buildSdkAttachments(rawAttachments) {
  const input = Array.isArray(rawAttachments) ? rawAttachments : [];
  const sdkAttachments = [];
  for (const att of input) {
    if (!att || typeof att !== "object") continue;

    if (isImageAttachment(att)) {
      const blobFromPath = readImageBlobFromPath(att);
      if (blobFromPath) {
        sdkAttachments.push(blobFromPath);
        continue;
      }
      const blobFromDataUrl = readImageBlobFromDataUrl(att);
      if (blobFromDataUrl) {
        sdkAttachments.push(blobFromDataUrl);
      }
      continue;
    }

    const filePath = String(att?.path || "").trim();
    if (filePath && fs.existsSync(filePath)) {
      sdkAttachments.push({
        type: "file",
        path: filePath,
        displayName: String(att?.name || ""),
      });
    }
  }
  return sdkAttachments;
}

function collectStreamTextCandidates(value, out, depth = 0) {
  if (depth > 8 || value === null || value === undefined) return;
  if (typeof value === "string") {
    const text = value;
    if (text) out.push(text);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStreamTextCandidates(item, out, depth + 1);
    return;
  }
  if (typeof value !== "object") return;
  collectStreamTextCandidates(value.text, out, depth + 1);
  collectStreamTextCandidates(value.delta, out, depth + 1);
  collectStreamTextCandidates(value.content, out, depth + 1);
  collectStreamTextCandidates(value.output_text, out, depth + 1);
  collectStreamTextCandidates(value.outputText, out, depth + 1);
  collectStreamTextCandidates(value.message, out, depth + 1);
  collectStreamTextCandidates(value.response, out, depth + 1);
  collectStreamTextCandidates(value.result, out, depth + 1);
  collectStreamTextCandidates(value.output, out, depth + 1);
}

export function extractStreamTextFromEvent(event) {
  const candidates = [];
  collectStreamTextCandidates(event?.data, candidates);
  collectStreamTextCandidates(event, candidates);
  if (!candidates.length) return "";
  const normalized = candidates
    .map((candidate) => String(candidate || ""))
    .filter((candidate) => candidate.length > 0);
  if (!normalized.length) return "";
  normalized.sort((a, b) => b.length - a.length);
  return normalized[0];
}

export function shouldEmitRelayStreamUpdate(nextText, previousText) {
  const next = String(nextText || "");
  const prev = String(previousText || "");
  if (!next) return false;
  if (!prev) return true;
  if (next === prev) return false;
  const delta = next.length - prev.length;
  if (delta >= 24) return true;
  if (delta > 0 && /[\n.!?:)]$/.test(next)) return true;
  if (delta <= 0) return true;
  return false;
}

export function resolveEmptyFinalTextHandling({ lastStreamedSent = "", lastActivityText = "" } = {}) {
  const streamed = String(lastStreamedSent || "").trim();
  if (streamed) {
    return { action: "use_stream_text", text: streamed };
  }
  const activity = String(lastActivityText || "").trim();
  return {
    action: "requeue",
    reason: activity
      ? `empty-final-text:last-activity:${activity.slice(0, 120)}`
      : "empty-final-text:no-stream-or-text",
  };
}

export async function publishRelayStreamEvent({
  api,
  message,
  text,
  done = false,
  dbg = () => {},
} = {}) {
  const value = String(text || "");
  try {
    await api("POST", "/api/stream", {
      messageId: message?.id,
      conversationId: message?.conversationId,
      mode: message?.relayMode || "agent",
      text: value,
      done: !!done,
    });
    return { ok: true, text: value };
  } catch (streamError) {
    dbg("relay stream publish failed", `msgId=${message?.id || "none"}`, streamError?.message || String(streamError));
    return { ok: false, text: value };
  }
}

function extractToolCallInputObject(value, toolName, depth = 0) {
  if (!value || typeof value !== "object" || depth > 12) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractToolCallInputObject(item, toolName, depth + 1);
      if (found) return found;
    }
    return null;
  }
  const name = value.name || value.tool || value.function_name || value.toolName || value.tool_name;
  if (String(name || "").trim() === toolName) {
    const input = value.input || value.arguments || value.params || value.args || null;
    if (input && typeof input === "object") return input;
    if (typeof value.arguments === "string") {
      try {
        const parsed = JSON.parse(value.arguments);
        if (parsed && typeof parsed === "object") return parsed;
      } catch {}
    }
  }
  const CONTAINER_KEYS = ["data", "output", "content", "tool_calls", "toolRequests", "calls", "items", "results", "steps", "turns", "messages", "events"];
  for (const key of CONTAINER_KEYS) {
    const child = value[key];
    if (child === undefined || child === null) continue;
    const found = extractToolCallInputObject(child, toolName, depth + 1);
    if (found) return found;
  }
  return null;
}

function normalizePlanBoardActions(rawActions, recommendedAction = "") {
  const ids = Array.isArray(rawActions)
    ? rawActions
      .map((entry) => {
        if (typeof entry === "string") return entry.trim().toLowerCase();
        if (entry && typeof entry === "object") {
          return String(entry.id || entry.actionId || entry.value || "").trim().toLowerCase();
        }
        return "";
      })
      .filter(Boolean)
    : [];
  const sourceIds = ids.length ? ids : ["autopilot", "interactive", "exit_only"];
  const seen = new Set();
  const deduped = [];
  for (const id of sourceIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    deduped.push(id);
  }
  const recommended = String(recommendedAction || "").trim().toLowerCase();
  return {
    actions: deduped.map((id) => {
      if (id === "autopilot_fleet") return { id, label: "Implement with autopilot fleet", mode: "autopilot" };
      if (id === "autopilot") return { id, label: "Implement in autopilot", mode: "autopilot" };
      if (id === "interactive") return { id, label: "Stop here and prompt myself", mode: "agent" };
      if (id === "exit_only") return { id, label: "Stop here", mode: "agent" };
      return { id, label: id.replace(/[_-]+/g, " "), mode: null };
    }),
    recommendedAction: recommended || null,
  };
}

function countPlanLikeLines(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^([-*]\s+|\d+\.\s+)/.test(line))
    .length;
}

export function buildPlanReadyBoardPayload({ finalEvent, message, finalText = "" } = {}) {
  const exitPlanInput = extractToolCallInputObject(finalEvent, "exit_plan_mode");
  const taskCompleteInput = extractToolCallInputObject(finalEvent, "task_complete");
  const toolInput = (exitPlanInput && typeof exitPlanInput === "object")
    ? exitPlanInput
    : ((taskCompleteInput && typeof taskCompleteInput === "object") ? taskCompleteInput : null);
  const fallbackSummary = String(finalText || "").trim();
  const allowPlanModeFallback =
    !toolInput
    && String(message?.relayMode || "").trim().toLowerCase() === "plan"
    && countPlanLikeLines(fallbackSummary) >= 2;
  if (!toolInput && !allowPlanModeFallback) return null;
  const summary = String(
    toolInput?.summary
    || toolInput?.result
    || toolInput?.output
    || toolInput?.message
    || fallbackSummary
    || "",
  ).trim();
  if (!summary) return null;
  const normalized = normalizePlanBoardActions(toolInput?.actions, toolInput?.recommendedAction);
  const source = exitPlanInput
    ? "exit_plan_mode"
    : (taskCompleteInput ? "task_complete" : "plan-mode-fallback");
  return {
    queueId: message?.id,
    messageId: message?.id,
    conversationId: message?.conversationId,
    mode: message?.relayMode || "agent",
    boardType: "plan_ready",
    title: "Plan ready for review",
    body: summary,
    actions: normalized.actions,
    recommendedAction: normalized.recommendedAction,
    context: {
      source,
      queueMessageId: message?.id || null,
      conversationId: message?.conversationId || null,
      relayMode: message?.relayMode || "agent",
    },
  };
}

export function createPollingLoop({
  sleep,
  pollMs,
  api,
  dbg,
  session,
  sendTimeout,
  publishModelSnapshot,
  setModelForMessage,
  buildPromptWithRelayContext,
  sendAndWaitWithHardTimeout,
  sendWithBestEffortStreaming,
  extractFinalText,
  getLastActivityText,
  getCurrentModelId,
  getPreferredConversationSessionMode,
  getSupportsIsolatedSessions,
  getWarnedConversationModeFallback,
  setWarnedConversationModeFallback,
  getPollingLoopStarted,
  setPollingLoopStarted,
  getSessionReady,
  getWaitingForAI,
  getLastAskUserBridge,
  syncActiveSession,
  ensureSessionForConversation,
  setActiveMsg,
  setWaitingForAI,
  setRelayTurnActive,
  setLastActivityText,
  setLastAskUserBridge,
  getPendingAskUserRequest,
  setPendingAskUserRequest,
  clearRelayScopeState,
  shouldFetchPending = () => true,
  extractQuestionPrompt,
  extractQuestionChoices,
  handleControl,
  getSessionId = () => null,
}) {
  let stopRequested = false;
  let lastAbortControlCheckAt = 0;
  let activeTurnMessageId = "";
  let iterationPromise = null;

  async function waitForRelayQuestionAnswer(questionId, timeoutMs = DEFAULT_QUESTION_TIMEOUT_MS, pollIntervalMs = 1500) {
    const started = Date.now();
    while (true) {
      const { question } = await api("GET", `/api/relay-question/${questionId}`);
      if (!question) throw new Error("Relay question missing");
      if (question.status === "answered") {
        return {
          answer: String(question.answer || "").trim(),
          structuredAnswer: question.structuredAnswer && typeof question.structuredAnswer === "object"
            ? question.structuredAnswer
            : null,
          timedOut: false,
        };
      }
      if (question.status === "timed_out" || question.status === "cancelled") {
        return {
          answer: QUESTION_TIMEOUT_CONTINUATION_TEXT,
          structuredAnswer: null,
          timedOut: true,
        };
      }
      if (Date.now() - started >= timeoutMs) {
        await api("POST", `/api/relay-question/${questionId}/timeout`, {}).catch(() => {});
        return {
          answer: QUESTION_TIMEOUT_CONTINUATION_TEXT,
          structuredAnswer: null,
          timedOut: true,
        };
      }
      await sleep(pollIntervalMs);
    }
  }

  async function createFallbackRelayQuestion(message, parsed) {
    if (!parsed.prompt) return null;

    const created = await api("POST", "/api/relay-question", {
      queueId: message.id,
      messageId: message.id,
      conversationId: message.conversationId,
      mode: message.relayMode || "agent",
      prompt: parsed.prompt,
      choices: parsed.choices,
      allowFreeform: parsed.choices.length === 0,
      timeout_ms: sendTimeout,
        context: {
          source: "fallback-text-question",
          rationale: "Auto-converted a plain-text follow-up question into a relay question card.",
          queueMessageId: message.id,
          conversationId: message.conversationId,
          relayMode: message.relayMode || "agent",
      },
      request: {
        source: "polling-loop-fallback",
      },
    });

    const questionId = created?.question?.id;
    if (!questionId) return null;
    const answer = await waitForRelayQuestionAnswer(questionId, sendTimeout);
    return {
      questionId,
      answer,
      prompt: parsed.prompt,
      choices: parsed.choices,
    };
  }

  async function continueAfterQuestionAnswer(message, { questionPrompt, choices, answer, assistantText = "", timedOut = false } = {}) {
    const normalizedChoices = Array.isArray(choices) ? choices : [];
    const normalizedAnswer = String(answer || "").trim();
    const lines = [
      "You are resuming a paused relay turn after asking the user a follow-up question.",
      `Original user request: ${String(message?.text || "").trim()}`,
      assistantText ? `Your last assistant reply before the pause: ${String(assistantText || "").trim()}` : "",
      `Question asked: ${String(questionPrompt || "").trim()}`,
      normalizedChoices.length
        ? `Choices shown to the user: ${normalizedChoices.map((choice, idx) => `${idx + 1}. ${String(choice || "").trim()}`).join(" | ")}`
        : "Choices: (not available)",
      timedOut
        ? `No user answer was received before timeout. Treat this as if the user could not respond and continue according to the current relay mode.`
        : `User's answer: ${normalizedAnswer}`,
      "Continue the original task using that answer.",
      "Do not repeat the question and do not turn the answer into a right-or-wrong grading step unless the original request explicitly asked for that.",
      "Respond with the next assistant message only.",
    ];
    const finalEvent = await sendAndWaitWithHardTimeout({ prompt: lines.join("\n") }, sendTimeout);
    return String(extractFinalText(finalEvent) || "").trim();
  }

  async function createRelayQuestionFromAskUserRequest(message, request) {
    const prompt = extractQuestionPrompt(request);
    const choices = extractQuestionChoices(request);
    if (!prompt) return null;
    const activeSession = getActiveSession();
    const requestedSchema = extractRequestedSchema(request);

    const created = await api("POST", "/api/relay-question", {
      queueId: message.id,
      messageId: message.id,
      conversationId: message.conversationId,
      mode: message.relayMode || "agent",
      prompt,
      choices,
      allowFreeform: choices.length === 0,
      requestedSchema: requestedSchema || undefined,
      sdk_session_id: activeSession?.sdkSessionId || undefined,
      timeout_ms: sendTimeout,
      context: {
        source: "ask-user-autopilot-bridge",
        rationale: "ask_user called but onUserInputRequest was bypassed (autopilot mode); intercepted via onPreToolUse.",
        queueMessageId: message.id,
        conversationId: message.conversationId,
        relayMode: message.relayMode || "agent",
      },
      request: { source: "polling-loop-ask-user-intercept" },
    });

    const questionId = created?.question?.id;
    if (!questionId) return null;

    dbg("ask_user autopilot bridge: relay question created", questionId, "for msgId", message.id, "prompt=", prompt, "choices=", String(choices.length));
    const result = await waitForRelayQuestionAnswer(questionId, sendTimeout);
    return { questionId, prompt, choices, answer: result.answer, structuredAnswer: result.structuredAnswer || null, timedOut: result.timedOut };
  }

  async function continueAfterAskUserAnswer(message, request, answer, timedOut = false) {
    const prompt = extractQuestionPrompt(request);
    const choices = extractQuestionChoices(request);
    return continueAfterQuestionAnswer(message, {
      questionPrompt: prompt,
      choices,
      answer,
      timedOut,
    });
  }

  async function processPendingSdkSessionDeletes() {
    const status = await api("GET", "/api/status").catch(() => null);
    if (status?.relayPaused) return false;
    const pending = await api("GET", "/api/sdk-session-delete/pending").catch(() => null);
    const request = pending?.request || null;
    const sdkSessionId = String(request?.sdkSessionId || "").trim();
    if (!sdkSessionId) return false;

    let ok = false;
    let errorText = "";
    try {
      const activeSession = getActiveSession();
      const activeSdkSessionId = String(activeSession?.sdkSessionId || "").trim();
      if (activeSdkSessionId && activeSdkSessionId === sdkSessionId) {
        throw new Error("Refusing to delete the currently active SDK session");
      }
      if (!session || typeof session.deleteSession !== "function") {
        throw new Error("SDK deleteSession() is unavailable in this CLI runtime");
      }
      await session.deleteSession(sdkSessionId);
      ok = true;
      await session.log(`🧹 Deleted SDK session ${sdkSessionId.slice(0, 8)} from relay request`, { ephemeral: true });
    } catch (error) {
      ok = false;
      errorText = String(error?.message || error || "unknown delete failure").trim() || "unknown delete failure";
      dbg("sdk delete failed", `session=${sdkSessionId}`, errorText);
      await session.log(`⚠️ SDK session delete failed (${sdkSessionId.slice(0, 8)}): ${errorText}`, { level: "warn" });
    }

    await api("POST", "/api/sdk-session-delete/result", {
      sdk_session_id: sdkSessionId,
      conversation_id: request?.conversationId || undefined,
      ok,
      error: ok ? undefined : errorText,
    }).catch(() => {});

    return true;
  }

  async function checkActiveAbortControl(message, { force = false } = {}) {
    const ownerSessionId = String(message?.ownerSessionId || "").trim();
    if (!ownerSessionId || !getWaitingForAI()) return false;
    const now = Date.now();
    if (!force && (now - lastAbortControlCheckAt) < 1200) return false;
    lastAbortControlCheckAt = now;
    const queueMessageId = String(message?.id || "").trim();
    const pending = await api("GET", `/api/control/active?sdkSessionId=${encodeURIComponent(ownerSessionId)}&queueMessageId=${encodeURIComponent(queueMessageId)}`).catch(() => null);
    const control = pending?.control || null;
    if (!control || String(control.type || "").trim() !== "abort_turn") return false;

    if (!session || typeof session.abort !== "function") {
      const error = "SDK abort() is unavailable in this CLI runtime";
      await api("POST", `/api/control/${encodeURIComponent(control.id)}/result`, {
        ok: false,
        error,
      }).catch(() => {});
      await session?.log?.(`⚠️ Stop request could not be executed: ${error}`, { level: "warn" });
      return false;
    }

    await session.log(`⛔ Stop requested for relay turn ${String(message?.id || "").slice(0, 8)}`, { ephemeral: true });
    await session.abort();
    await api("POST", `/api/control/${encodeURIComponent(control.id)}/result`, {
      ok: true,
      note: "session.abort() completed",
    }).catch(() => {});
    const abortError = new Error("Relay turn aborted by user request");
    abortError.code = "RELAY_TURN_ABORTED";
    abortError.controlId = control.id;
    throw abortError;
  }

  async function handlePendingPayload(pending, source = "poll") {
    const pendingBlockedReason = String(pending?.routing?.blockedReason || "").trim();
    const control = pending?.control || null;
    if (control && typeof handleControl === "function") {
      const handled = await handleControl(control, pending);
      if (handled) return true;
    }
    const { message } = pending || {};

    if (!message) return false;

    activeTurnMessageId = String(message.id || "");
    setActiveMsg(message);
    if (typeof ensureSessionForConversation !== "function") {
      dbg("session routing unavailable for msgId", message.id, "ensureSessionForConversation is not configured");
      await session.log("⚠️ Session routing is unavailable for this turn", { level: "warn" });
      await api("POST", "/api/response", {
        messageId: message.id,
        conversationId: message.conversationId,
        text: "I couldn't process this turn because session routing is unavailable in the relay runtime. Please retry after the relay extension is fully initialized.",
        model: await getCurrentModelId() || message.model || null,
      }).catch(async () => {
        await api("POST", "/api/requeue", { messageId: message.id }).catch(() => {});
      });
      setActiveMsg(null);
      return true;
    }

    const sessionResolution = await ensureSessionForConversation(message.conversationId, source);
    if (sessionResolution && !sessionResolution.ok) {
      const activeSdkSessionId = String(sessionResolution?.activeSessionId || "").trim();
      const targetSdkSessionId = String(sessionResolution?.targetSessionId || "").trim();
      const detail = String(sessionResolution?.message || "").trim();
      const retryable = sessionResolution?.retryable === true;
      dbg(
        "session availability check failed for msgId",
        message.id,
        `reason=${sessionResolution.reason || "unknown"}`,
        `active=${activeSdkSessionId || "none"}`,
        `target=${targetSdkSessionId || "none"}`,
      );
      await session.log(
        detail
          ? `⚠️ Session unavailable for this turn: ${detail}`
          : "⚠️ Session unavailable for this turn",
        { level: "warn" },
      );
      if (retryable) {
        await api("POST", "/api/requeue", { messageId: message.id }).catch(() => {});
      } else {
        await api("POST", "/api/response", {
          messageId: message.id,
          conversationId: message.conversationId,
          text: detail
            ? `System note: I could not process this turn because the bound SDK session is unavailable (${detail}).`
            : "System note: I could not process this turn because the bound SDK session is unavailable.",
          model: await getCurrentModelId() || message.model || null,
        }).catch(async () => {
          await api("POST", "/api/requeue", { messageId: message.id }).catch(() => {});
        });
      }
      setActiveMsg(null);
      return true;
    }

    const synced = await syncActiveSession?.(source, true);
    if (!synced) {
      dbg("session sync failed before processing msgId", message.id, "- requeueing");
      await session.log("⚠️ Session sync failed before processing; re-queuing turn", { level: "warn" });
      await api("POST", "/api/requeue", { messageId: message.id }).catch(() => {});
      setActiveMsg(null);
      return true;
    }
    setWaitingForAI(true);
    setRelayTurnActive(true, message);
    setLastActivityText("");
    setLastAskUserBridge(null);
    setPendingAskUserRequest?.(null);

    const label = message.isNewConversation ? "new conv" : "existing conv";
    await session.log(`📨 [${label}] Web message (${message.model || "default"}${message.reasoningEffort ? `:${message.reasoningEffort}` : ""} / ${message.relayMode || "agent"}): "${String(message.text || "").slice(0, 80)}"`);
    dbg("session.send: queuing for msgId", message.id, `source=${source}`, pendingBlockedReason ? `blocked=${pendingBlockedReason}` : "");
    let lastStreamedSent = "";
    const pushRelayStream = async (text, done = false) => {
      const value = String(text || "");
      if (!value && !done) return;
      if (!done && value === lastStreamedSent) return;
      const publish = await publishRelayStreamEvent({
        api,
        message,
        text: value,
        done,
        dbg,
      });
      if (!done && publish.ok) lastStreamedSent = value;
    };
    let sendAndWaitStartedAtMs = 0;

    try {
      if (message.model) {
        const modelSwitch = await setModelForMessage(message.model);
        const activeModel = modelSwitch.after || modelSwitch.current || "unknown";
        const switchText = modelSwitch.switched
          ? `Model selected: requested=${message.model} active=${activeModel} via=${modelSwitch.via || "switchTo"}`
          : `Model switch failed: requested=${message.model} active=${activeModel}${modelSwitch.error ? ` error=${modelSwitch.error}` : ""}`;
        await publishModelSnapshot("model-switch", true);
        await api("POST", "/api/activity", {
          messageId: message.id,
          conversationId: message.conversationId,
          mode: message.relayMode || "agent",
          text: switchText,
        }).catch(() => {});
        dbg("model switch", switchText);
      }

      const prompt = await buildPromptWithRelayContext(message);

      const sdkAttachments = buildSdkAttachments(message.attachments);
      const payload = sdkAttachments.length ? { prompt, attachments: sdkAttachments } : { prompt };
      if (message.reasoningEffort && String(message.reasoningEffort || "").trim().toLowerCase() !== "none") {
        payload.reasoningEffort = String(message.reasoningEffort || "").trim();
      }
      if (sdkAttachments.length) {
        const imageCount = sdkAttachments.filter((att) => att.type === "blob").length;
        const fileCount = sdkAttachments.filter((att) => att.type === "file").length;
        dbg("sdk attachments prepared", `msgId=${message.id}`, `total=${sdkAttachments.length}`, `images=${imageCount}`, `files=${fileCount}`);
        await api("POST", "/api/activity", {
          messageId: message.id,
          conversationId: message.conversationId,
          mode: message.relayMode || "agent",
          text: `Attached ${sdkAttachments.length} file(s) to SDK request${imageCount ? ` (images=${imageCount})` : ""}${fileCount ? ` (files=${fileCount})` : ""}.`,
        }).catch(() => {});
      }

      let finalEvent;
      let lastWorkerStatusCheckAt = 0;
      const inspectActiveWorkerLiveness = async () => {
        await checkActiveAbortControl(message, { force: true });
        const ownerSessionId = String(message?.ownerSessionId || "").trim();
        if (!ownerSessionId) return;
        const now = Date.now();
        if ((now - lastWorkerStatusCheckAt) < 10_000) return;
        lastWorkerStatusCheckAt = now;

        const status = await api("GET", "/api/status").catch(() => null);
        const workers = Array.isArray(status?.sessionWorker?.workers) ? status.sessionWorker.workers : [];
        const worker = workers.find((entry) => String(entry?.sdkSessionId || "").trim() === ownerSessionId) || null;
        if (!worker) {
          throw Object.assign(new Error("Active session worker is missing from relay status"), {
            code: "RELAY_WORKER_UNAVAILABLE",
            terminalFailure: buildWorkerLivenessTerminalFailure({
              message,
              ownerSessionId,
              issueReason: "worker-missing",
              detail: "No worker snapshot was reported for the owning session.",
            }),
          });
        }

        const degraded = String(worker?.uiState || "").trim().toLowerCase() === "yellow";
        const degradedReason = String(worker?.degradedReason || "").trim().toLowerCase();
        const routingMismatch = (
          (worker?.conversationId && String(worker.conversationId).trim() !== String(message?.conversationId || "").trim())
          || (message?.runtimeSessionId && worker?.runtimeSessionId && String(worker.runtimeSessionId).trim() !== String(message.runtimeSessionId).trim())
        );
        if (!degraded && !routingMismatch) return;

        const issueReason = routingMismatch
          ? "worker-routing-mismatch"
          : (degradedReason || "worker-degraded");
        const detail = routingMismatch
          ? `workerConversation=${String(worker?.conversationId || "").trim() || "none"} workerRuntime=${String(worker?.runtimeSessionId || "").trim() || "none"}`
          : String(worker?.lastError || worker?.degradedReason || "").trim();
        throw Object.assign(new Error(`Active session worker became unavailable (${issueReason})`), {
          code: "RELAY_WORKER_UNAVAILABLE",
          terminalFailure: buildWorkerLivenessTerminalFailure({
            message,
            ownerSessionId,
            issueReason,
            detail,
          }),
        });
      };
      const sendWithoutStreaming = async (sendPayload) => {
        const turnPromise = Promise.resolve().then(() => sendAndWaitWithHardTimeout(sendPayload, sendTimeout));
        let tmuxBridgeAttempted = false;
        while (true) {
          const outcome = await Promise.race([
            turnPromise.then((value) => ({ done: true, value })),
            sleep(1000).then(() => ({ done: false })),
          ]);
          if (outcome.done) return outcome.value;
          await inspectActiveWorkerLiveness();

          // Check for pending ask_user that wasn't handled by onUserInputRequest
          // This happens on Linux where the CLI shows its terminal prompt instead
          const pendingReq = !tmuxBridgeAttempted ? getPendingAskUserRequest?.() : null;
          if (pendingReq && !getLastAskUserBridge?.()) {
            const sessionId = getSessionId?.();
            if (sessionId) {
              tmuxBridgeAttempted = true;
              dbg("ask_user tmux bridge: detected pending request while sendAndWait blocked", `sessionId=${sessionId}`, `msgId=${message.id}`);
              dbg("ask_user tmux bridge: pendingReq keys=", Object.keys(pendingReq || {}).join(","), "toolArgs=", JSON.stringify(pendingReq?.toolArgs)?.slice(0, 300));
              try {
                // Create relay question for web UI
                const prompt = extractQuestionPrompt?.(pendingReq) || "Clarification needed";
                const choices = extractQuestionChoices?.(pendingReq) || [];
                const requestedSchema = extractRequestedSchema(pendingReq);
                const fields = requestedSchema ? schemaFields(requestedSchema) : [];
                dbg("ask_user tmux bridge: extracted prompt=", prompt?.slice(0, 100), "choices=", JSON.stringify(choices), "fields=", String(fields.length));
                const created = await api("POST", "/api/relay-question", {
                  queueId: message.id,
                  messageId: message.id,
                  conversationId: message.conversationId,
                  mode: message.relayMode || "agent",
                  prompt,
                  choices,
                  allowFreeform: true,
                  requestedSchema: requestedSchema || undefined,
                  timeout_ms: sendTimeout,
                  context: {
                    source: "tmux-bridge",
                    rationale: "CLI showed terminal prompt instead of using SDK callback; bridging via tmux.",
                    queueMessageId: message.id,
                  },
                });
                const questionId = created?.question?.id;
                if (questionId) {
                  dbg("ask_user tmux bridge: question created", `questionId=${questionId}`, `msgId=${message.id}`);
                  await api("POST", "/api/activity", {
                    messageId: message.id,
                    conversationId: message.conversationId,
                    mode: message.relayMode || "agent",
                    text: "Tool (ask_user): question posted via tmux bridge; waiting for web answer",
                  }).catch(() => {});

                  // Wait for answer from web UI
                  const { answer, structuredAnswer, timedOut } = await waitForRelayQuestionAnswer(questionId, sendTimeout);
                  dbg("ask_user tmux bridge: got answer", `questionId=${questionId}`, `answer="${String(answer || "").slice(0, 50)}"`, `timedOut=${timedOut}`);

                  if (!timedOut && (answer || structuredAnswer)) {
                    // Send answer to CLI via tmux
                    const wasFreeform = !choices.some((c) => String(c || "").trim().toLowerCase() === String(answer || "").trim().toLowerCase());
                    const sent = await answerCliPromptViaTmux({
                      sessionName: sessionId,
                      answer,
                      choices,
                      wasFreeform,
                      structuredAnswer: structuredAnswer || null,
                      fields: fields.length ? fields : null,
                      dbg,
                    });
                    if (sent) {
                      dbg("ask_user tmux bridge: answer sent to terminal", `sessionId=${sessionId}`);
                      setLastAskUserBridge?.({ source: "tmux-bridge", at: Date.now(), messageId: message.id });
                      await api("POST", "/api/activity", {
                        messageId: message.id,
                        conversationId: message.conversationId,
                        mode: message.relayMode || "agent",
                        text: `Tool (ask_user): user answered "${String(answer || "").slice(0, 60)}" (via tmux bridge)`,
                      }).catch(() => {});
                    }
                  } else if (timedOut) {
                    // Send Ctrl+D to decline the prompt
                    dbg("ask_user tmux bridge: timeout, sending Ctrl+D to decline");
                    await declineCliPromptViaTmux(sessionId, dbg).catch(() => {});
                  }
                  setPendingAskUserRequest?.(null);
                }
              } catch (bridgeErr) {
                dbg("ask_user tmux bridge failed", `msgId=${message.id}`, bridgeErr?.message || String(bridgeErr));
              }
            }
          }
        }
      };
      try {
        sendAndWaitStartedAtMs = Date.now();
        finalEvent = await sendWithoutStreaming(payload);
      } catch (attachmentError) {
        if (!sdkAttachments.length) throw attachmentError;
        dbg("sdk attachment delivery failed", `msgId=${message.id}`, attachmentError?.message || String(attachmentError));
        await api("POST", "/api/activity", {
          messageId: message.id,
          conversationId: message.conversationId,
          mode: message.relayMode || "agent",
          text: `Attachment delivery failed (${attachmentError?.message || "unknown error"}). Retrying without SDK attachments.`,
        }).catch(() => {});
        finalEvent = await sendWithoutStreaming({ prompt });
      }
      const sendAndWaitDurationMs = sendAndWaitStartedAtMs > 0 ? Math.max(0, Date.now() - sendAndWaitStartedAtMs) : null;
      dbg("session.sendAndWait: completed for msgId", message.id, sendAndWaitDurationMs ? `durationMs=${sendAndWaitDurationMs}` : "");

      const text = stripPromptContextPrefix(extractFinalText(finalEvent), message, "", prompt);
      const model = await getCurrentModelId() || finalEvent?.data?.model || finalEvent?.data?.modelId || message.model || null;
      const bridgedViaAskUser = !!getLastAskUserBridge?.();
      const pendingAskUserReq = !bridgedViaAskUser ? getPendingAskUserRequest?.() : null;
      const boardPayload = buildPlanReadyBoardPayload({
        finalEvent,
        message,
        finalText: text,
      });
      if (boardPayload) {
        try {
          await api("POST", "/api/relay-board", boardPayload);
        } catch (boardError) {
          dbg("plan board publish failed", `msgId=${message.id}`, boardError?.message || String(boardError));
        }
      }

      if (!bridgedViaAskUser && pendingAskUserReq) {
        dbg("ask_user safety-net bridge triggered — onUserInputRequest was not called for msgId", message.id, "(unexpected; should fire via SDK handler now)");
        try {
          const bridged = await createRelayQuestionFromAskUserRequest(message, pendingAskUserReq);
          if (bridged?.questionId) {
            let resumedText = "";
            try {
              resumedText = await continueAfterAskUserAnswer(message, pendingAskUserReq, bridged.answer, bridged.timedOut);
            } catch (evaluateErr) {
              dbg("ask_user autopilot resume failed", `msgId=${message.id}`, evaluateErr?.message || String(evaluateErr));
            }
            await api("POST", "/api/response", {
              messageId: message.id,
              conversationId: message.conversationId,
              text: resumedText || (
                bridged.timedOut
                  ? "The user did not respond before timeout. I continued with the current relay mode."
                  : `Thanks — I received your answer: "${bridged.answer}". I hit a problem while resuming the turn from it.`
              ),
              model,
            });
            await session.log("✅ ask_user safety-net bridge: relay question card shown, answer received, turn resumed", { ephemeral: true });
            return true;
          }
        } catch (bridgeErr) {
          dbg("ask_user safety-net bridge failed", `msgId=${message.id}`, bridgeErr?.message || String(bridgeErr));
          await api("POST", "/api/activity", {
            messageId: message.id,
            conversationId: message.conversationId,
            mode: message.relayMode || "agent",
            text: `ask_user safety-net bridge failed (${bridgeErr?.message || "unknown error"}). Falling through to normal response.`,
          }).catch(() => {});
        }
      }

      const fallbackBridgeCheck = !bridgedViaAskUser && !pendingAskUserReq && !!text
        ? shouldForceFallbackQuestionBridge(text)
        : { shouldForce: false, parsed: null };
      const shouldForceQuestionBridge = fallbackBridgeCheck.shouldForce;

      if (shouldForceQuestionBridge) {
        try {
          const bridged = await createFallbackRelayQuestion(message, fallbackBridgeCheck.parsed);
          if (bridged?.questionId) {
            let resumedText = "";
            try {
              resumedText = await continueAfterQuestionAnswer(message, {
                questionPrompt: bridged.prompt,
                choices: bridged.choices,
                answer: bridged.answer,
                timedOut: bridged.timedOut,
                assistantText: text,
              });
            } catch (evaluateErr) {
              dbg("fallback question resume failed", `msgId=${message.id}`, evaluateErr?.message || String(evaluateErr));
            }
            await api("POST", "/api/response", {
              messageId: message.id,
              conversationId: message.conversationId,
              text: resumedText || (
                bridged.timedOut
                  ? "The user did not respond before timeout. I continued with the current relay mode."
                  : `Thanks — I received your answer: "${bridged.answer}". I hit a problem while resuming the turn from it.`
              ),
              model,
            });
            await session.log("✅ Converted plain-text question into relay bridge card and resumed the turn", { ephemeral: true });
            return true;
          }
        } catch (bridgeErr) {
          dbg("fallback question bridge failed", `msgId=${message.id}`, bridgeErr?.message || String(bridgeErr));
          await api("POST", "/api/activity", {
            messageId: message.id,
            conversationId: message.conversationId,
            mode: message.relayMode || "agent",
            text: `Question bridge fallback failed (${bridgeErr?.message || "unknown error"}).`,
          }).catch(() => {});
        }
      }

      if (!text) {
        const emptyHandling = resolveEmptyFinalTextHandling({
          lastStreamedSent,
          lastActivityText: String(getLastActivityText?.() || ""),
        });
        if (emptyHandling.action === "use_stream_text") {
          const streamedText = String(emptyHandling.text || "");
          dbg("sendAndWait returned empty content; finalizing from streamed text msgId", message.id, `len=${streamedText.length}`);
          await session.log("⚠️ Empty final envelope text — using streamed text as final reply", { level: "warn" });
          await pushRelayStream(streamedText, true);
          await api("POST", "/api/response", { messageId: message.id, conversationId: message.conversationId, text: streamedText, model });
        } else {
          dbg("sendAndWait returned empty content; re-queueing msgId", message.id, emptyHandling.reason || "empty-final-text");
          await session.log("⚠️ Empty assistant response envelope — re-queuing instead of sending fallback", { level: "warn" });
          await api("POST", "/api/requeue", { messageId: message.id }).catch(() => {});
        }
      } else {
        await pushRelayStream(text || lastStreamedSent, true);
        await api("POST", "/api/response", { messageId: message.id, conversationId: message.conversationId, text, model });
        await session.log(`✅ Sent response to web (${text.length} chars)`, { ephemeral: true });
      }
    } catch (e) {
      const terminalFailure = normalizeTerminalSendAndWaitError(e);
      dbg(
        "sendAndWait ERROR for msgId",
        message.id,
        ":",
        e.message,
        `terminal=${terminalFailure ? "yes" : "no"}`,
        `stableCode=${terminalFailure?.stableCode || "none"}`,
      );
      if (String(e?.code || "").trim() === "RELAY_TURN_ABORTED") {
        await pushRelayStream(lastStreamedSent, true);
      } else if (isTerminalSendAndWaitError(e)) {
        const failureText = buildTerminalFailureText(e);
        await session.log("❌ Terminal SDK/tool-output error — marking turn failed", { level: "error" }).catch((logError) => {
          dbg("session.log failed while reporting terminal error", message.id, logError?.message || String(logError));
        });
        await pushRelayStream(lastStreamedSent, true);
        await api("POST", "/api/response", {
          messageId: message.id,
          conversationId: message.conversationId,
          text: failureText,
          terminalError: terminalFailure || undefined,
          model: await getCurrentModelId() || message.model || null,
        }).catch(async (responseError) => {
          dbg("terminal response publish failed for msgId", message.id, responseError?.message || String(responseError));
          await api("POST", "/api/requeue", { messageId: message.id }).catch(() => {});
        });
      } else if (e?.code === "RELAY_WORKER_UNAVAILABLE" && e?.terminalFailure) {
        await session.log("⚠️ Session worker became unavailable during the turn — marking it failed", { level: "warn" }).catch((logError) => {
          dbg("session.log failed while reporting worker-unavailable", message.id, logError?.message || String(logError));
        });
        await pushRelayStream(lastStreamedSent, true);
        await api("POST", "/api/response", {
          messageId: message.id,
          conversationId: message.conversationId,
          terminalError: e.terminalFailure,
          model: await getCurrentModelId() || message.model || null,
        }).catch(async () => {
          await api("POST", "/api/requeue", { messageId: message.id }).catch(() => {});
        });
      } else {
        await session.log(`❌ Response failed: ${e.message}; re-queuing`, { level: "error" }).catch((logError) => {
          dbg("session.log failed while reporting generic send error", message.id, logError?.message || String(logError));
        });
        api("POST", "/api/requeue", { messageId: message.id }).catch(() => {});
      }
    } finally {
      setLastActivityText("");
      setPendingAskUserRequest?.(null);
      clearRelayScopeState?.();
      setRelayTurnActive(false, message);
      setActiveMsg(null);
      setWaitingForAI(false);
      activeTurnMessageId = "";
    }
    return true;
  }

  async function runPollingIteration() {
    if (!getSessionReady()) return;
    try {
        await api("POST", "/api/heartbeat", {
          activeQueueMessageId: getWaitingForAI() ? activeTurnMessageId || undefined : undefined,
        });
        await publishModelSnapshot("poll");

        if (getWaitingForAI()) return;
        // Keep SDK-session-delete maintenance best-effort only; never starve
        // user turn dequeue when delete requests are backlogged/retrying.
        await processPendingSdkSessionDeletes();
        if (!shouldFetchPending()) return;

        const pending = await api("GET", "/api/pending");
        await handlePendingPayload(pending, "poll");
    } catch (error) {
      dbg("runPollingIteration failed", error?.message || String(error));
      // Server may be down — keep retrying silently
    }
  }

  async function runPollingIterationSerialized() {
    if (iterationPromise) return iterationPromise;
    iterationPromise = Promise.resolve()
      .then(() => runPollingIteration())
      .finally(() => {
        iterationPromise = null;
      });
    return iterationPromise;
  }

  async function startPolling() {
    if (getPollingLoopStarted()) return;
    setPollingLoopStarted(true);
    stopRequested = false;
    dbg("startPolling: entered");
    await session.log("🔄 Polling started", { ephemeral: true });

    while (!stopRequested) {
      await sleep(pollMs);
      if (stopRequested) break;
      await runPollingIterationSerialized();
    }

    setPollingLoopStarted(false);
    dbg("startPolling: exited");
  }

  async function kick() {
    if (stopRequested || !getPollingLoopStarted()) return false;
    await runPollingIterationSerialized();
    return true;
  }

  function stopPolling() {
    stopRequested = true;
  }

  return {
    handlePendingPayload,
    startPolling,
    kick,
    stopPolling,
  };
}
