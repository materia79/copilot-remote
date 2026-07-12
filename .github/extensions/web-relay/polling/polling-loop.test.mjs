import test from 'node:test';
import assert from 'node:assert/strict';

import { shouldUseTmuxAskUserFallback } from './polling-loop.mjs';

test('uses tmux fallback for legacy schema-free ask_user requests', () => {
  assert.equal(
    shouldUseTmuxAskUserFallback({
      toolName: 'ask_user',
      toolArgs: { message: 'Continue?', choices: ['Yes', 'No'] },
    }),
    true,
  );
});

test('does not use tmux fallback for structured ask_user requests', () => {
  assert.equal(
    shouldUseTmuxAskUserFallback({
      toolName: 'ask_user',
      toolArgs: {
        message: 'Continue?',
        requestedSchema: {
          type: 'object',
          properties: { answer: { type: 'string', enum: ['yes', 'no'] } },
          required: ['answer'],
        },
      },
    }),
    false,
  );
});

test('does not turn malformed structured requests into legacy question cards', () => {
  assert.equal(
    shouldUseTmuxAskUserFallback({
      toolName: 'ask_user',
      toolArgs: JSON.stringify({
        message: 'Continue?',
        requestedSchema: { answer: { type: 'string' } },
      }),
    }),
    false,
  );
});
