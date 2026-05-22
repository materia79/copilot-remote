import test from "node:test";
import assert from "node:assert/strict";
import { resolveSessionBinding, extractTargetSessionId } from "./session-binding.mjs";

test("extractTargetSessionId resolves runtime session id variants", () => {
  assert.equal(extractTargetSessionId({ sdkSessionId: "sdk-a" }), "sdk-a");
  assert.equal(extractTargetSessionId({ runtimeSession: { sdkSessionId: "sdk-b" } }), "sdk-b");
  assert.equal(extractTargetSessionId({ runtimeSession: { sdk_session_id: "sdk-c" } }), "sdk-c");
  assert.equal(extractTargetSessionId({ id: "sdk-d" }), null);
  assert.equal(extractTargetSessionId({}, "sdk-fallback"), null);
});

test("resolveSessionBinding returns ok when the session is available", () => {
  const result = resolveSessionBinding({
    conversationId: "conv-1",
    details: { sdkSessionId: "sdk-target" },
    activeSessionId: "sdk-target",
  });
  assert.equal(result.ok, true);
  assert.equal(result.switched, false);
  assert.equal(result.via, "session-liveness");
  assert.equal(result.activeSessionId, "sdk-target");
  assert.equal(result.targetSessionId, "sdk-target");
});

test("resolveSessionBinding returns claimable state when the conversation is unbound", () => {
  const result = resolveSessionBinding({
    conversationId: "conv-1",
    details: {},
    activeSessionId: "sdk-target",
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "target-session-missing");
  assert.equal(result.canClaim, true);
  assert.equal(result.activeSessionId, "sdk-target");
  assert.equal(result.targetSessionId, null);
});

test("resolveSessionBinding returns ok when ids match", () => {
  const result = resolveSessionBinding({
    conversationId: "conv-1",
    details: { runtimeSession: { sdk_session_id: "sdk-target" } },
    activeSessionId: "sdk-target",
  });
  assert.equal(result.ok, true);
  assert.equal(result.switched, false);
  assert.equal(result.via, "session-liveness");
});

test("resolveSessionBinding rejects a bound conversation owned by another SDK session", () => {
  const result = resolveSessionBinding({
    conversationId: "conv-1",
    details: { sdkSessionId: "sdk-old" },
    activeSessionId: "sdk-new",
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "session-binding-mismatch");
  assert.equal(result.retryable, true);
  assert.equal(result.targetSessionId, "sdk-old");
});

test("resolveSessionBinding handles missing required ids deterministically", () => {
  const noConversation = resolveSessionBinding({
    conversationId: "",
    details: { sdkSessionId: "sdk-target" },
    activeSessionId: "sdk-target",
  });
  assert.equal(noConversation.reason, "conversation-id-missing");
  assert.equal(noConversation.retryable, false);

  const noActive = resolveSessionBinding({
    conversationId: "conv-1",
    details: { sdkSessionId: "sdk-target" },
    activeSessionId: null,
  });
  assert.equal(noActive.reason, "active-session-missing");
  assert.equal(noActive.retryable, true);
});

