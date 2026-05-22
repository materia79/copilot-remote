import test from 'node:test';
import assert from 'node:assert/strict';
import { buildConversationMessages } from './sessions-routes.mjs';

test('buildConversationMessages keeps persisted user text over transcript text', () => {
  const messages = buildConversationMessages({
    dbMessages: [
      { id: 'u1', role: 'user', text: 'Select Agent', timestamp: '2026-05-22T00:00:00.000Z' },
      { id: 'a1', role: 'assistant', text: 'Clean reply', timestamp: '2026-05-22T00:00:01.000Z' },
    ],
    transcriptMessages: [
      { id: 'u1', role: 'user', text: '[Relay mode: agent] Select Agent', timestamp: '2026-05-22T00:00:00.000Z' },
      {
        id: 'a1',
        role: 'assistant',
        text: '[Relay mode: agent] Clean reply',
        activities: ['Tool (view): server/routes'],
        timestamp: '2026-05-22T00:00:01.000Z',
      },
    ],
  });

  assert.equal(messages[0].text, 'Select Agent');
  assert.equal(messages[1].text, 'Clean reply');
  assert.deepEqual(messages[1].activities, ['Tool (view): server/routes']);
});

test('buildConversationMessages falls back to transcript messages when no persisted rows exist', () => {
  const messages = buildConversationMessages({
    dbMessages: [],
    transcriptMessages: [
      { id: 'u1', role: 'user', text: 'Hello', timestamp: '2026-05-22T00:00:00.000Z' },
      { id: 'a1', role: 'assistant', text: 'Reply', timestamp: '2026-05-22T00:00:01.000Z' },
    ],
  });

  assert.equal(messages.length, 2);
  assert.equal(messages[0].text, 'Hello');
  assert.equal(messages[1].text, 'Reply');
});
