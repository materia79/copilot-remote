import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildCopilotMessageOptions } from './copilot-attachments.mjs';

/** An `fs` stand-in: only the listed paths exist, with the given contents. */
function fakeFs(files = {}) {
  return {
    existsSync: (p) => Object.prototype.hasOwnProperty.call(files, p),
    readFileSync: (p) => {
      if (!Object.prototype.hasOwnProperty.call(files, p)) throw new Error(`ENOENT: ${p}`);
      return files[p];
    },
  };
}

test('a message with no attachments is just its text', () => {
  assert.deepEqual(buildCopilotMessageOptions({ text: 'hello' }), { prompt: 'hello', attachments: [] });
  assert.deepEqual(buildCopilotMessageOptions({ text: '', attachments: [] }), { prompt: '', attachments: [] });
  assert.deepEqual(buildCopilotMessageOptions(null), { prompt: '', attachments: [] });
});

test('a readable image is embedded as a blob attachment and noted in the prompt', () => {
  const bytes = Buffer.from('png-bytes');
  const { prompt, attachments } = buildCopilotMessageOptions({
    text: 'what is this?',
    attachments: [{ name: 'shot.png', type: 'image/png', path: '/w/shot.png' }],
  }, { fsImpl: fakeFs({ '/w/shot.png': bytes }) });

  assert.deepEqual(attachments, [{
    type: 'blob',
    data: bytes.toString('base64'),
    mimeType: 'image/png',
    displayName: 'shot.png',
  }]);
  assert.equal(prompt, 'what is this?\n\nAttached image "shot.png" (image/png) is embedded in this message.');
});

test('an oversized image falls back to a file reference the agent can open', () => {
  const { prompt, attachments } = buildCopilotMessageOptions({
    text: 'look',
    attachments: [{ name: 'huge.png', type: 'image/png', path: '/w/huge.png' }],
  }, { fsImpl: fakeFs({ '/w/huge.png': Buffer.alloc(64) }), maxInlineImageBytes: 8 });

  assert.deepEqual(attachments, [{ type: 'file', path: '/w/huge.png', displayName: 'huge.png' }]);
  assert.match(prompt, /Attached image "huge\.png" \(image\/png\): \/w\/huge\.png/);
});

test('an image that exists only as a data URL is still embedded', () => {
  const { attachments } = buildCopilotMessageOptions({
    text: 'pasted',
    attachments: [{ name: 'paste.png', type: 'image/png', dataUrl: 'data:image/png;base64,AAEC' }],
  }, { fsImpl: fakeFs({}) });

  assert.deepEqual(attachments, [{ type: 'blob', data: 'AAEC', mimeType: 'image/png', displayName: 'paste.png' }]);
});

test('the decoded ceiling applies to data URLs exactly at the boundary', () => {
  // Audit #33: disk images enforced the 5 MiB DECODED limit, data URLs did
  // not, so a ~9 MiB decoded image could ride in under the server's larger
  // encoded ceiling. Boundary: exactly at the limit embeds, one byte over
  // does not.
  const max = 8;
  const atLimit = `data:image/png;base64,${Buffer.alloc(max, 1).toString('base64')}`;
  const overLimit = `data:image/png;base64,${Buffer.alloc(max + 1, 1).toString('base64')}`;

  const embedded = buildCopilotMessageOptions({
    text: 'x',
    attachments: [{ name: 'ok.png', type: 'image/png', dataUrl: atLimit }],
  }, { fsImpl: fakeFs({}), maxInlineImageBytes: max });
  assert.equal(embedded.attachments.length, 1);
  assert.equal(embedded.attachments[0].type, 'blob');

  const rejected = buildCopilotMessageOptions({
    text: 'x',
    attachments: [{ name: 'big.png', type: 'image/png', dataUrl: overLimit }],
  }, { fsImpl: fakeFs({}), maxInlineImageBytes: max });
  assert.deepEqual(rejected.attachments, []);
});

test('an oversized data URL degrades to a file reference when a path exists', () => {
  // This is also the hole where an oversized DISK image with a dataUrl twin
  // used to sneak inline: the disk read refused it, the data URL did not.
  const max = 8;
  const bigBytes = Buffer.alloc(64, 1);
  const { prompt, attachments } = buildCopilotMessageOptions({
    text: 'look',
    attachments: [{
      name: 'huge.png',
      type: 'image/png',
      path: '/home/dev/huge.png',
      dataUrl: `data:image/png;base64,${bigBytes.toString('base64')}`,
    }],
  }, { fsImpl: fakeFs({ '/home/dev/huge.png': bigBytes }), maxInlineImageBytes: max });

  assert.deepEqual(attachments, [{ type: 'file', path: '/home/dev/huge.png', displayName: 'huge.png' }]);
  assert.match(prompt, /Attached image "huge\.png" \(image\/png\): \/home\/dev\/huge\.png/);
});

