import test from 'node:test';
import assert from 'node:assert/strict';

import { shouldStageTmuxFallback } from './question-routing-hooks.mjs';

test('stages legacy ask_user calls for tmux fallback', () => {
  assert.equal(
    shouldStageTmuxFallback({
      toolArgs: { message: 'Continue?', choices: ['Yes', 'No'] },
    }),
    true,
  );
});

test('leaves valid and malformed structured calls for elicitation handling', () => {
  assert.equal(
    shouldStageTmuxFallback({
      toolArgs: {
        requestedSchema: {
          type: 'object',
          properties: { answer: { type: 'string' } },
        },
      },
    }),
    false,
  );
  assert.equal(
    shouldStageTmuxFallback({
      toolArgs: JSON.stringify({
        requestedSchema: { answer: { type: 'string' } },
      }),
    }),
    false,
  );
});
