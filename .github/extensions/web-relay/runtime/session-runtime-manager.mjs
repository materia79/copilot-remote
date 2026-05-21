function normalizeId(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function readSessionId(candidate) {
  if (!candidate || typeof candidate !== "object") return null;
  return normalizeId(
    candidate.sessionId
    || candidate.sdkSessionId
    || candidate.id
    || candidate?.session?.sessionId
    || candidate?.session?.sdkSessionId
    || candidate?.session?.id,
  );
}

function listCallableNames(target) {
  if (!target || (typeof target !== "object" && typeof target !== "function")) return [];
  const names = new Set();
  let cursor = target;
  let depth = 0;
  while (cursor && depth < 4) {
    for (const name of Object.getOwnPropertyNames(cursor)) {
      if (name === "constructor") continue;
      try {
        if (typeof target[name] === "function") names.add(name);
      } catch {}
    }
    cursor = Object.getPrototypeOf(cursor);
    depth += 1;
  }
  return [...names].sort();
}

async function tryInvocation(candidate, targetSessionId) {
  const attempts = [
    [targetSessionId],
    [{ sessionId: targetSessionId }],
    [{ sdkSessionId: targetSessionId }],
    [{ id: targetSessionId }],
  ];
  for (const args of attempts) {
    try {
      const result = await candidate.fn.apply(candidate.owner, args);
      return { ok: true, result, args };
    } catch (error) {
      candidate.lastError = String(error?.message || error || "unknown error");
    }
  }
  return { ok: false, error: candidate.lastError || "invocation failed" };
}

export function classifySessionSwitchFailure({ errors = [], mismatched = 0, candidateCount = 0 } = {}) {
  const joined = errors.map((value) => String(value || "").toLowerCase()).join(" | ");
  if (!candidateCount) {
    return {
      reason: "switch-api-missing",
      retryable: false,
      message: "SDK runtime does not expose a session switch/resume API.",
    };
  }
  if (mismatched > 0) {
    return {
      reason: "switch-mismatch",
      retryable: true,
      message: "SDK switch call returned without activating the target session.",
    };
  }
  if (/\b(timeout|timed out|econnreset|econnrefused|temporar|busy|try again|unavailable)\b/.test(joined)) {
    return {
      reason: "switch-call-transient-failure",
      retryable: true,
      message: "SDK switch/resume call failed due to a transient runtime error.",
    };
  }
  if (/\b(not found|unknown session|invalid session|no such session|missing session)\b/.test(joined)) {
    return {
      reason: "target-session-invalid",
      retryable: false,
      message: "Conversation is bound to an SDK session that is no longer available.",
    };
  }
  return {
    reason: "switch-call-failed",
    retryable: false,
    message: "SDK runtime rejected session activation for the target session.",
  };
}

export function createSessionRuntimeManager({ dbg, getSession, setSession }) {
  let capabilitiesLoggedFor = "";

  function discoverCapabilities(label = "runtime") {
    const current = getSession?.();
    const sid = readSessionId(current) || "unknown";
    if (!current) {
      dbg("session capability discovery:", label, "no active session object");
      return { sessionId: null, methodNames: [] };
    }
    if (capabilitiesLoggedFor === sid) {
      return { sessionId: sid, methodNames: listCallableNames(current) };
    }
    const methodNames = listCallableNames(current);
    const rpcNames = listCallableNames(current?.rpc || null);
    const rpcSessionNames = listCallableNames(current?.rpc?.session || null);
    dbg("session capability discovery:", label, `sessionId=${sid}`);
    dbg("session methods:", methodNames.join(", ") || "(none)");
    dbg("session.rpc methods:", rpcNames.join(", ") || "(none)");
    dbg("session.rpc.session methods:", rpcSessionNames.join(", ") || "(none)");
    capabilitiesLoggedFor = sid;
    return { sessionId: sid, methodNames, rpcNames, rpcSessionNames };
  }

  async function activateSession(targetSessionId, reason = "unknown") {
    const target = normalizeId(targetSessionId);
    const current = getSession?.();
    const activeBefore = readSessionId(current);

    if (!target) {
      return {
        ok: false,
        reason: "target-session-missing",
        retryable: false,
        message: "No target SDK session id provided",
        activeSessionId: activeBefore,
        targetSessionId: null,
      };
    }
    if (!current) {
      return {
        ok: false,
        reason: "active-session-missing",
        retryable: true,
        message: "No active SDK runtime session available",
        activeSessionId: null,
        targetSessionId: target,
      };
    }
    if (activeBefore === target) {
      return { ok: true, switched: false, activeSessionId: activeBefore, targetSessionId: target };
    }

    const capabilities = discoverCapabilities(`activate:${reason}`);

    const candidates = [
      { name: "session.resumeSession", owner: current, fn: current?.resumeSession },
      { name: "session.switchSession", owner: current, fn: current?.switchSession },
      { name: "session.activateSession", owner: current, fn: current?.activateSession },
      { name: "session.resume", owner: current, fn: current?.resume },
      { name: "session.switchToSession", owner: current, fn: current?.switchToSession },
      { name: "session.rpc.session.resume", owner: current?.rpc?.session, fn: current?.rpc?.session?.resume },
      { name: "session.rpc.session.switchTo", owner: current?.rpc?.session, fn: current?.rpc?.session?.switchTo },
      { name: "session.rpc.session.activate", owner: current?.rpc?.session, fn: current?.rpc?.session?.activate },
    ].filter((entry) => typeof entry.fn === "function" && entry.owner);
    dbg(
      "session switch candidate APIs:",
      candidates.length ? candidates.map((entry) => entry.name).join(", ") : "(none)",
      `active=${activeBefore || "unknown"}`,
      `target=${target}`,
      `reason=${reason}`,
    );
    const invocationErrors = [];
    let mismatchedAttempts = 0;

    for (const candidate of candidates) {
      const attempt = await tryInvocation(candidate, target);
      if (!attempt.ok) {
        dbg("session switch attempt failed:", candidate.name, attempt.error || "unknown");
        invocationErrors.push(`${candidate.name}: ${attempt.error || "unknown"}`);
        continue;
      }

      const result = attempt.result;
      let resultSessionId = null;
      if (result && typeof result === "object") {
        if (typeof result.sendAndWait === "function") {
          setSession?.(result);
        } else if (result.session && typeof result.session.sendAndWait === "function") {
          setSession?.(result.session);
        }
        resultSessionId = readSessionId(result) || readSessionId(result.session);
      }

      const activeAfter = readSessionId(getSession?.());
      if (activeAfter === target) {
        dbg("session switched:", `from=${activeBefore || "unknown"}`, `to=${target}`, `via=${candidate.name}`);
        return { ok: true, switched: true, via: candidate.name, activeSessionId: activeAfter, targetSessionId: target };
      }
      dbg(
        "session switch attempt did not change active session:",
        candidate.name,
        `active=${activeAfter || "unknown"}`,
        `target=${target}`,
        `resultSession=${resultSessionId || "unknown"}`,
      );
      mismatchedAttempts += 1;
    }

    const activeAfter = readSessionId(getSession?.());
    const classified = classifySessionSwitchFailure({
      errors: invocationErrors,
      mismatched: mismatchedAttempts,
      candidateCount: candidates.length,
    });
    if (!candidates.length) {
      dbg(
        "session switch unavailable in runtime:",
        `active=${activeBefore || "unknown"}`,
        `target=${target}`,
        `reason=${reason}`,
        `sessionMethods=${Array.isArray(capabilities?.methodNames) ? capabilities.methodNames.length : 0}`,
        `rpcMethods=${Array.isArray(capabilities?.rpcNames) ? capabilities.rpcNames.length : 0}`,
        `rpcSessionMethods=${Array.isArray(capabilities?.rpcSessionNames) ? capabilities.rpcSessionNames.length : 0}`,
      );
    }
    const detail = invocationErrors.length
      ? ` (${invocationErrors.slice(0, 2).join("; ")})`
      : "";
    return {
      ok: false,
      reason: classified.reason,
      retryable: classified.retryable,
      message: `${classified.message}${detail}`,
      activeSessionId: activeAfter || activeBefore,
      targetSessionId: target,
    };
  }

  return {
    discoverCapabilities,
    activateSession,
  };
}