test('an oversized data URL with no path is dropped with a note, never silently', () => {
  const max = 8;
  const { prompt, attachments } = buildCopilotMessageOptions({
    text: 'look',
    attachments: [{
      name: 'huge.png',
      type: 'image/png',
      dataUrl: `data:image/png;base64,${Buffer.alloc(64, 1).toString('base64')}`,
    }],
  }, { fsImpl: fakeFs({}), maxInlineImageBytes: max });

  assert.deepEqual(attachments, []);
  // The model must not be left answering about an image it never received.
  assert.match(prompt, /Attached image "huge\.png" \(image\/png\) was too large to embed/);
});

test('invalid base64 in a data URL is never decoded into a corrupt blob', () => {
  // Buffer.from(..., 'base64') is lenient and would happily decode garbage;
  // strict validation drops it instead (silently, matching how other invalid
  // attachments degrade today).
  for (const data of ['not base64!!!', 'AAE', 'AA==C']) {
    const { prompt, attachments } = buildCopilotMessageOptions({
      text: 'x',
      attachments: [{ name: 'bad.png', type: 'image/png', dataUrl: `data:image/png;base64,${data}` }],
    }, { fsImpl: fakeFs({}) });
    assert.deepEqual(attachments, [], data);
    assert.equal(prompt, 'x', data);
  }
});

test('non-image files become file attachments with their absolute path', () => {
  const { prompt, attachments } = buildCopilotMessageOptions({
    text: 'review',
    attachments: [{ name: 'notes.md', type: 'text/markdown', path: '/w/notes.md' }],
  }, { fsImpl: fakeFs({ '/w/notes.md': Buffer.from('# notes') }) });

  assert.deepEqual(attachments, [{ type: 'file', path: '/w/notes.md', displayName: 'notes.md' }]);
  assert.match(prompt, /Attached file "notes\.md" \(text\/markdown\): \/w\/notes\.md/);
});

test('an attachment that is not on disk is dropped rather than sent as a dead path', () => {
  const { prompt, attachments } = buildCopilotMessageOptions({
    text: 'review',
    attachments: [{ name: 'gone.md', type: 'text/markdown', path: '/w/gone.md' }],
  }, { fsImpl: fakeFs({}) });

  assert.deepEqual(attachments, []);
  assert.equal(prompt, 'review');
});

test('the server-provided prompt context is appended last', () => {
  // Same composition order as buildCursorUserMessage / buildClaudeUserContent:
  // user text, note lines, attachmentPromptContext.
  const { prompt } = buildCopilotMessageOptions({
    text: 'review',
    attachments: [{ name: 'notes.md', type: 'text/markdown', path: '/w/notes.md' }],
    attachmentPromptContext: '<system_reminder>Attached files: notes.md</system_reminder>',
  }, { fsImpl: fakeFs({ '/w/notes.md': Buffer.from('# notes') }) });

  assert.deepEqual(prompt.split('\n\n'), [
    'review',
    'Attached file "notes.md" (text/markdown): /w/notes.md',
    '<system_reminder>Attached files: notes.md</system_reminder>',
  ]);
});

test('prompt context survives even when every attachment was unreadable', () => {
  const { prompt, attachments } = buildCopilotMessageOptions({
    text: 'review',
    attachments: [{ name: 'gone.md', type: 'text/markdown', path: '/w/gone.md' }],
    attachmentPromptContext: '<system_reminder>Attached files: gone.md</system_reminder>',
  }, { fsImpl: fakeFs({}) });

  assert.deepEqual(attachments, []);
  assert.match(prompt, /<system_reminder>Attached files: gone\.md<\/system_reminder>$/);
});

test('an unreadable image file does not throw the turn', () => {
  const exploding = {
    existsSync: () => true,
    readFileSync: () => { throw new Error('EACCES'); },
  };
  const { prompt, attachments } = buildCopilotMessageOptions({
    text: 'look',
    attachments: [{ name: 'locked.png', type: 'image/png', path: '/w/locked.png' }],
  }, { fsImpl: exploding });

  assert.deepEqual(attachments, [{ type: 'file', path: '/w/locked.png', displayName: 'locked.png' }]);
  assert.match(prompt, /Attached image "locked\.png"/);
});

test('junk entries in the attachment list are skipped', () => {
  const { attachments } = buildCopilotMessageOptions({
    text: 'x',
    attachments: [null, 'nope', 42, { name: 'ok.md', type: 'text/markdown', path: '/w/ok.md' }],
  }, { fsImpl: fakeFs({ '/w/ok.md': Buffer.from('ok') }) });
  assert.equal(attachments.length, 1);
});
