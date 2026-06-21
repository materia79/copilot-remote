import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
  createSshTunnelManager,
  normalizeSshTunnelConfig,
} from './ssh-tunnel-manager-service.mjs';

function createFakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.killSignals = [];
  child.kill = (signal) => {
    child.killSignals.push(signal);
    child.exitCode = 0;
    child.emit('close', 0);
  };
  return child;
}

function createFakeTimers() {
  const timers = [];
  return {
    timers,
    setTimeoutImpl(fn, ms) {
      const timer = {
        fn,
        ms,
        cleared: false,
        unref() {},
      };
      timers.push(timer);
      return timer;
    },
    clearTimeoutImpl(timer) {
      if (!timer) return;
      timer.cleared = true;
    },
  };
}

test('normalizeSshTunnelConfig defaults to disabled mode', () => {
  const normalized = normalizeSshTunnelConfig({});
  assert.equal(normalized.mode, 'disabled');
  assert.equal(normalized.enabled, false);
  assert.equal(normalized.valid, true);
  assert.deepEqual(normalized.errors, []);
});

test('normalizeSshTunnelConfig validates managed mode requirements', () => {
  const normalized = normalizeSshTunnelConfig({
    mode: 'managed',
  });
  assert.equal(normalized.valid, false);
  assert.deepEqual(normalized.errors, [
    'sshTunnel.user is required when sshTunnel.mode is "managed"',
    'sshTunnel.host is required when sshTunnel.mode is "managed"',
    'sshTunnel.remotePort must be a positive integer when sshTunnel.mode is "managed"',
  ]);
});

test('tunnel manager stays direct when mode is disabled', () => {
  const spawnCalls = [];
  const manager = createSshTunnelManager({
    tunnelConfig: { mode: 'disabled' },
    spawnImpl(command, args, options) {
      spawnCalls.push({ command, args, options });
      return createFakeChild();
    },
    logger: { log() {}, warn() {} },
  });
  manager.start();
  assert.equal(spawnCalls.length, 0);
  assert.equal(manager.state.mode, 'disabled');
  assert.equal(manager.state.blocking, false);
  assert.equal(manager.state.connected, false);
});

test('managed tunnel spawns and non-required mode remains unblocked on disconnect', () => {
  const spawnCalls = [];
  const children = [];
  const fakeTimers = createFakeTimers();
  const manager = createSshTunnelManager({
    tunnelConfig: {
      mode: 'managed',
      user: 'ubuntu',
      host: 'relay.example.com',
      remotePort: 4444,
      required: false,
    },
    localPort: 3333,
    spawnImpl(command, args, options) {
      spawnCalls.push({ command, args, options });
      const child = createFakeChild();
      children.push(child);
      return child;
    },
    setTimeoutImpl: fakeTimers.setTimeoutImpl,
    clearTimeoutImpl: fakeTimers.clearTimeoutImpl,
    logger: { log() {}, warn() {} },
  });

  manager.start();
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].command, 'ssh');
  assert.deepEqual(spawnCalls[0].args.slice(0, 6), ['-N', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3', '-o']);
  assert.ok(spawnCalls[0].args.includes('-R'));
  assert.ok(spawnCalls[0].args.includes('4444:127.0.0.1:3333'));
  assert.ok(spawnCalls[0].args.includes('ubuntu@relay.example.com'));
  assert.equal(manager.state.blocking, false);

  children[0].emit('spawn');
  const readinessTimer = fakeTimers.timers.find((timer) => timer.ms === 1200);
  assert.ok(readinessTimer);
  readinessTimer.fn();
  assert.equal(manager.state.connected, true);
  assert.equal(manager.state.blocking, false);

  children[0].exitCode = 1;
  children[0].emit('close', 1);
  assert.equal(manager.state.connected, false);
  assert.equal(manager.state.blocking, false);
});

test('required managed tunnel blocks when disconnected and unblocks after connect', () => {
  const children = [];
  const fakeTimers = createFakeTimers();
  const manager = createSshTunnelManager({
    tunnelConfig: {
      mode: 'managed',
      user: 'ubuntu',
      host: 'relay.example.com',
      remotePort: 4444,
      required: true,
    },
    spawnImpl() {
      const child = createFakeChild();
      children.push(child);
      return child;
    },
    setTimeoutImpl: fakeTimers.setTimeoutImpl,
    clearTimeoutImpl: fakeTimers.clearTimeoutImpl,
    logger: { log() {}, warn() {} },
  });

  manager.start();
  assert.equal(manager.state.blocking, true);

  children[0].emit('spawn');
  const readinessTimer = fakeTimers.timers.find((timer) => timer.ms === 1200);
  readinessTimer.fn();
  assert.equal(manager.state.connected, true);
  assert.equal(manager.state.blocking, false);

  children[0].exitCode = 255;
  children[0].emit('close', 255);
  assert.equal(manager.state.connected, false);
  assert.equal(manager.state.blocking, true);
});

test('managed tunnel keeps Windows spawn behavior stable', () => {
  const spawnCalls = [];
  const manager = createSshTunnelManager({
    tunnelConfig: {
      mode: 'managed',
      user: 'ubuntu',
      host: 'relay.example.com',
      remotePort: 4444,
    },
    platform: 'win32',
    spawnImpl(command, args, options) {
      spawnCalls.push({ command, args, options });
      return createFakeChild();
    },
    logger: { log() {}, warn() {} },
  });

  manager.start();
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].command, 'ssh');
  assert.deepEqual(spawnCalls[0].options, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
});

test('remote reclaim uses single quoted sh -lc command', async () => {
  const spawnCalls = [];
  const children = [];
  const manager = createSshTunnelManager({
    tunnelConfig: {
      mode: 'managed',
      user: 'ubuntu',
      host: 'relay.example.com',
      remotePort: 4444,
      autoReclaimPort: true,
    },
    spawnImpl(command, args, options) {
      spawnCalls.push({ command, args, options });
      const child = createFakeChild();
      children.push(child);
      return child;
    },
    logger: { log() {}, warn() {} },
  });

  manager.start();
  assert.equal(spawnCalls.length, 1);
  children[0].stderr.emit('data', Buffer.from('Error: remote port forwarding failed for listen port 4444'));
  children[0].exitCode = 255;
  children[0].emit('close', 255);
  assert.equal(spawnCalls.length, 2);

  const reclaimArgs = spawnCalls[1].args;
  const remoteCommand = reclaimArgs[reclaimArgs.length - 1];
  assert.equal(reclaimArgs[reclaimArgs.length - 2], 'ubuntu@relay.example.com');
  assert.match(remoteCommand, /^sh -lc '/);
  assert.match(remoteCommand, /lsof -tiTCP:4444/);
  assert.ok(!reclaimArgs.includes('-lc'));

  children[1].exitCode = 0;
  children[1].emit('close', 0);
  await Promise.resolve();
});
