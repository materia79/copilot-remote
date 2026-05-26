'use strict';

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { resolveStartupWorkspaceRoot } from './workspace-root.mjs';
import { RELAY_RESTART_EXIT_CODE } from './relay-exit-codes.mjs';
import { RELAY_SUPERVISED_ENV } from './relay-self-restart.mjs';

const projectDir = path.dirname(fileURLToPath(import.meta.url));
const nodeBin = process.execPath;
const rawArgs = process.argv.slice(2);
const launchWorkspaceRoot = resolveStartupWorkspaceRoot(projectDir);
const serverScript = path.join(projectDir, 'server.js');
const relayScript = path.join(projectDir, 'relay.mjs');

const tokenArgIdx = rawArgs.indexOf('--token');
const tokenFromArg = tokenArgIdx !== -1 ? rawArgs[tokenArgIdx + 1] : null;
const portArgIdx = rawArgs.indexOf('--port');
const portFromArg = portArgIdx !== -1 ? rawArgs[portArgIdx + 1] : null;

let shuttingDown = false;
let restartingServer = false;
let serverProc = null;
let relayProc = null;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readConfig() {
  const configPath = process.env.COPILOT_WEB_RELAY_CONFIG
    ? path.resolve(String(process.env.COPILOT_WEB_RELAY_CONFIG))
    : path.join(projectDir, 'config.json');
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return null;
  }
}

async function waitForServerReady(token, port, maxWaitMs) {
  const deadline = Date.now() + maxWaitMs;
  const url = `http://localhost:${port}/api/status`;

  while (Date.now() < deadline) {
    if (serverProc && serverProc.exitCode !== null) {
      throw new Error('Server exited before becoming ready');
    }

    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) return;
    } catch {
      // Retry until deadline.
    }

    await delay(300);
  }

  throw new Error(`Timed out waiting for server readiness at ${url}`);
}

function killProcessTree(proc) {
  if (!proc || proc.exitCode !== null) return;

  const isWindows = process.platform === 'win32';
  const pidTarget = (!isWindows && proc.spawnargs) ? -proc.pid : proc.pid;

  try {
    process.kill(pidTarget, 'SIGTERM');
  } catch {
    return;
  }

  // Escalate if the child did not exit promptly.
  setTimeout(() => {
    if (proc.exitCode !== null) return;
    try { process.kill(pidTarget, 'SIGKILL'); } catch {}
  }, 1200);
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;

  killProcessTree(relayProc);
  killProcessTree(serverProc);

  setTimeout(() => process.exit(code), 150);
}

async function main() {
  const cfg = readConfig() || {};
  const configToken = typeof cfg.authToken === 'string' ? cfg.authToken.trim() : '';
  const sharedToken = tokenFromArg || configToken || randomUUID();
  const port = Number(cfg.port) || 3333;

  if (!tokenFromArg && !configToken) {
    console.log('[start] No token in args/config; generated a startup token.');
  }

  while (!shuttingDown) {
    restartingServer = false;
    console.log('[start] Launching web server...');
    const serverArgs = [serverScript, ...rawArgs];
    if (!tokenFromArg) {
      serverArgs.push('--token', sharedToken);
    }

    serverProc = spawn(nodeBin, serverArgs, {
      cwd: launchWorkspaceRoot,
      env: { ...process.env, COPILOT_WORKSPACE_ROOT: launchWorkspaceRoot, [RELAY_SUPERVISED_ENV]: '1' },
      stdio: 'inherit',
      detached: process.platform !== 'win32',
      windowsHide: false,
    });

    const serverExitPromise = new Promise((resolve) => {
      serverProc.once('exit', (code, signal) => resolve({ code, signal }));
    });

    await waitForServerReady(sharedToken, port, 20_000);
    if (shuttingDown) break;

    console.log('[start] Launching relay...');
    const relayArgs = [relayScript, '--token', sharedToken];
    if (portFromArg) relayArgs.push('--port', portFromArg);
    if (rawArgs.includes('--foreground')) relayArgs.push('--foreground');
    if (rawArgs.includes('--quiet')) relayArgs.push('--quiet');
    if (rawArgs.includes('--verbose')) relayArgs.push('--verbose');

    relayProc = spawn(nodeBin, relayArgs, {
      cwd: launchWorkspaceRoot,
      env: { ...process.env, COPILOT_WORKSPACE_ROOT: launchWorkspaceRoot },
      stdio: 'inherit',
      detached: process.platform !== 'win32',
      windowsHide: false,
    });

    relayProc.once('exit', (code, signal) => {
      if (shuttingDown || restartingServer) return;
      console.log(`[start] Relay exited (code=${code ?? 'null'}, signal=${signal ?? 'none'}). Stopping server...`);
      killProcessTree(serverProc);
      process.exit(code ?? 1);
    });

    const { code, signal } = await serverExitPromise;
    if (shuttingDown) break;
    const serverExitCode = Number.isInteger(Number(code)) ? Number(code) : null;
    const restartRequested = serverExitCode === RELAY_RESTART_EXIT_CODE;

    if (restartRequested) {
      restartingServer = true;
      console.log(`[start] Server exited (code=${serverExitCode}, signal=${signal ?? 'none'}). Restart requested, relaunching...`);
      killProcessTree(relayProc);
      relayProc = null;
      serverProc = null;
      await delay(150);
      continue;
    }

    console.log(`[start] Server exited (code=${code ?? 'null'}, signal=${signal ?? 'none'}). Stopping relay...`);
    killProcessTree(relayProc);
    process.exit(serverExitCode ?? 0);
  }
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('uncaughtException', (err) => {
  console.error('[start] Uncaught exception:', err);
  shutdown(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[start] Unhandled rejection:', reason);
  shutdown(1);
});

main().catch((err) => {
  console.error('[start] Failed to start:', err.message || err);
  shutdown(1);
});
