import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const extensionPath = path.resolve(__dirname, "..", "extension.mjs");

test("extension critical path uses runtime session switch manager", () => {
  const source = fs.readFileSync(extensionPath, "utf8");
  assert.match(source, /createSessionRuntimeManager/);
  assert.match(source, /\.activateSession\(/);
});

