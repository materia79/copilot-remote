import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { parsePort, readConfig } from './relay.mjs';

test('readConfig returns empty config when file is missing', () => {
  const root = fs.mkdtempSync(path.resolve('server', '.tmp-relay-config-'));
  const missingPath = path.join(root, 'config.json');
  try {
    assert.deepEqual(readConfig(missingPath), {});
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('parsePort falls back cleanly when override is invalid', () => {
  assert.equal(parsePort(undefined, 3333), 3333);
  assert.equal(parsePort('4444', 3333), 4444);
  assert.equal(parsePort('bad', 3333), 3333);
});
