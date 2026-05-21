import fs from "fs";
import { getActiveSession } from "../runtime/session-registry.mjs";

const RETRYABLE_SESSION_FAILURE_REASONS = new Set([
  "conversation-load-failed",
  "active-session-missing",
  "restart-required",
  "switch-mismatch",
  "switch-call-transient-failure",
]);

const NON_RETRYABLE_SESSION_FAILURE_REASONS = new Set([
  "conversation-id-missing",
  "target-session-missing",
]);

const MAX_SWITCH_RETRIES = 2;

export function classifySwitchingFailure(sessionResolution) {
  const reason = String(sessionResolution?.reason || "unknown");
  if (typeof sessionResolution?.retryable === "boolean") {
    return { reason, retryable: sessionResolution.retryable };
  }
  if (NON_RETRYABLE_SESSION_FAILURE_REASONS.has(reason)) {
    return { reason, retryable: false };
  }
  if (RETRYABLE_SESSION_FAILURE_REASONS.has(reason)) {
    return { reason, retryable: true };
  }
  return { reason, retryable: false };
}

export function evaluateSwitchRetry({ retryable, attempts = 0, maxRetries = MAX_SWITCH_RETRIES } = {}) {
  const currentAttempts = Number.isFinite(Number(attempts)) ? Number(attempts) : 0;
  const cap = Number.isFinite(Number(maxRetries)) ? Number(maxRetries) : MAX_SWITCH_RETRIES;
  if (!retryable) {
    return { shouldRetry: false, attempts: currentAttempts, maxRetries: cap };
  }
  if (currentAttempts < cap) {
    return { shouldRetry: true, attempts: currentAttempts + 1, maxRetries: cap };
  }
  return { shouldRetry: false, attempts: currentAttempts, maxRetries: cap };
}

function composeSwitchFailureMessage({
  activeSdkSessionId,
  targetSdkSessionId,
  detail,
  reason,
  attempt,
  maxRetries,
  retryable,
}) {
  const trimmedDetail = String(detail || "").trim();
  const exhaustedText = retryable === false
    ? "No retry was attempted because this failure type is classified as non-retryable."
    : Number.isFinite(attempt) && Number.isFinite(maxRetries)
      ? `Switching was retried ${attempt}/${maxRetries} time(s) before this terminal failure.`
      : "Switching failed with a terminal outcome.";
  return [
    "I couldn't process this turn because the active SDK session does not match this conversation binding.",
    activeSdkSessionId ? `Active session: ${activeSdkSessionId.slice(0, 8)}…` : "Active session: unavailable.",
    targetSdkSessionId ? `Conversation session: ${targetSdkSessionId.slice(0, 8)}…` : "Conversation session: unavailable.",
    `Failure type: ${reason}.`,
    "The relay attempted in-process session switching via SDK resume/switch APIs but could not activate the target session.",
    exhaustedText,
    trimmedDetail || "Please retry from the matching session conversation or start a new turn in the active session.",
  ].join(" ");
}

