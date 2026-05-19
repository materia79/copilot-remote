import fs from "fs";
import path from "path";

export function createDebugLogger({ logDir, fileName = "ext-debug.log", prefix = "[web-relay-dbg]" }) {
  const debugLogPath = path.resolve(logDir, fileName);

  function dbg(...args) {
    const line = `[${new Date().toISOString().slice(11,23)}] ${args.join(" ")}\n`;
    try { fs.mkdirSync(logDir, { recursive: true }); } catch {}
    try { fs.appendFileSync(debugLogPath, line); } catch {}
    process.stderr.write(`${prefix} ${line}`);
  }

  return {
    dbg,
    debugLogPath,
  };
}
