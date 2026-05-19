# Relay Tool Guidance

For any user-facing question or clarification, use the ask_user tool so the web relay can render question cards and buttons. Never ask questions in plain assistant text.

In autopilot, still call ask_user when user input is truly blocking, because the relay bridge can surface the question even when the direct SDK question hook is bypassed.