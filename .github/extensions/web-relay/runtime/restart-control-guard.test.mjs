import assert from "node:assert/strict";
import test from "node:test";
import { evaluateRestartControlGuard } from "./restart-control-guard.mjs";

test("does not defer non-restart control types", () => {
  const result = evaluateRestartControlGuard({
    controlType: "noop",
    targetSessionId: "sdk-a",
    currentSessionId: "sdk-a",
    graceUntilMs: Date.now() + 10_000,
  });
  assert.equal(result.defer, false);
  assert.equal(result.reason, "not-restart-control");
});

test("defers stale restart control when already bound to target", () => {
  const result = evaluateRestartControlGuard({
    controlType: "restart_cli",
    targetSessionId: "sdk-a",
    currentSessionId: "sdk-a",
    force: false,
    nowMs: 100,
    graceUntilMs: 0,
  });
  assert.equal(result.defer, true);
  assert.equal(result.reason, "already-bound-to-target");
});

test("respects force restart even when already bound to target", () => {
  const result = evaluateRestartControlGuard({
    controlType: "restart_cli",
    targetSessionId: "sdk-a",
    currentSessionId: "sdk-a",
    force: true,
    nowMs: 100,
    graceUntilMs: 50,
  });
  assert.equal(result.defer, false);
  assert.equal(result.reason, "none");
});

test("defers restart control during startup grace window", () => {
  const result = evaluateRestartControlGuard({
    controlType: "restart_cli",
    targetSessionId: "sdk-b",
    currentSessionId: "sdk-a",
    nowMs: 1_000,
    graceUntilMs: 6_000,
  });
  assert.equal(result.defer, true);
  assert.equal(result.reason, "startup-grace-window");
});

test("allows restart control after startup grace window", () => {
  const result = evaluateRestartControlGuard({
    controlType: "restart_cli",
    targetSessionId: "sdk-b",
    currentSessionId: "sdk-a",
    nowMs: 10_000,
    graceUntilMs: 6_000,
  });
  assert.equal(result.defer, false);
  assert.equal(result.reason, "none");
});

