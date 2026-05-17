import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform, userInfo } from "node:os";
import { dirname, join } from "node:path";

const ADMIN_KEY_SERVICE = "eph-openai-admin-key";
const PROJECT_ID_SERVICE = "eph-openai-project-id";

export function configPath() {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "eph", "config.json");
}

function accountName() {
  return process.env.USER || userInfo().username;
}

function runSecurity(args, options = {}) {
  const result = spawnSync("security", args, {
    encoding: "utf8",
    stdio: options.input ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
    input: options.input,
  });
  if (result.status !== 0) {
    const message = result.stderr?.trim() || result.stdout?.trim() || `security exited ${result.status}`;
    throw new Error(message);
  }
  return result.stdout.trim();
}

export function keychainAvailable() {
  if (platform() !== "darwin") return false;
  const result = spawnSync("security", ["help"], { stdio: "ignore" });
  return result.status === 0;
}

function readKeychain(service) {
  if (!keychainAvailable()) return undefined;
  try {
    return runSecurity(["find-generic-password", "-a", accountName(), "-s", service, "-w"]);
  } catch {
    return undefined;
  }
}

function writeKeychain(service, value) {
  runSecurity(["add-generic-password", "-U", "-a", accountName(), "-s", service, "-w", value]);
}

function deleteKeychain(service) {
  if (!keychainAvailable()) return;
  const result = spawnSync("security", ["delete-generic-password", "-a", accountName(), "-s", service], {
    stdio: "ignore",
  });
  // security returns non-zero when the item does not exist. That's fine for clear.
  void result;
}

export function readEphConfig() {
  const path = configPath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Failed to read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function writeEphConfig(config) {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

export function loadOpenAIAuth() {
  const config = readEphConfig();
  const fileOpenAI = config.openai || {};
  const adminKey =
    process.env.OPENAI_ADMIN_KEY ||
    (keychainAvailable() ? readKeychain(ADMIN_KEY_SERVICE) : undefined) ||
    fileOpenAI.adminKey;
  const projectId =
    process.env.OPENAI_PROJECT_ID ||
    (keychainAvailable() ? readKeychain(PROJECT_ID_SERVICE) : undefined) ||
    fileOpenAI.projectId;

  let source = "none";
  if (process.env.OPENAI_ADMIN_KEY && process.env.OPENAI_PROJECT_ID) source = "environment";
  else if (keychainAvailable() && readKeychain(ADMIN_KEY_SERVICE) && readKeychain(PROJECT_ID_SERVICE)) source = "macOS Keychain";
  else if (fileOpenAI.adminKey && fileOpenAI.projectId) source = configPath();
  else if (adminKey || projectId) source = "mixed";

  return { adminKey, projectId, source };
}

export function requireOpenAIAuth() {
  const auth = loadOpenAIAuth();
  if (!auth.adminKey || !auth.projectId) {
    throw new Error(
      "OpenAI Admin credentials are not configured. Run `eph auth setup`, or set OPENAI_ADMIN_KEY and OPENAI_PROJECT_ID."
    );
  }
  return auth;
}

export function saveOpenAIAuth({ backend, adminKey, projectId }) {
  if (backend === "keychain") {
    if (!keychainAvailable()) throw new Error("macOS Keychain is not available on this machine.");
    writeKeychain(ADMIN_KEY_SERVICE, adminKey);
    writeKeychain(PROJECT_ID_SERVICE, projectId);
    const path = writeEphConfig({ authBackend: "keychain" });
    return { source: "macOS Keychain", path };
  }

  if (backend === "file") {
    const path = writeEphConfig({
      authBackend: "file",
      openai: { adminKey, projectId },
    });
    return { source: path, path };
  }

  throw new Error(`Unsupported auth backend: ${backend}`);
}

export function clearOpenAIAuth() {
  deleteKeychain(ADMIN_KEY_SERVICE);
  deleteKeychain(PROJECT_ID_SERVICE);
  const path = configPath();
  if (existsSync(path)) rmSync(path, { force: true });
  return path;
}

export function mask(value) {
  if (!value) return "not set";
  if (value.length <= 10) return `${value.slice(0, 2)}…${value.slice(-2)}`;
  return `${value.slice(0, 7)}…${value.slice(-4)}`;
}
