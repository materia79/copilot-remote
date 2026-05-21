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
  const match = text.match(/--session-id(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s"'=]+))/i);
  const value = match?.[1] || match?.[2] || match?.[3] || '';
  return normalizeSessionId(value);
}

function looksLikeCopilotWorkerProcess(proc) {
  const name = String(proc?.name || '').trim().toLowerCase();
  const cmd = String(proc?.commandLine || '').trim().toLowerCase();
  if (!name && !cmd) return false;
  if (cmd.includes('\\server\\server.js')) return false;
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
    const targetPattern = new RegExp(`--session-id(?:=|\\s+)(?:"${escapeRegExp(target)}"|'${escapeRegExp(target)}'|${escapeRegExp(target)})(?:\\s|$)`, 'i');
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
        return targetPattern.test(proc.commandLine);
      });
  }

  function findWindowsProcessForSession(targetSessionId) {
    return findWindowsProcessesForSession(targetSessionId)[0] || null;
  }

  return {
    normalizeSessionId,
    parseSessionIdFromCommandLine,
    findWindowsProcessesForSession,
    findWindowsProcessForSession,
    getWindowsProcessSnapshot,
  };
}
