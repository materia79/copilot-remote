export function createApiClient({ serverUrl, token, getHeaders }) {
  return async function api(method, routePath, body) {
    const url = `${serverUrl}${routePath}`;
    const extraHeaders = typeof getHeaders === "function" ? (getHeaders() || {}) : {};
    const opts = {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...extraHeaders,
      },
      ...(method !== "GET" ? { body: JSON.stringify(body || {}) } : {}),
    };

    const res = await fetch(url, opts);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${routePath}`);
    return res.json();
  };
}
