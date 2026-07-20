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

function normalizeText(value) {
  const text = String(value || '').trim();
  return text || null;
}

function buildPosixWorkerLaunchCommand(targetSessionId, env = {}) {
  const cliExecutable = normalizeText(env?.COPILOT_WEB_RELAY_CLI_EXECUTABLE)
    || normalizeText(env?.COPILOT_CLI_EXECUTABLE)
    || normalizeText(env?.COPILOT_CLI_PATH)
    || 'copilot';
  return `${shellQuote(cliExecutable)} --allow-all --session-id ${shellQuote(targetSessionId)} -i ${shellQuote('launch the server')}`;
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
  const launchEnv = {
    ...env,
    SESSION_ID: String(targetSessionId || '').trim() || String(env?.SESSION_ID || '').trim(),
  };
  const exports = [];
  for (const key of [
    'COPILOT_ALLOW_ALL',
    'GITHUB_COPILOT_PROMPT_MODE_EXTENSIONS',
    'COPILOT_WEB_RELAY_ROOT',
    'COPILOT_WEB_RELAY_SERVER_DIR',
    'COPILOT_WEB_RELAY_CONFIG',
    'COPILOT_WEB_RELAY_TOOLS',
    'COPILOT_WEB_RELAY_LOG_DIR',
    'COPILOT_WEB_RELAY_CLI_EXECUTABLE',
    'COPILOT_WEB_RELAY_EXTENSION_BOOTSTRAP_PATH',
    'COPILOT_SDK_PATH',
    'EXTENSION_PATH',
    'SESSION_ID',
    'COPILOT_WORKSPACE_ROOT',
    'INIT_CWD',
  ]) {
    const value = String(launchEnv?.[key] || '').trim();
    if (!value) continue;
    exports.push(`${key}=${shellQuote(value)}`);
  }
  const prefix = exports.length ? `${exports.join(' ')} ` : '';
  // Use script to create a pseudo-TTY without GH_FORCE_TTY so the CLI routes
  // ask_user requests through the SDK's onUserInputRequest handler instead of
  // drawing terminal prompts.
  const workerCommand = buildPosixWorkerLaunchCommand(targetSessionId, env);
  return `${prefix}exec script -q -c ${shellQuote(workerCommand)} /dev/null`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildWorkerLaunchEnv({ processCwd, workspaceRoot, env = process.env } = {}) {
  const launchProcessCwd = String(processCwd || '').trim();
  const launchWorkspaceRoot = String(workspaceRoot || '').trim() || launchProcessCwd;
  if (!launchProcessCwd && !launchWorkspaceRoot) return env;
  const launchEnv = {
    ...env,
    COPILOT_ALLOW_ALL: 'true',
    GITHUB_COPILOT_PROMPT_MODE_EXTENSIONS: 'true',
    ...(launchWorkspaceRoot ? {
      COPILOT_WORKSPACE_ROOT: launchWorkspaceRoot,
      INIT_CWD: launchWorkspaceRoot,
    } : {}),
    ...(launchProcessCwd ? { PWD: launchProcessCwd } : {}),
  };
  // COPILOT_ALLOW_ALL matches the --allow-all launch flag and lets headless
  // workers pass folder trust before extension activation. The global wrapper
  // handles outside-package workers and defers to the project extension inside
  // this package, so workers must not force both.
  delete launchEnv.COPILOT_WEB_RELAY_FORCE_GLOBAL_EXTENSION;
  return launchEnv;
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
  allowProcessReuse = true,
} = {}) {
  const target = String(targetSessionId || '').trim();
  if (!target) throw new Error('missing-target-session-id');

  if (allowProcessReuse) {
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
  }

  const launchWorkspaceRoot = String(workspaceRoot || cwd || process.cwd());
  const launchProcessCwd = String(processCwd || cwd || process.cwd());
  const launchEnv = buildWorkerLaunchEnv({
    processCwd: launchProcessCwd,
    workspaceRoot: launchWorkspaceRoot,
    env,
  });
  const launchSessionEnv = {
    ...launchEnv,
    SESSION_ID: target,
  };

  if (isTmuxAvailable({ platform, execFileSyncImpl })) {
    const sessionName = normalizeTmuxSessionName(target);
    const tmuxEnv = { ...launchSessionEnv };
    delete tmuxEnv.TMUX;
    delete tmuxEnv.TMUX_PANE;
    if (allowProcessReuse) {
      const existingPanePid = getTmuxPanePid(sessionName, { execFileSyncImpl });
      if (existingPanePid && isPidAlive(existingPanePid)) {
        return {
          pid: existingPanePid,
          reused: true,
          launchMode: 'tmux',
          tmuxSessionName: sessionName,
        };
      }
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
      buildTmuxWorkerShellCommand(target, launchSessionEnv),
    ], {
      env: tmuxEnv,
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

  const posixCliExecutable = normalizeText(launchSessionEnv.COPILOT_WEB_RELAY_CLI_EXECUTABLE)
    || normalizeText(launchSessionEnv.COPILOT_CLI_EXECUTABLE)
    || normalizeText(launchSessionEnv.COPILOT_CLI_PATH)
    || 'copilot';
  const spawnCommand = platform === 'win32'
    ? (launchSessionEnv.ComSpec || process.env.ComSpec || 'cmd.exe')
    : posixCliExecutable;
  const spawnArgs = platform === 'win32'
    ? [
      '/d',
      '/s',
      '/c',
      'start',
      `Copilot Worker ${target.slice(0, 8)}`,
      'gh',
      'copilot',
      '--',
      '--allow-all',
      '--session-id',
      target,
    ]
    : ['--allow-all', '--session-id', target, '-i', 'launch the server'];
  const child = spawnImpl(spawnCommand, spawnArgs, {
    cwd: launchProcessCwd,
    env: launchSessionEnv,
    detached: true,
    stdio: 'ignore',
    windowsHide: platform !== 'win32',
  });
  child.unref?.();
  if (platform === 'win32') {
    const attempts = Math.max(1, Number(detachedPollAttempts) || 1);
    for (let index = 0; index < attempts; index += 1) {
      await sleep(Math.max(50, Number(detachedPollDelayMs) || 200));
      const processMatch = typeof processInspector?.findProcessForSession === 'function'
        ? processInspector.findProcessForSession(target)
        : null;
      const processPid = parsePositiveInt(processMatch?.processId);
      if (processPid && isPidAlive(processPid)) {
        return {
          pid: processPid,
          reused: false,
          launchMode: 'console',
          tmuxSessionName: null,
          child,
        };
      }
    }
    return {
      pid: null,
      reused: false,
      launchMode: 'console',
      tmuxSessionName: null,
      child,
    };
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
