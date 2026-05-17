import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  createOpenAISessionKey,
  ephKeyName,
  listOpenAISessionKeys,
  parseExpiryFromName,
  revokeOpenAISessionKey,
  revokeOpenAISessionKeyByName,
} from "./openai.js";

const VERSION = "0.1.0";

function usage() {
  return `eph ${VERSION}

Ephemeral AI sessions for remote machines.

Usage:
  eph <ssh-host> [task...]              Start remote Pi with disposable OpenAI key
  eph --local [task...]                 Start local Pi with disposable OpenAI key
  eph keys create [label]               Create an OpenAI session key and print it
  eph keys list                         List eph OpenAI service accounts
  eph keys revoke <id>                  Revoke an OpenAI service account
  eph cleanup                           Revoke expired eph OpenAI service accounts

Options:
  --provider <openai|anthropic>         Provider for Pi (default: openai)
  --prompt-key                          Prompt for a manual provider key instead of managed OpenAI
  --ttl <duration>                      Session key TTL for name/cleanup, e.g. 30m, 2h (default: 2h)
  --remote-pi <command>                 Remote Pi command (default: pi)
  --local                              Run Pi locally instead of over SSH
  --task <text>                         Initial prompt for Pi
  -h, --help                            Show help

Environment for OpenAI managed mode:
  OPENAI_ADMIN_KEY                      OpenAI Admin key. Keep this local, never on remote hosts.
  OPENAI_PROJECT_ID                     Project where eph creates service accounts.
`;
}

function parseDuration(input, fallbackSeconds = 7200) {
  if (!input) return fallbackSeconds;
  const match = String(input).trim().match(/^(\d+)(s|m|h|d)?$/i);
  if (!match) throw new Error(`Invalid duration: ${input}`);
  const n = Number(match[1]);
  const unit = (match[2] || "s").toLowerCase();
  return n * ({ s: 1, m: 60, h: 3600, d: 86400 }[unit] || 1);
}

function parseArgs(argv) {
  const opts = {
    provider: "openai",
    promptKey: false,
    local: false,
    ttlSeconds: 7200,
    remotePi: "pi",
    task: "",
  };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") opts.help = true;
    else if (arg === "--provider") opts.provider = argv[++i];
    else if (arg === "--prompt-key") opts.promptKey = true;
    else if (arg === "--local") opts.local = true;
    else if (arg === "--ttl") opts.ttlSeconds = parseDuration(argv[++i]);
    else if (arg === "--remote-pi") opts.remotePi = argv[++i];
    else if (arg === "--task") opts.task = argv[++i] || "";
    else if (arg.startsWith("--")) throw new Error(`Unknown option: ${arg}`);
    else positional.push(arg);
  }
  return { opts, positional };
}

async function promptSecret(label) {
  // Avoid echo by temporarily disabling terminal echo via stty.
  if (process.stdin.isTTY) spawnSync("stty", ["-echo"], { stdio: "inherit" });
  try {
    const rl = createInterface({ input, output });
    const value = await rl.question(label);
    rl.close();
    output.write("\n");
    return value.trim();
  } finally {
    if (process.stdin.isTTY) spawnSync("stty", ["echo"], { stdio: "inherit" });
  }
}

function providerEnvVar(provider) {
  if (provider === "openai") return "OPENAI_API_KEY";
  if (provider === "anthropic") return "ANTHROPIC_API_KEY";
  throw new Error(`Unsupported provider: ${provider}`);
}

async function acquireCredential(opts, label) {
  if (opts.promptKey || opts.provider !== "openai") {
    if (opts.provider !== "openai" && !opts.promptKey) {
      throw new Error(`${opts.provider} does not support managed eph keys yet. Use --prompt-key.`);
    }
    const apiKey = await promptSecret(`${opts.provider} API key: `);
    return { mode: "manual", apiKey, id: undefined, name: undefined };
  }

  const name = ephKeyName(label, opts.ttlSeconds);
  console.error(`Creating OpenAI session key: ${name}`);
  const credential = await createOpenAISessionKey({ name });
  return { mode: "managed", ...credential };
}

