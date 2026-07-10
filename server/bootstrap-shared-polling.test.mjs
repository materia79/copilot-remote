import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const sourcePath = fileURLToPath(new URL('./public/app/bootstrap.js', import.meta.url));
const source = fs.readFileSync(sourcePath, 'utf8');

test('shared conversation polling has in-flight and sequence guards', () => {
  assert.match(source, /let sharedConversationPollInFlight = false;/);
  assert.match(source, /let sharedConversationRequestSeq = 0;/);
  assert.match(source, /let sharedConversationAppliedSeq = 0;/);
  assert.match(source, /if \(sharedConversationPollInFlight\) return;/);
  assert.match(source, /const requestSeq = \+\+sharedConversationRequestSeq;/);
  assert.match(source, /if \(requestSeq < sharedConversationAppliedSeq\) return;/);
  assert.match(source, /sharedConversationAppliedSeq = requestSeq;/);
  assert.match(source, /sharedConversationPollInFlight = false;/);
});
