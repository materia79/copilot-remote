'use strict';

import { fileURLToPath } from 'url';
import { isRelaySelfRestartWorker, runDirectRelaySupervisor } from './relay-self-restart.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const runtimeArgs = process.argv.slice(2);

if (isRelaySelfRestartWorker(process.env)) {
  await import('./server-runtime.mjs');
} else {
  await runDirectRelaySupervisor({
    scriptPath,
    args: runtimeArgs,
    cwd: process.cwd(),
    env: process.env,
    logger: console,
  });
}