async function revokeIfManaged(credential) {
  if (credential?.mode !== "managed" || !credential.id) return;
  console.error(`Revoking OpenAI session key: ${credential.id}`);
  try {
    await revokeOpenAISessionKey(credential.id);
  } catch (error) {
    if (!credential.name) throw error;
    console.error(`Direct revoke failed; retrying by service account name: ${credential.name}`);
    const count = await revokeOpenAISessionKeyByName(credential.name);
    if (count === 0) throw error;
  }
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function makeRemoteEnv({ provider, apiKey, task }) {
  const envName = providerEnvVar(provider);
  return [
    `export ${envName}=${shellQuote(apiKey)}`,
    `export PI_CODING_AGENT_DIR="$EPH_TMP/config"`,
    `export PI_CODING_AGENT_SESSION_DIR="$EPH_TMP/sessions"`,
    `export PI_TELEMETRY=0`,
    `export PI_SKIP_VERSION_CHECK=1`,
    task ? `export EPH_TASK=${shellQuote(task)}` : `export EPH_TASK=''`,
  ].join("\n") + "\n";
}

function runLocalPi({ provider, apiKey, task }) {
  const envName = providerEnvVar(provider);
  const env = {
    ...process.env,
    [envName]: apiKey,
    PI_CODING_AGENT_DIR: `/tmp/eph-local-${process.pid}/config`,
    PI_CODING_AGENT_SESSION_DIR: `/tmp/eph-local-${process.pid}/sessions`,
    PI_TELEMETRY: "0",
    PI_SKIP_VERSION_CHECK: "1",
  };
  const args = ["--no-session", "--provider", provider];
  if (task) args.push(task);
  return spawnSync("pi", args, { stdio: "inherit", env }).status ?? 1;
}

function runRemotePi({ host, provider, apiKey, task, remotePi }) {
  const session = `eph-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const remoteDir = `/tmp/${session}`;
  const envScript = makeRemoteEnv({ provider, apiKey, task });

  console.error(`Preparing remote ephemeral state on ${host}:${remoteDir}`);
  const prep = spawnSync(
    "ssh",
    [host, `umask 077; mkdir -p ${shellQuote(remoteDir)}; cat > ${shellQuote(`${remoteDir}/env`)}`],
    { input: envScript, encoding: "utf8", stdio: ["pipe", "inherit", "inherit"] }
  );
  if ((prep.status ?? 1) !== 0) return prep.status ?? 1;

  const remoteCommand = [
    `EPH_TMP=${shellQuote(remoteDir)}`,
    `. ${shellQuote(`${remoteDir}/env`)}`,
    `mkdir -p "$PI_CODING_AGENT_DIR" "$PI_CODING_AGENT_SESSION_DIR"`,
    `cleanup() { unset ${providerEnvVar(provider)}; rm -rf "$EPH_TMP"; }`,
    `trap cleanup EXIT INT TERM`,
    `REMOTE_PI=${shellQuote(remotePi)}`,
    `if ! command -v "$REMOTE_PI" >/dev/null 2>&1; then for candidate in "$HOME/.local/bin/pi" "$HOME/.local/share/pi-node"/*/bin/pi; do if [ -x "$candidate" ]; then REMOTE_PI="$candidate"; break; fi; done; fi`,
    `command -v "$REMOTE_PI" >/dev/null 2>&1 || { echo "eph: remote Pi command not found: ${remotePi}" >&2; echo "Install Pi or pass --remote-pi /path/to/pi" >&2; exit 127; }`,
    task
      ? `"$REMOTE_PI" --no-session --provider ${shellQuote(provider)} "$EPH_TASK"`
      : `"$REMOTE_PI" --no-session --provider ${shellQuote(provider)}`,
  ].join("; ");

  const result = spawnSync("ssh", ["-t", host, `bash -lc ${shellQuote(remoteCommand)}`], { stdio: "inherit" });
  return result.status ?? 1;
}

async function keysCommand(args) {
  const sub = args[0] || "list";
  if (sub === "create") {
    const label = args[1] || "manual";
    const credential = await createOpenAISessionKey({ name: ephKeyName(label) });
    console.log(JSON.stringify({ id: credential.id, name: credential.name, apiKey: credential.apiKey }, null, 2));
    return;
  }
  if (sub === "list") {
    const keys = await listOpenAISessionKeys();
    for (const key of keys.filter((k) => k.name.startsWith("eph-"))) {
      const exp = parseExpiryFromName(key.name);
      console.log(`${key.id}\t${key.name}\t${exp ? exp.toISOString() : "no-expiry-in-name"}`);
    }
    return;
  }
  if (sub === "revoke") {
    const id = args[1];
    if (!id) throw new Error("Usage: eph keys revoke <id>");
    await revokeOpenAISessionKey(id);
    console.log(`revoked ${id}`);
    return;
  }
  throw new Error(`Unknown keys command: ${sub}`);
}

async function cleanupCommand() {
  const now = new Date();
  const keys = await listOpenAISessionKeys();
  let revoked = 0;
  for (const key of keys.filter((k) => k.name.startsWith("eph-"))) {
    const exp = parseExpiryFromName(key.name);
    if (exp && exp <= now) {
      await revokeOpenAISessionKey(key.id);
      revoked++;
      console.log(`revoked ${key.id}\t${key.name}`);
    }
  }
  console.log(`cleanup complete: ${revoked} revoked`);
}

export async function main(argv) {
  const { opts, positional } = parseArgs(argv);
  if (opts.help || argv.length === 0) {
    console.log(usage());
    return;
  }

  if (positional[0] === "keys") {
    await keysCommand(positional.slice(1));
    return;
  }
  if (positional[0] === "cleanup") {
    await cleanupCommand();
    return;
  }

  const host = opts.local ? undefined : positional[0];
  const taskFromPositional = opts.local ? positional.join(" ") : positional.slice(1).join(" ");
  const task = opts.task || taskFromPositional;
  if (!opts.local && !host) throw new Error("Usage: eph <ssh-host> [task...] or eph --local [task...]");

  const label = opts.local ? "local" : host;
  const credential = await acquireCredential(opts, label);
  let status = 1;
  try {
    if (opts.local) {
      status = runLocalPi({ provider: opts.provider, apiKey: credential.apiKey, task });
    } else {
      status = runRemotePi({ host, provider: opts.provider, apiKey: credential.apiKey, task, remotePi: opts.remotePi });
    }
  } finally {
    await revokeIfManaged(credential);
  }
  process.exitCode = status;
}
