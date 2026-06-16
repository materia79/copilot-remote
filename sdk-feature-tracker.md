# Copilot SDK Feature Tracker (relay/app)

Updated: 2026-06-16
Scope: `server/` + `.github/extensions/web-relay/`

Status legend: **Implemented** | **Partial** | **Not implemented**

## Session + lifecycle


| SDK feature                                                                    | Status          | Notes / evidence                                                                                                                                                                                           |
| ------------------------------------------------------------------------------ | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `joinSession()` (extension mode)                                               | Implemented     | Extension joins foreground CLI session via SDK extension API (`.github/extensions/web-relay/extension.mjs:836-890`; SDK `extension.d.ts:21`).                                                              |
| `CopilotClient.createSession()` (standalone mode)                              | Implemented     | Standalone relay creates SDK sessions (`server/relay.mjs:552-571`; SDK `client.d.ts:221`).                                                                                                                 |
| `CopilotClient.resumeSession()`                                                | Not implemented | No runtime path currently resumes previous SDK session IDs via SDK API.                                                                                                                                    |
| `CopilotClient.listSessions()` / `getSessionMetadata()` / `getLastSessionId()` | Not implemented | Not used in relay or extension paths.                                                                                                                                                                      |
| `CopilotClient.deleteSession()`                                                | Partial         | Implemented where available for cleanup/deletion flows, guarded for runtime support (`.github/extensions/web-relay/polling/polling-loop.mjs:542-544`, `server/services/delete-archive-service.mjs:12-23`). |
| `session.disconnect()`                                                         | Not implemented | No explicit disconnect lifecycle wired.                                                                                                                                                                    |
| `session.abort()`                                                              | Implemented     | User stop control aborts active turn (`.github/extensions/web-relay/polling/polling-loop.mjs:575-590`; SDK `session.d.ts:248`).                                                                            |


## Turn execution + streaming


| SDK feature                                | Status          | Notes / evidence                                                                                                                                                                                       |
| ------------------------------------------ | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `session.send()` / `session.sendAndWait()` | Implemented     | Core turn flow uses send+sendAndWait wrappers (`.github/extensions/web-relay/runtime/session-io.mjs:115-133`, `.github/extensions/web-relay/polling/polling-loop.mjs:888`; SDK `session.d.ts:99-125`). |
| Message attachments (file/blob/etc.)       | Implemented     | Relay maps and sends SDK attachments in payload (`.github/extensions/web-relay/polling/polling-loop.mjs:714-723`; SDK `types.d.ts:1480-1510`).                                                         |
| Per-turn reasoning effort                  | Implemented     | Relay forwards `reasoningEffort` when provided (`.github/extensions/web-relay/polling/polling-loop.mjs:716-718`).                                                                                      |
| Streaming event mode (`streaming: true`)   | Implemented     | Enabled on join; deltas consumed (`.github/extensions/web-relay/extension.mjs:845`, `.github/extensions/web-relay/skills/reasoning-stream.mjs:212-216`; SDK `types.d.ts:1270-1277`).                   |
| `session.getEvents()`                      | Not implemented | Not used in runtime flows.                                                                                                                                                                             |


## User input + elicitation


| SDK feature                                                        | Status          | Notes / evidence                                                                                                                                                                                                         |
| ------------------------------------------------------------------ | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `onUserInputRequest` (ask_user text/choices)                       | Implemented     | Bridged to relay question cards (`.github/extensions/web-relay/extension.mjs:849-852`, `.github/extensions/web-relay/skills/question-routing-hooks.mjs:246-304`; SDK `types.d.ts:685-718`).                              |
| `onElicitationRequest` (structured forms)                          | Implemented     | Multi-field structured forms handled and validated (`.github/extensions/web-relay/extension.mjs:856-859`, `.github/extensions/web-relay/skills/question-routing-hooks.mjs:338-424`; SDK `types.d.ts:479-516,1244-1248`). |
| Session UI helpers (`session.ui.confirm/select/input/elicitation`) | Not implemented | Relay uses callback bridge instead of direct session UI API (`SDK session.d.ts:69-80`).                                                                                                                                  |
| `onExitPlanModeRequest`                                            | Not implemented | No top-level registration in join/create configs.                                                                                                                                                                        |
| `onAutoModeSwitchRequest`                                          | Not implemented | No top-level registration in join/create configs.                                                                                                                                                                        |


