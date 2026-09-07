import test from 'node:test';
import assert from 'node:assert/strict';

import os from 'node:os';
import path from 'node:path';

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

test('an omitted baseDirectory defaults to ~/.copilot (runtime 1.0.83 refuses empty mode without one)', () => {
  const options = buildInstalledCopilotClientOptions({ cliPath: '/opt/copilot/app.js' });
  // The runtime's own pre-1.0.83 default, made explicit: the import sweep and
  // model discovery must keep seeing the CLI's real session state.
  assert.equal(options.baseDirectory, path.join(os.homedir(), '.copilot'));
});
