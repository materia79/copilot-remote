import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseQuestionFromText,
  shouldForceFallbackQuestionBridge,
} from './question-text.mjs';

test('ignores fenced code when detecting fallback questions', () => {
  const text = [
    'Here are the lines:',
    '```js',
    'const value = foo?.bar ? "yes" : "no";',
    '1. not a choice',
    '2. still not a choice',
    '```',
  ].join('\n');

  const parsed = parseQuestionFromText(text);
  assert.equal(parsed.prompt, '');
  assert.deepEqual(parsed.choices, []);
  assert.deepEqual(shouldForceFallbackQuestionBridge(text), { shouldForce: false, parsed: null });
});

test('detects a natural question with numbered choices', () => {
  const text = [
    'Which option should I use?',
    '1. Use Windows Terminal',
    '2. Use PowerShell',
  ].join('\n');

  const parsed = parseQuestionFromText(text);
  assert.equal(parsed.prompt, 'Which option should I use?');
  assert.deepEqual(parsed.choices, ['Use Windows Terminal', 'Use PowerShell']);
  assert.equal(shouldForceFallbackQuestionBridge(text).shouldForce, true);
});

test('does not convert a declarative summary that merely contains a question mark', () => {
  const text = [
    'Found it. The bug was in the fallback bridge because it scanned any ? in prose.',
    ' - Added the helper module',
    ' - Updated the detector',
    ' - Added a regression test',
  ].join('\n');

  const parsed = parseQuestionFromText(text);
  assert.equal(parsed.prompt, '');
  assert.deepEqual(parsed.choices, []);
  assert.deepEqual(shouldForceFallbackQuestionBridge(text), { shouldForce: false, parsed: null });
});
