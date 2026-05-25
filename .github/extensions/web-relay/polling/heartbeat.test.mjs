import test from "node:test";
import assert from "node:assert/strict";
import { createHeartbeatController } from "./heartbeat.mjs";

test("heartbeat includes active queue message id while a relay turn is active", async () => {
  const calls = [];
  const controller = createHeartbeatController({
    api: async (...args) => {
      calls.push(args);
      return { ok: true };
    },
    pollMs: 1_000,
    getSessionReady: () => true,
    getHeartbeatTimer: () => null,
    setHeartbeatTimer: () => {},
    getActiveQueueMessageId: () => "msg-123",
  });

  const ok = await controller.pulseHeartbeat();

  assert.equal(ok, true);
  assert.deepEqual(calls, [["POST", "/api/heartbeat", { activeQueueMessageId: "msg-123" }]]);
});

test("heartbeat omits active queue message id when no relay turn is active", async () => {
  const calls = [];
  const controller = createHeartbeatController({
    api: async (...args) => {
      calls.push(args);
      return { ok: true };
    },
    pollMs: 1_000,
    getSessionReady: () => true,
    getHeartbeatTimer: () => null,
    setHeartbeatTimer: () => {},
    getActiveQueueMessageId: () => null,
  });

  const ok = await controller.pulseHeartbeat();

  assert.equal(ok, true);
  assert.deepEqual(calls, [["POST", "/api/heartbeat", {}]]);
});
