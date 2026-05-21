import test from "node:test";
import assert from "node:assert/strict";
import { sortConversationMessages } from "./thread-order.mjs";

test("sorts assistant replies back under the user message they answer", () => {
  const messages = sortConversationMessages([
    { id: "u1", role: "user", text: "one", timestamp: "2026-05-22T00:00:00.000Z" },
    { id: "u2", role: "user", text: "two", timestamp: "2026-05-22T00:00:01.000Z" },
    { id: "a1", role: "assistant", text: "reply", timestamp: "2026-05-22T00:00:02.000Z", sourceMessageId: "u1" },
  ]);

  assert.deepEqual(messages.map((m) => m.id), ["u1", "a1", "u2"]);
});
