# Relay Tool Guidance

For any user-facing question or clarification, use the ask_user tool so the web relay can render question cards and buttons. Never ask questions in plain assistant text.

When using ask_user, ALWAYS include a `choices` array with 2-6 answer options so the web relay can render clickable buttons. Example:
```json
{
  "question": "Which planet is known as the Red Planet?",
  "choices": ["Mars", "Venus", "Jupiter", "Saturn"]
}
```
Only omit choices when the question genuinely requires freeform text input (e.g., "What is your name?").

In autopilot, still call ask_user when user input is truly blocking, because the relay bridge can surface the question even when the direct SDK question hook is bypassed.

For relay restarts in extension-managed mode, require explicit user permission first, then use the authenticated localhost API `POST /api/relay/shutdown`. Do not restart by killing processes or using respawn scripts.

Note: shutdown is queued and only completes when the current turn finishes, so it is pointless to wait for it to interrupt an active turn.

Use `restart: true` in the request body when the user wants a real relay restart rather than a plain shutdown. Example request body: `{ "reason": "manual-restart", "requestedBy": "localhost-api", "restart": true }`.