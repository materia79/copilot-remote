import assert from 'node:assert/strict';
import test from 'node:test';
import { createRelayCliLauncherService } from './relay-cli-launcher-service.mjs';

test('windows launcher kills copilot pids then spawns resumed gh once', async () => {
  const execCalls = [];
  const spawnCalls = [];
  let snapshotIndex = 0;
  const snapshots = [
    [
      { processId: 101, name: 'gh.exe', commandLine: 'gh copilot -- --allow-all --resume bab3' },
      { processId: 202, name: 'cmd.exe', commandLine: 'cmd /c C:\\Users\\simon\\AppData\\Roaming\\npm\\copilot.cmd --allow-all --resume bab3' },
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
    targetSessionId: '3dd70b44-42cf-4e6d-ab0f-40392d8426b3',
    reason: 'test',
  });
  assert.equal(scheduled.ok, true);
  await service.waitForIdle();

  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].command, 'gh');
  assert.deepEqual(
    spawnCalls[0].args,
    ['copilot', '--', '--allow-all', '--resume', '3dd70b44-42cf-4e6d-ab0f-40392d8426b3'],
  );
  assert.equal(spawnCalls[0].options.detached, true);
  assert.equal(execCalls.some((args) => String(args?.[2] || '').includes('Stop-Process -Id $id')), true);
  const state = service.getState();
  assert.equal(state?.status, 'spawned');
  assert.deepEqual(state?.killedPids, [101, 202]);
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
