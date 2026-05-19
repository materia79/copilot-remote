'use strict';

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { resolveStartupWorkspaceRoot } from './workspace-root.mjs';

const projectDir = path.dirname(fileURLToPath(import.meta.url));
const nodeBin = process.execPath;
const rawArgs = process.argv.slice(2);
const launchWorkspaceRoot = resolveStartupWorkspaceRoot(projectDir);
const serverScript = path.join(projectDir, 'server.js');
const relayScript = path.join(projectDir, 'relay.mjs');

const tokenArgIdx = rawArgs.indexOf('--token');
const tokenFromArg = tokenArgIdx !== -1 ? rawArgs[tokenArgIdx + 1] : null;

let shuttingDown = false;
let serverProc = null;
let relayProc = null;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readConfig() {
  const configPath = path.join(projectDir, 'config.json');
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

  console.log('[start] Launching web server...');
  const serverArgs = [serverScript, ...rawArgs];
  if (!tokenFromArg) {
    serverArgs.push('--token', sharedToken);
  }

  serverProc = spawn(nodeBin, serverArgs, {
    cwd: launchWorkspaceRoot,
    env: { ...process.env, COPILOT_WORKSPACE_ROOT: launchWorkspaceRoot },
    stdio: 'inherit',
    detached: process.platform !== 'win32',
    windowsHide: false,
  });

  serverProc.on('exit', (code, signal) => {
    console.log(`[start] Server exited (code=${code ?? 'null'}, signal=${signal ?? 'none'}). Stopping relay...`);
    killProcessTree(relayProc);
    process.exit(code ?? 0);
  });

  await waitForServerReady(sharedToken, port, 20_000);

  console.log('[start] Launching relay...');
  const relayArgs = [relayScript, '--token', sharedToken];
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

  relayProc.on('exit', (code, signal) => {
    if (shuttingDown) return;
    console.log(`[start] Relay exited (code=${code ?? 'null'}, signal=${signal ?? 'none'}). Stopping server...`);
    killProcessTree(serverProc);
    process.exit(code ?? 1);
  });
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
