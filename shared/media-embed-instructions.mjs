// How agents embed media inline in their reply messages, taught once per
// provider. The rendering work is client-side (sanitizePreviewHtml resolves
// bare absolute paths to the drive/workspace file routes and upgrades
// media-extension images to players); this module only carries the words.
//
// One constant, four seams — Claude (system-prompt append), Copilot (relay
// tool guidance document), Cursor and Grok (once-per-worker prompt prefix) —
// following preview-tool-core.mjs: providers cannot drift apart on wording
// because there is exactly one wording.

export const MEDIA_EMBED_INSTRUCTION_HEADING = '## Embedding media in replies';

export const MEDIA_EMBED_INSTRUCTION_TEXT =
  'To show the user an image, video, or audio clip inline in a reply, write a '
  + 'markdown image whose target is the file\'s absolute path on this machine, '
  + 'e.g. ![what it shows](/home/user/screenshots/result.png) or '
  + '![demo clip](C:\\Users\\user\\Videos\\demo.mp4). The web app renders it '
  + 'inline for the signed-in user — video and audio files become players — '
  + 'with no upload, URL-encoding, or extra tooling needed. Media does not '
  + 'render in shared/public transcript views.';

export function renderMediaEmbedInstructionBlock() {
  return `${MEDIA_EMBED_INSTRUCTION_HEADING}\n\n${MEDIA_EMBED_INSTRUCTION_TEXT}`;
}

/**
 * Append the media-embed block to a guidance document unless it already
 * carries one (idempotent, so a doc that gains the section statically or via a
 * second apply pass is not taught twice).
 */
export function applyMediaEmbedInstructions(baseInstructions = '') {
  const base = String(baseInstructions || '').trimEnd();
  if (base.includes(MEDIA_EMBED_INSTRUCTION_HEADING)) return base;
  return [base, renderMediaEmbedInstructionBlock()].filter(Boolean).join('\n\n');
}
