# Copilot Remote

Use your local GitHub Copilot CLI session from any browser (phone, tablet, or second computer) through a self-hosted web relay.

```text
[Browser] <-- WebSocket --> [server.js :3333] <-- HTTP poll --> [Copilot CLI session]
```

## What this repository provides

Copilot Remote is split into two pieces:

1. **Web relay server** (`server/`): queueing, persistence, auth, browser UI, file browser, uploads.
2. **Copilot CLI extension** (`.github/extensions/web-relay/`): polls the relay, executes turns, streams activity, bridges `ask_user` questions into web question cards.

## Highlights

- Remote chat UI for a local Copilot CLI session
- Per-message **mode** picker: `plan`, `ask`, `agent`, `autopilot`
- Per-message **model** picker (live model discovery + fallback catalog)
- Streaming tool/activity updates while a turn runs
- Web question cards for `ask_user` clarification flows
- Conversation history stored in local SQLite
- Conversation **compact** workflow (`/compact`) to continue with summary carry-over
- Workspace + drives browser with file preview and raw file access
- `@file:` and `@folder:` reference tokens with copy-to-clipboard helpers
- Uploads and image attachment relay support
- Optional SSH reverse tunnel support for internet access
- PWA install support with installed-app fullscreen preference and browser-mode fallbacks

## Prerequisites

| Requirement | Notes |
|---|---|
| Node.js 18+ | Runs the relay server |
| GitHub CLI (`gh`) | Must be available in PATH |
| GitHub Copilot CLI extension | `gh extension install github/gh-copilot` |
| Copilot subscription | Individual, Business, or Enterprise |

## Quick start

```bash
git clone https://github.com/materia79/copilot-remote
cd copilot-remote
npm install
```

Create `server/config.json`:

```json
{
  "authToken": "change-me",
  "port": 3333,
  "localhostOnly": true,
  "pollIntervalMs": 3000,
  "processingTimeoutMs": 600000,
  "conversationSessionMode": "isolated"
}
```

Start Copilot with the relay extension:

```bash
npm run copilot:relay
```

If you installed the extension globally in `~/.copilot/extensions/web-relay/`, you can also start plain Copilot from any repository:

```bash
gh copilot
```

In that setup, the extension auto-starts and supervises `server.js` for the active CLI session; `npm run copilot:relay` is just a convenience launcher for this repository.

Open:

```text
http://<your-pc-ip>:3333/
```

When `localhostOnly` is `true`, use `http://localhost:3333/` from the same machine.

Sign in once with your token. The relay then uses an HttpOnly auth cookie.

## Runtime modes and startup commands

| Command | Purpose |
|---|---|
| `npm run copilot:relay` | Starts Copilot CLI with an initial prompt so the extension loads and polling begins |
| `npm run start:server` | Server only (use with an active Copilot CLI session that loads the extension) |
| `npm run start:server:respawn` | Manual watchdog fallback (Windows; use only outside extension-managed mode) |
| `npm run start:server:respawn:posix` | Manual watchdog fallback (Linux/macOS; use only outside extension-managed mode) |
| `npm start` | Standalone development mode (`server.js` + `relay.mjs`) |

### Single runtime owner rule

Run only one relay owner at a time:

1. **Extension-managed mode**: Copilot CLI extension handles polling.
2. **Standalone mode**: `npm start` handles polling itself.

Do not run extension polling together with standalone relay polling.

In extension-managed mode, polling begins after the CLI session becomes active (typically after the first prompt).
The extension now supervises managed `server.js` restarts (bounded backoff) while the CLI session is alive, and stops restart attempts on session shutdown.
When the CLI extension connects, it also prints the relay info window (local/network/remote/auth/polling URLs) directly in the Copilot CLI client.

## Using the web UI

- Choose **mode** and **model** per message in the composer.
- Use **Compact** to branch to a fresh conversation seeded with summary context.
- Use **Browse files** to inspect workspace/drives and open previews.
- Click file/folder copy controls to insert ``@file:...`` / ``@folder:...`` tokens.
- Answer clarification prompts in relay question cards (from `ask_user`).
- Use the usage button (`📊`) for live Copilot usage summary.
- Use the **Context** button to read the latest token/context metrics in a modal from local session-state events.
- Workspace browsing is locked to the Copilot CLI startup CWD (your active repo root) and does not retarget via chat `cd ...` commands.

## Relay modes

| Mode | Behavior |
|---|---|
| `ask` | Clarification-first behavior before implementation |
| `plan` | Planning response style (no implementation unless requested) |
| `agent` | Interactive coding agent behavior |
| `autopilot` | Action-first behavior; asks only when truly blocking |

## Models

The model picker is fed by live snapshot updates from the active CLI runtime and falls back to a curated set:

- `claude-sonnet-4.6`
- `claude-haiku-4.5`
- `gpt-5.4`
- `gpt-5.4-mini`
- `gpt-5.3-codex`

