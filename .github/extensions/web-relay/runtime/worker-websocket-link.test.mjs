import assert from "node:assert/strict";
import test from "node:test";
import { createWorkerWebSocketLink } from "./worker-websocket-link.mjs";

class FakeWebSocket {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.OPEN = 1;
    this.CONNECTING = 0;
    this.CLOSED = 3;
    this.readyState = this.CONNECTING;
    this.listeners = new Map();
    this.sent = [];
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type, listener) {
    const list = this.listeners.get(type) || [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  emit(type, payload = {}) {
    for (const listener of this.listeners.get(type) || []) {
      listener(payload);
    }
  }

  open() {
    this.readyState = this.OPEN;
    this.emit("open");
  }

  receive(data) {
    this.emit("message", { data: JSON.stringify(data) });
  }

  close() {
    this.readyState = this.CLOSED;
    this.emit("close");
  }

  send(payload) {
    this.sent.push(String(payload));
  }
}

test("worker websocket link sends ready and processes delivered queue messages", async () => {
  FakeWebSocket.instances = [];
  const deliveries = [];
  const link = createWorkerWebSocketLink({
    serverUrl: "http://localhost:3333",
    token: "tok",
    getSessionReady: () => true,
    getSessionId: () => "sdk-1",
    getPid: () => 4242,
    onDeliver: async (pending, reason) => {
      deliveries.push({ pending, reason });
    },
    WebSocketImpl: FakeWebSocket,
    jitterMs: 0,
  });

  link.start();
  assert.equal(FakeWebSocket.instances.length, 1);
  const socket = FakeWebSocket.instances[0];
  assert.match(socket.url, /token=tok/);
  assert.match(socket.url, /sessionId=sdk-1/);
  assert.match(socket.url, /pid=4242/);

  socket.open();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(socket.sent.length, 2);
  assert.match(socket.sent[0], /"type":"worker.hello"/);
  assert.match(socket.sent[1], /"type":"worker.ready"/);

  socket.receive({ type: "queue.deliver", reason: "test", pending: { message: { id: "m1" } } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(deliveries, [{ pending: { message: { id: "m1" } }, reason: "test" }]);
  assert.equal(socket.sent.length, 3);
  assert.match(socket.sent[2], /"type":"worker.ready"/);
  link.stop();
});

test("worker websocket link reconnect backoff caps at 8 seconds", () => {
  FakeWebSocket.instances = [];
  const scheduled = [];
  const link = createWorkerWebSocketLink({
    serverUrl: "http://localhost:3333",
    token: "tok",
    getSessionReady: () => true,
    WebSocketImpl: FakeWebSocket,
    minBackoffMs: 1000,
    maxBackoffMs: 8_000,
    jitterMs: 0,
    setTimeoutImpl: (fn, delay) => {
      scheduled.push({ fn, delay });
      return { delay };
    },
    clearTimeoutImpl: () => {},
  });

  link.start();
  const first = FakeWebSocket.instances[0];
  first.open();
  first.close();
  assert.equal(scheduled[0]?.delay, 1000);
  scheduled.shift()?.fn();

  const second = FakeWebSocket.instances[1];
  second.open();
  second.close();
  assert.equal(scheduled[0]?.delay, 1000);
  scheduled.shift()?.fn();

  const third = FakeWebSocket.instances[2];
  third.close();
  assert.equal(scheduled[0]?.delay, 2000);
  scheduled.shift()?.fn();

  const fourth = FakeWebSocket.instances[3];
  fourth.close();
  assert.equal(scheduled[0]?.delay, 4000);
  scheduled.shift()?.fn();

  const fifth = FakeWebSocket.instances[4];
  fifth.close();
  assert.equal(scheduled[0]?.delay, 8000);
  scheduled.shift()?.fn();

  const sixth = FakeWebSocket.instances[5];
  sixth.close();
  assert.equal(scheduled[0]?.delay, 8_000);
  scheduled.shift()?.fn();

  const seventh = FakeWebSocket.instances[6];
  seventh.close();
  assert.equal(scheduled[0]?.delay, 8_000);
  scheduled.shift()?.fn();

  const eighth = FakeWebSocket.instances[7];
  eighth.close();
  assert.equal(scheduled[0]?.delay, 8_000);
  link.stop();
});
