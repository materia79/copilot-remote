import test from 'node:test';
import assert from 'node:assert/strict';

import { buildInstalledCopilotClientOptions } from './copilot-sdk-runtime.mjs';

test('buildInstalledCopilotClientOptions configures a restricted importer client', () => {
  assert.deepEqual(
    buildInstalledCopilotClientOptions({
      cliPath: '/opt/copilot/app.js',
      cwd: '/workspace/project',
      baseDirectory: '/home/tester/.copilot',
      logLevel: 'error',
    }),
    {
      connection: {
        kind: 'stdio',
        path: '/opt/copilot/app.js',
      },
      mode: 'empty',
      baseDirectory: '/home/tester/.copilot',
      useLoggedInUser: true,
      logLevel: 'error',
      workingDirectory: '/workspace/project',
    },
  );
});
