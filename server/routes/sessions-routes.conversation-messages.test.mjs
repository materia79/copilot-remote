import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildConversationMessages,
  normalizeConversationHistoryLimit,
  selectConversationHistoryPage,
} from './sessions-routes.mjs';
import { stripRelayPromptContext } from '../services/relay-prompt-sanitizer.mjs';

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

test('buildConversationMessages keeps DB rows canonical when persisted history exists', () => {
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

  assert.deepEqual(messages.map((message) => message.id), ['u2', 'a2']);
  assert.equal(messages.find((message) => message.id === 'u2')?.text, 'db user 2');
  assert.equal(messages.find((message) => message.id === 'a2')?.text, 'db assistant 2');
  assert.equal(messages.find((message) => message.id === 'a2')?.sourceMessageId, 'u2');
  assert.deepEqual(messages.find((message) => message.id === 'a2')?.activities, ['Tool (view): transcript file']);

  const history = selectConversationHistoryPage(messages, { limit: 4 });
  assert.deepEqual(history.messages.map((message) => message.id), ['u2', 'a2']);
  assert.equal(history.pageInfo.hasMore, false);
});

test('buildConversationMessages falls back to transcript rows when no DB messages exist', () => {
  const messages = buildConversationMessages({
    dbMessages: [],
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
    ],
  });

  assert.deepEqual(messages.map((message) => message.id), ['u1', 'a1']);
  assert.equal(messages.find((message) => message.id === 'a1')?.activities.length, 1);
});

test('stripRelayPromptContext removes the relay banner from visible text', () => {
  const message = {
    text: 'after a refresh it even came twice...',
    mode: 'ask',
  };
  const polluted = [
    '[Relay mode: ask]',
    'Prioritize clarification questions before doing any implementation work.',
    'If the request is ambiguous or underspecified, pause and ask through the web relay before making assumptions.',
    'Do not make broad assumptions when a question would materially change the result.',
    '# Relay Tool Guidance',
    'For any user-facing question or clarification, use the ask_user tool so the web relay can render question cards and buttons. Never ask questions in plain assistant text.',
    'In autopilot, still call ask_user when user input is truly blocking, because the relay bridge can surface the question even when the direct SDK question hook is bypassed.',
    'after a refresh it even came twice...',
  ].join(' ');

  assert.equal(stripRelayPromptContext(polluted, message.mode), 'after a refresh it even came twice...');
  assert.equal(stripRelayPromptContext('plain text', message.mode), 'plain text');
});
