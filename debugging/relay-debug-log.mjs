const DEBUG_ENDPOINT = 'http://127.0.0.1:7611/ingest/41e205ad-83bf-40b2-b2ab-5040e785036c';
const DEBUG_SESSION_ID = '0e20dd';

function sanitizeData(data) {
  if (!data || typeof data !== 'object') return {};
  const output = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    if (value === null) {
      output[key] = null;
      continue;
    }
    if (typeof value === 'string') {
      output[key] = value.slice(0, 400);
      continue;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      output[key] = value;
      continue;
    }
    output[key] = String(value).slice(0, 400);
  }
  return output;
}

export function postRelayDebugLog({
  runId = 'baseline',
  hypothesisId = 'H-unknown',
  location = 'unknown',
  message = 'log',
  data = {},
} = {}) {
  fetch(DEBUG_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Debug-Session-Id': DEBUG_SESSION_ID,
    },
    body: JSON.stringify({
      sessionId: DEBUG_SESSION_ID,
      id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
      runId,
      hypothesisId,
      location,
      message,
      data: sanitizeData(data),
      timestamp: Date.now(),
    }),
  }).catch(() => {});
}
