import test from 'node:test';
import assert from 'node:assert/strict';

import { stripRelayPromptContext } from './relay-prompt-sanitizer.mjs';

test('browser stripRelayPromptContext handles datetime and system reminder wrappers', () => {
  const input = [
    '<current_datetime>2026-07-05T15:00:07.419+00:00</current_datetime>',
    '<system_reminder><sql_tables>Available tables: todos</sql_tables></system_reminder>',
    '[Relay mode: ask] Ask clarifying questions first',
  ].join('\n');
  const output = stripRelayPromptContext(input, 'ask');
  assert.equal(output, 'Ask clarifying questions first');
});
