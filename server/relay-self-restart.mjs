import { spawn } from 'child_process';
import path from 'path';
import { RELAY_RESTART_EXIT_CODE } from './relay-exit-codes.mjs';

export const RELAY_SUPERVISED_ENV = 'COPILOT_WEB_RELAY_SUPERVISED';
export const RELAY_SELF_RESTART_MODE_ENV = 'COPILOT_WEB_RELAY_SELF_RESTART_MODE';
export const RELAY_SELF_RESTART_COUNT_ENV = 'COPILOT_WEB_RELAY_SELF_RESTART_COUNT';
export const RELAY_SELF_RESTART_CRASH_COUNT_ENV = 'COPILOT_WEB_RELAY_SELF_RESTART_CRASH_COUNT';

export function isRelayRestartSupervised(env = process.env) {
  const raw = String(env?.[RELAY_SUPERVISED_ENV] || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

export function isRelaySelfRestartWorker(env = process.env) {
  return String(env?.[RELAY_SELF_RESTART_MODE_ENV] || '').trim().toLowerCase() === 'worker';
}

export function buildRelayRuntimeEnv(env = process.env, overrides = {}) {
  return {
    ...env,
    [RELAY_SUPERVISED_ENV]: '1',
    ...overrides,
  };
}

export function spawnRelayRuntime({
  env = process.env,
  cwd = process.cwd(),
  scriptPath,
  args = [],
  execArgv = process.execArgv,
  restartCount = 0,
  crashCount = 0,
  spawnImpl = spawn,
  stdio = ['ignore', 'pipe', 'pipe'],
  detached = false,
  windowsHide = true,
  logger = console,
} = {}) {
  const child = spawnImpl(process.execPath, [...execArgv, scriptPath, ...args], {
    cwd,
    env: buildRelayRuntimeEnv(env, {
      [RELAY_SELF_RESTART_MODE_ENV]: 'worker',
      [RELAY_SELF_RESTART_COUNT_ENV]: String(restartCount),
      [RELAY_SELF_RESTART_CRASH_COUNT_ENV]: String(crashCount),
    }),
    detached,
    stdio,
    windowsHide,
  });
  logger?.log?.(`[relay] launched runtime pid=${child.pid || 'none'} script=${path.basename(String(scriptPath || ''))}`);
  return child;
}

function stopChildProcess(child, { signal = 'SIGTERM', killAfterMs = 1200 } = {}) {
  if (!child || child.exitCode !== null) return;
  try {
    child.kill(signal);
  } catch {
    return;
  }
  setTimeout(() => {
    if (!child || child.exitCode !== null) return;
    try { child.kill('SIGKILL'); } catch {}
  }, killAfterMs);
}

function waitForChildExit(child) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.once?.('error', (error) => finish({ code: null, signal: null, error }));
    child.once?.('exit', (code, signal) => finish({ code, signal, error: null }));
  });
}

export async function runDirectRelaySupervisor({
  scriptPath,
  args = [],
  cwd = process.cwd(),
  env = process.env,
  execArgv = process.execArgv,
  spawnImpl = spawn,
  stdio = ['ignore', 'pipe', 'pipe'],
  delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  exitImpl = (code) => process.exit(code),
  logger = console,
  installSignalHandlers = true,
  restartDelayMs = 500,
  maxCrashRestarts = 3,
} = {}) {
  let runtimeProc = null;
  let shuttingDown = false;
  let shutdownExitCode = 0;

  const requestShutdown = (signal = 'SIGTERM', exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    shutdownExitCode = exitCode;
    stopChildProcess(runtimeProc, { signal });
  };

  const handleSigInt = () => requestShutdown('SIGINT', 0);
  const handleSigTerm = () => requestShutdown('SIGTERM', 0);

  if (installSignalHandlers) {
    process.on('SIGINT', handleSigInt);
    process.on('SIGTERM', handleSigTerm);
  }

  try {
    let restartCount = 0;
    let crashCount = 0;
    while (true) {
      runtimeProc = spawnRelayRuntime({
        env,
        cwd,
        scriptPath,
        args,
        execArgv,
        restartCount,
        crashCount,
        spawnImpl,
        stdio,
        detached: false,
        logger,
      });
      if (runtimeProc.stdout?.on) {
        runtimeProc.stdout.on('data', (chunk) => process.stdout.write(chunk));
      }
      if (runtimeProc.stderr?.on) {
        runtimeProc.stderr.on('data', (chunk) => process.stderr.write(chunk));
      }

      const result = await waitForChildExit(runtimeProc);
      runtimeProc = null;

      if (shuttingDown) {
        return await exitImpl(shutdownExitCode);
      }

      if (result.error) {
        logger?.error?.(`[relay] runtime launch failed: ${result.error?.message || result.error}`);
        return await exitImpl(1);
      }

      const exitCode = Number.isInteger(Number(result.code)) ? Number(result.code) : null;
      if (exitCode === RELAY_RESTART_EXIT_CODE) {
        logger?.log?.(`[relay] runtime requested restart; relaunching ${path.basename(String(scriptPath || ''))}...`);
        restartCount += 1;
        crashCount = 0;
        await delay(restartDelayMs);
        continue;
      }

      if (exitCode === 0) {
        return await exitImpl(0);
      }

      const attempt = crashCount + 1;
      logger?.error?.(`[relay] runtime crashed with exit code ${exitCode ?? 'null'} (crash ${attempt}/${maxCrashRestarts}).`);
      if (attempt >= maxCrashRestarts) {
        logger?.error?.('[relay] crash limit reached; supervisor stopping.');
        return await exitImpl(1);
      }
      crashCount = attempt;
      await delay(restartDelayMs);
    }

  } finally {
    if (installSignalHandlers) {
      process.off('SIGINT', handleSigInt);
      process.off('SIGTERM', handleSigTerm);
    }
  }
}
