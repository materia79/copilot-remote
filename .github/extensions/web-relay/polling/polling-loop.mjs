import fs from "fs";
import { buildTerminalFailureText, isTerminalSendAndWaitError } from "../runtime/send-and-wait-errors.mjs";
import { getActiveSession } from "../runtime/session-registry.mjs";
import { DEFAULT_QUESTION_TIMEOUT_MS } from "../../../../shared/question-timeout.mjs";
import { QUESTION_TIMEOUT_CONTINUATION_TEXT } from "../../../../shared/question-timeout.mjs";
import { stripPromptContextPrefix } from "../skills/prompt-context.mjs";
import {
  parseQuestionFromText,
  shouldForceFallbackQuestionBridge,
} from "./question-text.mjs";

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
  extractQuestionPrompt,
  extractQuestionChoices,
  handleControl,
}) {
  let stopRequested = false;

  async function waitForRelayQuestionAnswer(questionId, timeoutMs = DEFAULT_QUESTION_TIMEOUT_MS, pollIntervalMs = 1500) {
    const started = Date.now();
    while (true) {
      const { question } = await api("GET", `/api/relay-question/${questionId}`);
      if (!question) throw new Error("Relay question missing");
      if (question.status === "answered") {
        return {
          answer: String(question.answer || "").trim(),
          timedOut: false,
        };
      }
      if (question.status === "timed_out" || question.status === "cancelled") {
        return {
          answer: QUESTION_TIMEOUT_CONTINUATION_TEXT,
          timedOut: true,
        };
      }
      if (Date.now() - started >= timeoutMs) {
        await api("POST", `/api/relay-question/${questionId}/timeout`, {}).catch(() => {});
        return {
          answer: QUESTION_TIMEOUT_CONTINUATION_TEXT,
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

    const created = await api("POST", "/api/relay-question", {
      queueId: message.id,
      messageId: message.id,
      conversationId: message.conversationId,
      mode: message.relayMode || "agent",
      prompt,
      choices,
      allowFreeform: choices.length === 0,
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
    return { questionId, prompt, choices, answer: result.answer, timedOut: result.timedOut };
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
            }
            setActiveMsg(null);
            continue;
          }

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
            let lastWorkerStatusCheckAt = 0;
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
            const onStreamingEvent = async (event) => {
              const streamedText = extractStreamTextFromEvent(event);
              if (!shouldEmitRelayStreamUpdate(streamedText, lastStreamedSent)) return;
              await pushRelayStream(streamedText, false);
            };
            const inspectActiveWorkerLiveness = async () => {
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
            try {
              if (typeof sendWithBestEffortStreaming === "function") {
                finalEvent = await sendWithBestEffortStreaming(payload, sendTimeout, onStreamingEvent, {
                  onWaiting: inspectActiveWorkerLiveness,
                });
              } else {
                finalEvent = await sendAndWaitWithHardTimeout(payload, sendTimeout);
              }
            } catch (attachmentError) {
              if (!sdkAttachments.length) throw attachmentError;
              dbg("sdk attachment delivery failed", `msgId=${message.id}`, attachmentError?.message || String(attachmentError));
              await api("POST", "/api/activity", {
                messageId: message.id,
                conversationId: message.conversationId,
                mode: message.relayMode || "agent",
                text: `Attachment delivery failed (${attachmentError?.message || "unknown error"}). Retrying without SDK attachments.`,
              }).catch(() => {});
              if (typeof sendWithBestEffortStreaming === "function") {
                finalEvent = await sendWithBestEffortStreaming({ prompt }, sendTimeout, onStreamingEvent, {
                  onWaiting: inspectActiveWorkerLiveness,
                });
              } else {
                finalEvent = await sendAndWaitWithHardTimeout({ prompt }, sendTimeout);
              }
            }
            dbg("session.sendAndWait: completed for msgId", message.id);

            const text = stripPromptContextPrefix(extractFinalText(finalEvent), message, "", prompt);
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
              dbg("sendAndWait ERROR for msgId", message.id, ":", e.message);
              if (isTerminalSendAndWaitError(e)) {
                const failureText = buildTerminalFailureText(e);
                await session.log("❌ Terminal SDK/tool-output error — marking turn failed", { level: "error" });
                await pushRelayStream(lastStreamedSent, true);
                await api("POST", "/api/response", {
                  messageId: message.id,
                  conversationId: message.conversationId,
                  text: failureText,
                  model: await getCurrentModelId() || message.model || null,
              }).catch(async () => {
                await api("POST", "/api/requeue", { messageId: message.id }).catch(() => {});
              });
            } else if (e?.code === "RELAY_WORKER_UNAVAILABLE" && e?.terminalFailure) {
              await session.log("⚠️ Session worker became unavailable during the turn — marking it failed", { level: "warn" });
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
              await session.log(`❌ Response failed: ${e.message}; re-queuing`, { level: "error" });
              api("POST", "/api/requeue", { messageId: message.id }).catch(() => {});
            }
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
