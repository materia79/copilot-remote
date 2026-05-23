import test from "node:test";
import assert from "node:assert/strict";
import { buildPromptWithMode, stripPromptContextPrefix } from "./prompt-context.mjs";

test("buildPromptWithMode includes relay mode instructions", () => {
  const prompt = buildPromptWithMode(
    { text: "Hello", relayMode: "ask" },
    "# Relay Tool Guidance",
  );
  assert.match(prompt, /\[Relay mode: ask\]/);
  assert.match(prompt, /Prioritize clarification questions/);
  assert.match(prompt, /These instructions remain in effect until relay mode changes/);
  assert.match(prompt, /Relay Tool Guidance/);
  assert.match(prompt, /Hello/);
});

test("buildPromptWithMode supports marker-only mode context", () => {
  const prompt = buildPromptWithMode(
    { text: "Hello", relayMode: "ask" },
    "# Relay Tool Guidance",
    { includeInstructions: false },
  );
  assert.match(prompt, /\[Relay mode: ask\]/);
  assert.doesNotMatch(prompt, /Prioritize clarification questions/);
  assert.doesNotMatch(prompt, /Relay Tool Guidance/);
  assert.match(prompt, /Hello/);
});

test("stripPromptContextPrefix removes echoed full and marker-only relay prompt context", () => {
  const message = {
    text: "the message bubbles show still the agent prompts",
    relayMode: "ask",
  };
  const fullPrompt = buildPromptWithMode(message, "# Relay Tool Guidance");
  const markerOnlyPrompt = buildPromptWithMode(message, "# Relay Tool Guidance", { includeInstructions: false });
  const echoedFull = `${fullPrompt} the message bubbles show still the agent prompts`;
  const echoedMarkerOnly = `${markerOnlyPrompt} the message bubbles show still the agent prompts`;
  assert.equal(
    stripPromptContextPrefix(echoedFull, message, "# Relay Tool Guidance"),
    "the message bubbles show still the agent prompts",
  );
  assert.equal(
    stripPromptContextPrefix(echoedMarkerOnly, message, "", markerOnlyPrompt),
    "the message bubbles show still the agent prompts",
  );
  assert.equal(stripPromptContextPrefix("plain answer", message), "plain answer");
});
