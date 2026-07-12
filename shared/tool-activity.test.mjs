import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractToolResultText,
  formatStoreMemoryActivity,
  formatToolResultActivity,
  formatVoteMemoryActivity,
} from './tool-activity.mjs';

test('extracts output_text value from web tool results', () => {
  assert.equal(
    extractToolResultText({
      type: 'output_text',
      text: { value: 'Search result preview' },
    }),
    'Search result preview',
  );
});

test('formats web search result activity', () => {
  assert.equal(
    formatToolResultActivity('web_search', {
      type: 'output_text',
      text: { value: 'A result from the search' },
    }),
    'Tool (web_search): output="A result from the search"',
  );
});

test('formats MCP-labelled web search names', () => {
  assert.equal(
    formatToolResultActivity('Web Search (MCP: github-mcp-server)', {
      output_text: { value: 'A result' },
    }),
    `Tool (Web Search (MCP: github-mcp-server)): output="A result"`,
  );
});

test('formats web fetch result activity and truncates output', () => {
  const result = formatToolResultActivity('web_fetch', {
    output_text: { value: 'x'.repeat(200) },
  }, 20);
  assert.equal(result, `Tool (web_fetch): output="${'x'.repeat(20)}"`);
});

test('formats all available store_memory fields', () => {
  assert.equal(
    formatStoreMemoryActivity('store_memory', {
      subject: 'tooling',
      fact: 'The relay exposes tool details.',
      citations: 'shared/tool-activity.mjs',
      reason: 'Useful for future implementation tasks.',
      scope: 'repository',
    }),
    'Tool (store_memory):\nsubject="tooling"\nfact="The relay exposes tool details."\ncitations="shared/tool-activity.mjs"\nreason="Useful for future implementation tasks."\nscope="repository"',
  );
});

test('formats partial store_memory payloads without empty fields', () => {
  assert.equal(
    formatStoreMemoryActivity('store_memory', { subject: 'tooling', scope: 'repository' }),
    'Tool (store_memory):\nsubject="tooling"\nscope="repository"',
  );
});

test('preserves the full store_memory field content', () => {
  const fact = 'long-fact-'.repeat(100);
  const activity = formatStoreMemoryActivity('store_memory', { fact });
  assert.match(activity, new RegExp(`fact="${fact}"`));
});

test('formats all available vote_memory fields', () => {
  assert.equal(
    formatVoteMemoryActivity('vote_memory', {
      fact: 'The relay exposes verbose memory activity.',
      direction: 'upvote',
      reason: 'This is useful for future debugging.',
      scope: 'repository',
    }),
    'Tool (vote_memory):\nfact="The relay exposes verbose memory activity."\ndirection="upvote"\nreason="This is useful for future debugging."\nscope="repository"',
  );
});

test('preserves the full vote_memory fact', () => {
  const fact = 'long-fact-'.repeat(100);
  const activity = formatVoteMemoryActivity('vote_memory', { fact, direction: 'downvote' });
  assert.match(activity, new RegExp(`fact="${fact}"`));
});