Selection is persisted in browser storage and attached per message.

## Configuration reference (`server/config.json`)

| Key | Default | Description |
|---|---|---|
| `authToken` | generated if missing | Required for API/UI auth; set explicitly for stable access |
| `port` | `3333` | HTTP + WebSocket port |
| `localhostOnly` | `true` | Bind only to loopback (`127.0.0.1`) and disable LAN/WAN access |
| `pollIntervalMs` | `3000` | CLI heartbeat/poll cadence |
| `processingTimeoutMs` | `600000` | Max turn processing wait |
| `conversationSessionMode` | `isolated` | Configured strategy (`isolated` / `shared`) exposed in status |
| `maxRequeueRetries` | `5` | Queue retry limit for failed processing |
| `remotePath` | `""` | URL base path when reverse-proxied under a subpath |
| `sshTunnel.enabled` | `false` | Enable reverse SSH tunnel |
| `sshTunnel.remoteBind` | `loopback` | Remote bind mode for SSH `-R` (`loopback` or `public`) |
| `sshTunnel.user` | — | SSH user |
| `sshTunnel.host` | — | SSH host |
| `sshTunnel.remotePort` | — | Remote forwarded port |
| `sshTunnel.identityFile` | optional | SSH key path (falls back to default agent/key) |

> In extension-managed mode, turns currently run through one SDK session, so isolation is enforced with conversation-scoped prompt guardrails rather than separate runtime processes.

## Optional remote internet access (SSH tunnel)

Configure:

```json
"sshTunnel": {
  "enabled": true,
  "remoteBind": "loopback",
  "user": "ubuntu",
  "host": "relay.example.com",
  "remotePort": 4444,
  "identityFile": "~/.ssh/id_rsa"
}
```

`localhostOnly` controls only the local relay listener (`127.0.0.1` vs `0.0.0.0`).
SSH tunnel exposure is controlled independently by `sshTunnel.remoteBind`.

Then reverse proxy on the VPS (example Caddy):

```text
relay.example.com {
    reverse_proxy localhost:4444
}
```

The relay auto-reconnects tunnel drops with exponential backoff.

## Global extension install (optional)

Install extension files for use across repositories:

```text
%USERPROFILE%\.copilot\extensions\web-relay\   (Windows)
~/.copilot/extensions/web-relay/               (Linux/macOS)
```

Useful environment variables:

- `COPILOT_WEB_RELAY_SERVER_DIR` (recommended)
- `COPILOT_WEB_RELAY_ROOT`
- `COPILOT_WEB_RELAY_CONFIG`
- `COPILOT_WEB_RELAY_TOOLS`
- `COPILOT_WEB_RELAY_LOG_DIR`
- `COPILOT_WEB_RELAY_NODE`

Project-local extension files still take precedence when both exist.

If the same extension is available both project-local (`.github/extensions/web-relay/`) and user-global (`~/.copilot/extensions/web-relay/`), Copilot may show duplicates in extension management. Keep only one active copy to avoid double-loading.

## API overview

Common routes:

- Browser/API: `/api/message`, `/api/conversations`, `/api/conversation/:id`, `/api/status`, `/api/models`, `/api/usage`
- CLI bridge: `/api/pending`, `/api/response`, `/api/activity`, `/api/heartbeat`
- Questions: `/api/relay-question`, `/api/relay-question/:id`, `/api/relay-question/:id/answer`
- File access: `/api/files/*`, `/api/files-preview/*`, `/api/repo/tree`, `/api/drives/*`
- Uploads: `/api/upload`, `/api/upload/:sha256/content`

All authenticated routes accept either:

- `Authorization: Bearer <token>`
- auth cookie from prior login

For deeper implementation/API details, see [`server/README.md`](server/README.md).

## Troubleshooting

| Symptom | What to check |
|---|---|
| UI says CLI offline | Send one CLI prompt to trigger extension session start, then check `/api/status` |
| Messages stuck pending | Ensure only one relay owner is running and only one process owns port `3333` |
| Wrong/old model shown | Check `/api/models` and extension logs for model snapshot updates |
| Clarification card not progressing | Answer via the web card; relay resumes after question status becomes `answered` |
| File links fail | Verify auth token/cookie and that paths are inside allowed workspace/drive roots |

## Security notes

- Auth is token-based and enforced on API + Socket.IO.
- Successful auth sets an HttpOnly cookie for browser sessions.
- Keep `server/config.json` private and rotate `authToken` if exposed.
- Set `localhostOnly` to `true` to force local-only access (no LAN/WAN listener).
- If exposed beyond LAN, use HTTPS and a strong token.

## Repository layout

```text
copilot-remote/
├── .github/extensions/web-relay/   # Copilot CLI extension (polling, ask_user bridge, model snapshotting)
├── server/                         # Express + Socket.IO relay server and web app
├── docs/                           # Project planning notes
└── README.md
```
