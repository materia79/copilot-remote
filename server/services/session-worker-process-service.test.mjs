import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionWorkerProcessInspector } from './session-worker-process-service.mjs';

test('session worker inspector parses both session-id forms', () => {
  const inspector = createSessionWorkerProcessInspector({ platform: 'win32', execFileSyncImpl: () => Buffer.from('[]') });
  assert.equal(
    inspector.parseSessionIdFromCommandLine('gh copilot -- --allow-all --session-id=abc-123'),
    'abc-123',
  );
  assert.equal(
    inspector.parseSessionIdFromCommandLine('gh copilot -- --allow-all --session-id abc-123'),
    'abc-123',
  );
});

test('session worker inspector finds only matching live session processes', () => {
  const snapshots = [
    [
      { processId: 11, name: 'gh.exe', commandLine: 'gh copilot -- --allow-all --session-id=abc-123' },
      { processId: 12, name: 'cmd.exe', commandLine: 'cmd /c copilot.cmd --allow-all --session-id abc-123' },
      { processId: 13, name: 'gh.exe', commandLine: 'gh copilot -- --allow-all --session-id=other-session' },
      { processId: 14, name: 'node.exe', commandLine: 'node server.js' },
    ],
  ];
  const inspector = createSessionWorkerProcessInspector({
    platform: 'win32',
    execFileSyncImpl: (_file, args) => {
      const command = String(args?.[2] || '');
      if (command.includes('ConvertTo-Json')) {
        return Buffer.from(JSON.stringify(snapshots[0]));
      }
      return Buffer.from('[]');
    },
  });

  const matches = inspector.findWindowsProcessesForSession('abc-123');
  assert.deepEqual(matches.map((proc) => proc.processId), [11, 12]);
  assert.equal(inspector.findWindowsProcessForSession('other-session')?.processId, 13);
  assert.equal(inspector.findWindowsProcessForSession('missing-session'), null);
});
