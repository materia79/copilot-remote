import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildTmuxWorkerShellCommand,
  killTmuxSession,
  launchSessionCli,
  normalizeTmuxSessionName,
} from './session-worker-launch-service.mjs';

test('normalizeTmuxSessionName rejects unsafe session ids', () => {
  assert.throws(() => normalizeTmuxSessionName('abc:def'), /invalid-tmux-session-name/);
  assert.equal(normalizeTmuxSessionName('abc-123_DEF'), 'abc-123_DEF');
});

test('buildTmuxWorkerShellCommand injects only relay env needed for workers', () => {
  const command = buildTmuxWorkerShellCommand('abc-123', {
    GITHUB_COPILOT_PROMPT_MODE_EXTENSIONS: 'true',
    COPILOT_WEB_RELAY_SERVER_DIR: '/repo/server',
    INIT_CWD: '/workspace',
    IGNORED_VAR: 'nope',
  });

  assert.match(command, /GITHUB_COPILOT_PROMPT_MODE_EXTENSIONS='true'/);
  assert.match(command, /COPILOT_WEB_RELAY_SERVER_DIR='\/repo\/server'/);
  assert.match(command, /INIT_CWD='\/workspace'/);
  assert.doesNotMatch(command, /IGNORED_VAR/);
  assert.match(command, /exec gh copilot -- --allow-all --session-id 'abc-123'/);
});

test('killTmuxSession returns false when tmux kill races after session exists', () => {
  const execCalls = [];
  const killed = killTmuxSession('abc-123', {
    execFileSyncImpl(command, args) {
      execCalls.push([command, ...args]);
      assert.equal(command, 'tmux');
      if (args[0] === 'has-session') return Buffer.alloc(0);
      if (args[0] === 'kill-session') throw new Error('session vanished');
      throw new Error(`unexpected tmux args: ${args.join(' ')}`);
    },
  });

  assert.equal(killed, false);
  assert.deepEqual(execCalls, [
    ['tmux', 'has-session', '-t', 'abc-123'],
    ['tmux', 'kill-session', '-t', 'abc-123'],
  ]);
});

test('launchSessionCli uses tmux on posix and returns discovered worker pid', async () => {
  const calls = [];
  let finds = 0;
  let paneChecks = 0;
  const execFileSyncImpl = (command, args) => {
    calls.push([command, ...args]);
    if (command !== 'tmux') throw new Error(`unexpected command: ${command}`);
    if (args[0] === '-V') return Buffer.from('tmux 3.6');
    if (args[0] === 'has-session') {
      const err = new Error('missing');
      err.status = 1;
      throw err;
    }
    if (args[0] === 'list-panes') {
      paneChecks += 1;
      return paneChecks >= 2 ? Buffer.from(`${process.pid}\n`) : Buffer.from('');
    }
    if (args[0] === 'new-session') return Buffer.alloc(0);
    throw new Error(`unexpected tmux args: ${args.join(' ')}`);
  };
  const processInspector = {
    findProcessForSession() {
      finds += 1;
      return finds >= 2 ? { processId: process.pid, commandLine: 'gh copilot -- --session-id abc-123' } : null;
    },
  };

  const launched = await launchSessionCli({
    targetSessionId: 'abc-123',
    processCwd: '/relay',
    workspaceRoot: '/repo',
    env: {
      GITHUB_COPILOT_PROMPT_MODE_EXTENSIONS: 'true',
      COPILOT_WORKSPACE_ROOT: '/stale',
    },
    platform: 'linux',
    execFileSyncImpl,
    processInspector,
    tmuxPollAttempts: 2,
    tmuxPollDelayMs: 1,
  });

  assert.equal(launched.launchMode, 'tmux');
  assert.equal(launched.pid, process.pid);
  assert.equal(launched.tmuxSessionName, 'abc-123');
  assert.ok(calls.length >= 2);
  const newSessionCall = calls.find((call) => call[1] === 'new-session');
  assert.equal(newSessionCall?.[6], '/relay');
  assert.deepEqual(newSessionCall?.slice(-3), ['sh', '-lc', "GITHUB_COPILOT_PROMPT_MODE_EXTENSIONS='true' COPILOT_WORKSPACE_ROOT='/repo' INIT_CWD='/repo' exec gh copilot -- --allow-all --session-id 'abc-123'"]);
});

test('launchSessionCli falls back to detached spawn when tmux is unavailable', async () => {
  const spawnCalls = [];
  const launched = await launchSessionCli({
    targetSessionId: 'abc-123',
    processCwd: '/relay',
    workspaceRoot: '/repo',
    env: {
      PATH: process.env.PATH || '',
      COPILOT_WORKSPACE_ROOT: '/stale',
    },
    platform: 'linux',
    execFileSyncImpl(command) {
      if (command === 'tmux') throw new Error('missing tmux');
      throw new Error(`unexpected command: ${command}`);
    },
    processInspector: {
      findProcessForSession() {
        return null;
      },
    },
    spawnImpl(command, args, options) {
      spawnCalls.push({ command, args, options });
      return {
        pid: 4242,
        unref() {},
      };
    },
  });

  assert.equal(launched.launchMode, 'detached');
  assert.equal(launched.pid, 4242);
  assert.equal(spawnCalls[0]?.command, 'gh');
  assert.equal(spawnCalls[0]?.options?.cwd, '/relay');
  assert.equal(spawnCalls[0]?.options?.env?.COPILOT_WORKSPACE_ROOT, '/repo');
  assert.equal(spawnCalls[0]?.options?.env?.INIT_CWD, '/repo');
  assert.equal(spawnCalls[0]?.options?.env?.PWD, '/relay');
});

test('launchSessionCli reuses a live existing process before launching', async () => {
  const launched = await launchSessionCli({
    targetSessionId: 'abc-123',
    cwd: '/repo',
    platform: 'linux',
    processInspector: {
      findProcessForSession() {
        return { processId: process.pid, commandLine: 'gh copilot -- --session-id abc-123' };
      },
    },
    execFileSyncImpl() {
      throw new Error('tmux should not be checked when live process is reused');
    },
    spawnImpl() {
      throw new Error('spawn should not be called when live process is reused');
    },
  });

  assert.equal(launched.reused, true);
  assert.equal(launched.pid, process.pid);
  assert.equal(launched.launchMode, 'existing');
});

test('launchSessionCli ignores a dead discovered pid and continues to launch', async () => {
  const spawnCalls = [];
  const launched = await launchSessionCli({
    targetSessionId: 'abc-123',
    cwd: '/repo',
    platform: 'linux',
    processInspector: {
      findProcessForSession() {
        return { processId: 99999999, commandLine: 'gh copilot -- --session-id abc-123' };
      },
    },
    execFileSyncImpl(command) {
      if (command === 'tmux') throw new Error('missing tmux');
      throw new Error(`unexpected command: ${command}`);
    },
    spawnImpl(command, args, options) {
      spawnCalls.push({ command, args, options });
      return {
        pid: 4243,
        unref() {},
      };
    },
  });

  assert.equal(launched.reused, false);
  assert.equal(launched.launchMode, 'detached');
  assert.equal(launched.pid, 4243);
  assert.equal(spawnCalls[0]?.command, 'gh');
});
