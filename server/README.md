# Copilot Web Proxy

A Node.js web server that lets you chat with your GitHub Copilot CLI from any device via a browser.

## Setup

```bash
npm install
```

This project now runs in package-wide ESM mode (`"type": "module"` in `package.json`).

## Starting the Server

If you run `gh copilot` and the web-relay extension is loaded (project-local or user-global),
the extension auto-starts `server.js` when needed and keeps the relay listener singleton
while letting session-affine CLI workers run in parallel.

> **Single-owner rule:** Use either extension-managed polling **or** standalone `relay.mjs`, never both at the same time.

Tell the Copilot CLI agent: **"launch the server"**

Or start Copilot with no manual prompt typing:

```bash
npm run copilot:relay
```

That runs `gh copilot -- --allow-all -i "launch the server"` from the repo root, so the
extension is discovered and the relay starts immediately. If you installed the extension
globally, plain `gh copilot` from any repository is enough.

Or manually:

```bash
npm start
```

This starts both the web server and relay automatically.
Stopping the main process (Ctrl+C / closing the terminal) also stops the relay.

If you install this repo locally with `npm link` or `npm install -g .`, the `copilot-remote`
command starts the web relay server if needed and then launches `gh copilot` in the same shell
from whatever folder you run it in. If a relay is already live, it reuses it instead of starting
a second owner.

Relay server output is redirected to a logfile under `%LOCALAPPDATA%\copilot-remote\logs` by
default (or `COPILOT_WEB_RELAY_LOG_DIR` if set), so the terminal stays reserved for the CLI.

The global launcher no longer injects a bootstrap prompt; it just starts `gh copilot` directly
after the relay is ready.

If you need a specific `server/config.json` for token or tunnel settings, set
`COPILOT_WEB_RELAY_CONFIG` to that file before launching. The global npm install does not include
the repo-local gitignored config file by default.

If you want CLI-extension mode (your active Copilot CLI session does the work),
start only the web server manually:

```bash
npm run start:server
```

Mode summary:

- `npm start`: server + standalone SDK relay (manual development / local end-to-end testing)
- `npm run start:server`: server only (use with `.github/extensions/web-relay/extension.mjs` in CLI session)
- `npm run start:server:respawn`: legacy/manual watchdog tool (`respawn.bat`, outside extension-managed flow)
- `npm run start:server:respawn:posix`: legacy/manual watchdog tool (`respawn.sh`, outside extension-managed flow)

On Windows, the visible relay launcher path now targets a stable per-workspace Windows Terminal window name so later foreground launches reuse the same window instead of opening new desktop windows. Keep the hidden/stdio path as a fallback only.

### Runtime safety checklist (avoid duplicate relay workers)

1. Stop stale detached watchdog/relay processes before restart.
2. Keep exactly one listener on port `3333`.
3. The relay singleton lock is stored at `server/data/relay-server.lock` (stale locks are auto-recovered).
4. In extension-managed mode, do not run `npm start` or `node relay.mjs`.
5. Verify `/api/status` shows `cliOnline: true` and queue counts are moving or zero.

Script necessity note:

- Extension-managed relay does not call npm scripts directly; it starts `server.js` itself.
- Extension-managed relay supervision now includes bounded auto-restart while the CLI session is active.
- Keep `npm start` for manual local development (starts server + standalone relay).
- Keep `npm run start:server` for server-only manual runs and extension-parity testing.
- Treat `npm run start:server:respawn` / `npm run start:server:respawn:posix` as manual fallback only (not the default extension-managed path).

## Global extension install (user-scoped)

Copilot also scans a user extensions directory, so you can make this extension available
across repositories:

```text
C:\Users\<you>\.copilot\extensions\web-relay\extension.mjs
```

With global install, starting `gh copilot` in any workspace will load this extension and keep
the relay tied to that workspace CWD instead of forcing a fixed repo launcher.

If you also keep a project-local copy, extension management can show two `web-relay` entries.
Keep only one active to prevent duplicate loading.

For global install, copy the full `web-relay` extension folder there and set one of these
environment variables so it can find your relay server files:

