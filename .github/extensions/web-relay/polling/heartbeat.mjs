export function createHeartbeatController({
  api,
  pollMs,
  getSessionReady,
  getHeartbeatTimer,
  setHeartbeatTimer,
  getActiveQueueMessageId,
}) {
  async function pulseHeartbeat() {
    if (!getSessionReady()) return false;
    try {
      const activeQueueMessageId = typeof getActiveQueueMessageId === "function"
        ? String(getActiveQueueMessageId() || "").trim()
        : "";
      await api("POST", "/api/heartbeat", activeQueueMessageId ? { activeQueueMessageId } : {});
      return true;
    } catch {
      return false;
    }
  }

  function startHeartbeat() {
    if (getHeartbeatTimer()) return;
    void pulseHeartbeat();
    const timer = setInterval(() => {
      void pulseHeartbeat();
    }, pollMs);
    setHeartbeatTimer(timer);
  }

  function stopHeartbeat() {
    const timer = getHeartbeatTimer();
    if (!timer) return;
    clearInterval(timer);
    setHeartbeatTimer(null);
  }

  return {
    pulseHeartbeat,
    startHeartbeat,
    stopHeartbeat,
  };
}
