import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { createRelaySingletonGuard } from "./relay-singleton-guard.mjs";

function createTempDir() {
  const base = path.resolve("server", "services", ".tmp-relay-singleton");
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, "case-"));
}

test("acquire writes singleton lock payload", () => {
  const root = createTempDir();
  const lockPath = path.join(root, "relay.lock");
  const guard = createRelaySingletonGuard({
    lockPath,
    pid: 4242,
    token: "token-a",
    now: () => "2026-01-01T00:00:00.000Z",
    isProcessAlive: () => true,
  });
  try {
    const lock = guard.acquire();
    assert.equal(lock.pid, 4242);
    assert.equal(lock.token, "token-a");
    const persisted = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    assert.equal(persisted.pid, 4242);
    assert.equal(persisted.token, "token-a");
    assert.equal(persisted.startedAt, "2026-01-01T00:00:00.000Z");
  } finally {
    try { guard.release(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rejects duplicate startup for live matching owner", () => {
  const root = createTempDir();
  const lockPath = path.join(root, "relay.lock");
  fs.writeFileSync(lockPath, JSON.stringify({
    pid: 7777,
    token: "token-a",
    startedAt: "2026-01-01T01:00:00.000Z",
  }));
  const guard = createRelaySingletonGuard({
    lockPath,
    pid: 8888,
    token: "token-a",
    isProcessAlive: (pid) => pid === 7777,
  });
  try {
    assert.throws(() => guard.acquire(), /Relay already running/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("recovers stale lock when pid is not alive", () => {
  const root = createTempDir();
  const lockPath = path.join(root, "relay.lock");
  fs.writeFileSync(lockPath, JSON.stringify({
    pid: 1111,
    token: "token-old",
    startedAt: "2026-01-01T02:00:00.000Z",
  }));
  const guard = createRelaySingletonGuard({
    lockPath,
    pid: 2222,
    token: "token-new",
    isProcessAlive: () => false,
  });
  try {
    const lock = guard.acquire();
    assert.equal(lock.pid, 2222);
    const persisted = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    assert.equal(persisted.pid, 2222);
    assert.equal(persisted.token, "token-new");
  } finally {
    try { guard.release(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("release only removes current owner lock", () => {
  const root = createTempDir();
  const lockPath = path.join(root, "relay.lock");
  fs.writeFileSync(lockPath, JSON.stringify({
    pid: 1000,
    token: "owner-a",
    startedAt: "2026-01-01T03:00:00.000Z",
  }));
  const guard = createRelaySingletonGuard({
    lockPath,
    pid: 2000,
    token: "owner-b",
  });
  try {
    assert.equal(guard.release(), false);
    assert.equal(fs.existsSync(lockPath), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
