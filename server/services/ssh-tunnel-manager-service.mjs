'use strict';

import os from 'os';
import path from 'path';
import { spawn } from 'child_process';

function toText(value) {
  return String(value || '').trim();
}

function parsePositivePort(value) {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 65535) return value;
  if (typeof value !== 'string') return null;
  const num = Number.parseInt(value.trim(), 10);
  if (!Number.isInteger(num) || num <= 0 || num > 65535) return null;
  return num;
}

function normalizeTunnelMode(raw = {}) {
  const mode = toText(raw.mode).toLowerCase();
  if (mode === 'disabled' || mode === 'managed') return mode;
  if (raw.enabled === true) return 'managed';
  return 'disabled';
}

function normalizeRemoteBind(rawValue) {
  return toText(rawValue).toLowerCase() === 'public' ? 'public' : 'loopback';
}

function normalizeIdentityFile(rawValue) {
  const value = toText(rawValue);
  if (!value) return null;
  return value.replace(/^~/, os.homedir());
}

export function normalizeSshTunnelConfig(rawConfig = {}, {
  defaultCommand = 'ssh',
  configBaseDir = process.cwd(),
} = {}) {
  const raw = rawConfig && typeof rawConfig === 'object' ? rawConfig : {};
  const mode = normalizeTunnelMode(raw);
  const required = raw.required === true;
  const user = toText(raw.user);
  const host = toText(raw.host);
  const remotePort = parsePositivePort(raw.remotePort);
  const remoteBindMode = normalizeRemoteBind(raw.remoteBind);
  const autoReclaimPort = raw.autoReclaimPort !== false;
  const remoteCleanupCommand = toText(raw.remoteCleanupCommand);
  const identityFile = normalizeIdentityFile(raw.identityFile);
  const commandInput = toText(raw.command || defaultCommand);
  const command = commandInput.includes('/') || commandInput.includes('\\')
    ? path.resolve(configBaseDir, commandInput)
    : commandInput;

  const errors = [];
  if (!command) errors.push('sshTunnel.command is required');
  if (mode === 'managed') {
    if (!user) errors.push('sshTunnel.user is required when sshTunnel.mode is "managed"');
    if (!host) errors.push('sshTunnel.host is required when sshTunnel.mode is "managed"');
    if (!remotePort) errors.push('sshTunnel.remotePort must be a positive integer when sshTunnel.mode is "managed"');
  }

  return {
    mode,
    enabled: mode === 'managed',
    valid: errors.length === 0,
    errors,
    required,
    user,
    host,
    remotePort,
    remoteBindMode,
    autoReclaimPort,
    remoteCleanupCommand,
    identityFile,
    command,
  };
}

function buildTunnelRemoteForwardSpec({ remoteBindMode, remotePort, localPort }) {
  const localTargetHost = '127.0.0.1';
  if (remoteBindMode === 'public') return `*:${remotePort}:${localTargetHost}:${localPort}`;
  return `${remotePort}:${localTargetHost}:${localPort}`;
}

function buildTunnelSpawnOptions(platform, stdio) {
  if (platform === 'win32') {
    return { stdio, windowsHide: true };
  }
  return { stdio };
}

function buildTunnelCommandArgs(tunnelConfig, localPort) {
  const args = [
    '-N',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'BatchMode=yes',
    '-o', 'ExitOnForwardFailure=yes',
    '-R', buildTunnelRemoteForwardSpec({
      remoteBindMode: tunnelConfig.remoteBindMode,
      remotePort: tunnelConfig.remotePort,
      localPort,
    }),
  ];
  if (tunnelConfig.identityFile) args.push('-i', tunnelConfig.identityFile);
  args.push(`${tunnelConfig.user}@${tunnelConfig.host}`);
  return args;
}

function buildCleanupCommand(tunnelConfig) {
  if (tunnelConfig.remoteCleanupCommand) return tunnelConfig.remoteCleanupCommand;
  return [
    `if command -v lsof >/dev/null 2>&1; then`,
    `  pids=$(lsof -tiTCP:${tunnelConfig.remotePort} -sTCP:LISTEN 2>/dev/null || true);`,
    `elif command -v fuser >/dev/null 2>&1; then`,
    `  pids=$(fuser -n tcp ${tunnelConfig.remotePort} 2>/dev/null || true);`,
    'else',
    '  pids="";',
    'fi;',
    'if [ -n "$pids" ]; then kill $pids 2>/dev/null || true; fi',
  ].join(' ');
}

