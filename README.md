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

On your trusted local machine:

```bash
export OPENAI_ADMIN_KEY="sk-admin-..."
export OPENAI_PROJECT_ID="proj_..."
```

Recommended: store these in 1Password, macOS Keychain, `pass`, or another local secret manager and export them only when needed.

Never copy `OPENAI_ADMIN_KEY` to the remote host.

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

List active `eph-*` OpenAI service accounts:

```bash
eph keys list
```

Revoke one:

```bash
eph keys revoke svcacct_...
```

Revoke expired `eph-*` keys:

```bash
eph cleanup
```

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
