import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const indexPath = fileURLToPath(new URL('./public/index.html', import.meta.url));
const workerPath = fileURLToPath(new URL('./public/sw.js', import.meta.url));
const indexSource = fs.readFileSync(indexPath, 'utf8');
const workerSource = fs.readFileSync(workerPath, 'utf8');

test('activates the versioned service worker before importing the app module', () => {
  assert.match(indexSource, /await __activateCurrentPwaShell\(\);/);
  assert.match(indexSource, /navigator\.serviceWorker\.register\(/);
  assert.match(indexSource, /updateViaCache: 'none'/);
  assert.match(indexSource, /if \(__IS_SHARED_ROUTE && !navigator\.serviceWorker\.controller\) return;/);
  assert.match(indexSource, /await __recoverStalePwaShell\(scopeRoot\)/);
  assert.match(indexSource, /registration\.unregister\(\)/);
  assert.match(indexSource, /window\.location\.reload\(\)/);
  assert.match(indexSource, /if \(!hadController\) return;/);
  assert.match(indexSource, /return import\(`\$\{__APP_BASE\}\/app\/bootstrap\.js\?\$\{__PWA_BUST\}\$\{recoverySuffix\}`\);/);
});

test('serves application modules network-first to prevent mixed release graphs', () => {
  assert.match(workerSource, /function isApplicationModuleRequest\(url\)/);
  assert.match(workerSource, /if \(isApplicationModuleRequest\(url\)\) \{\s*event\.respondWith\(networkFirst\(request, request\.url\)\);/);
});
