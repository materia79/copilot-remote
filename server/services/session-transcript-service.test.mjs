import test from 'node:test';
import assert from 'node:assert/strict';

import { createSessionTranscriptService } from './session-transcript-service.mjs';

test('preserves intermediate assistant tool-request content as structured thoughts', () => {
  const service = createSessionTranscriptService({});
  const messages = service.parseSessionEventsToMessages([
    {
      id: 'intermediate',
      type: 'assistant.message',
      timestamp: '2026-01-01T00:00:01Z',
      data: {
        turnId: 'turn-1',
        content: 'First paragraph.\n\n- first item\n- second item',
        toolRequests: [{ id: 'tool-1' }],
      },
    },
    {
      id: 'final',
      type: 'assistant.message',
      timestamp: '2026-01-01T00:00:02Z',
      data: {
        messageId: 'assistant-1',
        turnId: 'turn-1',
        content: 'Completed response.',
      },
    },
  ]);

  assert.deepEqual(messages, [{
    id: 'assistant-1',
    role: 'assistant',
    text: 'Completed response.',
    model: undefined,
    activities: [],
    thoughts: [{
      reasoningId: 'session-thought-1',
      text: 'First paragraph.\n\n- first item\n- second item',
      done: true,
      timestamp: '2026-01-01T00:00:01Z',
    }],
    timestamp: '2026-01-01T00:00:02Z',
  }]);
});