- `COPILOT_WEB_RELAY_SERVER_DIR` (recommended) → absolute path to the `server` folder
- `COPILOT_WEB_RELAY_ROOT` → repo root that contains `server\`
- Optional overrides: `COPILOT_WEB_RELAY_CONFIG`, `COPILOT_WEB_RELAY_TOOLS`, `COPILOT_WEB_RELAY_LOG_DIR`

Project-local extensions still take precedence if the same extension name exists in both locations.

The startup banner shows your access URLs and token.

## Accessing the UI

Open in any browser:
```
http://<your-pc-ip>:3333/
```

If `localhostOnly` is enabled in `config.json`, the server listens only on loopback and you must use:

```
http://localhost:3333/
```

`localhostOnly` affects only the local relay listener. SSH reverse tunnel exposure is configured separately with `sshTunnel.remoteBind`.

Sign in once with the token prompt; the browser stores the session in an HttpOnly cookie.
The workspace browser is locked to the Copilot CLI startup CWD (or to
`COPILOT_WORKSPACE_ROOT` when explicitly set), so the active repo root stays stable
for the whole session. Plain `cd ...` chat commands do not retarget `Browse files`.

## Install as an app

The UI is now a Progressive Web App. On Android Chrome, use the browser menu to choose
**Install app** or **Add to Home screen**. Installed app mode now prefers fullscreen launch
where supported (with standalone fallback), and hides install/fullscreen header buttons.

When opened in a regular browser tab, the in-app **Install** button remains available
in the chat header (shown as `⬇` on small screens).

If you host the relay behind a subpath, open the URL with a trailing slash so the PWA scope matches correctly for install prompts.

## Model Selection

The composer includes a model picker next to the Send button.
Models are now populated dynamically from the active Copilot CLI runtime using
raw model IDs (no relay-specific aliases). The selected model ID is sent as-is
for each message.

Behavior notes:

- The picker refreshes from live CLI model discovery when relay status changes.
- Selection is persisted in browser storage and reused if still available.
- If live discovery is temporarily unavailable, the relay can use cached/current
  model state and shows a warning banner.
- In extension-managed mode, the relay still switches model per message and
  reports the active model used in the response.

## Relay Mode Selection

The composer also includes a per-message mode picker:

- `plan`
- `ask`
- `agent`
- `autopilot`

Mode is stored with each queued message so the relay can change behavior per turn.
Clarification prompts from the CLI are forwarded back into the browser as question
cards with a reply box.

## Conversation titles

The active conversation header includes a `✍️` button for renaming the conversation inline.
Title edits are saved to the database and broadcast to other open clients immediately.

## Session worker rollout flags

Session-worker refactor gates are OFF by default and can be enabled per flag:

- `SESSION_WORKER_ROUTING_ENABLED`
- `SESSION_WORKER_CONTINUATION_ROUTING_ENABLED`
- `SESSION_WORKER_FALLBACK_RESTART_ENABLED` (deprecated no-op)

`SESSION_WORKER_FALLBACK_RESTART_ENABLED` is now a deprecated no-op. Session-worker routing no longer asks the global restart orchestrator to respawn CLIs for worker failures.

Configuration precedence is:

1. `server/config.json` → `features.{FLAG_NAME}` (`true/false`, `1/0`, `yes/no`, `on/off`)
2. Environment override: `COPILOT_REMOTE_{FLAG_NAME}`

Unknown flag names and invalid values are ignored safely.

Question bridge rule:

- User-facing questions/clarifications must use `ask_user` so they flow through
  the relay question bridge and render as web question cards/buttons.
- This applies in `autopilot` too: still call `ask_user` for clarification, and
  the relay layer will surface the question card even if the direct question hook
  is bypassed.
- Plain-text assistant questions are not considered bridge-backed questions.
- Relay now includes a fallback: if a turn clearly ends with a plain-text follow-up
  question and choices but no `ask_user` bridge was used, it auto-converts that
  question into a relay question card, waits for the answer, and resumes the turn.

## How It Works

```
[Browser] ←── WebSocket ──→ [server.js :3333] ←── HTTP poll ──→ [Copilot CLI session]
```

1. Browser sends a message → stored in server queue
2. CLI agent polls `GET /api/pending` every few seconds
3. When a message is found, the CLI processes it and posts the response to `POST /api/response`  
4. Server broadcasts response via Socket.io → appears in browser instantly

## Monitoring Mode (CLI)

After launching the server, the CLI enters a polling loop:
- Checks `/api/pending` every ~3 seconds
- Processes any message with full PC access (file system, commands, etc.)
- Posts the response back
- CLI appears **online** (green dot) in the web UI while polling
- While working, relay tool activity is streamed into the pending assistant bubble
  (for example `Search (glob)` and `Search (grep)`).
- Assistant reply text is streamed into the pending assistant bubble while the turn is running.
- Tool activity is now also kept with the assistant message as a collapsible
  **Tool activity** section after the response arrives.
- Clarification prompts from `ask_user`/user-input requests are forwarded as
  question cards in the conversation; answering the card resumes the waiting turn.
- Answered relay question cards stay visible in the conversation journal, including
  the answer you submitted.

### Session activation behavior (important)

In extension-managed mode, the web server can already be running while the CLI is still
shown as offline. Polling starts when the Copilot session becomes active (`onSessionStart`),
which usually happens after your first prompt in the CLI.

This means the following startup sequence is expected:
1. Open `http://localhost:3333` and briefly see "CLI is offline"
2. Send one message in the CLI
3. Extension starts polling and queued web messages begin processing

