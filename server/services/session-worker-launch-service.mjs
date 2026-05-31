'use strict';

import { execFileSync, spawn } from 'child_process';

function shellQuote(value) {
  return `'${String(value || '').replace(/'/g, `'\\''`)}'`;
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
  ]) {
    const value = String(env?.[key] || '').trim();
    if (!value) continue;
    exports.push(`${key}=${shellQuote(value)}`);
  }
  const prefix = exports.length ? `${exports.join(' ')} ` : '';
  return `${prefix}exec gh copilot -- --allow-all --session-id ${shellQuote(targetSessionId)}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildWorkerLaunchEnv(cwd, env = process.env) {
  const launchCwd = String(cwd || '').trim();
  if (!launchCwd) return env;
  return {
    ...env,
    COPILOT_WORKSPACE_ROOT: launchCwd,
    PWD: launchCwd,
  };
}

export async function launchSessionCli({
  targetSessionId,
  cwd,
  env = process.env,
  platform = process.platform,
  spawnImpl = spawn,
  execFileSyncImpl = execFileSync,
  processInspector = null,
  tmuxPollAttempts = 4,
  tmuxPollDelayMs = 200,
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

  const launchCwd = String(cwd || process.cwd());
  const launchEnv = buildWorkerLaunchEnv(launchCwd, env);

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
      launchCwd,
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

  const child = spawnImpl('gh', ['copilot', '--', '--allow-all', '--session-id', target], {
    cwd: launchCwd,
    env: launchEnv,
    detached: true,
    stdio: 'ignore',
    shell: platform === 'win32',
    windowsHide: platform === 'win32',
  });
  child.unref?.();
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
