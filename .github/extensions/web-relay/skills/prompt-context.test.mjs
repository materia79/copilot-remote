import test from "node:test";
import assert from "node:assert/strict";
import { buildPromptWithMode } from "./prompt-context.mjs";

test("buildPromptWithMode includes relay mode instructions", () => {
  const prompt = buildPromptWithMode({ text: "Hello", relayMode: "ask" });
  assert.match(prompt, /\[Relay mode: ask\]/);
  assert.match(prompt, /Prioritize clarification questions/);
  assert.match(prompt, /Hello/);
});
