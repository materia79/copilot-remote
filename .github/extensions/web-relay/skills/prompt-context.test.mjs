import test from "node:test";
import assert from "node:assert/strict";
import { buildPromptWithMode, stripPromptContextPrefix } from "./prompt-context.mjs";

test("buildPromptWithMode includes relay mode instructions", () => {
  const prompt = buildPromptWithMode({ text: "Hello", relayMode: "ask" });
  assert.match(prompt, /\[Relay mode: ask\]/);
  assert.match(prompt, /Prioritize clarification questions/);
  assert.match(prompt, /Hello/);
});

test("stripPromptContextPrefix removes echoed relay prompt context", () => {
  const message = {
    text: "the message bubbles show still the agent prompts",
    relayMode: "ask",
  };
  const prompt = buildPromptWithMode(message);
  const echoed = `${prompt} the message bubbles show still the agent prompts`;
  assert.equal(stripPromptContextPrefix(echoed, message), "the message bubbles show still the agent prompts");
  assert.equal(stripPromptContextPrefix("plain answer", message), "plain answer");
});
