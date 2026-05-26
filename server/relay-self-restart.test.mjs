import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  buildRelayRuntimeEnv,
  isRelayRestartSupervised,
  isRelaySelfRestartWorker,
  runDirectRelaySupervisor,
  spawnRelayRuntime,
  RELAY_SELF_RESTART_MODE_ENV,
  RELAY_SELF_RESTART_COUNT_ENV,
  RELAY_SELF_RESTART_CRASH_COUNT_ENV,
  RELAY_SUPERVISED_ENV,
} from './relay-self-restart.mjs';

test('detects supervised relay restart launches from env', () => {
  assert.equal(isRelayRestartSupervised({ [RELAY_SUPERVISED_ENV]: '1' }), true);
  assert.equal(isRelayRestartSupervised({ [RELAY_SUPERVISED_ENV]: 'true' }), true);
  assert.equal(isRelayRestartSupervised({ [RELAY_SUPERVISED_ENV]: 'no' }), false);
  assert.equal(isRelayRestartSupervised({}), false);
});

test('buildRelayRuntimeEnv marks child launches as supervised', () => {
  const env = buildRelayRuntimeEnv({
    PATH: 'C:\\Windows\\System32',
  });
  assert.equal(env[RELAY_SUPERVISED_ENV], '1');
  assert.equal(env.PATH, 'C:\\Windows\\System32');
});

test('detects worker mode from env', () => {
  assert.equal(isRelaySelfRestartWorker({ [RELAY_SELF_RESTART_MODE_ENV]: 'worker' }), true);
  assert.equal(isRelaySelfRestartWorker({ [RELAY_SELF_RESTART_MODE_ENV]: 'supervisor' }), false);
  assert.equal(isRelaySelfRestartWorker({}), false);
});

test('spawns relay runtime child with self-restart worker env', () => {
  let recorded = null;
  const proc = spawnRelayRuntime({
    env: {
      PATH: 'C:\\Windows\\System32',
    },
    cwd: 'C:\\repo',
    scriptPath: 'C:\\git\\copilot-remote\\server\\server.js',
    args: ['--token', 'abc123', '--port', '3333'],
    execArgv: ['--trace-warnings'],
    restartCount: 2,
    crashCount: 1,
    spawnImpl: (...args) => {
      recorded = args;
      return { pid: 4321 };
    },
    logger: { log() {} },
  });

  assert.equal(proc.pid, 4321);
  assert.ok(recorded);
  assert.equal(recorded[0], process.execPath);
  assert.deepEqual(recorded[1], ['--trace-warnings', 'C:\\git\\copilot-remote\\server\\server.js', '--token', 'abc123', '--port', '3333']);
  assert.equal(recorded[2].cwd, 'C:\\repo');
  assert.equal(recorded[2].detached, false);
  assert.deepEqual(recorded[2].stdio, ['ignore', 'pipe', 'pipe']);
  assert.equal(recorded[2].windowsHide, true);
  assert.equal(recorded[2].env[RELAY_SUPERVISED_ENV], '1');
  assert.equal(recorded[2].env[RELAY_SELF_RESTART_MODE_ENV], 'worker');
  assert.equal(recorded[2].env[RELAY_SELF_RESTART_COUNT_ENV], '2');
  assert.equal(recorded[2].env[RELAY_SELF_RESTART_CRASH_COUNT_ENV], '1');
  assert.equal(recorded[2].env.PATH, 'C:\\Windows\\System32');
});

test('direct relay supervisor relaunches runtime after intentional restart without detaching', async () => {
  const spawnCalls = [];
  const exitCodes = [];
  const childExitCodes = [75, 0];

  function createProc(exitCode, pid) {
    const proc = new EventEmitter();
    proc.pid = pid;
    proc.exitCode = null;
    proc.kill = () => {};
    queueMicrotask(() => {
      proc.exitCode = exitCode;
      proc.emit('exit', exitCode, null);
    });
    return proc;
  }

  let spawnCount = 0;
  await runDirectRelaySupervisor({
    scriptPath: 'C:\\git\\copilot-remote\\server\\server-runtime.mjs',
    args: ['--token', 'abc123'],
    cwd: 'C:\\repo',
    env: { PATH: 'C:\\Windows\\System32' },
    execArgv: [],
    spawnImpl: (...args) => {
      spawnCalls.push(args);
      const exitCode = childExitCodes[spawnCount] ?? 0;
      spawnCount += 1;
      return createProc(exitCode, 5000 + spawnCount);
    },
    delay: async () => {},
    exitImpl: async (code) => {
      exitCodes.push(code);
    },
    logger: { log() {}, error() {} },
    installSignalHandlers: false,
  });

  assert.equal(spawnCalls.length, 2);
  assert.deepEqual(exitCodes, [0]);
  assert.equal(spawnCalls[0][2].detached, false);
  assert.deepEqual(spawnCalls[0][2].stdio, ['ignore', 'pipe', 'pipe']);
  assert.equal(spawnCalls[0][2].env[RELAY_SUPERVISED_ENV], '1');
  assert.equal(spawnCalls[0][2].env[RELAY_SELF_RESTART_MODE_ENV], 'worker');
  assert.deepEqual(spawnCalls[0][1], ['C:\\git\\copilot-remote\\server\\server-runtime.mjs', '--token', 'abc123']);
});

test('direct relay supervisor retries crash exits with bounded backoff', async () => {
  const spawnCalls = [];
  const exitCodes = [];
  const delays = [];

  function createProc(exitCode, pid) {
    const proc = new EventEmitter();
    proc.pid = pid;
    proc.exitCode = null;
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = () => {};
    queueMicrotask(() => {
      proc.exitCode = exitCode;
      proc.emit('exit', exitCode, null);
    });
    return proc;
  }

  let spawnCount = 0;
  await runDirectRelaySupervisor({
    scriptPath: 'C:\\git\\copilot-remote\\server\\server.js',
    cwd: 'C:\\repo',
    env: {},
    execArgv: [],
    maxCrashRestarts: 2,
    spawnImpl: (...args) => {
      spawnCalls.push(args);
      spawnCount += 1;
      return createProc(1, 7000 + spawnCount);
    },
    delay: async (ms) => { delays.push(ms); },
    exitImpl: async (code) => { exitCodes.push(code); },
    logger: { log() {}, error() {} },
    installSignalHandlers: false,
  });

  assert.equal(spawnCalls.length, 2);
  assert.deepEqual(delays, [500]);
  assert.deepEqual(exitCodes, [1]);
  assert.equal(spawnCalls[1][2].env[RELAY_SELF_RESTART_CRASH_COUNT_ENV], '1');
});
