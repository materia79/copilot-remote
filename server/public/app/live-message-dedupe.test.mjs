import test from "node:test";
import assert from "node:assert/strict";
import { isLikelyLiveDuplicateMessage } from "./live-message-dedupe.mjs";
import { stripRelayPromptContext } from "./relay-prompt-sanitizer.mjs";

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

test("treats a wrapped relay user echo as a duplicate of the plain user text", () => {
  const polluted = [
    "[Relay mode: agent]",
    "Proceed as an interactive coding agent and use tools as needed.",
    "If you need clarification, pause and ask through the web relay instead of stalling silently.",
    "These instructions remain in effect until relay mode changes.",
    "# Relay Tool Guidance",
    "For any user-facing question or clarification, use the ask_user tool so the web relay can render question cards and buttons. Never ask questions in plain assistant text.",
    "In autopilot, still call ask_user when user input is truly blocking, because the relay bridge can surface the question even when the direct SDK question hook is bypassed.",
    "For relay restarts in extension-managed mode, require explicit user permission first, then use the authenticated localhost API `POST /api/relay/shutdown`. Do not restart by killing processes or using respawn scripts.",
    "Note: shutdown is queued and only completes when the current turn finishes, so it is pointless to wait for it to interrupt an active turn.",
    "Use `restart: true` in the request body when the user wants a real relay restart rather than a plain shutdown. Example request body: `{ \"reason\": \"manual-restart\", \"requestedBy\": \"localhost-api\", \"restart\": true }`.",
    "the user messages still duplicate clientside and now the first one does not have the mode instructions included but the second one has",
  ].join(" ");
  const duplicate = isLikelyLiveDuplicateMessage({
    incomingMessageId: "tx-u4",
    incomingMessage: {
      role: "user",
      mode: "agent",
      text: polluted,
      timestamp: "2026-05-25T14:40:35.000Z",
    },
    existingMessages: [
      {
        id: "db-u4",
        role: "user",
        mode: "agent",
        text: "the user messages still duplicate clientside and now the first one does not have the mode instructions included but the second one has",
        timestamp: "2026-05-25T14:40:17.901Z",
      },
    ],
    hasPendingTextMatch: true,
  });

  assert.equal(stripRelayPromptContext(polluted, "agent"), "the user messages still duplicate clientside and now the first one does not have the mode instructions included but the second one has");
  assert.equal(duplicate, true);
});
