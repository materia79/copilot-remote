import test from "node:test";
import assert from "node:assert/strict";
import {
  buildTerminalFailureText,
  isTerminalSendAndWaitError,
  normalizeTerminalSendAndWaitError,
} from "./send-and-wait-errors.mjs";

test("detects terminal missing tool output errors", () => {
  assert.equal(
    isTerminalSendAndWaitError(new Error("Execution failed: CAPIError: 400 No tool output found for function call call_X.")),
    true,
  );
  assert.equal(isTerminalSendAndWaitError(new Error("Timeout after 600000ms waiting for session.idle")), false);
});

test("normalizes terminal errors into stable surfacing fields", () => {
  const normalized = normalizeTerminalSendAndWaitError(
    new Error("Execution failed: CAPIError: 400 No tool output found for function call call_123 request_id=req_456."),
  );
  assert.equal(normalized?.terminal, true);
  assert.equal(normalized?.code, "missing-tool-output");
  assert.equal(normalized?.stableCode, "relay.missing-tool-output");
  assert.equal(normalized?.functionCallId, "call_123");
  assert.equal(normalized?.requestId, "req_456");
});

test("builds a user-facing terminal failure text", () => {
  const text = buildTerminalFailureText(new Error("Execution failed: CAPIError: 400 No tool output found for function call call_X."));
  assert.match(text, /error code:\s*relay\.missing-tool-output/i);
  assert.match(text, /Details:/i);
  assert.match(text, /ids:/i);
});
