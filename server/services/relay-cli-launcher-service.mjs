'use strict';

import { execFileSync, spawn } from 'child_process';

function normalizeText(value) {
  return String(value || '').trim().toLowerCase();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isoNow(now) {
  return new Date(now()).toISOString();
}

function parsePositiveInt(value) {
  const num = Number.parseInt(String(value || ''), 10);
  return Number.isInteger(num) && num > 0 ? num : null;
}

export function createRelayCliLauncherService({
  platform = process.platform,
  cwd = process.cwd(),
  env = process.env,
  now = () => Date.now(),
  execFileSyncImpl = execFileSync,
  spawnImpl = spawn,
  sleepImpl = sleep,
  restartDelayMs = 500,
  killWaitMs = 700,
  maxKillAttempts = 10,
  log = () => {},
} = {}) {
  let activeJob = null;

  function getState() {
    if (!activeJob) return null;
    return {
      transactionId: activeJob.transactionId,
      targetSessionId: activeJob.targetSessionId,
      reason: activeJob.reason || null,
      status: activeJob.status,
      startedAt: activeJob.startedAt,
      completedAt: activeJob.completedAt || null,
      spawnedPid: activeJob.spawnedPid || null,
      error: activeJob.error || null,
      killedPids: Array.isArray(activeJob.killedPids) ? [...activeJob.killedPids] : [],
    };
  }

  function looksLikeCopilotProcess(proc) {
    const name = normalizeText(proc?.name);
    const cmd = normalizeText(proc?.commandLine);
    if (!name && !cmd) return false;
    if (cmd.includes('\\server\\server.js')) return false;
    if (name === 'gh.exe' && cmd.includes('gh') && cmd.includes('copilot')) return true;
    if (name === 'copilot.exe') return true;
    const explicitCliNodeMarker = (
      cmd.includes('@github\\copilot') ||
      cmd.includes('\\copilot.cmd') ||
      cmd.includes('copilot-win32') ||
      cmd.includes('gh copilot') ||
      cmd.includes('--resume') ||
      cmd.includes('--allow-all') ||
      cmd.includes('copilot-mcp-server') ||
      cmd.includes('@aykahshi/copilot-mcp-server')
    );
    if ((name === 'node.exe' || name === 'cmd.exe') && (
      explicitCliNodeMarker
    )) return true;
    if (cmd.includes('gh copilot')) return true;
    return false;
  }

  function getWindowsProcessSnapshot() {
    const script = [
      '$list = Get-CimInstance Win32_Process | ForEach-Object {',
      '  [pscustomobject]@{',
      '    processId = [int]$_.ProcessId;',
      '    parentProcessId = [int]$_.ParentProcessId;',
      '    name = [string]$_.Name;',
      '    commandLine = [string]$_.CommandLine;',
      '  }',
      '};',
      '$list | ConvertTo-Json -Depth 3 -Compress',
    ].join(' ');
    const output = execFileSyncImpl('powershell.exe', ['-NoProfile', '-Command', script], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const text = String(output || '').trim();
    if (!text) return [];
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  }

  function collectWindowsRetirePids() {
    const snapshot = getWindowsProcessSnapshot();
    return snapshot
      .map((proc) => ({
        processId: parsePositiveInt(proc?.processId),
        name: String(proc?.name || ''),
        commandLine: String(proc?.commandLine || ''),
      }))
      .filter((proc) => proc.processId)
      .filter((proc) => looksLikeCopilotProcess(proc))
      .map((proc) => proc.processId);
  }

  function stopWindowsPids(pids) {
    const ids = Array.from(new Set(
      (Array.isArray(pids) ? pids : [pids])
        .map((value) => parsePositiveInt(value))
        .filter(Boolean),
    ));
    if (!ids.length) return [];
    const script = [
      '$ids = @(' + ids.join(',') + ')',
      'foreach ($id in $ids) {',
      '  try { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue } catch {}',
      '}',
    ].join('; ');
    execFileSyncImpl('powershell.exe', ['-NoProfile', '-Command', script], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return ids;
  }

  async function retireCliProcesses(job) {
    if (platform !== 'win32') return [];
    const killed = new Set();
    const attempts = Math.max(1, Number(maxKillAttempts || 1));
    for (let index = 0; index < attempts; index += 1) {
      let targetPids = [];
      try {
        targetPids = collectWindowsRetirePids();
      } catch (error) {
        job.error = error?.message || String(error);
        throw error;
      }
      if (!targetPids.length) return Array.from(killed);
      for (const pid of stopWindowsPids(targetPids)) killed.add(pid);
      await sleepImpl(Math.max(0, Number(killWaitMs || 0)));
    }
    return Array.from(killed);
  }

  function spawnResumedCli(targetSessionId) {
    const child = spawnImpl('gh', ['copilot', '--', '--allow-all', '--resume', targetSessionId], {
      cwd,
      env,
      detached: true,
      stdio: 'ignore',
      shell: platform === 'win32',
      windowsHide: true,
    });
    child.unref?.();
    return child?.pid || null;
  }

  async function runJob(job) {
    job.status = 'running';
    if (restartDelayMs > 0) {
      await sleepImpl(restartDelayMs);
    }
    log(`relay cli launcher: retiring cli processes for ${job.targetSessionId} tx=${job.transactionId || 'none'}`);
    job.killedPids = await retireCliProcesses(job);
    log(`relay cli launcher: spawning resumed cli for ${job.targetSessionId}`);
    job.spawnedPid = spawnResumedCli(job.targetSessionId);
    job.status = 'spawned';
    job.completedAt = isoNow(now);
  }

  function scheduleRestart({ targetSessionId, transactionId = null, reason = null } = {}) {
    const target = String(targetSessionId || '').trim();
    const tx = String(transactionId || '').trim() || null;
    if (!target) {
      return { ok: false, error: 'missing-target-session', state: getState() };
    }
    const current = activeJob;
    if (current && !current.completedAt && current.status !== 'failed') {
      if (current.targetSessionId === target && current.transactionId === tx) {
        return { ok: true, accepted: true, reused: true, state: getState() };
      }
      return { ok: false, error: 'launcher-busy', state: getState() };
    }

    const job = {
      transactionId: tx,
      targetSessionId: target,
      reason: String(reason || '').trim() || null,
      startedAt: isoNow(now),
      completedAt: null,
      status: 'scheduled',
      spawnedPid: null,
      error: null,
      killedPids: [],
      promise: null,
    };
    activeJob = job;
    job.promise = runJob(job).catch((error) => {
      job.status = 'failed';
      job.completedAt = isoNow(now);
      job.error = error?.message || String(error);
      log(`relay cli launcher failed for ${job.targetSessionId}: ${job.error}`);
    });
    return { ok: true, accepted: true, reused: false, state: getState() };
  }

  async function waitForIdle() {
    if (activeJob?.promise) {
      await activeJob.promise;
    }
  }

  return {
    scheduleRestart,
    waitForIdle,
    getState,
  };
}
