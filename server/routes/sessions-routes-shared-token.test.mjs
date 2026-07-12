import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  normalizeShareToken,
  buildConversationShareToken,
  normalizeSharedViewerId,
} from './sessions-routes.mjs';

test('normalizeShareToken accepts valid hex tokens', () => {
  const value = normalizeShareToken('A'.repeat(32));
  assert.equal(value, 'a'.repeat(32));
});

test('normalizeShareToken rejects invalid or short tokens', () => {
  assert.equal(normalizeShareToken(''), '');
  assert.equal(normalizeShareToken('abc123'), '');
  assert.equal(normalizeShareToken('g'.repeat(64)), '');
  assert.equal(normalizeShareToken('a'.repeat(129)), '');
});

test('normalizeShareToken accepts upper-bound token length', () => {
  assert.equal(normalizeShareToken('b'.repeat(128)), 'b'.repeat(128));
});

test('buildConversationShareToken returns long lowercase hex token', () => {
  const token = buildConversationShareToken();
  assert.match(token, /^[a-f0-9]{64}$/);
});

test('normalizeSharedViewerId sanitizes unsafe characters', () => {
  const sanitized = normalizeSharedViewerId(' viewer:abc<>/\\$%__\n ');
  assert.equal(sanitized, 'viewer:abc__');
  assert.equal(normalizeSharedViewerId(''), '');
});

test('normalizeSharedViewerId limits identifier length', () => {
  assert.equal(normalizeSharedViewerId('x'.repeat(256)).length, 128);
});

test('shared upload route is registered at top level (not nested inside presence route)', () => {
  const filePath = fileURLToPath(new URL('./sessions-routes.mjs', import.meta.url));
  const source = fs.readFileSync(filePath, 'utf8');
  const presenceStart = source.indexOf("app.post('/api/shared/:token/presence'");
  const uploadStart = source.indexOf("app.get('/api/shared/:token/upload/:sha256/content'");
  assert.ok(presenceStart >= 0, 'presence route must exist');
  assert.ok(uploadStart >= 0, 'shared upload route must exist');
  const presenceEnd = source.indexOf('\n  });', presenceStart);
  assert.ok(presenceEnd > presenceStart, 'presence route terminator must exist');
  assert.ok(uploadStart > presenceEnd, 'shared upload route must be declared after presence route closes');
});

test('shared presence route applies rate limit responses', () => {
  const filePath = fileURLToPath(new URL('./sessions-routes.mjs', import.meta.url));
  const source = fs.readFileSync(filePath, 'utf8');
  assert.match(source, /const SHARED_PRESENCE_RATE_WINDOW_MS = 10_000;/);
  assert.match(source, /const SHARED_PRESENCE_RATE_LIMIT = 24;/);
  assert.match(source, /res\.setHeader\('Retry-After', String\(rateLimit\.retryAfterSeconds \|\| 1\)\);/);
  assert.match(source, /return res\.status\(429\)\.json\(\{/);
});

test('shared access status event is created only after a successful shared payload is built', () => {
  const filePath = fileURLToPath(new URL('./sessions-routes.mjs', import.meta.url));
  const source = fs.readFileSync(filePath, 'utf8');
  const sharedRouteStart = source.indexOf("app.get('/api/shared/:token'");
  const sharedRouteEnd = source.indexOf("\n  });", sharedRouteStart);
  const sharedRoute = source.slice(sharedRouteStart, sharedRouteEnd);
  assert.ok(sharedRouteStart >= 0, 'shared read route must exist');
  assert.match(sharedRoute, /if \(!payload\) return res\.status\(404\)\.json\(\{ error: 'Shared conversation not found' \}\);[\s\S]*statusEventService\.recordSharedAccess/);
  assert.match(sharedRoute, /io\.emit\('shared_access', sharedAccess\.event\)/);
});

test('shared upload route handles stream errors explicitly', () => {
  const filePath = fileURLToPath(new URL('./sessions-routes.mjs', import.meta.url));
  const source = fs.readFileSync(filePath, 'utf8');
  assert.match(source, /const stream = fs\.createReadStream\(filePath\);/);
  assert.match(source, /stream\.on\('error', \(\) => \{/);
  assert.match(source, /res\.status\(500\)\.json\(\{ error: 'Failed to stream shared attachment' \}\);/);
});
