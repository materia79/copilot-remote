import fs from "fs";
import path from "path";

function safeReadLock(lockPath) {
  try {
    const raw = fs.readFileSync(lockPath, "utf8");
    const parsed = JSON.parse(raw);
    return {
      pid: Number.parseInt(String(parsed?.pid ?? ""), 10),
      token: typeof parsed?.token === "string" ? parsed.token : "",
      startedAt: typeof parsed?.startedAt === "string" ? parsed.startedAt : null,
    };
  } catch {
    return null;
  }
}

export function createRelaySingletonGuard({
  lockPath,
  pid,
  token,
  now = () => new Date().toISOString(),
  isProcessAlive,
  logger = console,
}) {
  const lockFilePath = path.resolve(String(lockPath || ""));
  const currentPid = Number.parseInt(String(pid || process.pid), 10);
  const currentToken = String(token || "").trim();
  const processAlive = typeof isProcessAlive === "function"
    ? isProcessAlive
    : (candidatePid) => {
      if (!Number.isInteger(candidatePid) || candidatePid <= 0) return false;
      try {
        process.kill(candidatePid, 0);
        return true;
      } catch {
        return false;
      }
    };

  function writeLock() {
    fs.mkdirSync(path.dirname(lockFilePath), { recursive: true });
    const payload = {
      pid: currentPid,
      token: currentToken,
      startedAt: now(),
    };
    const fd = fs.openSync(lockFilePath, "wx");
    try {
      fs.writeFileSync(fd, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    } finally {
      try { fs.closeSync(fd); } catch {}
    }
    return payload;
  }

  function acquire() {
    try {
      return writeLock();
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
    }

    const existingLock = safeReadLock(lockFilePath);
    const existingPid = Number.isInteger(existingLock?.pid) ? existingLock.pid : null;
    const existingToken = typeof existingLock?.token === "string" ? existingLock.token : "";
    const existingStartedAt = existingLock?.startedAt || "unknown";

    if (existingPid && processAlive(existingPid)) {
      if (existingToken && existingToken === currentToken) {
        throw new Error(`Relay already running (pid=${existingPid}, startedAt=${existingStartedAt}).`);
      }
      throw new Error(
        `Relay appears to be owned by another live process (pid=${existingPid}, startedAt=${existingStartedAt}).`
      );
    }

    try {
      fs.unlinkSync(lockFilePath);
      logger?.warn?.(`[server] Recovered stale singleton lock: ${lockFilePath}`);
    } catch (unlinkError) {
      if (unlinkError?.code !== "ENOENT") throw unlinkError;
    }

    return writeLock();
  }

  function release() {
    const existingLock = safeReadLock(lockFilePath);
    if (!existingLock) return false;
    if (existingLock.pid !== currentPid) return false;
    if (String(existingLock.token || "") !== currentToken) return false;
    try {
      fs.unlinkSync(lockFilePath);
      return true;
    } catch (error) {
      if (error?.code === "ENOENT") return true;
      throw error;
    }
  }

  return {
    lockFilePath,
    acquire,
    release,
  };
}
