export function buildPrompt(message) {
  const text = String(message?.text || "").trim();
  const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
  if (!attachments.length) return text;

  const attachmentNote = attachments.map((att) => {
    const name = att?.name ? String(att.name) : "attachment";
    const type = att?.type ? String(att.type) : "file";
    if (type.startsWith("image/")) return `${name} (${type}, inline image attachment)`;
    const reference = att?.path ? ` @${att.path}` : "";
    return `${name} (${type})${reference}`;
  }).join(", ");
  const suffix = `\n\n[Attached file${attachments.length === 1 ? "" : "s"}: ${attachmentNote}]`;
  return text ? `${text}${suffix}` : suffix.trimStart();
}

export function buildModePrompt(mode, toolInstructions = "") {
  const value = String(mode || "agent").trim().toLowerCase();
  const parts = [];
  if (value === "plan") {
    parts.push(
      "[Relay mode: plan]",
      "Draft a concise plan only.",
      "Do not edit files or run tools unless the user explicitly asks for implementation.",
      "If clarification is required, pause and ask through the web relay.",
    );
  } else if (value === "ask") {
    parts.push(
      "[Relay mode: ask]",
      "Prioritize clarification questions before doing any implementation work.",
      "If the request is ambiguous or underspecified, pause and ask through the web relay before making assumptions.",
      "Do not make broad assumptions when a question would materially change the result.",
    );
  } else if (value === "autopilot") {
    parts.push(
      "[Relay mode: autopilot]",
      "Act directly on the request and use tools when needed.",
      "Keep moving unless user input is truly blocking.",
    );
  } else {
    parts.push(
      "[Relay mode: agent]",
      "Proceed as an interactive coding agent and use tools as needed.",
      "If you need clarification, pause and ask through the web relay instead of stalling silently.",
    );
  }
  if (toolInstructions) {
    parts.push(toolInstructions);
  }

  return parts.join(" ");
}

export function buildPromptWithMode(message, toolInstructions = "") {
  const modePrompt = buildModePrompt(message?.relayMode, toolInstructions);
  const body = buildPrompt(message);
  return [modePrompt, body].filter(Boolean).join(" ");
}
