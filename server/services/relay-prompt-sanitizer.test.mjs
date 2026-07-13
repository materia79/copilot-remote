import test from 'node:test';
import assert from 'node:assert/strict';

import { stripRelayPromptContext } from './relay-prompt-sanitizer.mjs';

test('stripRelayPromptContext removes relay marker after current_datetime block', () => {
  const input = [
    '<current_datetime>2026-07-05T15:00:07.419+00:00</current_datetime>',
    '',
    '[Relay mode: agent] Explain test strategy',
  ].join('\n');
  const output = stripRelayPromptContext(input, 'agent');
  assert.equal(output, 'Explain test strategy');
});

test('stripRelayPromptContext removes relay marker after system_reminder block', () => {
  const input = [
    '<system_reminder>',
    '<sql_tables>Available tables: todos, todo_deps</sql_tables>',
    '</system_reminder>',
    '',
    '[Relay mode: plan] Draft a concise plan',
  ].join('\n');
  const output = stripRelayPromptContext(input, 'plan');
  assert.equal(output, 'Draft a concise plan');
});

test('stripRelayPromptContext keeps normal user text untouched', () => {
  const output = stripRelayPromptContext('Just a plain user message', 'agent');
  assert.equal(output, 'Just a plain user message');
});
