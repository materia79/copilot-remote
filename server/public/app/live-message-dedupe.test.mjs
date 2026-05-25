import test from "node:test";
import assert from "node:assert/strict";
import { isLikelyLiveDuplicateMessage } from "./live-message-dedupe.mjs";

test("treats same-text same-role recent message as a live duplicate", () => {
  const duplicate = isLikelyLiveDuplicateMessage({
    incomingMessageId: "tx-u1",
    incomingMessage: {
      role: "user",
      text: "when you are done, do a second pass please",
      timestamp: "2026-05-25T12:06:40.000Z",
    },
    existingMessages: [
      {
        id: "db-u1",
        role: "user",
        text: "when you are done, do a second pass please",
        timestamp: "2026-05-25T12:06:37.000Z",
      },
    ],
  });

  assert.equal(duplicate, true);
});

test("keeps a later same-text message outside the recent duplicate window", () => {
  const duplicate = isLikelyLiveDuplicateMessage({
    incomingMessageId: "tx-u2",
    incomingMessage: {
      role: "user",
      text: "ping",
      timestamp: "2026-05-25T12:20:00.000Z",
    },
    existingMessages: [
      {
        id: "db-u1",
        role: "user",
        text: "ping",
        timestamp: "2026-05-25T12:00:00.000Z",
      },
    ],
  });

  assert.equal(duplicate, false);
});

test("treats a still-pending same-text user echo as a live duplicate", () => {
  const duplicate = isLikelyLiveDuplicateMessage({
    incomingMessageId: "tx-u3",
    incomingMessage: {
      role: "user",
      text: "Check the codebase and the recent changes and update your plan",
      timestamp: "2026-05-25T12:22:33.582Z",
    },
    existingMessages: [
      {
        id: "db-u1",
        role: "user",
        text: "Check the codebase and the recent changes and update your plan",
        timestamp: "2026-05-25T12:21:55.021Z",
      },
    ],
    hasPendingTextMatch: true,
  });

  assert.equal(duplicate, true);
});

test("treats matching assistant sourceMessageId as a live duplicate", () => {
  const duplicate = isLikelyLiveDuplicateMessage({
    incomingMessageId: "assistant-b",
    incomingMessage: {
      role: "assistant",
      text: "Done.",
      timestamp: "2026-05-25T12:06:45.000Z",
      sourceMessageId: "user-1",
    },
    existingMessages: [
      {
        id: "assistant-a",
        role: "assistant",
        text: "Done.",
        timestamp: "2026-05-25T12:06:30.000Z",
        sourceMessageId: "user-1",
      },
    ],
  });

  assert.equal(duplicate, true);
});
