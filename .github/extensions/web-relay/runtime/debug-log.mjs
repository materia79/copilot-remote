import fs from "fs";
import path from "path";

export function createDebugLogger({ logDir, fileName = "ext-debug.log", prefix = "[web-relay-dbg]" }) {
  const debugLogPath = path.resolve(logDir, fileName);

  function dbg(...args) {
    const now = new Date();
    const stamp = [
      now.getUTCFullYear(),
      String(now.getUTCMonth() + 1).padStart(2, "0"),
      String(now.getUTCDate()).padStart(2, "0"),
      String(now.getUTCHours()).padStart(2, "0"),
      String(now.getUTCMinutes()).padStart(2, "0"),
      String(now.getUTCSeconds()).padStart(2, "0"),
    ].join("-");
    const line = `[${stamp}] ${args.join(" ")}\n`;
    try { fs.mkdirSync(logDir, { recursive: true }); } catch {}
    try { fs.appendFileSync(debugLogPath, line); } catch {}
    process.stderr.write(`${prefix} ${line}`);
  }

  return {
    dbg,
    debugLogPath,
  };
}
