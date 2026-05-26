# Copilot Relay Operating Instructions

When changing anything related to the web relay (`server/` or `.github/extensions/web-relay/`):

1. Use a **single runtime owner**. Do not mix extension-managed mode with standalone relay mode.
   - **Extension-managed (default):** let `.github/extensions/web-relay/extension.mjs` own server supervision and polling/heartbeat.
   - **Standalone dev mode:** `npm start` (starts `server.js` + `relay.mjs`) only when you intentionally are not relying on extension polling.
   - Never run `npm start`, `node server/relay.mjs`, and extension polling together.
   - Never kill or restart the node process bound to port `3333` unless the user explicitly gives permission to restart the web relay.
2. Before any restart, stop stale relay/watchdog processes from earlier runs (especially detached shells) so only one web relay remains bound to `:3333`.
   3. For extension-managed mode, only restart the web relay after explicit user permission. Manual restarts must use the authenticated localhost API (`POST /api/relay/shutdown`); do not use direct process kills or respawn scripts.
      - Include `restart: true` in the request body for an intentional self-restart; omit it for a plain shutdown.
      - Preferred restart request body: `{ "reason": "manual-restart", "requestedBy": "localhost-api", "restart": true }`.
      - `POST /api/relay/shutdown` is queued and only actually exits once the current turn is idle, so do not wait for it to "interrupt" an in-flight turn.
4. Keep the main Copilot CLI session running so extension polling can continue.
5. Verify relay health after changes:
   - `GET /api/status` reports `cliOnline: true`
   - Queue is draining (`pendingCount`/`processingCount` moving or zero)
   - Exactly one listener owns port `3333`
6. Check logs for startup and processing errors:
   - Relay/server logs from `server.js`
   - Extension debug log: `server/logs/ext-debug.log`
7. If the CLI asks a clarification question, answer it in the web relay question card UI element (displayed in the relay dashboard) instead of auto-answering in code. If no clarification question appears, proceed with the next step.
8. Per-message execution mode now lives in the browser composer (`plan` / `ask` / `agent` / `autopilot`) and is stored with each queued turn.
9. When a turn needs user input, always use `ask_user` rather than asking inline text.
10. In `autopilot`, still use `ask_user` for clarification; the relay bridge will capture it and show a web question card even if the direct SDK question hook is bypassed.
11. Do not spawn Copilot CLI client instances for tests or debugging without explicit user permission; ask first if a test would launch one.
12. When tracing a stuck or missing message, follow this exact sequence to locate where it stopped:
   - Collect identifiers first: `conversation_id`, approximate timestamp, and message text (or `message_id` if available).
   - Trace server flow in `server/logs/server.log` for that conversation:
     - `QUEUED` (accepted by relay)
     - `DEQUEUED` (picked for execution)
     - `RESPONSE` (completed)
   - Trace extension flow in `server/logs/ext-debug.log` for same window:
     - `session.send: queuing for msgId ...`
     - `session.sendAndWait: completed ...` (or failure/retry signals)
   - Check DB queue truth in `server/data/copilot.db` (`queue` table) for the specific row status (`pending`/`processing`/`done`) and ownership (`owner_sdk_session_id`, `runtime_session_id`).
   - Check live runtime snapshot via authenticated `GET /api/status`:
     - `sessionWorker.workers[]` entry for the target `sdkSessionId`
     - `activeBridgeOwner`
     - queue counters (`pendingCount`, `processingCount`)
   - Validate worker PID reality: if status says `ready/processing` but the worker PID is not running, treat as stale worker registration.
    - Conclude with a one-line stop point: **accepted but not dequeued**, **dequeued but no response**, or **response emitted but UI missed update**.

Do not consider relay-related work complete until restart + status + log checks pass.

## Git Commit Policy

- **Never commit on `main` without explicit user instruction.** The user decides when changes are committed to main.
- On feature branches, only commit autonomously during a large, multi-step implementation where it is clearly expected as part of the work.
- When in doubt, always ask before committing.
- Never push without explicit user instruction.
