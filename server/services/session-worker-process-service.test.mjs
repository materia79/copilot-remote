import test from 'node:test';
import assert from 'node:assert/strict';

import { createSessionWorkerProcessInspector } from './session-worker-process-service.mjs';

test('process inspector finds posix session worker processes by session id', () => {
  const execFileSyncImpl = (command, args) => {
    assert.equal(command, 'ps');
    assert.deepEqual(args, ['-eo', 'pid=,ppid=,comm=,args=', '-ww']);
    return Buffer.from([
      `101 1 node gh copilot -- --allow-all --session-id abc-123`,
      `102 1 bash /bin/bash -lc echo nope`,
      `103 1 copilot /usr/bin/copilot --allow-all --resume=def-456`,
    ].join('\n'));
  };
  const inspector = createSessionWorkerProcessInspector({
    platform: 'linux',
    execFileSyncImpl,
  });

  const abc = inspector.findProcessForSession('abc-123');
  const def = inspector.findProcessForSession('def-456');

  assert.equal(abc?.processId, 101);
  assert.match(abc?.commandLine || '', /--session-id abc-123/);
  assert.equal(def?.processId, 103);
  assert.match(def?.commandLine || '', /--resume=def-456/);
});

test('process inspector ignores relay server process on linux path form', () => {
  const inspector = createSessionWorkerProcessInspector({
    platform: 'linux',
    execFileSyncImpl(command, args) {
      assert.equal(command, 'ps');
      assert.deepEqual(args, ['-eo', 'pid=,ppid=,comm=,args=', '-ww']);
      return Buffer.from([
        `201 1 node /home/user/project/server/server.js --allow-all --session-id abc-123`,
        `202 1 node gh copilot -- --allow-all --session-id abc-123`,
      ].join('\n'));
    },
  });

  const matches = inspector.findProcessesForSession('abc-123');
  assert.deepEqual(matches.map((proc) => proc.processId), [202]);
});

test('process inspector ignores relay server process on windows path form', () => {
  const inspector = createSessionWorkerProcessInspector({
    platform: 'win32',
    execFileSyncImpl(command, args) {
      assert.equal(command, 'powershell.exe');
      assert.deepEqual(args, ['-NoProfile', '-Command', [
        '$list = Get-CimInstance Win32_Process | ForEach-Object {',
        '  [pscustomobject]@{',
        '    processId = [int]$_.ProcessId;',
        '    parentProcessId = [int]$_.ParentProcessId;',
        '    name = [string]$_.Name;',
        '    commandLine = [string]$_.CommandLine;',
        '  }',
        '};',
        '$list | ConvertTo-Json -Depth 3 -Compress',
      ].join(' ')]);
      return Buffer.from(JSON.stringify([
        {
          processId: 301,
          parentProcessId: 1,
          name: 'node.exe',
          commandLine: 'node C:\\repo\\server\\server.js --allow-all --session-id abc-123',
        },
        {
          processId: 302,
          parentProcessId: 1,
          name: 'gh.exe',
          commandLine: 'gh copilot -- --allow-all --session-id abc-123',
        },
      ]));
    },
  });

  const matches = inspector.findWindowsProcessesForSession('abc-123');
  assert.deepEqual(matches.map((proc) => proc.processId), [302]);
});

test('process inspector parses quoted session-id flag tokens on windows command lines', () => {
  const inspector = createSessionWorkerProcessInspector({
    platform: 'win32',
    execFileSyncImpl() {
      return Buffer.from(JSON.stringify([
        {
          processId: 401,
          parentProcessId: 1,
          name: 'gh.exe',
          commandLine: '"gh" "copilot" "--" "--allow-all" "--session-id" "abc-123"',
        },
      ]));
    },
  });

  const match = inspector.findProcessForSession('abc-123');
  assert.equal(match?.processId, 401);
});

test('process inspector prefers gh/copilot over transient cmd wrapper on windows', () => {
  const inspector = createSessionWorkerProcessInspector({
    platform: 'win32',
    execFileSyncImpl() {
      return Buffer.from(JSON.stringify([
        {
          processId: 501,
          parentProcessId: 1,
          name: 'cmd.exe',
          commandLine: 'C:\\Windows\\System32\\cmd.exe /d /s /c ""gh" "copilot" "--" "--allow-all" "--session-id" "abc-123""',
        },
        {
          processId: 502,
          parentProcessId: 501,
          name: 'gh.exe',
          commandLine: '"gh" "copilot" "--" "--allow-all" "--session-id" "abc-123"',
        },
      ]));
    },
  });

  const match = inspector.findProcessForSession('abc-123');
  assert.equal(match?.processId, 502);
});

test('process inspector does not treat wrapper-only cmd.exe as live worker on windows', () => {
  const inspector = createSessionWorkerProcessInspector({
    platform: 'win32',
    execFileSyncImpl() {
      return Buffer.from(JSON.stringify([
        {
          processId: 601,
          parentProcessId: 1,
          name: 'cmd.exe',
          commandLine: 'C:\\Windows\\System32\\cmd.exe /d /s /c ""gh" "copilot" "--" "--allow-all" "--session-id" "abc-123""',
        },
      ]));
    },
  });

  const match = inspector.findProcessForSession('abc-123');
  assert.equal(match, null);
});

test('process inspector prefers newest non-wrapper worker when multiple candidates match', () => {
  const inspector = createSessionWorkerProcessInspector({
    platform: 'win32',
    execFileSyncImpl() {
      return Buffer.from(JSON.stringify([
        {
          processId: 700,
          parentProcessId: 1,
          name: 'gh.exe',
          commandLine: 'gh copilot -- --allow-all --session-id abc-123',
        },
        {
          processId: 701,
          parentProcessId: 1,
          name: 'gh.exe',
          commandLine: 'gh copilot -- --allow-all --session-id abc-123',
        },
      ]));
    },
  });

  const match = inspector.findProcessForSession('abc-123');
  assert.equal(match?.processId, 701);
});
