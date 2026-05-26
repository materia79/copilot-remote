import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createManagedServerLifecycle } from "./managed-server.mjs";

async function withEnv(updates, fn) {
  const previous = new Map();
  for (const [key, value] of Object.entries(updates)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function createFsStub() {
  let fd = 10;
  return {
    mkdirSync() {},
    openSync() { fd += 1; return fd; },
    closeSync() {},
    statSync() { return { size: 0 }; },
    readSync() {},
  };
}

function createProcStub() {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.exitCode = null;
  return proc;
}

function createLifecycleHarness(t, overrides = {}) {
  const spawned = [];
  const killed = [];
  const delays = [];
  const api = overrides.api || (async () => ({}));
  const spawn = overrides.spawn || ((...args) => {
    const proc = createProcStub();
    spawned.push({ args, proc });
    return proc;
  });

  const lifecycle = createManagedServerLifecycle({
    api,
    dbg: () => {},
    fs: overrides.fs || createFsStub(),
    spawn,
    killProcessTree: (proc) => { killed.push(proc); },
    delay: async (ms) => { delays.push(ms); },
    token: "test-token",
    logDir: "C:\\logs",
    serverDir: "C:\\server",
    serverLogPath: "C:\\logs\\server.log",
    serverErrPath: "C:\\logs\\server.err.log",
    nodeBin: "node",
    serverStartTimeoutMs: 30,
  });

  t.after(async () => {
    await lifecycle.stopManagedServer();
    lifecycle.killManagedProcessTree();
  });

  return { lifecycle, spawned, killed, delays };
}

test("attaches to existing relay when status probe succeeds", async (t) => {
  const { lifecycle, spawned } = createLifecycleHarness(t, {
    api: async () => ({ ok: true }),
  });
  const started = await lifecycle.ensureManagedServer();
  assert.equal(started, false);
  assert.equal(spawned.length, 0);
});

test("repeated attach startup probes never spawn duplicate relay", async (t) => {
  const { lifecycle, spawned } = createLifecycleHarness(t, {
    api: async () => ({ ok: true }),
  });
  const first = await lifecycle.ensureManagedServer();
  const second = await lifecycle.ensureManagedServer();
  assert.equal(first, false);
  assert.equal(second, false);
  assert.equal(spawned.length, 0);
});

test("fails with token mismatch diagnostics and does not spawn", async (t) => {
  const { lifecycle, spawned } = createLifecycleHarness(t, {
    api: async () => {
      throw new Error("HTTP 401 /api/status");
    },
  });
  await assert.rejects(
    lifecycle.ensureManagedServer(),
    /rejected this token \(401\)/i
  );
  assert.equal(spawned.length, 0);
});

test("fails with port conflict diagnostics when status probe returns non-401 http", async (t) => {
  const { lifecycle, spawned } = createLifecycleHarness(t, {
    api: async () => {
      throw new Error("HTTP 404 /api/status");
    },
  });
  await assert.rejects(
    lifecycle.ensureManagedServer(),
    /Port 3333 is already serving HTTP 404/i
  );
  assert.equal(spawned.length, 0);
});

test("spawns relay once when probe is unreachable and waits until ready", async (t) => {
  let calls = 0;
  const { lifecycle, spawned } = createLifecycleHarness(t, {
    api: async () => {
      calls += 1;
      if (calls === 1) throw new Error("fetch failed");
      if (calls === 2) throw new Error("fetch failed");
      return { ok: true };
    },
  });
  const started = await lifecycle.ensureManagedServer();
  assert.equal(started, true);
  assert.equal(spawned.length, 1);
});

test("managed server marks spawned relay as supervised", async (t) => {
  let calls = 0;
  const { lifecycle, spawned } = createLifecycleHarness(t, {
    api: async () => {
      calls += 1;
      if (calls <= 2) throw new Error("fetch failed");
      return { ok: true };
    },
  });
  const started = await lifecycle.ensureManagedServer();
  assert.equal(started, true);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].args[2].env.COPILOT_WEB_RELAY_SUPERVISED, "1");
});

test("concurrent startup calls share one spawn attempt", async (t) => {
  let calls = 0;
  const { lifecycle, spawned } = createLifecycleHarness(t, {
    api: async () => {
      calls += 1;
      if (calls === 1 || calls === 2) throw new Error("fetch failed");
      return { ok: true };
    },
  });
  const [first, second] = await Promise.all([
    lifecycle.ensureManagedServer(),
    lifecycle.ensureManagedServer(),
  ]);
  assert.equal(first, true);
  assert.equal(second, true);
  assert.equal(spawned.length, 1);
});

test("persistent shutdown does not kill shared relay by default", async (t) => {
  await withEnv({
    COPILOT_WEB_RELAY_PERSISTENT_SERVER: "true",
    COPILOT_WEB_RELAY_USE_OWNER_PID: undefined,
  }, async () => {
    let calls = 0;
    const { lifecycle, killed } = createLifecycleHarness(t, {
      api: async () => {
        calls += 1;
        if (calls === 1) throw new Error("network down");
        return { ok: true };
      },
    });
    await lifecycle.ensureManagedServer();
    await lifecycle.stopManagedServer();
    lifecycle.killManagedProcessTree();
    assert.equal(killed.length, 0);
  });
});

test("persistent lifecycle re-attaches after stop without respawn", async (t) => {
  await withEnv({
    COPILOT_WEB_RELAY_PERSISTENT_SERVER: "true",
    COPILOT_WEB_RELAY_USE_OWNER_PID: undefined,
  }, async () => {
    let calls = 0;
    const { lifecycle, spawned, killed } = createLifecycleHarness(t, {
      api: async () => {
        calls += 1;
        if (calls === 1 || calls === 2) throw new Error("network down");
        return { ok: true };
      },
    });

    const started = await lifecycle.ensureManagedServer();
    assert.equal(started, true);
    assert.equal(spawned.length, 1);

    await lifecycle.stopManagedServer();
    lifecycle.killManagedProcessTree();
    assert.equal(killed.length, 0);

    const attached = await lifecycle.ensureManagedServer();
    assert.equal(attached, false);
    assert.equal(spawned.length, 1);
  });
});

test("legacy owner-pid mode kills managed process on shutdown", async (t) => {
  await withEnv({
    COPILOT_WEB_RELAY_PERSISTENT_SERVER: "true",
    COPILOT_WEB_RELAY_USE_OWNER_PID: "true",
  }, async () => {
    let calls = 0;
    const { lifecycle, killed } = createLifecycleHarness(t, {
      api: async () => {
        calls += 1;
        if (calls === 1) throw new Error("network down");
        return { ok: true };
      },
    });
    await lifecycle.ensureManagedServer();
    await lifecycle.stopManagedServer();
    assert.equal(killed.length, 1);
  });
});
