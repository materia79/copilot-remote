import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { createSessionWorkerWebSocketService } from './session-worker-websocket-service.mjs';

class FakeWebSocketServer extends EventEmitter {
  constructor() {
    super();
    this.closeCalls = 0;
  }

  handleUpgrade(_req, _socket, _head, done) {
    const ws = new FakeSocket();
    done(ws);
  }

  close() {
    this.closeCalls += 1;
  }
}

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.OPEN = 1;
    this.readyState = 1;
    this.sent = [];
    this.closeCalls = 0;
  }

  send(payload) {
    this.sent.push(String(payload));
  }

  close() {
    this.closeCalls += 1;
    this.readyState = 3;
  }
}

test('worker websocket service authenticates upgrade requests', () => {
  const httpServer = new EventEmitter();
  const rawSocket = {
    wrote: '',
    destroyed: false,
    write(value) { this.wrote += String(value); },
    destroy() { this.destroyed = true; },
  };
  const service = createSessionWorkerWebSocketService({
    WebSocketServerImpl: FakeWebSocketServer,
    httpServer,
    authToken: 'secret-token',
    queueCounts: () => ({ pendingCount: 0, processingCount: 0, parkedCount: 0 }),
  });

  const handled = service.handleUpgrade(
    { url: '/api/session-worker/ws?token=wrong', headers: { host: 'localhost:3333' } },
    rawSocket,
    Buffer.alloc(0),
  );
  assert.equal(handled, true);
  assert.match(rawSocket.wrote, /401 Unauthorized/);
  assert.equal(rawSocket.destroyed, true);
});

test('worker websocket service notifies connected clients on queue changes', () => {
  const httpServer = new EventEmitter();
  let pendingCount = 0;
  let touchCalls = 0;
  const service = createSessionWorkerWebSocketService({
    WebSocketServerImpl: FakeWebSocketServer,
    httpServer,
    authToken: 'secret-token',
    queueCounts: () => ({ pendingCount, processingCount: 0, parkedCount: 0 }),
    touchCli: () => { touchCalls += 1; },
  });

  service.start();
  httpServer.emit('upgrade',
    { url: '/api/session-worker/ws?token=secret-token', headers: { host: 'localhost:3333' } },
    {},
    Buffer.alloc(0),
  );

  assert.equal(service.status().connectedCount, 1);
  pendingCount = 3;
  const event = service.emitQueueChanged('test');
  assert.equal(event.pendingCount, 3);
  assert.equal(touchCalls >= 1, true);
  service.stop();
});

