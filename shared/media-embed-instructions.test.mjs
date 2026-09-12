import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MEDIA_EMBED_INSTRUCTION_HEADING,
  MEDIA_EMBED_INSTRUCTION_TEXT,
  renderMediaEmbedInstructionBlock,
  applyMediaEmbedInstructions,
} from './media-embed-instructions.mjs';

test('block renders heading plus text', () => {
  const block = renderMediaEmbedInstructionBlock();
  assert.ok(block.startsWith(MEDIA_EMBED_INSTRUCTION_HEADING));
  assert.ok(block.includes(MEDIA_EMBED_INSTRUCTION_TEXT));
});

test('the taught wording covers both platforms and the shared-view caveat', () => {
  assert.match(MEDIA_EMBED_INSTRUCTION_TEXT, /absolute path/);
  // Both path shapes appear as inline examples (win32 shape is example text,
  // not a filesystem fixture).
  assert.match(MEDIA_EMBED_INSTRUCTION_TEXT, /\/home\/user\//);
  assert.match(MEDIA_EMBED_INSTRUCTION_TEXT, /C:\\Users\\user\\/);
  assert.match(MEDIA_EMBED_INSTRUCTION_TEXT, /shared\/public/);
});

test('apply appends the block to a guidance document', () => {
  const applied = applyMediaEmbedInstructions('# Relay Tool Guidance\n\nAsk through ask_user.');
  assert.ok(applied.includes('Ask through ask_user.'));
  assert.ok(applied.includes(MEDIA_EMBED_INSTRUCTION_HEADING));
});

test('apply is idempotent and tolerates empty input', () => {
  const once = applyMediaEmbedInstructions('base');
  assert.equal(applyMediaEmbedInstructions(once), once);
  assert.equal(applyMediaEmbedInstructions(''), renderMediaEmbedInstructionBlock());
});
