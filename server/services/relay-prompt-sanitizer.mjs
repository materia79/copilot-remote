'use strict';

const RELAY_TOOL_GUIDANCE = [
  '# Relay Tool Guidance',
  'For any user-facing question or clarification, use the ask_user tool so the web relay can render question cards and buttons. Never ask questions in plain assistant text.',
  'In autopilot, still call ask_user when user input is truly blocking, because the relay bridge can surface the question even when the direct SDK question hook is bypassed.',
].join(' ');

const MODE_PREFIXES = {
  plan: [
    '[Relay mode: plan]',
    'Draft a concise plan only.',
    'Do not edit files or run tools unless the user explicitly asks for implementation.',
    'If clarification is required, pause and ask through the web relay.',
  ].join(' '),
  ask: [
    '[Relay mode: ask]',
    'Prioritize clarification questions before doing any implementation work.',
    'If the request is ambiguous or underspecified, pause and ask through the web relay before making assumptions.',
    'Do not make broad assumptions when a question would materially change the result.',
  ].join(' '),
  autopilot: [
    '[Relay mode: autopilot]',
    'Act directly on the request and use tools when needed.',
    'Keep moving unless user input is truly blocking.',
  ].join(' '),
  agent: [
    '[Relay mode: agent]',
    'Proceed as an interactive coding agent and use tools as needed.',
    'If you need clarification, pause and ask through the web relay instead of stalling silently.',
  ].join(' '),
};

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function whitespaceFlexiblePattern(value) {
  return String(value || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => escapeRegExp(part))
    .join('\\s+');
}

function buildPromptPrefixPatterns(mode) {
  const requestedMode = String(mode || '').trim().toLowerCase();
  const modes = requestedMode && MODE_PREFIXES[requestedMode]
    ? [requestedMode]
    : Object.keys(MODE_PREFIXES);
  return modes.map((key) => {
    const modePrefix = MODE_PREFIXES[key];
    return new RegExp(`^${whitespaceFlexiblePattern(`${modePrefix} ${RELAY_TOOL_GUIDANCE}`)}\\s*`, 'i');
  });
}

export function stripRelayPromptContext(text, relayMode = '', attachments = []) {
  const value = String(text || '').trim();
  if (!value) return '';
  const patterns = buildPromptPrefixPatterns(relayMode);
  for (const pattern of patterns) {
    const stripped = value.replace(pattern, '').trim();
    if (stripped && stripped !== value) return stripped;
  }
  return value;
}
