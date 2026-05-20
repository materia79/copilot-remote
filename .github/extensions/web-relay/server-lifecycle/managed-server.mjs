export function createManagedServerLifecycle({
  api,
  dbg,
  fs,
  spawn,
  killProcessTree,
  delay,
  token,
  logDir,
  serverDir,
  serverLogPath,
  serverErrPath,
  nodeBin,
  serverStartTimeoutMs,
}) {
  let managedServerProc = null;
  let managedServerStdoutFd = null;
  let managedServerStderrFd = null;
  let managedServerOwned = false;
  let managedServerStartPromise = null;
  let desiredRunning = false;
  let stoppingManagedServer = false;
  let restartTimer = null;
  let restartAttempts = 0;
  let attemptedSqliteRepair = false;

  const RESTART_BACKOFF_MS = [1000, 2000, 5000, 10000, 20000];
  const STARTUP_LOG_TAIL_BYTES = 24 * 1024;

  function readLogTail(filePath, maxBytes = STARTUP_LOG_TAIL_BYTES) {
    try {
      const stats = fs.statSync(filePath);
      const size = Number(stats?.size || 0);
      if (size <= 0) return "";
      const readFrom = Math.max(0, size - Math.max(1024, Number(maxBytes) || STARTUP_LOG_TAIL_BYTES));
      const readSize = Math.max(0, size - readFrom);
      if (!readSize) return "";
      const fd = fs.openSync(filePath, "r");
      try {
        const chunk = Buffer.alloc(readSize);
        fs.readSync(fd, chunk, 0, readSize, readFrom);
        return chunk.toString("utf8");
      } finally {
        try { fs.closeSync(fd); } catch {}
      }
    } catch {
      return "";
    }
  }

  function hasBetterSqliteAbiMismatch(logText) {
    const text = String(logText || "");
    if (!text) return false;
    if (!/better_sqlite3\.node/i.test(text)) return false;
    return /NODE_MODULE_VERSION|compiled against a different Node\.js version|ERR_DLOPEN_FAILED/i.test(text);
  }

  async function rebuildBetterSqlite3() {
    const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";
    dbg("attempting native module repair", "command=npm rebuild better-sqlite3");

    return await new Promise((resolve) => {
      let out = "";
      const rebuildProc = spawn(npmBin, ["rebuild", "better-sqlite3"], {
        cwd: serverDir,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });

      const append = (prefix, chunk) => {
        const text = String(chunk || "");
        if (!text) return;
        out += `${prefix}${text}`;
        if (out.length > 12_000) {
          out = out.slice(out.length - 12_000);
        }
      };

      rebuildProc.stdout?.on("data", (chunk) => append("", chunk));
      rebuildProc.stderr?.on("data", (chunk) => append("", chunk));

      rebuildProc.once("error", (error) => {
        resolve({
          ok: false,
          code: null,
          error: error?.message || String(error),
          output: out,
        });
      });

      rebuildProc.once("exit", (code) => {
        resolve({
          ok: Number(code) === 0,
          code: Number.isFinite(Number(code)) ? Number(code) : null,
          error: null,
          output: out,
        });
      });
    });
  }

  function closeManagedServerStreams() {
    if (managedServerStdoutFd !== null) {
      try { fs.closeSync(managedServerStdoutFd); } catch {}
      managedServerStdoutFd = null;
    }
    if (managedServerStderrFd !== null) {
      try { fs.closeSync(managedServerStderrFd); } catch {}
      managedServerStderrFd = null;
    }
  }

  function clearRestartTimer() {
    if (!restartTimer) return;
    try { clearTimeout(restartTimer); } catch {}
    restartTimer = null;
  }

  function scheduleManagedServerRestart(reason = "unknown") {
    if (!desiredRunning) return;
    if (stoppingManagedServer) return;
    if (managedServerStartPromise) return;
    if (managedServerProc) return;
    if (restartTimer) return;

    const idx = Math.min(restartAttempts, RESTART_BACKOFF_MS.length - 1);
    const delayMs = RESTART_BACKOFF_MS[idx];
    restartAttempts += 1;
    dbg("managed web server restart scheduled", `reason=${reason}`, `in=${delayMs}ms`, `attempt=${restartAttempts}`);

    restartTimer = setTimeout(() => {
      restartTimer = null;
      if (!desiredRunning || stoppingManagedServer) return;
      void ensureManagedServer().catch((error) => {
        dbg("managed web server restart attempt failed", error?.message || String(error));
      });
    }, delayMs);
  }

  async function waitForServerReady(timeoutMs = serverStartTimeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        await api("GET", "/api/status");
        return true;
      } catch {
        await delay(300);
      }
    }
    return false;
  }

  async function stopManagedServer() {
    desiredRunning = false;
    stoppingManagedServer = true;
    clearRestartTimer();

    if (!managedServerOwned) {
      stoppingManagedServer = false;
      return;
    }

    killProcessTree(managedServerProc);

    if (managedServerProc) {
      await new Promise((resolve) => {
        if (managedServerProc.exitCode !== null) return resolve();
        managedServerProc.once("exit", resolve);
        setTimeout(resolve, 2000);
      });
    }

    closeManagedServerStreams();
    managedServerProc = null;
    managedServerOwned = false;
    restartAttempts = 0;
    attemptedSqliteRepair = false;
    stoppingManagedServer = false;
  }

  async function ensureManagedServer() {
    desiredRunning = true;
    stoppingManagedServer = false;
    clearRestartTimer();
    if (managedServerStartPromise) return managedServerStartPromise;

    managedServerStartPromise = (async () => {
      let startedOwnedProcess = false;
      try {
        try {
          await api("GET", "/api/status");
          managedServerOwned = false;
          restartAttempts = 0;
          dbg("web server already running");
          return false;
        } catch (error) {
          const message = String(error?.message || error || "");
          if (message.includes("HTTP 401 /api/status")) {
            throw new Error(
              "Web relay is running on :3333 but rejected this token (401). "
              + "Set matching authToken values in extension/server config or restart the relay with --token."
            );
          }
          // Not running yet.
        }

        if (!token) {
          throw new Error("No auth token available to start the web server");
        }

        fs.mkdirSync(logDir, { recursive: true });
        managedServerStdoutFd = fs.openSync(serverLogPath, "a");
        managedServerStderrFd = fs.openSync(serverErrPath, "a");
        const startupWorkspaceRoot = String(process.env.COPILOT_WORKSPACE_ROOT || process.cwd() || "").trim() || process.cwd();

        dbg("starting managed web server", serverDir);
        managedServerOwned = true;
        startedOwnedProcess = true;
        managedServerProc = spawn(nodeBin, ["server.js", "--token", token, "--owner-pid", String(process.pid)], {
          cwd: serverDir,
          env: { ...process.env, COPILOT_WORKSPACE_ROOT: startupWorkspaceRoot },
          stdio: ["ignore", managedServerStdoutFd, managedServerStderrFd],
          detached: process.platform !== "win32",
          windowsHide: false,
        });

        managedServerProc.once("exit", (code, signal) => {
          dbg("managed web server exited", `code=${code ?? "null"}`, `signal=${signal ?? "none"}`);
          const shouldRestart = desiredRunning && managedServerOwned && !stoppingManagedServer;
          closeManagedServerStreams();
          managedServerProc = null;
          managedServerOwned = false;
          if (shouldRestart) {
            scheduleManagedServerRestart("process-exit");
          }
        });

        const ready = await waitForServerReady();
        if (!ready) {
          throw new Error("Managed web server did not become ready");
        }

        restartAttempts = 0;
        dbg("managed web server ready");
        return true;
      } catch (error) {
        if (startedOwnedProcess) {
          killProcessTree(managedServerProc);
        }
        const startupErrorTail = readLogTail(serverErrPath);
        const shouldRepairSqlite = startedOwnedProcess
          && !attemptedSqliteRepair
          && hasBetterSqliteAbiMismatch(startupErrorTail);
        if (shouldRepairSqlite) {
          attemptedSqliteRepair = true;
          const repairResult = await rebuildBetterSqlite3();
          if (repairResult.ok) {
            restartAttempts = 0;
            dbg("native module repair succeeded", "better-sqlite3 rebuilt for current Node runtime");
          } else {
            dbg(
              "native module repair failed",
              `code=${repairResult.code ?? "null"}`,
              repairResult.error || "unknown error",
              (repairResult.output || "").slice(-400),
            );
          }
        }
        closeManagedServerStreams();
        managedServerProc = null;
        managedServerOwned = false;
        if (desiredRunning && !stoppingManagedServer) {
          scheduleManagedServerRestart("start-failed");
        }
        throw error;
      }
    })().finally(() => {
      managedServerStartPromise = null;
    });

    return managedServerStartPromise;
  }

  function killManagedProcessTree() {
    desiredRunning = false;
    stoppingManagedServer = true;
    clearRestartTimer();
    killProcessTree(managedServerProc);
  }

  return {
    ensureManagedServer,
    stopManagedServer,
    killManagedProcessTree,
  };
}
