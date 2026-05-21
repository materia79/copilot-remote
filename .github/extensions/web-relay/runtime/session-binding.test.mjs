import test from "node:test";
import assert from "node:assert/strict";
import { resolveSessionBinding, extractTargetSessionId } from "./session-binding.mjs";

test("extractTargetSessionId resolves runtime session id variants", () => {
  assert.equal(extractTargetSessionId({ sdkSessionId: "sdk-a" }), "sdk-a");
  assert.equal(extractTargetSessionId({ runtimeSession: { sdkSessionId: "sdk-b" } }), "sdk-b");
  assert.equal(extractTargetSessionId({ runtimeSession: { sdk_session_id: "sdk-c" } }), "sdk-c");
});

test("resolveSessionBinding returns restart-required on mismatch", () => {
  const result = resolveSessionBinding({
    conversationId: "conv-1",
    details: { sdkSessionId: "sdk-target" },
    activeSessionId: "sdk-active",
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "restart-required");
  assert.equal(result.retryable, true);
  assert.equal(result.activeSessionId, "sdk-active");
  assert.equal(result.targetSessionId, "sdk-target");
});

test("resolveSessionBinding returns ok when ids match", () => {
  const result = resolveSessionBinding({
    conversationId: "conv-1",
    details: { runtimeSession: { sdk_session_id: "sdk-target" } },
    activeSessionId: "sdk-target",
  });
  assert.equal(result.ok, true);
  assert.equal(result.switched, false);
  assert.equal(result.via, "restart-orchestrator-binding");
});

test("resolveSessionBinding handles missing required ids deterministically", () => {
  const noConversation = resolveSessionBinding({
    conversationId: "",
    details: { sdkSessionId: "sdk-target" },
    activeSessionId: "sdk-target",
  });
  assert.equal(noConversation.reason, "conversation-id-missing");
  assert.equal(noConversation.retryable, false);

  const noTarget = resolveSessionBinding({
    conversationId: "conv-1",
    details: {},
    activeSessionId: "sdk-target",
  });
  assert.equal(noTarget.reason, "target-session-missing");
  assert.equal(noTarget.retryable, false);

  const noActive = resolveSessionBinding({
    conversationId: "conv-1",
    details: { sdkSessionId: "sdk-target" },
    activeSessionId: null,
  });
  assert.equal(noActive.reason, "active-session-missing");
  assert.equal(noActive.retryable, true);
});

