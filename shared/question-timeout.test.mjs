import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_QUESTION_TIMEOUT_MS, QUESTION_TIMEOUT_CONTINUATION_TEXT } from "./question-timeout.mjs";

test("uses a 15 minute relay question timeout", () => {
  assert.equal(DEFAULT_QUESTION_TIMEOUT_MS, 15 * 60_000);
});

test("defines the timeout continuation text", () => {
  assert.match(QUESTION_TIMEOUT_CONTINUATION_TEXT, /No user response before timeout/i);
});
