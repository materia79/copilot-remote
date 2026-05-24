import test from "node:test";
import assert from "node:assert/strict";
import {
  extractStreamTextFromEvent,
  shouldEmitRelayStreamUpdate,
  publishRelayStreamEvent,
  resolveEmptyFinalTextHandling,
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
