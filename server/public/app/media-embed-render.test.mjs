import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// sanitizePreviewHtml is DOM-bound (template parsing, element replacement), so
// this suite runs on a real JSDOM document rather than the global stubs the
// pure-string router suites use.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Element = dom.window.Element;
globalThis.Node = dom.window.Node;
globalThis.NodeFilter = dom.window.NodeFilter;
globalThis.sessionStorage = { getItem() { return ''; }, setItem() {} };

const { setServerPlatform } = await import('./store.js');
const { sanitizePreviewHtml, rewriteLocalAssetUrlsInNode } = await import('./router.js');

function sanitizedElement(html) {
  const host = document.createElement('div');
  host.innerHTML = sanitizePreviewHtml(html);
  return host.firstElementChild;
}

test('linux relay: safe root-relative image src is left for the post-insert rewriter', () => {
  setServerPlatform('linux');
  const el = sanitizedElement('<img src="/home/dev/shot.png" alt="shot">');
  assert.equal(el.tagName, 'IMG');
  assert.equal(el.getAttribute('src'), '/home/dev/shot.png');
});

test('linux relay: media-extension image becomes a player with controls', () => {
  setServerPlatform('linux');
  const video = sanitizedElement('<img src="/home/dev/demo.mp4" alt="demo clip">');
  assert.equal(video.tagName, 'VIDEO');
  assert.equal(video.getAttribute('src'), '/home/dev/demo.mp4');
  assert.equal(video.getAttribute('controls'), '');
  assert.equal(video.getAttribute('preload'), 'metadata');
  assert.equal(video.getAttribute('title'), 'demo clip');

  const audio = sanitizedElement('<img src="/home/dev/note.mp3">');
  assert.equal(audio.tagName, 'AUDIO');
  assert.equal(audio.getAttribute('src'), '/home/dev/note.mp3');
});

// Windows path shapes below are drive-route inputs for a win32-platform relay,
// exercised cross-platform through setServerPlatform('win32').
test('win32 relay: bare absolute path src resolves to the drive-file route instead of being stripped', () => {
  setServerPlatform('win32');
  const img = sanitizedElement('<img src="C:\\Users\\dev\\shot.png">');
  assert.equal(img.tagName, 'IMG');
  assert.equal(img.getAttribute('src'), '/api/drives/file?path=C%3A%2FUsers%2Fdev%2Fshot.png');
});

test('win32 relay: bare-path media becomes a player pointing at the drive-file route', () => {
  setServerPlatform('win32');
  const video = sanitizedElement('<img src="C:\\Users\\dev\\demo.mp4" alt="demo">');
  assert.equal(video.tagName, 'VIDEO');
  assert.equal(video.getAttribute('src'), '/api/drives/file?path=C%3A%2FUsers%2Fdev%2Fdemo.mp4');
  assert.equal(video.getAttribute('controls'), '');
});

test('linux relay: a foreign-platform path degrades to a dead workspace href, never an executable URL', () => {
  setServerPlatform('linux');
  // Drive-lettered shape is a win32 relay's input; the resolver's existing
  // workspace fallback maps it to a same-origin file URL that 404s — the same
  // treatment rewriteLocalAssetUrlsInNode gives such paths elsewhere.
  const img = sanitizedElement('<img src="C:\\Users\\dev\\shot.png" alt="x">');
  assert.equal(img.tagName, 'IMG');
  assert.equal(img.getAttribute('src'), '/api/files/Users/dev/shot.png');
});

test('unsafe srcs are still stripped and data images still allowed', () => {
  setServerPlatform('linux');
  const bad = sanitizedElement('<img src="javascript:alert(1)">');
  assert.equal(bad.getAttribute('src'), null);
  const data = sanitizedElement('<img src="data:image/png;base64,AAAA">');
  assert.equal(data.getAttribute('src'), 'data:image/png;base64,AAAA');
  // data: never upgrades to a media element.
  assert.equal(data.tagName, 'IMG');
});

test('raw video/audio tags pass with a whitelisted attribute set only', () => {
  setServerPlatform('linux');
  const video = sanitizedElement(
    '<video src="https://example.com/clip.mp4" controls preload="metadata" autoplay onclick="x()" width="320"></video>',
  );
  assert.equal(video.tagName, 'VIDEO');
  assert.equal(video.getAttribute('src'), 'https://example.com/clip.mp4');
  assert.equal(video.getAttribute('controls'), '');
  assert.equal(video.getAttribute('width'), '320');
  assert.equal(video.getAttribute('autoplay'), null);
  assert.equal(video.getAttribute('onclick'), null);

  const badSrc = sanitizedElement('<audio src="javascript:alert(1)" controls></audio>');
  assert.equal(badSrc.getAttribute('src'), null);
});

test('disallowed tags are still flattened to text', () => {
  setServerPlatform('linux');
  const host = document.createElement('div');
  host.innerHTML = sanitizePreviewHtml('<script>alert(1)</script><p>ok</p>');
  assert.equal(host.querySelector('script'), null);
  assert.equal(host.querySelector('p').textContent, 'ok');
});

test('post-insert rewriter now covers video and audio srcs', () => {
  setServerPlatform('linux');
  const root = document.createElement('div');
  root.innerHTML = '<video src="/home/dev/demo.mp4"></video><audio src="/home/dev/note.mp3"></audio>';
  rewriteLocalAssetUrlsInNode(root, { preferDrive: true });
  assert.equal(
    root.querySelector('video').getAttribute('src'),
    '/api/drives/file?path=%2Fhome%2Fdev%2Fdemo.mp4',
  );
  assert.equal(
    root.querySelector('audio').getAttribute('src'),
    '/api/drives/file?path=%2Fhome%2Fdev%2Fnote.mp3',
  );
});
