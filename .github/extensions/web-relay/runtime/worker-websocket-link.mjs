function normalizeText(value) {
  const text = String(value || "").trim();
  return text || null;
}

function normalizePositiveInt(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  const intValue = Math.trunc(numeric);
  return intValue > 0 ? intValue : null;
}

function toWebSocketUrl(serverUrl, token, getSessionId, getPid) {
  const source = new URL(String(serverUrl || "http://localhost:3333"));
  source.protocol = source.protocol === "https:" ? "wss:" : "ws:";
  source.pathname = "/api/session-worker/ws";
  source.search = "";
  if (token) source.searchParams.set("token", token);
  const sessionId = normalizeText(typeof getSessionId === "function" ? getSessionId() : null);
  if (sessionId) source.searchParams.set("sessionId", sessionId);
  const pid = normalizePositiveInt(typeof getPid === "function" ? getPid() : null);
  if (pid) source.searchParams.set("pid", String(pid));
  return source.toString();
}

export function createWorkerWebSocketLink({
  serverUrl,
  token,
  dbg = () => {},
  onDeliver = async () => {},
  pollNow = async () => {},
  getSessionReady = () => false,
  getSessionId = () => null,
  getPid = () => null,
  minBackoffMs = 1000,
  maxBackoffMs = 8_000,
  jitterMs = 250,
  WebSocketImpl = globalThis.WebSocket,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  let ws = null;
  let stopped = false;
  let reconnectTimer = null;
  let reconnectAttempt = 0;
  let reconnectDelayMs = 0;
  let pollInFlight = null;
  let deliveryInFlight = null;

  async function triggerPoll(reason = "ws-event") {
    if (!getSessionReady()) return false;
    if (pollInFlight) return pollInFlight;
    pollInFlight = Promise.resolve()
      .then(() => pollNow(reason))
      .catch((error) => {
        dbg("worker ws trigger poll failed", reason, error?.message || String(error));
        return false;
      })
      .finally(() => {
        pollInFlight = null;
      });
    return pollInFlight;
  }

  function send(payload) {
    if (!ws || ws.readyState !== ws.OPEN) return false;
    try {
      ws.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }

  async function notifyReady(reason = "worker-ready") {
    if (!getSessionReady()) return false;
    return send({
      type: "worker.ready",
      reason,
      sessionId: normalizeText(getSessionId()),
      pid: normalizePositiveInt(getPid()),
    });
  }

  async function deliverPending(pending, reason = "queue-deliver") {
    if (!getSessionReady()) return false;
    if (deliveryInFlight) return deliveryInFlight;
    deliveryInFlight = Promise.resolve()
      .then(() => onDeliver(pending, reason))
      .catch((error) => {
        dbg("worker ws delivery failed", reason, error?.message || String(error));
        return false;
      })
      .finally(() => {
        deliveryInFlight = null;
      });
    return deliveryInFlight;
  }

  function clearReconnectTimer() {
    if (!reconnectTimer) return;
    clearTimeoutImpl(reconnectTimer);
    reconnectTimer = null;
  }

  function scheduleReconnect() {
    if (stopped) return;
    clearReconnectTimer();
    reconnectAttempt += 1;
    const backoff = Math.min(maxBackoffMs, minBackoffMs * (2 ** Math.max(0, reconnectAttempt - 1)));
    const jitter = Math.floor(Math.random() * Math.max(0, jitterMs));
    reconnectDelayMs = Math.min(maxBackoffMs, backoff + jitter);
    dbg("worker ws reconnect scheduled", `attempt=${reconnectAttempt}`, `delayMs=${reconnectDelayMs}`);
    reconnectTimer = setTimeoutImpl(() => {
      reconnectTimer = null;
      connect();
    }, reconnectDelayMs);
  }

  function connect() {
    if (stopped) return;
    if (ws && (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING)) return;
    if (typeof WebSocketImpl !== "function") {
      dbg("worker ws unavailable: global WebSocket is missing");
      return;
    }
    const url = toWebSocketUrl(serverUrl, token, getSessionId, getPid);
    ws = new WebSocketImpl(url);
    ws.addEventListener("open", () => {
      reconnectAttempt = 0;
      reconnectDelayMs = 0;
      dbg("worker ws connected");
      send({
        type: "worker.hello",
        sessionId: normalizeText(getSessionId()),
        pid: normalizePositiveInt(getPid()),
      });
      void notifyReady("ws-open");
    });
    ws.addEventListener("message", (event) => {
      let payload = null;
      try {
        payload = JSON.parse(String(event?.data || ""));
      } catch {
        return;
      }
      if (payload?.type === "queue.deliver") {
        void deliverPending(payload.pending || null, String(payload.reason || "queue-deliver"))
          .finally(() => notifyReady("delivery-complete"));
        return;
      }
      if (payload?.type === "server.draining") {
        dbg("worker ws draining", payload.reason || "relay-shutdown");
        try { ws?.close?.(); } catch {}
        return;
      }
      if (payload?.type === "queue.changed") {
        void triggerPoll("ws-queue-changed");
        return;
      }
      if (payload?.type === "queue.blocked") {
        dbg("worker ws blocked", payload.reason || "blocked");
      }
    });
    ws.addEventListener("close", () => {
      if (stopped) return;
      dbg("worker ws disconnected");
      scheduleReconnect();
    });
    ws.addEventListener("error", (error) => {
      dbg("worker ws error", error?.message || String(error));
      try { ws?.close?.(); } catch {}
    });
  }

  function start() {
    stopped = false;
    connect();
  }

  function stop() {
    stopped = true;
    clearReconnectTimer();
    if (ws) {
      try { ws.close(); } catch {}
      ws = null;
    }
  }

  function status() {
    const connected = !!ws && ws.readyState === ws.OPEN;
    return {
      connected,
      delivering: !!deliveryInFlight,
      reconnectAttempt,
      reconnectDelayMs,
    };
  }

  return {
    notifyReady,
    start,
    stop,
    status,
  };
}
