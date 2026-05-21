export function isRetryableSessionJoinConflict(error) {
  const message = String(error?.message || error || '');
  if (!message) return false;
  return (
    message.includes('Failed to connect to IDE MCP server')
    && message.includes('Conflict: A connection for this session already exists')
  );
}

export async function joinSessionWithRetry({
  joinSessionImpl,
  joinOptions,
  dbg = () => {},
  delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  retries = 4,
  retryDelayMs = 1500,
} = {}) {
  if (typeof joinSessionImpl !== 'function') {
    throw new Error('joinSessionImpl must be a function');
  }
  const maxAttempts = Math.max(1, Number(retries || 1));
  const waitMs = Math.max(0, Number(retryDelayMs || 0));
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await joinSessionImpl(joinOptions);
    } catch (error) {
      lastError = error;
      if (!isRetryableSessionJoinConflict(error) || attempt >= maxAttempts) {
        throw error;
      }
      dbg(
        'joinSession conflict retry',
        `attempt=${attempt}/${maxAttempts}`,
        `delay=${waitMs}ms`,
        error?.message || String(error),
      );
      await delay(waitMs);
    }
  }

  throw lastError || new Error('joinSession failed');
}
