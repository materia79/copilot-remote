import test from "node:test";
import assert from "node:assert/strict";
import { createQuestionRoutingHooks } from "./question-routing-hooks.mjs";

function createHooks(overrides = {}) {
  const apiCalls = [];
  const hooks = createQuestionRoutingHooks({
    api: async (...args) => {
      apiCalls.push(args);
      return {};
    },
    dbg: () => {},
    forwardRelayQuestion: async () => "answer",
    isAskUserTool: overrides.isAskUserTool || (() => false),
    normalizeActivityText: (value) => String(value || "").trim(),
    formatToolActivity: overrides.formatToolActivity || (() => null),
    extractQuestionChoices: () => [],
    getRelayTurnActive: overrides.getRelayTurnActive || (() => false),
    getActiveMessage: overrides.getActiveMessage || (() => null),
    setLastAskUserBridge: () => {},
    getLastActivityText: () => "",
    setLastActivityText: () => {},
    setPendingAskUserRequest: () => {},
  });
  return { hooks, apiCalls };
}

test("onPreToolUse always returns an allow decision when relay turn is inactive", async () => {
  const { hooks, apiCalls } = createHooks();
  const result = await hooks.onPreToolUse({ name: "some_tool" });

  assert.deepEqual(result, { permissionDecision: "allow" });
  assert.equal(apiCalls.length, 0);
});

test("onPreToolUse still logs relay activity when relay turn is active", async () => {
  const { hooks, apiCalls } = createHooks({
    getRelayTurnActive: () => true,
    getActiveMessage: () => ({
      id: "msg-1",
      conversationId: "conv-1",
      relayMode: "agent",
    }),
    isAskUserTool: () => true,
    formatToolActivity: () => "Tool (ask_user): clarification requested",
  });

  const result = await hooks.onPreToolUse({ name: "ask_user" });

  assert.deepEqual(result, { permissionDecision: "allow" });
  assert.equal(apiCalls.length, 2);
});
