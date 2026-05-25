import test from "node:test";
import assert from "node:assert/strict";
import {
  createPollingLoop,
  extractStreamTextFromEvent,
  shouldEmitRelayStreamUpdate,
  publishRelayStreamEvent,
  resolveEmptyFinalTextHandling,
  buildPlanReadyBoardPayload,
} from "./polling-loop.mjs";

test("extractStreamTextFromEvent prefers the longest nested stream text", () => {
  const event = {
    data: {
      text: "short",
      output: {
        content: [
          { text: "a bit longer" },
          { delta: { text: "this is the longest streamed text candidate" } },
        ],
      },
    },
  };

  assert.equal(
    extractStreamTextFromEvent(event),
    "this is the longest streamed text candidate",
  );
});

test("shouldEmitRelayStreamUpdate skips duplicates and emits meaningful growth", () => {
  assert.equal(shouldEmitRelayStreamUpdate("", ""), false);
  assert.equal(shouldEmitRelayStreamUpdate("hello", ""), true);
  assert.equal(shouldEmitRelayStreamUpdate("hello", "hello"), false);
  assert.equal(
    shouldEmitRelayStreamUpdate("hello world, this is a much longer chunk", "hello"),
    true,
  );
  assert.equal(shouldEmitRelayStreamUpdate("hello world.", "hello world"), true);
});

test("shouldEmitRelayStreamUpdate allows non-monotonic rewrites", () => {
  assert.equal(
    shouldEmitRelayStreamUpdate("Rewritten final sentence", "Rewritten final sentence in progress"),
    true,
  );
});