function isImageAttachment(att) {
  const type = String(att?.type || "").toLowerCase();
  return type.startsWith("image/");
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
  extractQuestionPrompt,
  extractQuestionChoices,
  handleControl,
}) {
  let stopRequested = false;
  const switchFailureAttempts = new Map();

  function switchFailureKey(messageId, sessionResolution) {
    const reason = String(sessionResolution?.reason || "unknown").trim() || "unknown";
    const target = String(sessionResolution?.targetSessionId || "none").trim() || "none";
    return `${String(messageId || "").trim()}::${reason}::${target}`;
  }

  function clearSwitchFailureAttempts(messageId) {
    const prefix = `${String(messageId || "").trim()}::`;
    for (const key of switchFailureAttempts.keys()) {
      if (key.startsWith(prefix)) switchFailureAttempts.delete(key);
    }
  }

  function computeSwitchFailurePolicy(messageId, sessionResolution) {
    const classification = classifySwitchingFailure(sessionResolution);
    const key = switchFailureKey(messageId, sessionResolution);
    const previousAttempts = Number(switchFailureAttempts.get(key) || 0);
    const decision = evaluateSwitchRetry({
      retryable: classification.retryable,
      attempts: previousAttempts,
      maxRetries: MAX_SWITCH_RETRIES,
    });
    if (decision.shouldRetry) {
      switchFailureAttempts.set(key, decision.attempts);
    }
    const policy = { ...classification, ...decision };
    dbg(
      "session switch retry policy",
      `msgId=${String(messageId || "").trim() || "unknown"}`,
      `reason=${policy.reason || "unknown"}`,
      `retryable=${policy.retryable ? "yes" : "no"}`,
      `attempt=${policy.attempts}/${policy.maxRetries}`,
      `shouldRetry=${policy.shouldRetry ? "yes" : "no"}`,
      `active=${String(sessionResolution?.activeSessionId || "").trim() || "none"}`,
      `target=${String(sessionResolution?.targetSessionId || "").trim() || "none"}`,
    );
    return policy;
  }

  function stripMarkdown(text) {
    return String(text || "")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/\*([^*]+)\*/g, "$1")
      .replace(/^\s*>+\s?/gm, "")
      .trim();
  }

  function parseQuestionFromText(text) {
    const lines = String(text || "")
      .split(/\r?\n/)
      .map((line) => stripMarkdown(line))
      .filter(Boolean);

    let prompt = lines.find((line) => line.includes("?")) || "";
    if (!prompt) {
      prompt = lines.find((line) => /^the\s.+question[:]?$/i.test(line)) || lines[0] || "";
    }

    const choices = lines
      .map((line) => {
        // Match numbered (1. 1) - *) and lettered (A. A) a. a)) choices
        const numbered = line.match(/^\s*(?:\d+[\.\)]|[a-dA-D][\.\)]|[-*])\s+(.+)$/);
        return numbered ? stripMarkdown(numbered[1]) : "";
      })
      .filter(Boolean)
      .slice(0, 8);

    return {
      prompt: stripMarkdown(prompt),
      choices,
    };
  }

  function shouldForceFallbackQuestionBridge(assistantText) {
    const parsed = parseQuestionFromText(assistantText);
    // Only force fallback bridge for clear follow-up questions with structured choices
    // so normal assistant replies are not converted into question cards.
    const hasQuestionPrompt = String(parsed?.prompt || "").includes("?");
    const hasChoices = Array.isArray(parsed?.choices) && parsed.choices.length >= 2;
    if (!hasQuestionPrompt || !hasChoices) return { shouldForce: false, parsed: null };
    return { shouldForce: true, parsed };
  }

  async function waitForRelayQuestionAnswer(questionId, timeoutMs = 5 * 60_000, pollIntervalMs = 1500) {
    const started = Date.now();
    while (true) {
      const { question } = await api("GET", `/api/relay-question/${questionId}`);
      if (!question) throw new Error("Relay question missing");
      if (question.status === "answered") return String(question.answer || "").trim();
      if (question.status === "timed_out" || question.status === "cancelled") {
        throw new Error(`Relay question ${question.status}`);
      }
      if (Date.now() - started >= timeoutMs) {
        await api("POST", `/api/relay-question/${questionId}/timeout`, {}).catch(() => {});
        throw new Error("Relay question timed out");
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
    const answer = await waitForRelayQuestionAnswer(questionId);
    return {
      questionId,
      answer,
      prompt: parsed.prompt,
      choices: parsed.choices,
    };
  }

  async function continueAfterQuestionAnswer(message, { questionPrompt, choices, answer, assistantText = "" } = {}) {
    const normalizedChoices = Array.isArray(choices) ? choices : [];
    const lines = [
      "You are resuming a paused relay turn after asking the user a follow-up question.",
      `Original user request: ${String(message?.text || "").trim()}`,
      assistantText ? `Your last assistant reply before the pause: ${String(assistantText || "").trim()}` : "",
      `Question asked: ${String(questionPrompt || "").trim()}`,
      normalizedChoices.length
        ? `Choices shown to the user: ${normalizedChoices.map((choice, idx) => `${idx + 1}. ${String(choice || "").trim()}`).join(" | ")}`
        : "Choices: (not available)",
      `User's answer: ${String(answer || "").trim()}`,
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

    const created = await api("POST", "/api/relay-question", {
      queueId: message.id,
      messageId: message.id,
      conversationId: message.conversationId,
      mode: message.relayMode || "agent",
      prompt,
      choices,
      allowFreeform: choices.length === 0,
      sdk_session_id: activeSession?.sdkSessionId || undefined,
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
    const answer = await waitForRelayQuestionAnswer(questionId);
    return { questionId, answer, prompt, choices };
  }

  async function continueAfterAskUserAnswer(message, request, answer) {
    const prompt = extractQuestionPrompt(request);
    const choices = extractQuestionChoices(request);
    return continueAfterQuestionAnswer(message, {
      questionPrompt: prompt,
      choices,
      answer,
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

  async function startPolling() {
    if (getPollingLoopStarted()) return;
    setPollingLoopStarted(true);
    stopRequested = false;
    dbg("startPolling: entered");
    await session.log("🔄 Polling started", { ephemeral: true });

    while (!stopRequested) {
      await sleep(pollMs);

      if (!getSessionReady()) continue;

      try {
        await api("POST", "/api/heartbeat", {});
        await publishModelSnapshot("poll");

        if (getWaitingForAI()) continue;
        const processedDelete = await processPendingSdkSessionDeletes();
        if (processedDelete) continue;

        const pending = await api("GET", "/api/pending");
        const control = pending?.control || null;
        if (control && typeof handleControl === "function") {
          const handled = await handleControl(control, pending);
          if (handled) continue;
        }
        const { message } = pending || {};

        if (message) {
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
            continue;
          }

          const sessionResolution = await ensureSessionForConversation(message.conversationId, "dequeue");
          if (sessionResolution && !sessionResolution.ok) {
            const activeSdkSessionId = String(sessionResolution?.activeSessionId || "").trim();
            const targetSdkSessionId = String(sessionResolution?.targetSessionId || "").trim();
            const detail = String(sessionResolution?.message || "").trim();
            const policy = computeSwitchFailurePolicy(message.id, sessionResolution);
            dbg(
              "session binding check failed for msgId",
              message.id,
              `reason=${sessionResolution.reason || "unknown"}`,
              `retryable=${policy.retryable ? "yes" : "no"}`,
              `attempt=${policy.attempts}/${policy.maxRetries}`,
              `active=${activeSdkSessionId || "none"}`,
              `target=${targetSdkSessionId || "none"}`,
            );

            if (policy.shouldRetry) {
              await session.log(
                `⚠️ Session binding mismatch (retry ${policy.attempts}/${policy.maxRetries}); re-queuing turn`,
                { level: "warn" },
              );
              await api("POST", "/api/requeue", { messageId: message.id }).catch(() => {});
              setActiveMsg(null);
              continue;
            }

            await session.log("⚠️ Session binding reached terminal failure for this turn", { level: "warn" });
            const mismatchText = composeSwitchFailureMessage({
              activeSdkSessionId,
              targetSdkSessionId,
              detail,
              reason: policy.reason,
              attempt: policy.attempts,
              maxRetries: policy.maxRetries,
              retryable: policy.retryable,
            });
            await api("POST", "/api/response", {
              messageId: message.id,
              conversationId: message.conversationId,
              text: mismatchText,
              model: await getCurrentModelId() || message.model || null,
            }).catch(async () => {
              await api("POST", "/api/requeue", { messageId: message.id }).catch(() => {});
            });
            clearSwitchFailureAttempts(message.id);
            setActiveMsg(null);
            continue;
          }
          clearSwitchFailureAttempts(message.id);

          const synced = await syncActiveSession?.("dequeue", true);
          if (!synced) {
            dbg("session sync failed before processing msgId", message.id, "- requeueing");
            await session.log("⚠️ Session sync failed before processing; re-queuing turn", { level: "warn" });
            await api("POST", "/api/requeue", { messageId: message.id }).catch(() => {});
            setActiveMsg(null);
            continue;
          }
          setWaitingForAI(true);
          setRelayTurnActive(true, message);
          setLastActivityText("");
          setLastAskUserBridge(null);
          setPendingAskUserRequest?.(null);

          const label = message.isNewConversation ? "new conv" : "existing conv";
          await session.log(`📨 [${label}] Web message (${message.model || "default"} / ${message.relayMode || "agent"}): "${String(message.text || "").slice(0, 80)}"`);
          dbg("session.send: queuing for msgId", message.id);

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
            let lastStreamedSent = "";
            const pushRelayStream = async (text, done = false) => {
              const value = String(text || "");
              if (!value && !done) return;
              if (!done && value === lastStreamedSent) return;
              if (!done) lastStreamedSent = value;
              await api("POST", "/api/stream", {
                messageId: message.id,
                conversationId: message.conversationId,
                mode: message.relayMode || "agent",
                text: value,
                done: !!done,
              }).catch(() => {});
            };
            try {
              finalEvent = await sendAndWaitWithHardTimeout(payload, sendTimeout);
            } catch (attachmentError) {
              if (!sdkAttachments.length) throw attachmentError;
              dbg("sdk attachment delivery failed", `msgId=${message.id}`, attachmentError?.message || String(attachmentError));
              await api("POST", "/api/activity", {
                messageId: message.id,
                conversationId: message.conversationId,
                mode: message.relayMode || "agent",
                text: `Attachment delivery failed (${attachmentError?.message || "unknown error"}). Retrying without SDK attachments.`,
              }).catch(() => {});
              finalEvent = await sendAndWaitWithHardTimeout({ prompt }, sendTimeout);
            }
            dbg("session.sendAndWait: completed for msgId", message.id);

            const text = extractFinalText(finalEvent);
            const model = await getCurrentModelId() || finalEvent?.data?.model || finalEvent?.data?.modelId || message.model || null;
            const bridgedViaAskUser = !!getLastAskUserBridge?.();
            const pendingAskUserReq = !bridgedViaAskUser ? getPendingAskUserRequest?.() : null;

            // Safety-net fallback: ask_user was called but onUserInputRequest did not fire.
            // With onUserInputRequest registered as a top-level joinSession property this should
            // never trigger for normal relay turns — kept here only as a last-resort guard.
            if (!bridgedViaAskUser && pendingAskUserReq) {
              dbg("ask_user safety-net bridge triggered — onUserInputRequest was not called for msgId", message.id, "(unexpected; should fire via SDK handler now)");
              try {
                const bridged = await createRelayQuestionFromAskUserRequest(message, pendingAskUserReq);
                if (bridged?.questionId) {
                  let resumedText = "";
                  try {
                    resumedText = await continueAfterAskUserAnswer(message, pendingAskUserReq, bridged.answer);
                  } catch (evaluateErr) {
                    dbg("ask_user autopilot resume failed", `msgId=${message.id}`, evaluateErr?.message || String(evaluateErr));
                  }
                  await api("POST", "/api/response", {
                    messageId: message.id,
                    conversationId: message.conversationId,
                    text: resumedText || `Thanks — I received your answer: "${bridged.answer}". I hit a problem while resuming the turn from it.`,
                    model,
                  });
                  await session.log("✅ ask_user safety-net bridge: relay question card shown, answer received, turn resumed", { ephemeral: true });
                  continue;
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
                      assistantText: text,
                    });
                  } catch (evaluateErr) {
                    dbg("fallback question resume failed", `msgId=${message.id}`, evaluateErr?.message || String(evaluateErr));
                  }
                  await api("POST", "/api/response", {
                    messageId: message.id,
                    conversationId: message.conversationId,
                    text: resumedText || `Thanks — I received your answer: "${bridged.answer}". I hit a problem while resuming the turn from it.`,
                    model,
                  });
                  await session.log("✅ Converted plain-text question into relay bridge card and resumed the turn", { ephemeral: true });
                  continue;
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
              const lastActivityText = String(getLastActivityText?.() || "").trim();
              const fallbackText = lastActivityText
                ? [
                    "I couldn't capture a direct assistant reply, but the turn completed.",
                    "This can happen when the answer is routed through a tool or sub-agent instead of the main text channel.",
                    `Last activity seen: ${lastActivityText}`,
                  ].join(" ")
                : [
                    "I couldn't capture a direct assistant reply, but the turn completed.",
                    "This can happen when the answer is routed through a tool or sub-agent instead of the main text channel.",
                    "Try reopening the message or asking for the final answer explicitly if you need a cleaner response.",
                  ].join(" ");
              dbg("sendAndWait returned empty content; sending fallback response msgId", message.id);
              await session.log("⚠️ Empty assistant response — sending fallback reply instead of re-queuing", { level: "warn" });
              await pushRelayStream("", true);
              await api("POST", "/api/response", { messageId: message.id, conversationId: message.conversationId, text: fallbackText, model });
            } else {
              await pushRelayStream(text, true);
              await api("POST", "/api/response", { messageId: message.id, conversationId: message.conversationId, text, model });
              await session.log(`✅ Sent response to web (${text.length} chars)`, { ephemeral: true });
            }
          } catch (e) {
            dbg("sendAndWait ERROR for msgId", message.id, ":", e.message);
            await session.log(`❌ Response failed: ${e.message}; re-queuing`, { level: "error" });
            api("POST", "/api/requeue", { messageId: message.id }).catch(() => {});
          } finally {
            setLastActivityText("");
            setPendingAskUserRequest?.(null);
            clearRelayScopeState?.();
            setRelayTurnActive(false, message);
            setActiveMsg(null);
            setWaitingForAI(false);
          }
        }
      } catch {
        // Server may be down — keep retrying silently
      }
    }

    setPollingLoopStarted(false);
    dbg("startPolling: exited");
  }

  function stopPolling() {
    stopRequested = true;
  }

  return {
    startPolling,
    stopPolling,
  };
}
