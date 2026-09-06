import fs from 'fs';

// Very large base64 payloads risk rejection by the runtime; larger images fall
// back to a file reference so the agent can read them from disk instead. Same
// threshold the Claude and Cursor workers use.
export const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;

function isImageAttachment(att) {
  return String(att?.type || '').toLowerCase().startsWith('image/');
}

/** Strict base64: the alphabet, optional padding, block length a multiple of 4. */
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Decode-and-validate an inline data URL (audit #33).
 *
 * Disk-backed images have always enforced the decoded 5 MiB ceiling; data URLs
 * used to skip it entirely, so a ~9 MiB decoded image (the server's ENCODED
 * ceiling is larger) could ride straight past a limit this module claims to
 * enforce. The ceiling is now applied to the DECODED byte count, uniformly with
 * the disk path, and the base64 itself is validated first — `Buffer.from` is
 * lenient and would silently decode garbage into a corrupt blob.
 *
 * Returns `{ data, mimeType }` for an embeddable image, `{ tooLarge: true }`
 * for a valid image over the ceiling (so the caller can degrade explicitly),
 * and `null` for anything invalid.
 */
function imageFromDataUrl(att, maxBytes) {
  const dataUrl = String(att?.dataUrl || '').trim();
  if (!dataUrl.startsWith('data:')) return null;
  const match = dataUrl.match(/^data:([^;,]+);base64,(.+)$/i);
  if (!match) return null;
  const mimeType = String(match[1] || '').trim().toLowerCase();
  const data = String(match[2] || '').trim();
  if (!mimeType.startsWith('image/') || !data) return null;
  if (data.length % 4 !== 0 || !BASE64_RE.test(data)) return null;
  if (Buffer.from(data, 'base64').length > maxBytes) return { tooLarge: true };
  return { data, mimeType };
}

/**
 * Build the `MessageOptions` payload for `session.send()` from a relay
 * message.
 *
 * Mirrors `buildCursorUserMessage` / `buildClaudeUserContent`: images small
 * enough to embed travel inline, everything else becomes a reference the
 * agent's file tools can open, and the server-provided
 * `attachmentPromptContext` is appended to the prompt. What differs is the
 * carrier — the Copilot SDK's `MessageOptions.attachments` is a typed union
 * rather than content blocks:
 *
 *   image, embeddable → `{ type: 'blob', data, mimeType, displayName }`
 *   image, too large  → `{ type: 'file', path, displayName }`
 *   any other file    → `{ type: 'file', path, displayName }`
 *
 * The note lines are kept even though the attachments are structured, because
 * they are what tells the model the absolute path of a file it may want to
 * re-read with its own tools — the same reason the siblings emit them.
 *
 * Text composition order (identical to the siblings): user text, note lines,
 * `attachmentPromptContext`, joined by blank lines.
 */
export function buildCopilotMessageOptions(message, {
  fsImpl = fs,
  maxInlineImageBytes = MAX_INLINE_IMAGE_BYTES,
} = {}) {
  const text = String(message?.text || '').trim();
  const input = Array.isArray(message?.attachments) ? message.attachments : [];
  const attachments = [];
  const noteLines = [];

  for (const att of input) {
    if (!att || typeof att !== 'object') continue;
    const name = String(att.name || 'attachment').trim() || 'attachment';
    const mime = String(att.type || 'application/octet-stream').trim() || 'application/octet-stream';
    const filePath = String(att.path || '').trim();

    if (isImageAttachment(att)) {
      let blob = null;
      let tooLarge = false;
      if (filePath && fsImpl.existsSync(filePath)) {
        try {
          const bytes = fsImpl.readFileSync(filePath);
          if (Buffer.isBuffer(bytes) && bytes.length && bytes.length <= maxInlineImageBytes) {
            blob = {
              data: bytes.toString('base64'),
              mimeType: mime.toLowerCase().startsWith('image/') ? mime.toLowerCase() : 'image/png',
            };
          }
        } catch {
          blob = null;
        }
      }
      if (!blob) {
        // The decoded ceiling applies to data URLs exactly as to disk reads —
        // this is also the path an OVERSIZED disk image with a dataUrl twin
        // used to sneak through.
        const decoded = imageFromDataUrl(att, maxInlineImageBytes);
        if (decoded?.tooLarge) tooLarge = true;
        else blob = decoded;
      }
      if (blob) {
        attachments.push({ type: 'blob', data: blob.data, mimeType: blob.mimeType, displayName: name });
        noteLines.push(`Attached image "${name}" (${mime}) is embedded in this message.`);
      } else if (filePath) {
        attachments.push({ type: 'file', path: filePath, displayName: name });
        noteLines.push(`Attached image "${name}" (${mime}): ${filePath}`);
      } else if (tooLarge) {
        // A valid image with nowhere to degrade to: too big to embed, no path
        // for a file reference. Dropping it SILENTLY would leave the model
        // answering about an image it never saw, so the omission is stated in
        // the same note channel every other attachment uses.
        noteLines.push(`Attached image "${name}" (${mime}) was too large to embed and has no file path, so it was omitted.`);
      }
      continue;
    }

    if (filePath && fsImpl.existsSync(filePath)) {
      attachments.push({ type: 'file', path: filePath, displayName: name });
      noteLines.push(`Attached file "${name}" (${mime}): ${filePath}`);
    }
  }

  const attachmentPromptContext = String(message?.attachmentPromptContext || '').trim();
  const textParts = [text];
  if (noteLines.length) textParts.push(noteLines.join('\n'));
  if (attachmentPromptContext) textParts.push(attachmentPromptContext);
  return { prompt: textParts.filter(Boolean).join('\n\n'), attachments };
}