test("publishRelayStreamEvent returns ok=true on success", async () => {
  const calls = [];
  const api = async (method, path, body) => {
    calls.push({ method, path, body });
    return { ok: true };
  };
  const published = await publishRelayStreamEvent({
    api,
    message: { id: "msg-1", conversationId: "conv-1", relayMode: "agent" },
    text: "partial",
    done: false,
  });
  assert.equal(published.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/api/stream");
  assert.equal(calls[0].body?.text, "partial");
});

test("publishRelayStreamEvent returns ok=false on failure", async () => {
  const api = async () => {
    throw new Error("network down");
  };
  const logs = [];
  const published = await publishRelayStreamEvent({
    api,
    message: { id: "msg-2", conversationId: "conv-2", relayMode: "agent" },
    text: "partial",
    done: false,
    dbg: (...args) => logs.push(args.join(" ")),
  });
  assert.equal(published.ok, false);
  assert.equal(published.text, "partial");
  assert.equal(logs.length > 0, true);
});

test("resolveEmptyFinalTextHandling prefers streamed text over fallback", () => {
  const resolved = resolveEmptyFinalTextHandling({
    lastStreamedSent: "streamed final",
    lastActivityText: "Tool (view) read file",
  });
  assert.deepEqual(resolved, { action: "use_stream_text", text: "streamed final" });
});

test("resolveEmptyFinalTextHandling requeues when no stream text exists", () => {
  const resolved = resolveEmptyFinalTextHandling({
    lastStreamedSent: "",
    lastActivityText: "Tool (task) running",
  });
  assert.equal(resolved.action, "requeue");
  assert.match(String(resolved.reason || ""), /^empty-final-text:/);
});

test("buildPlanReadyBoardPayload extracts exit_plan_mode summary and actions", () => {
  const payload = buildPlanReadyBoardPayload({
    finalEvent: {
      data: {
        tool_calls: [
          {
            name: "exit_plan_mode",
            input: {
              summary: "- Implement A\n- Validate B",
              actions: ["autopilot", "interactive", "exit_only"],
              recommendedAction: "autopilot",
            },
          },
        ],
      },
    },
    message: { id: "msg-1", conversationId: "conv-1", relayMode: "plan" },
    finalText: "fallback",
  });
  assert.equal(payload?.boardType, "plan_ready");
  assert.equal(payload?.title, "Plan ready for review");
  assert.equal(payload?.body, "- Implement A\n- Validate B");
  assert.equal(payload?.recommendedAction, "autopilot");
  assert.deepEqual(
    payload?.actions?.map((item) => item.id),
    ["autopilot", "interactive", "exit_only"],
  );
});

test("buildPlanReadyBoardPayload returns null when no exit_plan_mode call exists", () => {
  const payload = buildPlanReadyBoardPayload({
    finalEvent: { data: { text: "done" } },
    message: { id: "msg-2", conversationId: "conv-2", relayMode: "agent" },
    finalText: "done",
  });
  assert.equal(payload, null);
});

test("buildPlanReadyBoardPayload also extracts task_complete summaries", () => {
  const payload = buildPlanReadyBoardPayload({
    finalEvent: {
      data: {
        tool_calls: [
          {
            name: "task_complete",
            input: {
              summary: "- Plan drafted\n- Awaiting user decision",
            },
          },
        ],
      },
    },
    message: { id: "msg-3", conversationId: "conv-3", relayMode: "agent" },
    finalText: "",
  });
  assert.equal(payload?.boardType, "plan_ready");
  assert.equal(payload?.body, "- Plan drafted\n- Awaiting user decision");
  assert.equal(payload?.context?.source, "task_complete");
  assert.deepEqual(
    payload?.actions?.map((item) => item.id),
    ["autopilot", "interactive", "exit_only"],
  );
});

test("buildPlanReadyBoardPayload falls back to plan-mode final text when no tool payload is exposed", () => {
  const payload = buildPlanReadyBoardPayload({
    finalEvent: { data: { text: "" } },
    message: { id: "msg-4", conversationId: "conv-4", relayMode: "plan" },
    finalText: "- Inspect relay payload shape\n- Publish a review card\n- Re-test in the relay UI",
  });
  assert.equal(payload?.boardType, "plan_ready");
  assert.equal(payload?.body, "- Inspect relay payload shape\n- Publish a review card\n- Re-test in the relay UI");
  assert.equal(payload?.context?.source, "plan-mode-fallback");
  assert.deepEqual(
    payload?.actions?.map((item) => item.id),
    ["autopilot", "interactive", "exit_only"],
  );
});

test("buildPlanReadyBoardPayload does not treat arbitrary plan-mode text as a review card", () => {
  const payload = buildPlanReadyBoardPayload({
    finalEvent: { data: { text: "" } },
    message: { id: "msg-5", conversationId: "conv-5", relayMode: "plan" },
    finalText: "ask_user is still failing right now",
  });
  assert.equal(payload, null);
});

test("createPollingLoop uses stable sendAndWait path for relay turns", async () => {
  let pollingStarted = false;
  let waitingForAI = false;
  let sleepCalls = 0;
  let pendingCalls = 0;
  let sendAndWaitCalls = 0;
  let streamingCalls = 0;
  let responsePayload = null;
  let controller = null;

  const api = async (method, path, body) => {
    if (method === "POST" && path === "/api/heartbeat") return {};
    if (method === "GET" && path === "/api/status") return {};
    if (method === "GET" && path === "/api/sdk-session-delete/pending") return {};
    if (method === "GET" && path === "/api/pending") {
      pendingCalls += 1;
      if (pendingCalls === 1) {
        return {
          message: {
            id: "msg-1",
            conversationId: "conv-1",
            relayMode: "ask",
            text: "hello",
          },
        };
      }
      return {};
    }
    if (method === "POST" && path === "/api/stream") return { ok: true };
    if (method === "POST" && path === "/api/response") {
      responsePayload = body;
      return {};
    }
    if (method === "POST" && path === "/api/activity") return {};
    return {};
  };

  const sleep = async () => {
    sleepCalls += 1;
    if (sleepCalls >= 2) controller?.stopPolling();
  };

  controller = createPollingLoop({
    sleep,
    pollMs: 0,
    api,
    dbg: () => {},
    session: {
      log: async () => {},
      abort: async () => {},
    },
    sendTimeout: 100,
    publishModelSnapshot: async () => {},
    setModelForMessage: async () => ({ switched: false, current: null, after: null }),
    buildPromptWithRelayContext: async (message) => message.text,
    sendAndWaitWithHardTimeout: async () => {
      sendAndWaitCalls += 1;
      return { data: { text: "final reply" } };
    },
    sendWithBestEffortStreaming: async () => {
      streamingCalls += 1;
      return "opaque-id";
    },
    extractFinalText: (event) => event?.data?.text || "",
    getLastActivityText: () => "",
    getCurrentModelId: async () => null,
    getPreferredConversationSessionMode: () => "isolated",
    getSupportsIsolatedSessions: () => true,
    getWarnedConversationModeFallback: () => false,
    setWarnedConversationModeFallback: () => {},
    getPollingLoopStarted: () => pollingStarted,
    setPollingLoopStarted: (value) => {
      pollingStarted = value;
    },
    getSessionReady: () => true,
    getWaitingForAI: () => waitingForAI,
    getLastAskUserBridge: () => null,
    syncActiveSession: async () => true,
    ensureSessionForConversation: async () => ({ ok: true }),
    setActiveMsg: () => {},
    setWaitingForAI: (value) => {
      waitingForAI = value;
    },
    setRelayTurnActive: () => {},
    setLastActivityText: () => {},
    setLastAskUserBridge: () => {},
    getPendingAskUserRequest: () => null,
    setPendingAskUserRequest: () => {},
    clearRelayScopeState: () => {},
    extractQuestionPrompt: () => "",
    extractQuestionChoices: () => [],
    handleControl: async () => false,
  });

  await controller.startPolling();

  assert.equal(sendAndWaitCalls, 1);
  assert.equal(streamingCalls, 0);
  assert.equal(responsePayload?.text, "final reply");
});
