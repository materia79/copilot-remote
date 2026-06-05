const DEFAULT_PREFETCH_THRESHOLD_PX = 320;
const DEFAULT_LOAD_THRESHOLD_PX = 96;

function normalizeCursor(value) {
  return value && typeof value === 'object' ? { ...value } : null;
}

function normalizePage(result) {
  const page = result && typeof result === 'object' ? result : {};
  return {
    items: Array.isArray(page.items) ? page.items : [],
    hasMore: !!page.hasMore,
    nextCursor: normalizeCursor(page.nextCursor),
  };
}

export function createInfiniteLoader({
  fetchPage,
  applyPage,
  onStateChange = null,
  onError = null,
  prefetchThresholdPx = DEFAULT_PREFETCH_THRESHOLD_PX,
  loadThresholdPx = DEFAULT_LOAD_THRESHOLD_PX,
} = {}) {
  if (typeof fetchPage !== 'function') {
    throw new TypeError('createInfiniteLoader requires a fetchPage function');
  }
  if (typeof applyPage !== 'function') {
    throw new TypeError('createInfiniteLoader requires an applyPage function');
  }

  let version = 0;
  let hasMore = false;
  let nextCursor = null;
  let prefetchedPage = null;
  let loading = false;
  let prefetching = false;
  let latestDistancePx = Number.POSITIVE_INFINITY;

  function snapshot() {
    return {
      hasMore,
      nextCursor: normalizeCursor(nextCursor),
      hasPrefetchedPage: !!prefetchedPage,
      isLoading: loading,
      isPrefetching: prefetching,
    };
  }

  function emitState() {
    onStateChange?.(snapshot());
  }

  function clearBuffer() {
    prefetchedPage = null;
  }

  function reset({ hasMore: nextHasMore = false, nextCursor: cursor = null } = {}) {
    version += 1;
    hasMore = !!nextHasMore;
    nextCursor = normalizeCursor(cursor);
    clearBuffer();
    loading = false;
    prefetching = false;
    latestDistancePx = Number.POSITIVE_INFINITY;
    emitState();
  }

  function invalidate() {
    reset({
      hasMore,
      nextCursor,
    });
  }

  async function applyResolvedPage(page) {
    const normalized = normalizePage(page);
    await applyPage(normalized);
    hasMore = normalized.hasMore;
    nextCursor = normalizeCursor(normalized.nextCursor);
    clearBuffer();
    emitState();
    return normalized.items.length > 0;
  }

  async function loadNextPage(mode = 'load') {
    if (!hasMore || !nextCursor) return false;
    if (mode === 'prefetch') {
      if (prefetchedPage || prefetching || loading) return false;
      prefetching = true;
      emitState();
    } else {
      if (loading) return false;
      if (prefetchedPage) {
        loading = true;
        emitState();
        try {
          return await applyResolvedPage(prefetchedPage);
        } finally {
          loading = false;
          emitState();
          if (latestDistancePx <= prefetchThresholdPx) void loadNextPage('prefetch');
        }
      }
      if (prefetching) return false;
      loading = true;
      emitState();
    }

    const capturedVersion = version;
    const cursor = normalizeCursor(nextCursor);
    try {
      const rawPage = await fetchPage(cursor, { mode });
      if (rawPage == null) return false;
      const page = normalizePage(rawPage);
      if (capturedVersion !== version) return false;
      if (mode === 'prefetch') {
        prefetchedPage = page;
        emitState();
        if (latestDistancePx <= loadThresholdPx) {
          return await loadNextPage('load');
        }
        return page.items.length > 0;
      }
      return await applyResolvedPage(page);
    } catch (error) {
      onError?.(error, { mode });
      return false;
    } finally {
      if (mode === 'prefetch') {
        prefetching = false;
      } else {
        loading = false;
      }
      emitState();
    }
  }

  async function handleBoundaryDistance(distancePx) {
    latestDistancePx = Number.isFinite(Number(distancePx))
      ? Math.max(0, Number(distancePx))
      : Number.POSITIVE_INFINITY;
    if (!hasMore || !nextCursor) return false;
    if (latestDistancePx <= prefetchThresholdPx) {
      void loadNextPage('prefetch');
    }
    if (latestDistancePx <= loadThresholdPx) {
      return loadNextPage('load');
    }
    return false;
  }

  return {
    getState: snapshot,
    handleBoundaryDistance,
    invalidate,
    loadMore: () => {
      latestDistancePx = 0;
      return loadNextPage('load');
    },
    prefetch: () => loadNextPage('prefetch'),
    reset,
  };
}
