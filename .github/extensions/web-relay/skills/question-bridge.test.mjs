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
    getQuestionWaitTimeoutMs: () => 0,
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

test("question bridge sends the active turn timeout when creating relay questions", async () => {
  const calls = [];
  const bridge = createQuestionBridge({
    api: async (...args) => {
      calls.push(args);
      if (args[0] === "POST" && args[1] === "/api/relay-question") {
        return { question: { id: "question-1" } };
      }
      if (args[0] === "GET") {
        return { question: { status: "answered", answer: "Yes" } };
      }
      return {};
    },
    dbg: () => {},
    sleep: async () => {},
    getQuestionWaitTimeoutMs: () => 7_200_000,
    questionPollMs: 0,
    getActiveMessage: () => ({ id: "msg-1", conversationId: "conv-1", relayMode: "agent" }),
    extractQuestionPrompt: () => "Need a clarification?",
    extractQuestionChoices: () => ["Yes", "No"],
    serializeRequest: () => ({ hello: "world" }),
  });

  const result = await bridge.forwardRelayQuestion({});
  const createCall = calls.find(([method, path]) => method === "POST" && path === "/api/relay-question");

  assert.equal(result.answer, "Yes");
  assert.equal(createCall?.[2]?.timeout_ms, 7_200_000);
});
