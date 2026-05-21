import { getActiveSession } from '../runtime/session-registry.mjs';
import { QUESTION_TIMEOUT_CONTINUATION_TEXT } from "../../../../shared/question-timeout.mjs";

export function createQuestionBridge({
  api,
  dbg,
  sleep,
  questionWaitTimeoutMs,
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

  async function waitForRelayQuestionAnswer(questionId) {
    const started = Date.now();

    while (true) {
      const { question } = await api("GET", `/api/relay-question/${questionId}`);
      if (!question) throw new Error("Relay question missing");
      if (question.status === "answered") {
        return {
          answer: String(question.answer || ""),
          timedOut: false,
        };
      }
      if (question.status === "timed_out" || question.status === "cancelled") {
        return {
          answer: QUESTION_TIMEOUT_CONTINUATION_TEXT,
          timedOut: true,
        };
      }
      if (Date.now() - started >= questionWaitTimeoutMs) {
        await api("POST", `/api/relay-question/${questionId}/timeout`, {}).catch(() => {});
        return {
          answer: QUESTION_TIMEOUT_CONTINUATION_TEXT,
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
    const questionPayload = {
      queueId: activeMsg?.id,
      messageId: activeMsg?.id,
      conversationId: activeMsg?.conversationId,
      mode: activeMsg?.relayMode || "agent",
      prompt: extractQuestionPrompt(request),
      choices,
      allowFreeform: allowFreeform ?? !choices.length,
      sdk_session_id: activeSession?.sdkSessionId || undefined,
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
    );

    return waitForRelayQuestionAnswer(questionId);
  }

  return {
    forwardRelayQuestion,
    waitForRelayQuestionAnswer,
  };
}
