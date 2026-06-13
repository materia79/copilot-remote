import { getActiveSession } from '../runtime/session-registry.mjs';
import { QUESTION_TIMEOUT_CONTINUATION_TEXT } from "../../../../shared/question-timeout.mjs";
import { extractRequestedSchema } from "../../../../shared/question-schema.mjs";

export function createQuestionBridge({
  api,
  dbg,
  sleep,
  questionWaitTimeoutMs,
  getQuestionWaitTimeoutMs,
  questionPollMs,
  getActiveMessage,
  extractQuestionPrompt,
  extractQuestionChoices,
  serializeRequest,
}) {
  function firstDefined(...values) {
    for (const value of values) {
      if (value !== undefined && value !== null) return value;
    }
    return undefined;
  }

  function extractAllowFreeform(request) {
    const value = firstDefined(
      request?.allow_freeform,
      request?.allowFreeform,
      request?.toolArgs?.allow_freeform,
      request?.toolArgs?.allowFreeform,
      request?.input?.allow_freeform,
      request?.input?.allowFreeform,
      request?.arguments?.allow_freeform,
      request?.arguments?.allowFreeform,
    );
    if (value === undefined) return undefined;
    return !!value;
  }

  function resolveQuestionWaitTimeoutMs(timeoutMs = null) {
    if (timeoutMs !== null && timeoutMs !== undefined) {
      const requested = Number(timeoutMs);
      if (Number.isFinite(requested) && requested >= 0) return requested;
    }
    if (typeof getQuestionWaitTimeoutMs === "function") {
      const dynamic = Number(getQuestionWaitTimeoutMs());
      if (Number.isFinite(dynamic) && dynamic >= 0) return dynamic;
    }
    const fallback = Number(questionWaitTimeoutMs);
    return Number.isFinite(fallback) && fallback >= 0 ? fallback : 0;
  }

  async function waitForRelayQuestionAnswer(questionId, timeoutMs = null) {
    const started = Date.now();
    const effectiveTimeoutMs = resolveQuestionWaitTimeoutMs(timeoutMs);

    while (true) {
      const { question } = await api("GET", `/api/relay-question/${questionId}`);
      if (!question) throw new Error("Relay question missing");
      if (question.status === "answered") {
        return {
          answer: String(question.answer || ""),
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
      if (Date.now() - started >= effectiveTimeoutMs) {
        await api("POST", `/api/relay-question/${questionId}/timeout`, {}).catch(() => {});
        return {
          answer: QUESTION_TIMEOUT_CONTINUATION_TEXT,
          structuredAnswer: null,
          timedOut: true,
        };
      }
      await sleep(questionPollMs);
    }
  }

  async function forwardRelayQuestion(request) {
    const activeMsg = getActiveMessage();
    const choices = extractQuestionChoices(request);
    const allowFreeform = extractAllowFreeform(request);
    const activeSession = getActiveSession();
    const questionTimeoutMs = resolveQuestionWaitTimeoutMs();
    const requestedSchema = extractRequestedSchema(request);
    const questionPayload = {
      queueId: activeMsg?.id,
      messageId: activeMsg?.id,
      conversationId: activeMsg?.conversationId,
      mode: activeMsg?.relayMode || "agent",
      prompt: extractQuestionPrompt(request),
      choices,
      allowFreeform: allowFreeform ?? !choices.length,
      requestedSchema: requestedSchema || undefined,
      sdk_session_id: activeSession?.sdkSessionId || undefined,
      timeout_ms: questionTimeoutMs,
      context: {
        source: "onUserInputRequest",
        rationale: "Agent requested clarification to continue this turn.",
        queueMessageId: activeMsg?.id || null,
        conversationId: activeMsg?.conversationId || null,
        relayMode: activeMsg?.relayMode || "agent",
      },
      request: serializeRequest(request),
    };

    const created = await api("POST", "/api/relay-question", questionPayload);
    const questionId = created?.question?.id;
    if (!questionId) {
      throw new Error("Relay question could not be created");
    }

    dbg(
      "relay question created",
      questionId,
      "for msgId",
      activeMsg.id,
      "prompt=",
      questionPayload.prompt,
      "choices=",
      String(questionPayload.choices?.length || 0),
      "fields=",
      String(requestedSchema?.properties ? Object.keys(requestedSchema.properties).length : 0),
    );

    return waitForRelayQuestionAnswer(questionId, questionTimeoutMs);
  }

  return {
    forwardRelayQuestion,
    waitForRelayQuestionAnswer,
  };
}
