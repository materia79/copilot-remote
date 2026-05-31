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
        `201 1 node /home/simon/git/copilot-remote/server/server.js --allow-all --session-id abc-123`,
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
