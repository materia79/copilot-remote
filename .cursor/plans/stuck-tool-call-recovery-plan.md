# Stuck Tool-Call Recovery Plan

## Goal
Prevent SDK sessions from getting poisoned by missing tool outputs (`No tool output found for function call ...`) and eliminate requeue/respawn churn.

## 1. Pending tool-call tracking
- Add a relay-side `pending_tool_calls` store keyed by:
  - `sdkSessionId`
  - `callId`
  - `messageId`
- Mark rows on tool start and clear on tool completion.

## 2. Safe shutdown/teardown rules
- Do not tear down a worker/session while a turn has open pending tool calls.
- Allow shutdown only when pending tool calls are empty, unless forced recovery is active.

## 3. Dangling tool-call watchdog
- Add timeout checks for open tool calls (e.g., 60-120s).
- If timed out:
  - mark the tool call as timed out
  - fail the turn once with an explicit error response
  - avoid requeue loops

## 4. Poisoned-session containment
- On `No tool output found for function call <callId>`:
  - persist the stuck `callId`
  - mark session as `poisoned` and read-only/quarantined
  - stop retrying that session/turn in a loop
  - rotate new turns to a fresh SDK session
- Surface a clear relay error message (include exact error text; render in a code block in UI when possible).
- Do not auto-compact poisoned sessions as a recovery step.

## 5. Ask-user continuity hardening
- Persist ask-user question ownership and routing context.
- Enforce strict answer correlation to expected session/call context.
- Treat mismatches as explicit errors with visible diagnostics.

## 6. Operator visibility
- Extend `/api/status` with:
  - pending tool-call count
  - oldest pending age
  - poisoned session list
  - last stuck `callId`
- Add manual recovery endpoint/action for session quarantine/reset.
- Add status fields for `readOnly`/`quarantined` session state.

## 7. Regression coverage
- Add tests for:
  - tool start without completion
  - session end during open tool calls
  - repeated missing-tool-output errors
- Assert:
  - no infinite requeue churn
  - no duplicate worker storm
  - automatic session rotation/recovery works
  - poisoned sessions reject new writes and route new turns to fresh sessions

## 8. Compact and manual-recovery constraints
- `/compact` can fail on poisoned sessions with the same missing-tool-output error.
- Treat poisoned sessions as non-recoverable for compaction in normal flow.
- Recovery strategy should be: quarantine + start fresh session, not compact-in-place migration.

## 9. Operational prevention rule
- Avoid killing/restarting CLI processes while tool calls are in progress.
- Add a guard warning in operator docs/UI when shutdown is requested during active tool execution.

## Expected outcome
Turns either complete normally or fail once with clear diagnostics; sessions no longer remain permanently stuck after missing tool outputs.
