export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function killProcessTree(proc) {
  if (!proc || proc.exitCode !== null) return;

  const isWindows = process.platform === "win32";
  const pidTarget = (!isWindows && proc.spawnargs) ? -proc.pid : proc.pid;

  try {
    process.kill(pidTarget, "SIGTERM");
  } catch {
    return;
  }

  setTimeout(() => {
    if (proc.exitCode !== null) return;
    try { process.kill(pidTarget, "SIGKILL"); } catch {}
  }, 1200);
}
