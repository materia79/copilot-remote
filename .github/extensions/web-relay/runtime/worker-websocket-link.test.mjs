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
}

test("worker websocket link triggers poll on queue change", async () => {
  FakeWebSocket.instances = [];
  let pollCalls = 0;
  const link = createWorkerWebSocketLink({
    serverUrl: "http://localhost:3333",
    token: "tok",
    getSessionReady: () => true,
    getSessionId: () => "sdk-1",
    pollNow: async () => { pollCalls += 1; },
    WebSocketImpl: FakeWebSocket,
    jitterMs: 0,
  });

  link.start();
  assert.equal(FakeWebSocket.instances.length, 1);
  const socket = FakeWebSocket.instances[0];
  assert.match(socket.url, /token=tok/);
  assert.match(socket.url, /sessionId=sdk-1/);

  socket.open();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pollCalls, 1);

  socket.receive({ type: "queue.changed", pendingCount: 2 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pollCalls, 2);
  link.stop();
});

test("worker websocket link reconnect backoff caps at 32 seconds", () => {
  FakeWebSocket.instances = [];
  const scheduled = [];
  const link = createWorkerWebSocketLink({
    serverUrl: "http://localhost:3333",
    token: "tok",
    getSessionReady: () => true,
    pollNow: async () => {},
    WebSocketImpl: FakeWebSocket,
    minBackoffMs: 1000,
    maxBackoffMs: 32_000,
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
  assert.equal(scheduled[0]?.delay, 16_000);
  scheduled.shift()?.fn();

  const seventh = FakeWebSocket.instances[6];
  seventh.close();
  assert.equal(scheduled[0]?.delay, 32_000);
  scheduled.shift()?.fn();

  const eighth = FakeWebSocket.instances[7];
  eighth.close();
  assert.equal(scheduled[0]?.delay, 32_000);
  link.stop();
});

