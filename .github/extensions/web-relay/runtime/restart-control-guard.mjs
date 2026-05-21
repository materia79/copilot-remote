function normalizeId(value) {
  const text = String(value || "").trim();
  return text || "";
}

export function evaluateRestartControlGuard({
  controlType,
  targetSessionId,
  currentSessionId,
  force = false,
  nowMs = Date.now(),
  graceUntilMs = 0,
} = {}) {
  const type = String(controlType || "").trim().toLowerCase();
  if (type !== "restart_cli") {
    return { defer: false, reason: "not-restart-control" };
  }

  const target = normalizeId(targetSessionId);
  const current = normalizeId(currentSessionId);
  if (!force && target && current && target === current) {
    return { defer: true, reason: "already-bound-to-target" };
  }

  const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  const graceUntil = Number.isFinite(Number(graceUntilMs)) ? Number(graceUntilMs) : 0;
  if (graceUntil > 0 && now < graceUntil) {
    return { defer: true, reason: "startup-grace-window" };
  }

  return { defer: false, reason: "none" };
}

