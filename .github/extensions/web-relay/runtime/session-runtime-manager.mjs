function normalizeReason(reason, fallback = "switch-call-failed") {
  const text = String(reason || "").trim();
  return text || fallback;
}

function isTransientSwitchError(message) {
  const text = String(message || "").toLowerCase();
  if (!text) return false;
  return text.includes("timed out")
    || text.includes("timeout")
    || text.includes("tempor")
    || text.includes("busy")
    || text.includes("again");
}

function isInvalidTargetSwitchError(message) {
  const text = String(message || "").toLowerCase();
  if (!text) return false;
  return text.includes("unknown session")
    || text.includes("not found")
    || text.includes("invalid session")
    || text.includes("no session");
}

export function classifySessionSwitchFailure({
  errors = [],
  mismatched = 0,
  candidateCount = 0,
} = {}) {
  const normalizedErrors = Array.isArray(errors)
    ? errors.map((value) => String(value || "").trim()).filter(Boolean)
    : [];
  const mismatchCount = Math.max(0, Math.trunc(Number(mismatched) || 0));
  const candidates = Math.max(0, Math.trunc(Number(candidateCount) || 0));

  if (candidates <= 0) {
    return {
      reason: "switch-api-missing",
      retryable: false,
    };
  }
  if (mismatchCount > 0) {
    return {
      reason: "switch-result-mismatch",
      retryable: true,
    };
  }
  if (normalizedErrors.some((message) => isInvalidTargetSwitchError(message))) {
    return {
      reason: "target-session-invalid",
      retryable: false,
    };
  }
  if (normalizedErrors.some((message) => isTransientSwitchError(message))) {
    return {
      reason: "switch-call-transient-failure",
      retryable: true,
    };
  }
  return {
    reason: "switch-call-failed",
    retryable: false,
  };
}

export function createSessionRuntimeManager({
  dbg = () => {},
  getSession = () => null,
  setSession = () => {},
} = {}) {
  async function activateSession(targetSessionId, source = "unknown") {
    const target = String(targetSessionId || "").trim();
    const session = getSession?.() || null;
    const switchFn = session?.switchSession;
    if (!target) {
      return {
        ok: false,
        reason: "target-session-invalid",
        retryable: false,
        source,
      };
    }
    if (typeof switchFn !== "function") {
      return {
        ok: false,
        reason: "switch-api-missing",
        retryable: false,
        source,
      };
    }

    try {
      const switched = await switchFn.call(session, target);
      const switchedSessionId = String(switched?.sessionId || "").trim();
      const liveSession = getSession?.() || session;
      const activeSessionId = String(liveSession?.sessionId || switchedSessionId || "").trim();
      const mismatch = activeSessionId && activeSessionId !== target ? 1 : 0;
      const classified = classifySessionSwitchFailure({
        errors: [],
        mismatched: mismatch,
        candidateCount: 1,
      });
      if (mismatch > 0) {
        dbg(
          "runtime switch mismatch",
          `target=${target}`,
          `active=${activeSessionId}`,
          `source=${source}`,
        );
        return {
          ok: false,
          reason: normalizeReason(classified.reason),
          retryable: classified.retryable === true,
          source,
        };
      }
      if (liveSession && typeof liveSession === "object" && activeSessionId && activeSessionId !== liveSession.sessionId) {
        setSession?.({ ...liveSession, sessionId: activeSessionId });
      } else {
        setSession?.(liveSession);
      }
      return {
        ok: true,
        reason: null,
        retryable: false,
        activeSessionId: activeSessionId || target,
        source,
      };
    } catch (error) {
      const message = String(error?.message || error || "switch-call-failed");
      const classified = classifySessionSwitchFailure({
        errors: [message],
        mismatched: 0,
        candidateCount: 1,
      });
      dbg(
        "runtime switch failed",
        `target=${target}`,
        `reason=${classified.reason}`,
        `retryable=${classified.retryable === true ? "yes" : "no"}`,
        `source=${source}`,
      );
      return {
        ok: false,
        reason: normalizeReason(classified.reason),
        retryable: classified.retryable === true,
        error: message,
        source,
      };
    }
  }

  return {
    activateSession,
  };
}
