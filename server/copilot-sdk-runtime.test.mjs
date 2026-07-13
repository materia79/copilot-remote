import test from 'node:test';
import assert from 'node:assert/strict';

import { buildInstalledCopilotClientOptions } from './copilot-sdk-runtime.mjs';

test('buildInstalledCopilotClientOptions uses the SDK stdio connection shape', () => {
  assert.deepEqual(
    buildInstalledCopilotClientOptions({
      cliPath: '/opt/copilot/app.js',
      cwd: '/workspace/project',
      logLevel: 'error',
    }),
    {
      connection: {
        kind: 'stdio',
        path: '/opt/copilot/app.js',
      },
      useLoggedInUser: true,
      logLevel: 'error',
      workingDirectory: '/workspace/project',
    },
  );
});
