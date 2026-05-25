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

test("onPreToolUse publishes a plan board as soon as exit_plan_mode is requested", async () => {
  const { hooks, apiCalls } = createHooks({
    getRelayTurnActive: () => true,
    getActiveMessage: () => ({
      id: "msg-1",
      conversationId: "conv-1",
      relayMode: "plan",
    }),
    formatToolActivity: () => null,
  });

  const result = await hooks.onPreToolUse({
    name: "exit_plan_mode",
    input: {
      summary: "- Step one\n- Step two",
      actions: ["autopilot", "interactive", "exit_only"],
      recommendedAction: "interactive",
    },
  });

  assert.deepEqual(result, { permissionDecision: "allow" });
  assert.equal(apiCalls[0]?.[0], "POST");
  assert.equal(apiCalls[0]?.[1], "/api/relay-board");
  assert.equal(apiCalls[0]?.[2]?.title, "Plan ready for review");
  assert.equal(apiCalls[0]?.[2]?.body, "- Step one\n- Step two");
});

test("onPreToolUse publishes a plan board from stringified exit_plan_mode arguments", async () => {
  const { hooks, apiCalls } = createHooks({
    getRelayTurnActive: () => true,
    getActiveMessage: () => ({
      id: "msg-2",
      conversationId: "conv-2",
      relayMode: "plan",
    }),
    formatToolActivity: () => null,
  });

  const result = await hooks.onPreToolUse({
    name: "exit_plan_mode",
    arguments: JSON.stringify({
      summary: "- Parse real SDK args\n- Emit the board early",
      actions: ["interactive", "exit_only"],
      recommendedAction: "interactive",
    }),
  });

  assert.deepEqual(result, { permissionDecision: "allow" });
  assert.equal(apiCalls[0]?.[0], "POST");
  assert.equal(apiCalls[0]?.[1], "/api/relay-board");
  assert.equal(apiCalls[0]?.[2]?.body, "- Parse real SDK args\n- Emit the board early");
  assert.deepEqual(
    apiCalls[0]?.[2]?.actions?.map((item) => item.id),
    ["interactive", "exit_only"],
  );
  assert.equal(apiCalls[0]?.[2]?.recommendedAction, "interactive");
});

test("onPreToolUse publishes a plan board from nested request arguments", async () => {
  const { hooks, apiCalls } = createHooks({
    getRelayTurnActive: () => true,
    getActiveMessage: () => ({
      id: "msg-3",
      conversationId: "conv-3",
      relayMode: "plan",
    }),
    formatToolActivity: () => null,
  });

  const result = await hooks.onPreToolUse({
    name: "exit_plan_mode",
    request: JSON.stringify({
      arguments: JSON.stringify({
        summary: "- Handle nested payloads\n- Keep plan cards immediate",
        actions: ["autopilot", "interactive", "exit_only"],
        recommendedAction: "autopilot",
      }),
    }),
  });

  assert.deepEqual(result, { permissionDecision: "allow" });
  assert.equal(apiCalls[0]?.[1], "/api/relay-board");
  assert.equal(apiCalls[0]?.[2]?.body, "- Handle nested payloads\n- Keep plan cards immediate");
  assert.deepEqual(
    apiCalls[0]?.[2]?.actions?.map((item) => item.id),
    ["autopilot", "interactive", "exit_only"],
  );
  assert.equal(apiCalls[0]?.[2]?.recommendedAction, "autopilot");
});
