import test from "node:test";
import assert from "node:assert/strict";
import { createQuestionBridge } from "./question-bridge.mjs";

test("question bridge timeout returns a continuation response", async () => {
  const calls = [];
  const bridge = createQuestionBridge({
    api: async (...args) => {
      calls.push(args);
      if (args[0] === "GET") {
        return { question: { status: "pending" } };
      }
      return {};
    },
    dbg: () => {},
    sleep: async () => {},
    questionWaitTimeoutMs: 0,
    questionPollMs: 0,
    getActiveMessage: () => ({ id: "msg-1", conversationId: "conv-1", relayMode: "agent" }),
    extractQuestionPrompt: () => "Need a clarification?",
    extractQuestionChoices: () => [],
    serializeRequest: () => null,
  });

  const result = await bridge.waitForRelayQuestionAnswer("question-1");

  assert.equal(result.timedOut, true);
  assert.match(result.answer, /No user response before timeout/i);
  assert.equal(calls.some(([method, path]) => method === "POST" && path.endsWith("/timeout")), true);
});
