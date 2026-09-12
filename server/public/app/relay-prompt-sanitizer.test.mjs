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

test('browser stripRelayPromptContext drops a leading media-embed guidance block', () => {
  const input = [
    '## Embedding media in replies',
    '',
    'To show the user an image, video, or audio clip inline in a reply, write a markdown image whose target is the absolute path.',
    '',
    '[Relay mode: ask] Prioritize clarification questions before implementation work.',
    '',
    'hello',
  ].join('\n');
  const output = stripRelayPromptContext(input, 'ask');
  assert.doesNotMatch(output, /Embedding media in replies/);
  assert.doesNotMatch(output, /^\[Relay mode/);
  assert.match(output, /hello$/);
});