If a conversation is still unbound when the CLI first sees it, the extension now claims it through `/api/session-sync` before processing so the browser can send back to the same SDK session.

| Symptom | Check |
|---|---|
| UI says "CLI is offline" | Verify `/api/status` works with the auth cookie or `Authorization: Bearer <token>` and shows `cliOnline: true` |
| UI flaps online/offline after restart | Ensure you are not mixing extension-managed mode with standalone `relay.mjs`, and confirm only one relay process owns port `3333` |
| "Web relay connected" banner repeats too often | Ensure only one extension instance is active; banner dedupe now persists across extension restarts for the same CLI session and reprints only when relay details change |
| No response after sending | Tail `server\ext-debug.log` and confirm `onSessionStart fired` + `startPolling called` |
| Wrong model used | Check logs for `Model selected: requested=... active=...` |
| Question card stuck | Answer in the card UI; logs should show `relay question created` and `relay question answered` |
| Tunnel not connecting | Check server console for `[ssh-tunnel]` lines; confirm SSH key auth works without password |
| Tunnel keeps reconnecting | VPS `sshd_config` needs `GatewayPorts no` (default) — Caddy handles the public port |

## API Reference

All authenticated routes accept an HttpOnly auth cookie or an `Authorization: Bearer <token>` header.

`GET /api/status` now also includes `readyBanner`, a preformatted relay-info payload used by the CLI extension to print the access window directly in the Copilot CLI client when relay connectivity is established.
It also includes `restartOrchestrator` with the current relay-side restart transaction state.
Queue metrics include `parkedCount` for turns deferred behind restart/rebind gates.

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/message` | Send a message from the browser |
| POST | `/api/upload` | Upload binary file content (deduped by SHA-256) |
| GET | `/api/upload/:sha256/content` | Stream stored upload content by hash |
| GET | `/api/files/*` | Stream a workspace file by repo-relative path (token required) |
| GET | `/api/files-preview/*` | Return structured preview JSON for markdown/code/text/image files |
| GET | `/api/repo/tree` | Return repository tree snapshot (supports `includeHidden` and `includeHeavy`) |
| GET | `/api/drives/roots` | Return browsable drive roots (local fixed + removable) for explorer drive mode |
| GET | `/api/drives/list` | Lazy-load entries for a drive directory (`path`, optional `includeHidden`) |
| GET | `/api/drives/file` | Stream a drive file by absolute drive path query (`path`) |
| GET | `/api/drives/files-preview` | Return structured preview JSON for a drive file (`path`) |
| GET | `/api/conversations` | List all conversations |
| GET | `/api/sessions` | List runtime sessions bound 1:1 to conversations |
| GET | `/api/conversation/:id` | Get full conversation with messages and session-root path metadata |
| PATCH | `/api/conversation/:id` | Update a conversation title |
| POST | `/api/conversation/:id/compact` | Compact a conversation into a new one with carry-over summary seed |
| DELETE | `/api/conversation/:id` | Delete a conversation |
| GET | `/api/sdk-session-delete/pending` | (CLI relay) Fetch next pending SDK session delete request |
| POST | `/api/sdk-session-delete/result` | (CLI relay) Report SDK session delete result |
| POST | `/api/session-sync` | (CLI relay) Sync conversation↔SDK binding and optionally confirm orchestrator rebind completion |
| GET | `/api/pending` | (CLI) Fetch next pending message |
| POST | `/api/response` | (CLI) Submit response for a message |
| GET | `/api/restart-orchestrator` | Read relay restart orchestrator state |
| POST | `/api/restart-orchestrator/request` | Queue a restart transaction for a target SDK session |
| POST | `/api/activity` | (CLI) Push in-flight tool activity for current message |
| POST | `/api/stream` | (CLI) Push in-flight assistant text stream for current pending message |
| POST | `/api/relay/pause` | Pause dequeueing and drop currently queued messages |
| POST | `/api/relay/resume` | Resume dequeueing after pause |
| GET | `/api/relay-questions` | (CLI/UI) List relay questions by `status` (for example `pending` or `answered`) |
| GET | `/api/relay-question/:id` | (CLI) Fetch a single relay question |
| POST | `/api/relay-question` | (CLI) Create a relay question for the browser |
| POST | `/api/relay-question/:id/answer` | (UI) Submit an answer for a relay question |
| POST | `/api/relay-question/:id/timeout` | (CLI/UI) Mark a relay question timed out |
| POST | `/api/heartbeat` | (CLI) Keep CLI status alive |
| GET | `/api/status` | Overall status |
| GET | `/api/models` | Live/cached model catalog used by the UI picker |
| POST | `/api/models/snapshot` | (CLI/relay) Publish discovered model snapshot |
| GET | `/api/context/:conversationId` | Parse and return context metrics from session-state events for a conversation |
| GET | `/api/context` | Parse context metrics only when `conversationId` query is provided; otherwise returns a missing-selection response |
| GET | `/api/usage` | Live Copilot usage snapshot |

### Upload storage model

- Physical blobs are stored in `server/uploads/<sha256>` (content-addressed).
- Metadata (`original_name`, `mime_type`, `size_bytes`) is stored in SQLite.
- Message/conversation references are tracked in SQLite; when a conversation is deleted,
  unreferenced blobs are garbage-collected from disk automatically.
- Image attachments are forwarded to the Copilot SDK as multimodal attachments
  (`file` when a disk path is available, otherwise inline `blob`).
- Non-image uploads continue to be exposed as file references.

### Chat file reference tokens

- The web explorer/file preview can copy references as backticked tokens:
  - ``@file:<path>``
  - ``@folder:<path>``
- Folder tokens use the full folder path.
- File tokens use the full file path shown by the preview/browser context.
- Tokens are root-agnostic: workspace paths are repo-relative, drive paths keep `C:/...` form.

### Reference-driven inspection helper

- Messages containing `@file:` tokens are parsed server-side before queueing.
- Text/markdown references stay as plain references (no binary payload attached).
- Small image references (up to ~1 MB) are attached to the pending turn so vision-capable
  models receive real image input.
- Oversized image references are left as plain text references to avoid oversized request payloads.

### Workspace file bridge

- Use `/api/files/<repo-relative-path>` to open workspace files in a new tab. The browser sends the auth cookie automatically.
- Use `/api/files-preview/<repo-relative-path>` for structured preview JSON (`kind`, `language`, `content`, `truncated`, `size`).
- Use `/api/repo/tree?includeHidden=0&includeHeavy=0` for a full tree snapshot (toggleable hidden/heavy paths).
- Use `/api/drives/roots` + `/api/drives/list?path=<drive-path>&includeHidden=0|1` for lazy-loaded drive browsing (separate from workspace heavy mode).
- Use `/api/drives/file?path=<drive-path>` and `/api/drives/files-preview?path=<drive-path>` for drive file raw/preview access.
- Requests are auth-protected and restricted to files inside the workspace root.
- Drive browsing is auth-protected and restricted to local fixed/removable roots discovered on the host.
- Traversal or non-file paths are rejected.
- The web UI opens workspace mentions in an in-app preview dialog with **Preview / Raw** mode buttons.
- Markdown preview supports optional embedded-HTML mode with script/event-handler stripping and a visible warning.
- The floating **📁 Browse files** button opens the explorer with **Workspace** and **Drives** roots, tree navigation, list/icon folder views, and image thumbnails.

## Relay Tool Guidance

The CLI extension (`.github/extensions/web-relay/extension.mjs`) loads `relay-tools.md`
for shared tool guidance.

The browser UI keeps the usage button in the sidebar header, and that button continues to
call `/api/usage` directly.

## Config (`config.json`)

```json
{
  "authToken": "<your-token>",
  "port": 3333,
  "localhostOnly": true,
  "pollIntervalMs": 3000,
  "processingTimeoutMs": 600000,
  "conversationSessionMode": "isolated",
  "sshTunnel": {
    "enabled": false,
    "remoteBind": "loopback",
    "user": "ubuntu",
    "host": "relay.example.com",
    "remotePort": 4444,
    "identityFile": "~/.ssh/id_rsa"
  }
}
```

| Key | Default | Description |
|---|---|---|
| `authToken` | *(required)* | Token for all API / UI access |
| `port` | `3333` | HTTP/WebSocket listen port |
| `localhostOnly` | `true` | Bind only to loopback (`127.0.0.1`) and block LAN/WAN access |
| `pollIntervalMs` | `3000` | CLI poll interval (ms) |
| `processingTimeoutMs` | `600000` | Max response wait time (ms) |
| `conversationSessionMode` | `isolated` | SDK session strategy (`isolated` or `shared`) |
| `restartGracefulTimeoutMs` | `8000` | Graceful shutdown wait before force fallback |
| `restartShutdownTimeoutMs` | `45000` | Drain timeout while waiting for active queue jobs |
| `restartSpawnTimeoutMs` | `18000` | Max wait for resume process to leave online state |
| `restartRebindTimeoutMs` | `20000` | Max wait for session-sync rebind confirmation |
| `restartMaxAttempts` | `3` | Max restart attempts before terminal exhaustion |
| `restartRetryBackoffMs` | `[1000,3000,7000]` | Deterministic retry backoff schedule |
| `sshTunnel.enabled` | `false` | Start reverse tunnel on server boot |
| `sshTunnel.remoteBind` | `loopback` | Remote bind mode for SSH `-R` (`loopback` or `public`) |
| `sshTunnel.user` | — | SSH user on VPS |
| `sshTunnel.host` | — | VPS hostname / IP |
| `sshTunnel.remotePort` | — | Port opened on the VPS |
| `sshTunnel.identityFile` | *(optional)* | SSH private key path (`~` expanded); uses ssh-agent if omitted |

## SSH Reverse Tunnel

When `sshTunnel.enabled` is `true`, `server.js` spawns:

```
ssh -N -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
  -o StrictHostKeyChecking=accept-new -o BatchMode=yes \
  -o ExitOnForwardFailure=yes \
  -R <remoteSpec> <user>@<host>
```

`sshTunnel.remoteBind` controls `<remoteSpec>`:
- `loopback` => `<remotePort>:127.0.0.1:<port>` (loopback bind, best with Caddy `reverse_proxy localhost:<remotePort>`)
- `public` => `*:<remotePort>:127.0.0.1:<port>`
`ExitOnForwardFailure=yes` ensures the tunnel process exits immediately if remote port forwarding fails, allowing clean auto-retry instead of a false "connected" state.

**Auto-reconnect** — if the tunnel exits for any reason it is rescheduled with
exponential backoff (5 s → 10 s → 20 s → 40 s → 60 s cap, no retry limit).
The counter resets after a connection is stable for >30 s.

**Caddy VPS config:**

```
relay.example.com {
    reverse_proxy localhost:4444
}
```

**`/api/status`** now includes:

```json
"sshTunnel": {
  "enabled": true,
  "connected": true,
  "host": "relay.example.com",
  "remotePort": 4444,
  "remoteBindMode": "loopback",
  "reconnectAttempts": 0,
  "connectedSince": "2026-05-18T01:00:00.000Z"
}
```

`restartOrchestrator` in `/api/status` and `/api/restart-orchestrator` now exposes
attempt/retry/timeout fields (`attempts`, `maxAttempts`, `retryAt`, `retryBackoffMs`,
`spawnDeadlineAt`, `rebindDeadlineAt`) plus terminal outcomes
(`terminalOutcomeCode`, `terminalOutcomeMessage`, `terminalOutcomeAttempts`).
Failure classes are deterministic: transient timeouts (`spawn-timeout`, `rebind-timeout`)
retry with bounded backoff; session mismatch conflicts (`transaction-mismatch`, `target-mismatch`)
are terminal and stop retrying.  
`POST /api/session-sync` accepts optional orchestrator correlation/target/rebind fields:
`orchestrator_correlation_id`, `orchestrator_target_session_id`, and `rebind_completed`
(or `rebind_state=completed`). Rebind mismatches return `409` with `retryable`/`terminal`.
The extension dequeue/send path treats this restart-orchestrator flow as authoritative and
does not attempt in-process runtime session switch calls.



## Files

| File | Description |
|------|-------------|
| `server.js` | Main server |
| `public/index.html` | Web chat UI |
| `config.json` | Auth token and settings (gitignored) |
| `data/copilot.db` | Persisted conversations and queue storage (gitignored) |
| `relay-tools.md` | Markdown tool guidance loaded by the relay extension |
