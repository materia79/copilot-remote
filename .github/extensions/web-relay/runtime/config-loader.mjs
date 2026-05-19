import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

function toAbsolutePath(value) {
  if (!value) return "";
  return path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);
}

function looksLikeServerDir(serverDir) {
  if (!serverDir) return false;
  return fs.existsSync(path.join(serverDir, "server.js")) && fs.existsSync(path.join(serverDir, "config.json"));
}

export function resolveRelayPaths(importMetaUrl) {
  const __dirname = path.dirname(fileURLToPath(importMetaUrl));
  const projectServerDir = path.resolve(__dirname, "../../../server");
  const cwdServerDir = path.resolve(process.cwd(), "server");
  const envRoot = toAbsolutePath(process.env.COPILOT_WEB_RELAY_ROOT || "");
  const envServerDir = toAbsolutePath(process.env.COPILOT_WEB_RELAY_SERVER_DIR || "");
  const envConfigPath = toAbsolutePath(process.env.COPILOT_WEB_RELAY_CONFIG || "");
  const envToolsPath = toAbsolutePath(process.env.COPILOT_WEB_RELAY_TOOLS || "");
  const envLogDir = toAbsolutePath(process.env.COPILOT_WEB_RELAY_LOG_DIR || "");

  const resolvedServerDir =
    (looksLikeServerDir(envServerDir) && envServerDir) ||
    (looksLikeServerDir(path.join(envRoot, "server")) && path.join(envRoot, "server")) ||
    (looksLikeServerDir(projectServerDir) && projectServerDir) ||
    (looksLikeServerDir(cwdServerDir) && cwdServerDir) ||
    projectServerDir;

  const SERVER_DIR = resolvedServerDir;
  const CONFIG_PATH = envConfigPath || path.resolve(SERVER_DIR, "config.json");
  const RELAY_TOOLS_PATH = envToolsPath || path.resolve(SERVER_DIR, "relay-tools.md");
  const LOG_DIR = envLogDir || path.resolve(SERVER_DIR, "logs");
  const SERVER_LOG_PATH = path.resolve(LOG_DIR, "server.log");
  const SERVER_ERR_PATH = path.resolve(LOG_DIR, "server-err.log");

  return {
    __dirname,
    CONFIG_PATH,
    RELAY_TOOLS_PATH,
    SERVER_DIR,
    LOG_DIR,
    SERVER_LOG_PATH,
    SERVER_ERR_PATH,
  };
}

export function loadTokenFromConfig(configPath) {
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
    return String(cfg.authToken || "").trim();
  } catch {
    return "";
  }
}

export function loadRelayInstructionsFromFile(relayToolsPath) {
  try {
    return String(fs.readFileSync(relayToolsPath, "utf8")).trim();
  } catch {
    return "";
  }
}