export function createSshTunnelManager({
  tunnelConfig: rawTunnelConfig = {},
  localPort = 3333,
  runtimeLogPrefix = () => '',
  io = null,
  logger = console,
  runtimeShutdownRef = () => false,
  platform = process.platform,
  spawnImpl = spawn,
  nowIso = () => new Date().toISOString(),
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  configBaseDir = process.cwd(),
} = {}) {
  const tunnelConfig = normalizeSshTunnelConfig(rawTunnelConfig, { configBaseDir });
  const log = (msg) => logger.log(`${runtimeLogPrefix()}[ssh-tunnel] ${msg}`);
  const warn = (msg) => logger.warn(`${runtimeLogPrefix()}[ssh-tunnel] ${msg}`);

  for (const error of tunnelConfig.errors) {
    warn(error);
  }

  const state = {
    mode: tunnelConfig.mode,
    enabled: tunnelConfig.enabled && tunnelConfig.valid,
    valid: tunnelConfig.valid,
    required: tunnelConfig.required,
    connected: false,
    host: tunnelConfig.host || null,
    remotePort: tunnelConfig.remotePort || null,
    remoteBindMode: tunnelConfig.remoteBindMode,
    reconnectAttempts: 0,
    connectedSince: null,
    blocking: tunnelConfig.required && tunnelConfig.mode === 'managed',
    lastError: tunnelConfig.errors[0] || null,
    lastEventAt: nowIso(),
    proc: null,
    backoffTimer: null,
    cleanupInFlight: false,
    command: tunnelConfig.command || 'ssh',
  };

  const emitStatus = () => {
    state.lastEventAt = nowIso();
    io?.emit?.('ssh_tunnel_status', {
      connected: state.connected,
      host: state.host,
      remotePort: state.remotePort,
      mode: state.mode,
      enabled: state.enabled,
      required: state.required,
      blocking: state.blocking,
      reconnectAttempts: state.reconnectAttempts,
      connectedSince: state.connectedSince,
      lastError: state.lastError,
    });
  };

  const updateBlockingState = () => {
    state.blocking = state.required && state.mode === 'managed' && !state.connected;
  };

  const scheduleReconnect = (spawnTunnel, delayOverrideMs = null) => {
    if (runtimeShutdownRef()) return;
    if (state.backoffTimer) {
      clearTimeoutImpl(state.backoffTimer);
      state.backoffTimer = null;
    }
    const backoffSteps = [5_000, 10_000, 20_000, 40_000, 60_000];
    const computedDelay = backoffSteps[Math.min(state.reconnectAttempts, backoffSteps.length - 1)];
    const delay = Number.isFinite(delayOverrideMs) && delayOverrideMs >= 0
      ? Number(delayOverrideMs)
      : computedDelay;
    state.reconnectAttempts += 1;
    log(`Reconnecting in ${delay / 1000}s (attempt ${state.reconnectAttempts})...`);
    state.backoffTimer = setTimeoutImpl(spawnTunnel, delay);
  };

  const reclaimRemoteTunnelPort = async () => {
    if (!state.enabled || runtimeShutdownRef() || !tunnelConfig.autoReclaimPort) return false;
    if (state.cleanupInFlight) return false;
    state.cleanupInFlight = true;
    const args = [
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', 'BatchMode=yes',
    ];
    if (tunnelConfig.identityFile) args.push('-i', tunnelConfig.identityFile);
    args.push(`${tunnelConfig.user}@${tunnelConfig.host}`, 'sh', '-lc', buildCleanupCommand(tunnelConfig));

    log(`Attempting remote reclaim for listen port ${tunnelConfig.remotePort}...`);
    try {
      const ok = await new Promise((resolve) => {
        const proc = spawnImpl(tunnelConfig.command, args, buildTunnelSpawnOptions(platform, ['ignore', 'pipe', 'pipe']));
        proc.stdout.on('data', (d) => log(`cleanup stdout: ${d.toString().trim()}`));
        proc.stderr.on('data', (d) => log(`cleanup stderr: ${d.toString().trim()}`));
        proc.on('close', (code) => {
          log(`Remote reclaim finished (code=${code ?? 'null'})`);
          resolve(code === 0);
        });
        proc.on('error', (error) => {
          log(`Remote reclaim error: ${error?.message || error}`);
          resolve(false);
        });
      });
      return ok;
    } finally {
      state.cleanupInFlight = false;
    }
  };

  const spawnTunnel = () => {
    if (!state.enabled || runtimeShutdownRef()) return;
    if (state.proc && state.proc.exitCode === null) {
      log('Spawn skipped: existing tunnel process is still running.');
      return;
    }

    const args = buildTunnelCommandArgs(tunnelConfig, localPort);
    log(`Spawning: ${tunnelConfig.command} ${args.join(' ')}`);
    const proc = spawnImpl(tunnelConfig.command, args, buildTunnelSpawnOptions(platform, ['ignore', 'pipe', 'pipe']));
    state.proc = proc;
    state.lastError = null;
    updateBlockingState();
    emitStatus();

    const connectedAt = Date.now();
    let readinessTimer = null;
    let forwardingFailed = false;

    const markConnected = () => {
      if (state.connected) return;
      state.connected = true;
      state.connectedSince = nowIso();
      state.lastError = null;
      updateBlockingState();
      log(`Tunnel up to ${tunnelConfig.user}@${tunnelConfig.host} remote port ${tunnelConfig.remotePort}`);
      emitStatus();
    };
    const clearReadinessTimer = () => {
      if (!readinessTimer) return;
      clearTimeoutImpl(readinessTimer);
      readinessTimer = null;
    };

    proc.stdout.on('data', (d) => log(`stdout: ${d.toString().trim()}`));
    proc.stderr.on('data', (d) => {
      const text = d.toString().trim();
      log(`stderr: ${text}`);
      if (/remote port forwarding failed for listen port/i.test(text)) {
        forwardingFailed = true;
      }
    });
    proc.on('spawn', () => {
      clearReadinessTimer();
      readinessTimer = setTimeoutImpl(() => {
        readinessTimer = null;
        if (runtimeShutdownRef() || forwardingFailed) return;
        if (state.proc !== proc) return;
        if (proc.exitCode !== null) return;
        markConnected();
      }, 1200);
      if (typeof readinessTimer.unref === 'function') readinessTimer.unref();
    });
    proc.on('error', (error) => {
      clearReadinessTimer();
      state.lastError = error?.message || String(error);
      updateBlockingState();
      log(`Error: ${state.lastError}`);
      emitStatus();
    });
    proc.on('close', (code) => {
      clearReadinessTimer();
      const wasConnected = state.connected;
      state.connected = false;
      state.connectedSince = null;
      state.proc = null;
      if (wasConnected && Date.now() - connectedAt > 30_000) {
        state.reconnectAttempts = 0;
      }
      if (runtimeShutdownRef()) {
        log(`Process exited (code=${code}) during shutdown.`);
        updateBlockingState();
        emitStatus();
        return;
      }
      if (forwardingFailed) {
        state.lastError = `remote-forward-bind-failed:${code ?? 'null'}`;
        log(`Process exited (code=${code}) after remote forward bind failure.`);
        updateBlockingState();
        emitStatus();
        if (tunnelConfig.autoReclaimPort) {
          void reclaimRemoteTunnelPort().then((reclaimed) => {
            scheduleReconnect(spawnTunnel, reclaimed ? 1_000 : null);
          });
        } else {
          scheduleReconnect(spawnTunnel);
        }
        return;
      }
      state.lastError = `exit:${code ?? 'null'}`;
      log(`Process exited (code=${code}). Scheduling reconnect...`);
      updateBlockingState();
      emitStatus();
      scheduleReconnect(spawnTunnel);
    });
  };

  const start = () => {
    if (state.mode === 'disabled') {
      state.lastError = null;
      state.blocking = false;
      emitStatus();
      log('Tunnel mode disabled; running direct relay only.');
      return;
    }
    if (!state.enabled) {
      state.lastError = state.lastError || 'invalid-config';
      updateBlockingState();
      emitStatus();
      log('Managed tunnel mode requested but configuration is invalid; tunnel not started.');
      return;
    }
    log(`SSH tunnel enabled (${state.remoteBindMode}) to ${tunnelConfig.user}@${tunnelConfig.host}:${tunnelConfig.remotePort}`);
    spawnTunnel();
  };

  const stop = () => {
    if (state.backoffTimer) {
      clearTimeoutImpl(state.backoffTimer);
      state.backoffTimer = null;
    }
    if (state.proc) {
      try { state.proc.kill('SIGTERM'); } catch {}
      state.proc = null;
    }
  };

  return {
    state,
    config: tunnelConfig,
    start,
    stop,
    emitStatus,
  };
}
