import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

function existingDirectories(paths = []) {
  const out = [];
  for (const candidate of paths) {
    const normalized = String(candidate || '').trim();
    if (!normalized) continue;
    try {
      if (fs.statSync(normalized).isDirectory()) out.push(normalized);
    } catch {}
  }
  return out;
}

function resolveTtyConsoleRoot() {
  const require = createRequire(import.meta.url);
  return path.dirname(require.resolve('tty-console'));
}

export async function maybeStartTtyConsole({
  serverDir,
  logsDir,
  logger = console,
} = {}) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return null;

  const resolvedServerDir = path.resolve(String(serverDir || process.cwd()).trim() || process.cwd());
  const resolvedLogsDir = path.resolve(String(logsDir || path.join(resolvedServerDir, 'logs')).trim() || path.join(resolvedServerDir, 'logs'));
  fs.mkdirSync(resolvedLogsDir, { recursive: true });

  let ttyConsoleModule;
  try {
    ttyConsoleModule = await import('tty-console');
  } catch (error) {
    const code = String(error?.code || '').trim();
    if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') {
      logger?.log?.('[server] tty-console not installed; continuing without terminal console.');
      return null;
    }
    logger?.warn?.(`[server] tty-console load failed: ${error?.message || error}`);
    return null;
  }

  const ttyConsoleApi = ttyConsoleModule?.default || ttyConsoleModule;
  const ConsoleCtor = ttyConsoleApi?.Console;
  if (typeof ConsoleCtor !== 'function') {
    logger?.warn?.('[server] tty-console loaded but Console export was unavailable.');
    return null;
  }

  const ttyConsoleRoot = resolveTtyConsoleRoot();
  const bundledCommandsDir = path.join(ttyConsoleRoot, 'commands');
  const localCommandsDir = path.join(resolvedServerDir, 'commands');
  const commandsDirs = existingDirectories([bundledCommandsDir, localCommandsDir]);
  const configPath = path.join(resolvedLogsDir, 'console_config.json');
  const historyPath = path.join(resolvedLogsDir, 'console_history.json');

  const consoleOptions = {
    configPath,
    historyPath,
    exitOnStop: false,
  };
  if (commandsDirs.length === 1) {
    consoleOptions.commandsDir = commandsDirs[0];
  } else if (commandsDirs.length > 1) {
    consoleOptions.commandsDir = commandsDirs;
  }

  const runtime = new ConsoleCtor(consoleOptions);
  runtime.start?.();
  logger?.log?.(`[server] tty-console started (${commandsDirs.join(', ')})`);
  return runtime;
}
