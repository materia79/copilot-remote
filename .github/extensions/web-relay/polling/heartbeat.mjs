export function createHeartbeatController({ api, pollMs, getSessionReady, getHeartbeatTimer, setHeartbeatTimer }) {
  function startHeartbeat() {
    if (getHeartbeatTimer()) return;
    const timer = setInterval(() => {
      if (!getSessionReady()) return;
      api("POST", "/api/heartbeat", {}).catch(() => {});
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
    startHeartbeat,
    stopHeartbeat,
  };
}
