# eph

Ephemeral AI sessions for remote machines.

`eph` lets you run [Pi](https://pi.dev/) on a homelab/server host without leaving a long-lived AI API key behind.

```bash
eph portainer
```

What happens:

1. `eph` runs on your trusted local machine.
2. It creates a disposable OpenAI service-account key using your OpenAI Admin key.
3. It SSHes into the target host.
4. The target runs `pi --no-session` with temporary Pi config/session directories.
5. When Pi exits, `eph` revokes the disposable OpenAI key.
6. `eph cleanup` revokes stale `eph-*` keys if a session crashes before cleanup.

The goal is **no persistent AI credentials on the remote machine**. Pi itself can remain installed.

## Status

Early project. OpenAI managed credentials are the first-class path. Anthropic is supported only in manual-key mode because Anthropic's Admin API does not currently allow creating API keys programmatically.

## Security model

`eph` helps with this specific risk:

> I want to use an AI agent on a server, but I do not want a long-lived OpenAI API key sitting on that server after I leave.

Protects against:

- leaving `OPENAI_API_KEY` in `~/.pi/agent/auth.json`
- leaving Pi session files in normal Pi config directories
- forgetting to manually revoke a temporary OpenAI key
- stale `eph-*` OpenAI keys after crashes, via `eph cleanup`

Does **not** protect against:

- a host compromised during the active session
- root reading process environment or temp files while Pi is running
- bad commands if you give the AI shell access
- secrets printed in command output
- shell/system logs created by commands you run

Do not put your OpenAI Admin key on remote homelab hosts. Keep it only on your trusted local machine.

## Requirements

Local machine:

- Node.js 20+
- `ssh`
- OpenAI Admin key with permission to manage project service accounts
- OpenAI project ID for disposable session keys

Remote machine:

- SSH access from your local machine
- Pi installed and on `PATH`

Install Pi on the remote host once if needed:

```bash
curl -fsSL https://pi.dev/install.sh | sh
```

Do **not** run `/login` on the remote host for ephemeral sessions.

## Install

For development:

```bash
git clone https://github.com/rdyson/eph.git
cd eph
npm link
```

Or run directly:

```bash
node ./bin/eph.js --help
```

## Setup

On your trusted local machine, run:

```bash
eph auth setup
```

`eph` asks for:

- OpenAI Admin key
- OpenAI Project ID

On macOS, `eph auth setup` stores them in Keychain by default. On other systems, it stores them in `~/.config/eph/config.json` with mode `0600` unless you choose another backend.

Verify setup:

```bash
eph auth doctor
```

Verify that create/revoke works end-to-end:

```bash
eph auth doctor --live
```

You can also provide credentials with environment variables, which override stored config:

```bash
export OPENAI_ADMIN_KEY="sk-admin-..."
export OPENAI_PROJECT_ID="proj_..."
```

Never copy `OPENAI_ADMIN_KEY` to the remote host. `eph` uses it locally only to create and revoke disposable per-session keys.

### Credential responsibility

You choose how to expose your OpenAI Admin key to `eph`: Keychain, local config file, environment variables, or a password-manager wrapper. `eph` does not claim to secure your local machine.

What `eph` does guarantee:

- it never intentionally sends `OPENAI_ADMIN_KEY` to the remote host
- it never writes `OPENAI_ADMIN_KEY` into remote Pi config
- it sends only a disposable per-session API key to the remote host
- it revokes that disposable key when the session exits, when possible

## Quick start

Start an ephemeral Pi session on a remote host named `portainer` from your SSH config:

```bash
eph portainer
```

Start with an initial task:

```bash
eph portainer "Diagnose why I cannot access the app container. Start read-only. Check docker ps, logs, inspect, networks, port bindings, and listening ports. Do not restart or modify anything until you explain the likely cause."
```

Use a shorter TTL in the key name for janitor cleanup:

```bash
eph portainer --ttl 30m
```

Run locally instead of over SSH:

```bash
eph --local "Summarize this directory and identify obvious risks."
```

## Example: Portainer container debugging

You have a host in `~/.ssh/config`:

```sshconfig
Host portainer
  HostName 192.168.1.50
  User richard
  IdentityFile ~/.ssh/homelab_ed25519
  IdentitiesOnly yes
```

Remote host has Pi installed:

```bash
ssh portainer 'pi --version'
```

If Pi was installed by `pi.dev/install.sh` into `~/.local/share/pi-node/...`, `eph` auto-discovers it and adds Pi's bundled Node directory to `PATH` for the remote session. You usually do not need `--remote-pi`.

Start the session:

```bash
eph portainer "I can't access one of my containers. Start read-only. Identify the failing container, check docker ps, docker logs, docker inspect, docker networks, published ports, listening sockets, and any reverse proxy config. Do not restart containers or change files until I approve."
```

Inside Pi, you can ask follow-ups like:

```text
Check whether the container is listening on the expected internal port.
```

Pi may run commands such as:

```bash
docker ps
docker logs --tail=200 app
docker inspect app
docker network ls
docker network inspect bridge
ss -tulpn
curl -v http://localhost:8080
```

When you quit Pi, `eph` revokes the disposable OpenAI key.

## Key management

Create a disposable OpenAI key manually:

```bash
eph keys create portainer
```

List active `eph-*` OpenAI service accounts and their owned API keys:

```bash
eph keys list
```

For debugging OpenAI response shapes, print redacted JSON:

```bash
eph keys list --json
```

Revoke one by API-key id or service-account/user id:

```bash
eph keys revoke key_...
eph keys revoke user_...
```

Revoke expired `eph-*` credentials:

```bash
eph cleanup
```

Force-revoke all `eph-*` credentials, useful after testing:

```bash
eph cleanup --all
```

OpenAI service-account-owned API keys cannot be deleted directly. `eph` handles this by deleting/removing the owning service account/project user, which removes the owned API key.

Run cleanup from cron/systemd on your trusted local machine if you use `eph` often.

## Anthropic

Anthropic does not currently support API-key creation via their Admin API, so `eph` cannot provide true managed disposable Anthropic keys.

Manual mode is available:

```bash
eph portainer --provider anthropic --prompt-key
```

This still uses temporary remote Pi state and `pi --no-session`, but `eph` cannot revoke the Anthropic key after the session. Revoke or rotate it manually if needed.

A future proxy mode could make Anthropic truly ephemeral by giving the remote host an `eph` token instead of the real Anthropic key.

## How remote sessions work

`eph` creates a remote temp directory like:

```text
/tmp/eph-...
```

It writes a 0600 env file there containing only the disposable session key and temporary Pi state paths. Then it starts:

```bash
pi --no-session --provider openai
```

with:

```bash
PI_CODING_AGENT_DIR=/tmp/eph-.../config
PI_CODING_AGENT_SESSION_DIR=/tmp/eph-.../sessions
OPENAI_API_KEY=<disposable-session-key>
```

On normal exit, the remote temp directory is deleted and the OpenAI key is revoked from the local machine.

## Design notes

Why leave Pi installed?

Because the credential is the sensitive part. An installed Pi binary is usually less risky than a long-lived API key. `eph` focuses on credential lifetime rather than uninstalling tools after every session.

Why OpenAI first?

OpenAI Admin keys can create and revoke project service-account keys. That enables a real disposable-key lifecycle. Providers that cannot create/revoke keys programmatically need manual or proxy mode.

## Roadmap

- [ ] Verify OpenAI Admin API response shapes across account types
- [ ] Add tests for CLI parsing and key-name expiry parsing
- [ ] Add `eph install-pi <host>` helper
- [ ] Add optional `npx` remote mode for hosts without Pi installed
- [ ] Add systemd timer example for `eph cleanup`
- [ ] Add provider-agnostic proxy mode
- [ ] Add optional Pi extension for session status and warnings

## License

MIT
