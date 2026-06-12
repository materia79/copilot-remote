'use strict';

import { execFileSync } from 'child_process';

function normalizeSessionId(value) {
  const text = String(value || '').trim();
  return text || null;
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseSessionIdFromCommandLine(commandLine) {
  const text = String(commandLine || '');
  if (!text) return null;
  const match = text.match(/["']?--(?:session-id|resume)["']?(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s"'=]+))/i);
  const value = match?.[1] || match?.[2] || match?.[3] || '';
  return normalizeSessionId(value);
}

function buildSessionArgPattern(targetSessionId, { includeResume = true } = {}) {
  const target = normalizeSessionId(targetSessionId);
  if (!target) return null;
  const argName = includeResume ? 'session-id|resume' : 'session-id';
  return new RegExp(
    `["']?--(?:${argName})["']?(?:=|\\s+)(?:"${escapeRegExp(target)}"|'${escapeRegExp(target)}'|${escapeRegExp(target)})(?:\\s|$)`,
    'i',
  );
}

function scoreWindowsWorkerCandidate(proc) {
  const name = String(proc?.name || '').trim().toLowerCase();
  const cmd = String(proc?.commandLine || '').trim().toLowerCase();
  if (name === 'copilot.exe') return 400;
  if (name === 'gh.exe' && cmd.includes('copilot')) return 300;
  if (cmd.includes('gh copilot')) return 250;
  if (cmd.includes('copilot.cmd') || cmd.includes('copilot-win32')) return 225;
  if (name === 'cmd.exe' || name === 'powershell.exe' || name === 'conhost.exe') return 50;
  return 100;
}

function isWindowsWrapperProcess(proc) {
  const name = String(proc?.name || '').trim().toLowerCase();
  return name === 'cmd.exe' || name === 'powershell.exe' || name === 'conhost.exe';
}

function looksLikeCopilotWorkerProcess(proc) {
  const name = String(proc?.name || '').trim().toLowerCase();
  const cmd = String(proc?.commandLine || '').trim().toLowerCase();
  if (!name && !cmd) return false;
  if (cmd.includes('\\server\\server.js') || cmd.includes('/server/server.js')) return false;
  if (name === 'copilot.exe') return true;
  if (name === 'gh.exe' && cmd.includes('gh') && cmd.includes('copilot')) return true;
  if (cmd.includes('gh copilot')) return true;
  return cmd.includes('copilot.cmd')
    || cmd.includes('copilot-win32')
    || cmd.includes('@github\\copilot')
    || cmd.includes('@aykahshi/copilot-mcp-server')
    || cmd.includes('--allow-all')
    || cmd.includes('--resume');
}

export function createSessionWorkerProcessInspector({
  platform = process.platform,
  execFileSyncImpl = execFileSync,
} = {}) {
  function getPosixProcessSnapshot() {
    if (platform === 'win32') return [];
    const output = execFileSyncImpl('ps', ['-eo', 'pid=,ppid=,comm=,args=', '-ww'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const text = String(output || '').trim();
    if (!text) return [];
    return text
      .split(/\r?\n/)
      .map((line) => {
        const match = String(line || '').match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
        if (!match) return null;
        return {
          processId: Number.parseInt(match[1], 10),
          parentProcessId: Number.parseInt(match[2], 10),
          name: String(match[3] || ''),
          commandLine: String(match[4] || ''),
        };
      })
      .filter(Boolean);
  }

  function getWindowsProcessSnapshot() {
    if (platform !== 'win32') return [];
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

  function findWindowsProcessesForSession(targetSessionId) {
    const target = normalizeSessionId(targetSessionId);
    if (platform !== 'win32' || !target) return [];
    const targetPattern = buildSessionArgPattern(target, { includeResume: false });
    return getWindowsProcessSnapshot()
      .map((proc) => ({
        processId: Number.isInteger(Number(proc?.processId)) ? Number(proc.processId) : null,
        parentProcessId: Number.isInteger(Number(proc?.parentProcessId)) ? Number(proc.parentProcessId) : null,
        name: String(proc?.name || ''),
        commandLine: String(proc?.commandLine || ''),
      }))
      .filter((proc) => proc.processId)
      .filter((proc) => looksLikeCopilotWorkerProcess(proc))
      .filter((proc) => {
        const parsedSessionId = parseSessionIdFromCommandLine(proc.commandLine);
        if (parsedSessionId) return parsedSessionId === target;
        return targetPattern?.test(proc.commandLine);
      })
      .sort((left, right) => {
        const scoreDelta = scoreWindowsWorkerCandidate(right) - scoreWindowsWorkerCandidate(left);
        if (scoreDelta !== 0) return scoreDelta;
        return Number(right.processId || 0) - Number(left.processId || 0);
      });
  }

  function findWindowsProcessForSession(targetSessionId) {
    const candidates = findWindowsProcessesForSession(targetSessionId);
    return candidates.find((proc) => !isWindowsWrapperProcess(proc)) || null;
  }

  function findPosixProcessesForSession(targetSessionId) {
    const target = normalizeSessionId(targetSessionId);
    if (platform === 'win32' || !target) return [];
    const targetPattern = buildSessionArgPattern(target, { includeResume: true });
    return getPosixProcessSnapshot()
      .map((proc) => ({
        processId: Number.isInteger(Number(proc?.processId)) ? Number(proc.processId) : null,
        parentProcessId: Number.isInteger(Number(proc?.parentProcessId)) ? Number(proc.parentProcessId) : null,
        name: String(proc?.name || ''),
        commandLine: String(proc?.commandLine || ''),
      }))
      .filter((proc) => proc.processId)
      .filter((proc) => looksLikeCopilotWorkerProcess(proc))
      .filter((proc) => {
        const parsedSessionId = parseSessionIdFromCommandLine(proc.commandLine);
        if (parsedSessionId) return parsedSessionId === target;
        return targetPattern?.test(proc.commandLine);
      });
  }

  function findPosixProcessForSession(targetSessionId) {
    return findPosixProcessesForSession(targetSessionId)[0] || null;
  }

  function parsePositiveInt(value) {
    const num = Number.parseInt(String(value || ''), 10);
    return Number.isInteger(num) && num > 0 ? num : null;
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

  function findProcessesForSession(targetSessionId) {
    return platform === 'win32'
      ? findWindowsProcessesForSession(targetSessionId)
      : findPosixProcessesForSession(targetSessionId);
  }

  function findProcessForSession(targetSessionId) {
    return platform === 'win32'
      ? findWindowsProcessForSession(targetSessionId)
      : findPosixProcessForSession(targetSessionId);
  }

  return {
    normalizeSessionId,
    parseSessionIdFromCommandLine,
    findProcessForSession,
    findProcessesForSession,
    findPosixProcessForSession,
    findPosixProcessesForSession,
    getPosixProcessSnapshot,
    findWindowsProcessesForSession,
    findWindowsProcessForSession,
    getWindowsProcessSnapshot,
    stopWindowsPids,
  };
}
