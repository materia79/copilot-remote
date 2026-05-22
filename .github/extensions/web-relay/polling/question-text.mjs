function stripMarkdown(text) {
  return String(text || "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/^\s*>+\s?/gm, "")
    .trim();
}

function isFenceLine(line) {
  const trimmed = String(line || "").trim();
  return /^```/.test(trimmed) || /^~~~/.test(trimmed);
}

function isCodeLikeLine(line) {
  const value = String(line || "").trim();
  if (!value) return true;
  if (/^(const|let|var|function|class|import|export|return|if|for|while|switch)\b/i.test(value)) return true;
  if (/[{};]/.test(value)) return true;
  if (/=>|\?\.\s*|::/.test(value)) return true;
  return false;
}

function isLikelyQuestionPromptLine(line) {
  const value = stripMarkdown(line);
  if (!value || isCodeLikeLine(value)) return false;
  if (!/\?\s*$/.test(value)) return false;
  return /^(what|which|when|where|who|whom|whose|why|how|should|would|could|can|do|does|did|is|are|am|will|may|might|shall)\b/i.test(value)
    || /^(what|which|when|where|who|whom|whose|why|how)['’]s\b/i.test(value)
    || /^(can|could|would|will|do|does|did|is|are|am|should|shall)\s+you\b/i.test(value)
    || /^the\s.+question[:]?$/i.test(value)
    || /^question[:]?$/i.test(value);
}

export function parseQuestionFromText(text) {
  const rawLines = String(text || "").split(/\r?\n/);
  const visibleLines = [];
  let inFence = false;

  for (const rawLine of rawLines) {
    const trimmed = String(rawLine || "").trim();
    if (isFenceLine(trimmed)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const line = stripMarkdown(rawLine);
    if (line) visibleLines.push(line);
  }

  let promptIndex = visibleLines.findIndex((line) => isLikelyQuestionPromptLine(line));
  let prompt = promptIndex >= 0 ? visibleLines[promptIndex] : "";
  if (!prompt) {
    const explicitIndex = visibleLines.findIndex((line) => /^the\s.+question[:]?$/i.test(line) || /^question[:]?$/i.test(line));
    if (explicitIndex >= 0) {
      promptIndex = explicitIndex;
      prompt = visibleLines[explicitIndex];
    }
  }

  const choices = [];
  if (promptIndex >= 0) {
    for (const line of visibleLines.slice(promptIndex + 1)) {
      const numbered = line.match(/^\s*(?:\d+[\.\)]|[a-dA-D][\.\)]|[-*])\s+(.+)$/);
      if (!numbered) continue;
      const choice = stripMarkdown(numbered[1]);
      if (!choice || isCodeLikeLine(choice)) continue;
      choices.push(choice);
      if (choices.length >= 8) break;
    }
  }

  return {
    prompt: stripMarkdown(prompt),
    choices,
  };
}

export function shouldForceFallbackQuestionBridge(assistantText) {
  const parsed = parseQuestionFromText(assistantText);
  const hasQuestionPrompt = /\?\s*$/.test(String(parsed?.prompt || "")) || /^question[:]?$/i.test(String(parsed?.prompt || ""));
  const hasChoices = Array.isArray(parsed?.choices) && parsed.choices.length >= 2;
  if (!hasQuestionPrompt || !hasChoices) return { shouldForce: false, parsed: null };
  return { shouldForce: true, parsed };
}
