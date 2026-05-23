'use strict';

const RELAY_TOOL_GUIDANCE = [
  '# Relay Tool Guidance',
  'For any user-facing question or clarification, use the ask_user tool so the web relay can render question cards and buttons. Never ask questions in plain assistant text.',
  'In autopilot, still call ask_user when user input is truly blocking, because the relay bridge can surface the question even when the direct SDK question hook is bypassed.',
].join(' ');

const MODE_MARKERS = {
  plan: '[Relay mode: plan]',
  ask: '[Relay mode: ask]',
  autopilot: '[Relay mode: autopilot]',
  agent: '[Relay mode: agent]',
};

const MODE_INSTRUCTIONS = {
  plan: [
    'Draft a concise plan only.',
    'Do not edit files or run tools unless the user explicitly asks for implementation.',
    'If clarification is required, pause and ask through the web relay.',
    'These instructions remain in effect until relay mode changes.',
  ].join(' '),
  ask: [
    'Prioritize clarification questions before doing any implementation work.',
    'If the request is ambiguous or underspecified, pause and ask through the web relay before making assumptions.',
    'Do not make broad assumptions when a question would materially change the result.',
    'These instructions remain in effect until relay mode changes.',
  ].join(' '),
  autopilot: [
    'Act directly on the request and use tools when needed.',
    'Keep moving unless user input is truly blocking.',
    'These instructions remain in effect until relay mode changes.',
  ].join(' '),
  agent: [
    'Proceed as an interactive coding agent and use tools as needed.',
    'If you need clarification, pause and ask through the web relay instead of stalling silently.',
    'These instructions remain in effect until relay mode changes.',
  ].join(' '),
};

const LEGACY_MODE_INSTRUCTIONS = {
  plan: [
    'Draft a concise plan only.',
    'Do not edit files or run tools unless the user explicitly asks for implementation.',
    'If clarification is required, pause and ask through the web relay.',
  ].join(' '),
  ask: [
    'Prioritize clarification questions before doing any implementation work.',
    'If the request is ambiguous or underspecified, pause and ask through the web relay before making assumptions.',
    'Do not make broad assumptions when a question would materially change the result.',
  ].join(' '),
  autopilot: [
    'Act directly on the request and use tools when needed.',
    'Keep moving unless user input is truly blocking.',
  ].join(' '),
  agent: [
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
  const modes = requestedMode && MODE_MARKERS[requestedMode]
    ? [requestedMode]
    : Object.keys(MODE_MARKERS);
  return modes.flatMap((key) => {
    const marker = MODE_MARKERS[key];
    const currentFullPrefix = `${marker} ${MODE_INSTRUCTIONS[key]} ${RELAY_TOOL_GUIDANCE}`;
    const legacyFullPrefix = `${marker} ${LEGACY_MODE_INSTRUCTIONS[key]} ${RELAY_TOOL_GUIDANCE}`;
    return [
      new RegExp(`^${whitespaceFlexiblePattern(currentFullPrefix)}\\s*`, 'i'),
      new RegExp(`^${whitespaceFlexiblePattern(legacyFullPrefix)}\\s*`, 'i'),
      new RegExp(`^${whitespaceFlexiblePattern(marker)}\\s*`, 'i'),
    ];
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
