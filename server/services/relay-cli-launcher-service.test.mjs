import assert from 'node:assert/strict';
import test from 'node:test';
import { createRelayCliLauncherService } from './relay-cli-launcher-service.mjs';

test('windows launcher skips restart when target session is already running', async () => {
  const execCalls = [];
  const spawnCalls = [];
  const targetSessionId = '3dd70b44-42cf-4e6d-ab0f-40392d8426b3';
  const snapshots = [
    [
      { processId: 101, name: 'gh.exe', commandLine: `gh copilot -- --allow-all --session-id ${targetSessionId}` },
      { processId: 202, name: 'cmd.exe', commandLine: `cmd /c C:\\Users\\simon\\AppData\\Roaming\\npm\\copilot.cmd --allow-all --session-id=${targetSessionId}` },
      { processId: 303, name: 'node.exe', commandLine: 'node C:\\git\\copilot-remote\\server\\server.js' },
    ],
  ];
  const service = createRelayCliLauncherService({
    platform: 'win32',
    restartDelayMs: 0,
    killWaitMs: 0,
    maxKillAttempts: 3,
    now: () => Date.parse('2026-05-21T00:00:00.000Z'),
    sleepImpl: async () => {},
    execFileSyncImpl: (_file, args) => {
      execCalls.push(args);
      const command = String(args?.[2] || '');
      if (command.includes('ConvertTo-Json')) {
        return Buffer.from(JSON.stringify(snapshots[0]));
      }
      return Buffer.from('');
    },
    spawnImpl: (command, args, options) => {
      spawnCalls.push({ command, args, options });
      return { pid: 9090, unref() {} };
    },
  });

  const scheduled = service.scheduleRestart({
    transactionId: 'tx-1',
    targetSessionId,
    reason: 'test',
  });
  assert.equal(scheduled.ok, true);
  assert.equal(scheduled.reused, true);
  assert.equal(scheduled.accepted, false);
  await service.waitForIdle();

  assert.equal(spawnCalls.length, 0);
  assert.equal(execCalls.some((args) => String(args?.[2] || '').includes('Stop-Process -Id $id')), false);
  assert.equal(service.getState(), null);
});

test('windows launcher spawns when target session is absent and leaves others alone', async () => {
  const execCalls = [];
  const spawnCalls = [];
  const targetSessionId = '3dd70b44-42cf-4e6d-ab0f-40392d8426b3';
  let snapshotIndex = 0;
  const snapshots = [
    [
      { processId: 202, name: 'cmd.exe', commandLine: 'cmd /c C:\\Users\\simon\\AppData\\Roaming\\npm\\copilot.cmd --allow-all --session-id other-session' },
      { processId: 303, name: 'node.exe', commandLine: 'node C:\\git\\copilot-remote\\server\\server.js' },
    ],
    [],
  ];
  const service = createRelayCliLauncherService({
    platform: 'win32',
    restartDelayMs: 0,
    killWaitMs: 0,
    maxKillAttempts: 3,
    now: () => Date.parse('2026-05-21T00:00:00.000Z'),
    sleepImpl: async () => {},
    execFileSyncImpl: (_file, args) => {
      execCalls.push(args);
      const command = String(args?.[2] || '');
      if (command.includes('ConvertTo-Json')) {
        const snapshot = snapshots[Math.min(snapshotIndex, snapshots.length - 1)];
        snapshotIndex += 1;
        return Buffer.from(JSON.stringify(snapshot));
      }
      return Buffer.from('');
    },
    spawnImpl: (command, args, options) => {
      spawnCalls.push({ command, args, options });
      return { pid: 9090, unref() {} };
    },
  });

  const scheduled = service.scheduleRestart({
    transactionId: 'tx-1',
    targetSessionId,
    reason: 'test',
  });
  assert.equal(scheduled.ok, true);
  await service.waitForIdle();

  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].command, 'gh');
  assert.deepEqual(
    spawnCalls[0].args,
    ['copilot', '--', '--allow-all', '--session-id', targetSessionId],
  );
  assert.equal(spawnCalls[0].options.detached, true);
  assert.equal(spawnCalls[0].options.shell, true);
  assert.equal(spawnCalls[0].options.windowsHide, true);
  assert.equal(execCalls.some((args) => String(args?.[2] || '').includes('Stop-Process -Id $id')), false);
  const state = service.getState();
  assert.equal(state?.status, 'spawned');
  assert.deepEqual(state?.killedPids, []);
});

test('launcher reuses the same in-flight transaction', async () => {
  let resolveSleep;
  const spawnCalls = [];
  const service = createRelayCliLauncherService({
    platform: 'win32',
    restartDelayMs: 1,
    killWaitMs: 0,
    maxKillAttempts: 2,
    now: () => Date.parse('2026-05-21T00:05:00.000Z'),
    sleepImpl: () => new Promise((resolve) => { resolveSleep = resolve; }),
    execFileSyncImpl: (_file, args) => {
      const command = String(args?.[2] || '');
      if (command.includes('ConvertTo-Json')) return Buffer.from('[]');
      return Buffer.from('');
    },
    spawnImpl: (command, args, options) => {
      spawnCalls.push({ command, args, options });
      return { pid: 9191, unref() {} };
    },
  });

  const first = service.scheduleRestart({ transactionId: 'tx-2', targetSessionId: 'session-b' });
  const second = service.scheduleRestart({ transactionId: 'tx-2', targetSessionId: 'session-b' });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.reused, true);

  resolveSleep();
  await service.waitForIdle();
  assert.equal(spawnCalls.length, 1);
});

test('launcher resolves cwd lazily from the provided getter', async () => {
  let cwdValue = 'C:\\root-one';
  const spawnCalls = [];
  const service = createRelayCliLauncherService({
    platform: 'win32',
    restartDelayMs: 1,
    killWaitMs: 0,
    maxKillAttempts: 1,
    cwd: () => cwdValue,
    now: () => Date.parse('2026-05-21T00:10:00.000Z'),
    sleepImpl: async () => {},
    execFileSyncImpl: (_file, args) => {
      const command = String(args?.[2] || '');
      if (command.includes('ConvertTo-Json')) return Buffer.from('[]');
      return Buffer.from('');
    },
    spawnImpl: (command, args, options) => {
      spawnCalls.push({ command, args, options });
      return { pid: 9292, unref() {} };
    },
  });

  const scheduled = service.scheduleRestart({ transactionId: 'tx-3', targetSessionId: 'session-c' });
  assert.equal(scheduled.ok, true);
  cwdValue = 'C:\\root-two';
  await service.waitForIdle();

  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].options.cwd, 'C:\\root-two');
});
