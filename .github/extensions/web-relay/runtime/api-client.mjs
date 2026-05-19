export function createApiClient({ serverUrl, token }) {
  return async function api(method, routePath, body) {
    const url = `${serverUrl}${routePath}`;
    const opts = {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      ...(method !== "GET" ? { body: JSON.stringify(body || {}) } : {}),
    };

    const res = await fetch(url, opts);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${routePath}`);
    return res.json();
  };
}
