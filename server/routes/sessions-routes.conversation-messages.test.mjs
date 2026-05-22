import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildConversationMessages,
  normalizeConversationHistoryLimit,
  selectConversationHistoryPage,
} from './sessions-routes.mjs';

test('selectConversationHistoryPage clamps limit and advances cursors', () => {
  const messages = [
    { id: 'm1', role: 'user', text: 'one', timestamp: '2026-05-22T00:00:01.000Z' },
    { id: 'm2', role: 'assistant', text: 'two', timestamp: '2026-05-22T00:00:02.000Z' },
    { id: 'm3', role: 'user', text: 'three', timestamp: '2026-05-22T00:00:03.000Z' },
    { id: 'm4', role: 'assistant', text: 'four', timestamp: '2026-05-22T00:00:04.000Z' },
  ];

  assert.equal(normalizeConversationHistoryLimit(0), 1);
  assert.equal(normalizeConversationHistoryLimit(500), 100);
  assert.equal(normalizeConversationHistoryLimit('bad'), 20);

  const firstPage = selectConversationHistoryPage(messages, { limit: 2 });
  assert.deepEqual(firstPage.messages.map((message) => message.id), ['m3', 'm4']);
  assert.equal(firstPage.pageInfo.hasMore, true);
  assert.deepEqual(firstPage.pageInfo.nextCursor, {
    beforeMessageId: 'm3',
    beforeTimestamp: '2026-05-22T00:00:03.000Z',
  });

  const olderPage = selectConversationHistoryPage(messages, firstPage.pageInfo.nextCursor);
  assert.deepEqual(olderPage.messages.map((message) => message.id), ['m1', 'm2']);
  assert.equal(olderPage.pageInfo.hasMore, false);
  assert.deepEqual(olderPage.pageInfo.nextCursor, {
    beforeMessageId: 'm1',
    beforeTimestamp: '2026-05-22T00:00:01.000Z',
  });

  const timestampPage = selectConversationHistoryPage(messages, {
    limit: 2,
    beforeTimestamp: '2026-05-22T00:00:04.000Z',
  });
  assert.deepEqual(timestampPage.messages.map((message) => message.id), ['m2', 'm3']);
});

test('buildConversationMessages keeps DB rows canonical while backfilling transcript-only rows', () => {
  const responseMessageToSourceId = new Map([
    ['a1', 'u1'],
    ['a2', 'u2'],
  ]);

  const messages = buildConversationMessages({
    dbMessages: [
      {
        id: 'u2',
        role: 'user',
        text: 'db user 2',
        timestamp: '2026-05-22T00:00:03.000Z',
      },
      {
        id: 'a2',
        role: 'assistant',
        text: 'db assistant 2',
        timestamp: '2026-05-22T00:00:04.000Z',
      },
    ],
    transcriptMessages: [
      {
        id: 'u1',
        role: 'user',
        text: 'transcript user 1',
        timestamp: '2026-05-22T00:00:01.000Z',
      },
      {
        id: 'a1',
        role: 'assistant',
        text: 'transcript assistant 1',
        timestamp: '2026-05-22T00:00:02.000Z',
        activities: ['Thought: transcript progress'],
      },
      {
        id: 'u2',
        role: 'user',
        text: 'transcript user 2',
        timestamp: '2026-05-22T00:00:03.000Z',
      },
      {
        id: 'a2',
        role: 'assistant',
        text: 'transcript assistant 2',
        timestamp: '2026-05-22T00:00:04.000Z',
        activities: ['Tool (view): transcript file'],
      },
    ],
    responseMessageToSourceId,
  });

  assert.deepEqual(messages.map((message) => message.id), ['u1', 'a1', 'u2', 'a2']);
  assert.equal(messages.find((message) => message.id === 'u2')?.text, 'db user 2');
  assert.equal(messages.find((message) => message.id === 'a2')?.text, 'db assistant 2');
  assert.equal(messages.find((message) => message.id === 'a1')?.sourceMessageId, 'u1');
  assert.deepEqual(messages.find((message) => message.id === 'a1')?.activities, ['Thought: transcript progress']);

  const history = selectConversationHistoryPage(messages, { limit: 4 });
  assert.deepEqual(history.messages.map((message) => message.id), ['u1', 'a1', 'u2', 'a2']);
  assert.equal(history.pageInfo.hasMore, false);
});
