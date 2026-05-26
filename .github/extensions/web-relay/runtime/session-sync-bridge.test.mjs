import test from 'node:test';
import assert from 'node:assert/strict';
import { syncSessionToServer, syncWorkspaceRootToServer } from './session-sync-bridge.mjs';

test('syncSessionToServer sends workspace root and dedupes by cwd', async () => {
  const calls = [];
  const apiClient = async (method, url, payload) => {
    calls.push({ method, url, payload });
  };

  await syncSessionToServer('sdk-a', 'conv-a', apiClient, false, { workspaceRootPath: 'C:\\work\\one' });
  await syncSessionToServer('sdk-a', 'conv-a', apiClient, false, { workspaceRootPath: 'C:\\work\\one' });
  await syncSessionToServer('sdk-a', 'conv-a', apiClient, false, { workspaceRootPath: 'C:\\work\\two' });

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], {
    method: 'POST',
    url: '/api/session-sync',
    payload: {
      sdk_session_id: 'sdk-a',
      conversation_id: 'conv-a',
      workspace_root_path: 'C:\\work\\one',
    },
  });
  assert.deepEqual(calls[1].payload.workspace_root_path, 'C:\\work\\two');
});

test('syncWorkspaceRootToServer posts the startup cwd without a conversation id', async () => {
  const calls = [];
  const apiClient = async (method, url, payload) => {
    calls.push({ method, url, payload });
  };

  await syncWorkspaceRootToServer('I:\\rabi-ribi', apiClient, { sdkSessionId: 'sdk-startup' });

  assert.deepEqual(calls, [{
    method: 'POST',
    url: '/api/session-workspace-root',
    payload: {
      workspace_root_path: 'I:\\rabi-ribi',
      sdk_session_id: 'sdk-startup',
    },
  }]);
});