## Hooks + permissions


| SDK feature                                                                              | Status          | Notes / evidence                                                                                                                                                                    |
| ---------------------------------------------------------------------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hooks.onPreToolUse`                                                                     | Implemented     | Used for activity routing and ask_user pre-bridge (`.github/extensions/web-relay/extension.mjs:881-883`, `.github/extensions/web-relay/skills/question-routing-hooks.mjs:187-244`). |
| `hooks.onSessionStart` / `hooks.onSessionEnd`                                            | Implemented     | Relay activation + graceful shutdown (`.github/extensions/web-relay/extension.mjs:861-887`).                                                                                        |
| `hooks.onPostToolUse` / `onPreMcpToolCall` / `onUserPromptSubmitted` / `onErrorOccurred` | Not implemented | Not registered in join options (SDK hook types at `types.d.ts:940-969`).                                                                                                            |
| `onPermissionRequest`                                                                    | Partial         | Standalone relay sets `approveAll`; extension-join path does not set custom permission handler (`server/relay.mjs:562`; SDK `types.d.ts:1233-1238`).                                |


## Models + model APIs


| SDK feature                 | Status          | Notes / evidence                                                                                                                                           |
| --------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model switch per turn       | Implemented     | Relay switches requested model via session RPC model APIs (`.github/extensions/web-relay/extension.mjs` model service wiring; `server/relay.mjs:691-729`). |
| `session.setModel()` helper | Not implemented | Current implementation uses RPC-level model methods, not `session.setModel(...)` directly (SDK `session.d.ts:262-265`).                                    |
| `client.listModels()`       | Not implemented | Runtime model discovery is done through session RPC model endpoints in relay flow, not `client.listModels()`.                                              |


## Advanced session configuration


| SDK feature                                                      | Status          | Notes / evidence                                                    |
| ---------------------------------------------------------------- | --------------- | ------------------------------------------------------------------- |
| `requestCanvasRenderer` / canvas APIs                            | Not implemented | No canvas renderer opt-in or canvas API wiring.                     |
| `requestExtensions` / slash `commands`                           | Not implemented | No SDK session config for extension surface commands in relay path. |
| Tool filters (`availableTools` / `excludedTools`)                | Not implemented | Not configured in current session creation/join options.            |
| `mcpServers` session config                                      | Not implemented | No custom MCP server config set by relay runtime.                   |
| `customAgents` / `defaultAgent` / startup `agent`                | Not implemented | Not configured by relay runtime.                                    |
| `skillDirectories` / `instructionDirectories` / `disabledSkills` | Not implemented | Not configured by relay runtime.                                    |
| `provider` (BYOK)                                                | Not implemented | No BYOK provider session config in relay path.                      |
| `remoteSession` mode (`off/export/on`)                           | Not implemented | Not configured by relay runtime.                                    |
| `cloud` session creation options                                 | Not implemented | No `cloud` create-session usage.                                    |
| `infiniteSessions` tuning                                        | Not implemented | No explicit tuning/override configured by relay runtime.            |


## Client/runtime integration


| SDK feature                                            | Status          | Notes / evidence                                                                                                                                        |
| ------------------------------------------------------ | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime connection modes                               | Implemented     | Standalone supports hidden stdio and foreground TCP connection handling (`server/relay.mjs:507-541`; SDK runtime connection types `types.d.ts:57-130`). |
| Telemetry config / trace-context provider              | Not implemented | No relay wiring for `telemetry` / `onGetTraceContext` options.                                                                                          |
| Session filesystem provider (`sessionFs`)              | Not implemented | No custom session FS provider registered.                                                                                                               |
| Session lifecycle subscriptions (`client.onLifecycle`) | Not implemented | Not used in relay runtime.                                                                                                                              |
| TUI foreground control (`get/setForegroundSessionId`)  | Not implemented | Not used in relay runtime.                                                                                                                              |


## Conversation control gaps (important)


| Capability                          | Status                    | Notes                                                                                   |
| ----------------------------------- | ------------------------- | --------------------------------------------------------------------------------------- |
| Native SDK chat fork at message X   | Not implemented (SDK gap) | No public primitive currently wired for true server-side branch/fork semantics.         |
| Native SDK rewind-to-arbitrary-turn | Not implemented (SDK gap) | No public API currently wired for arbitrary rewind; CLI exposes last-turn `/rewind` UX. |


