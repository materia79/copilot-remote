import test from 'node:test';
import assert from 'node:assert/strict';

import { createTmuxInspectorSocketService } from './tmux-inspector-socket-service.mjs';

function createSocketStub() {
  const handlers = new Map();
  const emitted = [];
  return {
    id: 'socket-1',
    on(event, handler) {
      handlers.set(event, handler);
    },
    emit(event, payload) {
      emitted.push({ event, payload });
    },
    call(event, payload, ack) {
      const handler = handlers.get(event);
      assert.equal(typeof handler, 'function');
      handler(payload, ack);
    },
    triggerDisconnect() {
      const handler = handlers.get('disconnect');
      if (handler) handler();
    },
    emitted,
  };
}

test('tmux socket service denies open for inactive sessions', () => {
  const streamService = {
    attach() {
      throw new Error('should not attach');
    },
    detachWatcher() {},
    detach() {},
    status() { return {}; },
    stopAll() {},
  };
  const service = createTmuxInspectorSocketService({
    streamService,
    accessPolicy: {
      evaluateSession() {
        return { ok: false, code: 'session-worker-inactive', reason: 'inactive' };
      },
    },
  });
  const socket = createSocketStub();
  service.registerSocket(socket);

  let ackPayload = null;
  socket.call('tmux_inspector_open', { sdkSessionId: 'abc-123' }, (payload) => { ackPayload = payload; });
  assert.equal(ackPayload?.ok, false);
  assert.equal(ackPayload?.code, 'session-worker-inactive');
});

test('tmux socket service opens and closes watchers', () => {
  const streamService = {
    attachCalls: [],
    detachCalls: [],
    attach(input) {
      this.attachCalls.push(input);
      return { ok: true, snapshot: 'hello\n', watcherCount: 1 };
    },
    detach(input) {
      this.detachCalls.push(input);
      return { ok: true, removed: true, watcherCount: 0 };
    },
    detachWatcher() {
      return 1;
    },
    status() { return {}; },
    stopAll() {},
  };
  const service = createTmuxInspectorSocketService({
    streamService,
    accessPolicy: {
      evaluateSession() {
        return { ok: true, code: 'ok' };
      },
    },
  });
  const socket = createSocketStub();
  service.registerSocket(socket);

  let openAck = null;
  socket.call('tmux_inspector_open', { sdkSessionId: 'abc-123' }, (payload) => { openAck = payload; });
  assert.equal(openAck?.ok, true);
  assert.equal(openAck?.snapshot, 'hello\n');
  assert.equal(streamService.attachCalls.length, 1);
  assert.equal(streamService.attachCalls[0].watcherId, 'socket-1');

  let closeAck = null;
  socket.call('tmux_inspector_close', { sdkSessionId: 'abc-123' }, (payload) => { closeAck = payload; });
  assert.equal(closeAck?.ok, true);
  assert.equal(closeAck?.removed, true);
  assert.equal(streamService.detachCalls.length, 1);
});

test('tmux socket service detaches watcher on disconnect', () => {
  let detachedCount = 0;
  const streamService = {
    attach() {
      return { ok: true, snapshot: '', watcherCount: 1 };
    },
    detach() {
      return { ok: true, removed: true };
    },
    detachWatcher() {
      detachedCount += 1;
      return 1;
    },
    status() { return {}; },
    stopAll() {},
  };
  const service = createTmuxInspectorSocketService({
    streamService,
    accessPolicy: {
      evaluateSession() {
        return { ok: true };
      },
    },
  });
  const socket = createSocketStub();
  service.registerSocket(socket);
  socket.triggerDisconnect();
  assert.equal(detachedCount, 1);
});

test('tmux socket service resizes only for attached watcher sessions', () => {
  const resizeCalls = [];
  const streamService = {
    attach() {
      return { ok: true, snapshot: '', watcherCount: 1 };
    },
    detach() {
      return { ok: true, removed: true };
    },
    detachWatcher() {
      return 1;
    },
    isWatcherAttached({ sdkSessionId, watcherId }) {
      return sdkSessionId === 'abc-123' && watcherId === 'socket-1';
    },
    resizeSession(payload) {
      resizeCalls.push(payload);
      return { ok: true, code: 'resized', cols: 120, rows: 34 };
    },
    status() { return {}; },
    stopAll() {},
  };
  const service = createTmuxInspectorSocketService({
    streamService,
    accessPolicy: {
      evaluateSession() {
        return { ok: true, code: 'ok' };
      },
    },
  });
  const socket = createSocketStub();
  service.registerSocket(socket);

  let resizeAck = null;
  socket.call('tmux_inspector_resize', { sdkSessionId: 'abc-123', cols: 120, rows: 34 }, (payload) => {
    resizeAck = payload;
  });
  assert.equal(resizeAck?.ok, true);
  assert.equal(resizeCalls.length, 1);
  assert.equal(resizeCalls[0].cols, 120);
  assert.equal(resizeCalls[0].rows, 34);

  let deniedAck = null;
  socket.call('tmux_inspector_resize', { sdkSessionId: 'def-456', cols: 80, rows: 24 }, (payload) => {
    deniedAck = payload;
  });
  assert.equal(deniedAck?.ok, false);
  assert.equal(deniedAck?.code, 'not-attached');
});
