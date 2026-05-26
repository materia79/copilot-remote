import test from 'node:test';
import assert from 'node:assert/strict';
import { canUpdateWorkspaceRoot, launchWorkspaceRootSession, learnWorkspaceRootFromSessionSync } from './sessions-routes.mjs';

test('canUpdateWorkspaceRoot always allows root updates', () => {
  assert.equal(canUpdateWorkspaceRoot({ cliOnline: true }), true);
  assert.equal(canUpdateWorkspaceRoot({ cliOnline: false }), true);
  assert.equal(canUpdateWorkspaceRoot({}), true);
  assert.equal(canUpdateWorkspaceRoot({ cliOnline: false, activeRuntimeSessionCount: 1 }), true);
});

test('launchWorkspaceRootSession blocks the selected running session', async () => {
  const supervisor = {
    getWorkerState: () => ({ status: 'ready' }),
    ensureWorker: async () => ({ ok: true, worker: {} }),
  };

  const blocked = await launchWorkspaceRootSession({ cliOnline: false }, supervisor, 'sdk-1');
  assert.equal(blocked.ok, false);
  assert.equal(blocked.statusCode, 409);
});

test('launchWorkspaceRootSession allows launch when the selected session is not running', async () => {
  const calls = [];
  const supervisor = {
    ensureWorker: async (sessionId) => {
      calls.push(sessionId);
      return { ok: true, worker: { sdkSessionId: sessionId } };
    },
  };

  const missing = await launchWorkspaceRootSession({ cliOnline: false }, supervisor, '   ');
  assert.equal(missing.ok, false);
  assert.equal(missing.statusCode, 400);

  const launched = await launchWorkspaceRootSession({ cliOnline: true }, supervisor, 'sdk-2');
  assert.equal(launched.ok, true);
  assert.equal(launched.statusCode, 200);
  assert.deepEqual(calls, ['sdk-2']);
});

test('learnWorkspaceRootFromSessionSync updates the root through the runtime setter', () => {
  const calls = [];
  const result = learnWorkspaceRootFromSessionSync({
    workspaceRootPath: 'C:\\work\\new-root',
    setWorkspaceRoot: (rootPath, options) => {
      calls.push({ rootPath, options });
      return { changed: true, rootPath, rootName: 'new-root' };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.learned, true);
  assert.equal(result.changed, true);
  assert.equal(result.rootPath, 'C:\\work\\new-root');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].rootPath, 'C:\\work\\new-root');
  assert.equal(calls[0].options.reason, 'session-sync-cwd');
});

test('learnWorkspaceRootFromSessionSync ignores missing workspace roots', () => {
  const result = learnWorkspaceRootFromSessionSync({
    workspaceRootPath: '',
    setWorkspaceRoot: () => ({ changed: false }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.learned, false);
});

test('learnWorkspaceRootFromSessionSync skips startup-only sync without a conversation id', () => {
  let called = false;
  const result = learnWorkspaceRootFromSessionSync({
    sdkSessionId: 'sdk-startup',
    workspaceRootPath: 'C:\\work\\startup',
    learnConversationWorkspaceRoot: () => {
      called = true;
      return { ok: true, state: null };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.learned, false);
  assert.equal(result.changed, false);
  assert.equal(result.rootPath, 'C:\\work\\startup');
  assert.equal(called, false);
});
