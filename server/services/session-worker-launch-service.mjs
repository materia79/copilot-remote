'use strict';

import { execFileSync, spawn } from 'child_process';

function shellQuote(value) {
  return `'${String(value || '').replace(/'/g, `'\\''`)}'`;
}

function cmdQuote(value) {
  return `"${String(value || '').replace(/"/g, '\\"')}"`;
}

function parsePositiveInt(value) {
  const num = Number.parseInt(String(value || ''), 10);
  return Number.isInteger(num) && num > 0 ? num : null;
}

function isPidAlive(pidValue) {
  const pid = Number(pidValue);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = String(error?.code || '').trim().toUpperCase();
    return code === 'EPERM';
  }
}

export function normalizeTmuxSessionName(targetSessionId) {
  const text = String(targetSessionId || '').trim();
  if (!text) throw new Error('missing-target-session-id');
  if (!/^[A-Za-z0-9_-]+$/.test(text)) {
    throw new Error(`invalid-tmux-session-name:${text}`);
  }
  return text;
}

export function isTmuxAvailable({
  platform = process.platform,
  execFileSyncImpl = execFileSync,
} = {}) {
  if (platform === 'win32') return false;
  try {
    execFileSyncImpl('tmux', ['-V'], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

export function tmuxSessionExists(sessionName, {
  execFileSyncImpl = execFileSync,
} = {}) {
  try {
    execFileSyncImpl('tmux', ['has-session', '-t', sessionName], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

export function killTmuxSession(sessionName, {
  execFileSyncImpl = execFileSync,
} = {}) {
  if (!tmuxSessionExists(sessionName, { execFileSyncImpl })) return false;
  try {
    execFileSyncImpl('tmux', ['kill-session', '-t', sessionName], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

export function getTmuxPanePid(sessionName, {
  execFileSyncImpl = execFileSync,
} = {}) {
  try {
    const output = execFileSyncImpl('tmux', ['list-panes', '-t', sessionName, '-F', '#{pane_pid}'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const firstLine = String(output || '').trim().split(/\r?\n/).find(Boolean) || '';
    return parsePositiveInt(firstLine);
  } catch {
    return null;
  }
}

export function buildTmuxWorkerShellCommand(targetSessionId, env = {}) {
  const exports = [];
  for (const key of [
    'GITHUB_COPILOT_PROMPT_MODE_EXTENSIONS',
    'COPILOT_WEB_RELAY_ROOT',
    'COPILOT_WEB_RELAY_SERVER_DIR',
    'COPILOT_WEB_RELAY_CONFIG',
    'COPILOT_WEB_RELAY_TOOLS',
    'COPILOT_WEB_RELAY_LOG_DIR',
    'COPILOT_WORKSPACE_ROOT',
    'INIT_CWD',
  ]) {
    const value = String(env?.[key] || '').trim();
    if (!value) continue;
    exports.push(`${key}=${shellQuote(value)}`);
  }
  const prefix = exports.length ? `${exports.join(' ')} ` : '';
  return `${prefix}exec gh copilot -- --allow-all --session-id ${shellQuote(targetSessionId)}`;
}

export function buildWindowsWorkerCommand(targetSessionId) {
  return [
    'gh',
    'copilot',
    '--',
    '--allow-all',
    '--session-id',
    String(targetSessionId || '').trim(),
  ].map(cmdQuote).join(' ');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildWorkerLaunchEnv({ processCwd, workspaceRoot, env = process.env } = {}) {
  const launchProcessCwd = String(processCwd || '').trim();
  const launchWorkspaceRoot = String(workspaceRoot || '').trim() || launchProcessCwd;
  if (!launchProcessCwd && !launchWorkspaceRoot) return env;
  return {
    ...env,
    ...(launchWorkspaceRoot ? {
      COPILOT_WORKSPACE_ROOT: launchWorkspaceRoot,
      INIT_CWD: launchWorkspaceRoot,
    } : {}),
    ...(launchProcessCwd ? { PWD: launchProcessCwd } : {}),
  };
}

export async function launchSessionCli({
  targetSessionId,
  cwd,
  processCwd = '',
  workspaceRoot = '',
  env = process.env,
  platform = process.platform,
  spawnImpl = spawn,
  execFileSyncImpl = execFileSync,
  processInspector = null,
  tmuxPollAttempts = 4,
  tmuxPollDelayMs = 200,
  detachedPollAttempts = 10,
  detachedPollDelayMs = 200,
} = {}) {
  const target = String(targetSessionId || '').trim();
  if (!target) throw new Error('missing-target-session-id');

  const liveProcess = typeof processInspector?.findProcessForSession === 'function'
    ? processInspector.findProcessForSession(target)
    : null;
  const liveProcessPid = parsePositiveInt(liveProcess?.processId);
  if (liveProcessPid && isPidAlive(liveProcessPid)) {
    return {
      pid: liveProcessPid,
      reused: true,
      launchMode: platform === 'win32' ? 'detached' : 'existing',
      tmuxSessionName: null,
    };
  }

  const launchWorkspaceRoot = String(workspaceRoot || cwd || process.cwd());
  const launchProcessCwd = String(processCwd || cwd || process.cwd());
  const launchEnv = buildWorkerLaunchEnv({
    processCwd: launchProcessCwd,
    workspaceRoot: launchWorkspaceRoot,
    env,
  });

  if (isTmuxAvailable({ platform, execFileSyncImpl })) {
    const sessionName = normalizeTmuxSessionName(target);
    const existingPanePid = getTmuxPanePid(sessionName, { execFileSyncImpl });
    if (existingPanePid && isPidAlive(existingPanePid)) {
      return {
        pid: existingPanePid,
        reused: true,
        launchMode: 'tmux',
        tmuxSessionName: sessionName,
      };
    }
    killTmuxSession(sessionName, { execFileSyncImpl });
    execFileSyncImpl('tmux', [
      'new-session',
      '-d',
      '-s',
      sessionName,
      '-c',
      launchProcessCwd,
      'sh',
      '-lc',
      buildTmuxWorkerShellCommand(target, launchEnv),
    ], {
      env: launchEnv,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    const attempts = Math.max(1, Number(tmuxPollAttempts) || 1);
    for (let index = 0; index < attempts; index += 1) {
      await sleep(Math.max(50, Number(tmuxPollDelayMs) || 200));
      const processMatch = typeof processInspector?.findProcessForSession === 'function'
        ? processInspector.findProcessForSession(target)
        : null;
      if (processMatch?.processId) {
        return {
          pid: Number(processMatch.processId),
          reused: false,
          launchMode: 'tmux',
          tmuxSessionName: sessionName,
        };
      }
      const panePid = getTmuxPanePid(sessionName, { execFileSyncImpl });
      if (panePid && isPidAlive(panePid)) {
        return {
          pid: panePid,
          reused: false,
          launchMode: 'tmux',
          tmuxSessionName: sessionName,
        };
      }
    }
    throw new Error('worker-spawn-unhealthy:tmux-pane-missing');
  }

  const spawnCommand = platform === 'win32' ? (launchEnv.ComSpec || process.env.ComSpec || 'cmd.exe') : 'gh';
  const spawnArgs = platform === 'win32'
    ? ['/d', '/s', '/c', buildWindowsWorkerCommand(target)]
    : ['copilot', '--', '--allow-all', '--session-id', target];
  const child = spawnImpl(spawnCommand, spawnArgs, {
    cwd: launchProcessCwd,
    env: launchEnv,
    detached: true,
    stdio: 'ignore',
    windowsHide: platform === 'win32',
  });
  child.unref?.();
  if (platform === 'win32' && typeof processInspector?.findProcessForSession === 'function') {
    const attempts = Math.max(1, Number(detachedPollAttempts) || 1);
    for (let index = 0; index < attempts; index += 1) {
      await sleep(Math.max(50, Number(detachedPollDelayMs) || 200));
      const processMatch = processInspector.findProcessForSession(target);
      const processPid = parsePositiveInt(processMatch?.processId);
      if (processPid) {
        return {
          pid: processPid,
          reused: false,
          launchMode: 'detached',
          tmuxSessionName: null,
          child,
        };
      }
    }
  }
  const pid = parsePositiveInt(child?.pid);
  if (!pid) throw new Error('worker-spawn-unhealthy:missing-pid');
  return {
    pid,
    reused: false,
    launchMode: 'detached',
    tmuxSessionName: null,
    child,
  };
}
