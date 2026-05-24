function collectTextCandidates(value, out) {
  if (!value) return;
  if (typeof value === "string") {
    const text = value.trim();
    if (text) out.push(text);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectTextCandidates(item, out);
    return;
  }
  if (typeof value === "object") {
    collectTextCandidates(value.text, out);
    collectTextCandidates(value.content, out);
    collectTextCandidates(value.output_text, out);
    collectTextCandidates(value.outputText, out);
    collectTextCandidates(value.summary, out);
    collectTextCandidates(value.message, out);
    collectTextCandidates(value.result, out);
    collectTextCandidates(value.response, out);
    collectTextCandidates(value.output, out);
    collectTextCandidates(value.answer, out);
    collectTextCandidates(value.finalText, out);
    collectTextCandidates(value.final_text, out);
  }
}

/**
 * Deep-scans a response envelope for a specific named tool call and returns
 * a field from its input. Used to extract task_complete({ summary }) when
 * the agent closes via tool call instead of plain text.
 */
function extractToolCallInput(value, toolName, field, depth = 0) {
  if (!value || typeof value !== "object" || depth > 12) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractToolCallInput(item, toolName, field, depth + 1);
      if (found) return found;
    }
    return null;
  }
  // Check if this node IS the target tool call
  const name = value.name || value.tool || value.function_name || value.toolName || value.tool_name;
  if (name === toolName) {
    const input = value.input || value.arguments || value.params || value.args || {};
    if (input && typeof input === "object") {
      const text = input[field];
      if (text && typeof text === "string" && text.trim()) return text.trim();
    }
    // Also try string-encoded JSON arguments
    if (typeof value.arguments === "string") {
      try {
        const parsed = JSON.parse(value.arguments);
        if (parsed && typeof parsed[field] === "string" && parsed[field].trim()) return parsed[field].trim();
      } catch { /* ignore */ }
    }
  }
  // Recurse into known envelope container keys only (avoids traversing arbitrary tool inputs)
  const CONTAINER_KEYS = ["data", "output", "content", "tool_calls", "toolRequests",
                          "calls", "items", "results", "steps", "turns", "messages", "events"];
  for (const key of CONTAINER_KEYS) {
    const child = value[key];
    if (child !== undefined && child !== null) {
      const found = extractToolCallInput(child, toolName, field, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function extractFinalText(finalEvent, _dbg) {
  // task_complete({ summary }) is the agent's explicit closing message — highest priority.
  const taskSummary = extractToolCallInput(finalEvent, "task_complete", "summary");
  if (taskSummary) return taskSummary;

  const candidates = [];
  collectTextCandidates(finalEvent?.data?.content, candidates);
  collectTextCandidates(finalEvent?.data?.text, candidates);
  collectTextCandidates(finalEvent?.data?.output_text, candidates);
  collectTextCandidates(finalEvent?.data?.outputText, candidates);
  collectTextCandidates(finalEvent?.data?.summary, candidates);
  collectTextCandidates(finalEvent?.data?.message, candidates);
  collectTextCandidates(finalEvent?.data?.result, candidates);
  collectTextCandidates(finalEvent?.data?.response, candidates);
  collectTextCandidates(finalEvent?.data?.output, candidates);
  collectTextCandidates(finalEvent?.data?.answer, candidates);
  collectTextCandidates(finalEvent?.data?.finalText, candidates);
  collectTextCandidates(finalEvent?.data?.final_text, candidates);
  collectTextCandidates(finalEvent?.content, candidates);
  collectTextCandidates(finalEvent?.text, candidates);
  collectTextCandidates(finalEvent?.output_text, candidates);
  collectTextCandidates(finalEvent?.outputText, candidates);
  collectTextCandidates(finalEvent?.summary, candidates);
  collectTextCandidates(finalEvent?.message, candidates);
  collectTextCandidates(finalEvent?.result, candidates);
  collectTextCandidates(finalEvent?.response, candidates);
  collectTextCandidates(finalEvent?.output, candidates);
  collectTextCandidates(finalEvent?.answer, candidates);
  collectTextCandidates(finalEvent?.finalText, candidates);
  collectTextCandidates(finalEvent?.final_text, candidates);
  return candidates.find((value) => typeof value === "string" && value.trim()) || "";
}

export function createSessionIoHelpers({ getSession, sleep, dbg = () => {} }) {
  const STREAM_WAIT_POLL_MS = 5_000;
  const WAIT_TICK = Symbol("relay-stream-wait-tick");

  function buildRelayStreamTimeoutError(timeoutMs) {
    const error = new Error(`Hard timeout after ${timeoutMs}ms while streaming session.send`);
    error.code = "RELAY_STREAM_TIMEOUT";
    error.stableCode = "relay.stream-timeout";
    return error;
  }

  async function sendAndWaitWithHardTimeout(payload, timeoutMs) {
    return Promise.race([
      getSession().sendAndWait(payload, timeoutMs),
      sleep(timeoutMs + 5_000).then(() => {
        throw new Error(`Hard timeout after ${timeoutMs}ms waiting for sendAndWait`);
      }),
    ]);
  }

  async function sendWithBestEffortStreaming(payload, timeoutMs, onEvent, options = {}) {
    const session = getSession();
    if (!session) throw new Error("No active Copilot session");
    if (typeof session.send !== "function") {
      return sendAndWaitWithHardTimeout(payload, timeoutMs);
    }

    const streamOrResult = await session.send(payload);
    if (streamOrResult && typeof streamOrResult[Symbol.asyncIterator] === "function") {
      const deadline = Date.now() + timeoutMs + 5_000;
      let finalEvent = null;
      const iterator = streamOrResult[Symbol.asyncIterator]();
      const onWaiting = typeof options?.onWaiting === "function" ? options.onWaiting : null;
      const waitPollMs = Math.max(250, Math.min(Number(options?.waitPollMs) || STREAM_WAIT_POLL_MS, 30_000));

      try {
        while (true) {
          const remainingMs = deadline - Date.now();
          if (remainingMs <= 0) {
            throw buildRelayStreamTimeoutError(timeoutMs);
          }

          const nextOrTick = await Promise.race([
            iterator.next(),
            sleep(Math.min(waitPollMs, remainingMs)).then(() => WAIT_TICK),
          ]);

          if (nextOrTick === WAIT_TICK) {
            if (onWaiting) {
              await onWaiting({
                timeoutMs,
                deadline,
                remainingMs: Math.max(0, deadline - Date.now()),
              });
            }
            continue;
          }

          if (nextOrTick?.done) break;
          const event = nextOrTick?.value;
          finalEvent = event;
          if (typeof onEvent === "function") {
            try { await onEvent(event); } catch {}
          }
        }
      } finally {
        if (typeof iterator?.return === "function") {
          try { await iterator.return(); } catch {}
        }
      }
      return finalEvent || {};
    }

    if (typeof onEvent === "function") {
      try { await onEvent(streamOrResult); } catch {}
    }
    return streamOrResult;
  }

  function extractFinalTextWithLogging(finalEvent) {
    const result = extractFinalText(finalEvent, dbg);
    // Always log envelope structure so we can diagnose extraction misses
    try {
      const raw = JSON.stringify(finalEvent);
      dbg("extractFinalText: result=", JSON.stringify(result).slice(0, 120),
          "| envelope keys:", Object.keys(finalEvent || {}).join(","),
          "| raw (first 600):", raw.slice(0, 600));
    } catch {
      dbg("extractFinalText: result=", JSON.stringify(result).slice(0, 120), "| envelope: [unserializable]");
    }
    return result;
  }

  return {
    extractFinalText: extractFinalTextWithLogging,
    sendAndWaitWithHardTimeout,
    sendWithBestEffortStreaming,
  };
}
