const DB_NAME = 'copilot-remote-client-status';
const DB_VERSION = 1;
const STORE_NAME = 'events';
const MAX_EVENTS = 300;
export const STATUS_EVENT_PAGE_SIZE = 40;

let dbPromise = null;
let memoryEvents = [];
let nextMemoryId = 1;
const listeners = new Set();
let lastRelayOnline = null;
let lastCliOnline = null;
let diagnosticsInitialized = false;
let nativeConsole = null;

function emit(event) {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // Status listeners must not interfere with the application.
    }
  }
}

function sanitize(value, depth = 0) {
  if (depth > 3) return '[Max depth reached]';
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack || '' };
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitize(item, depth + 1));
  if (typeof value === 'object') {
    const output = {};
    for (const [key, item] of Object.entries(value).slice(0, 30)) {
      output[String(key).slice(0, 80)] = sanitize(item, depth + 1);
    }
    return output;
  }
  return String(value);
}

function openDatabase() {
  if (dbPromise) return dbPromise;
  if (!globalThis.indexedDB) return Promise.resolve(null);
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error || new Error('Could not open client status storage'));
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
  }).catch(() => null);
  return dbPromise;
}

function memoryInsert(event) {
  memoryEvents.push(event);
  if (memoryEvents.length > MAX_EVENTS) memoryEvents = memoryEvents.slice(-MAX_EVENTS);
}

async function persistEvent(event) {
  const database = await openDatabase();
  if (!database) return;
  await new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    store.put(event);
    const cursorRequest = store.openCursor();
    const ids = [];
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor) {
        ids.slice(0, Math.max(0, ids.length - MAX_EVENTS)).forEach((id) => store.delete(id));
        return;
      }
      ids.push(cursor.primaryKey);
      cursor.continue();
    };
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error || new Error('Could not persist client status event'));
  }).catch(() => {});
}

export async function loadStatusEvents() {
  const database = await openDatabase();
  if (!database) return memoryEvents.slice();
  const events = await new Promise((resolve) => {
    const request = database.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).getAll();
    request.onsuccess = () => resolve(Array.isArray(request.result) ? request.result : []);
    request.onerror = () => resolve([]);
  });
  return events.sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0)).slice(-MAX_EVENTS);
}

function compareStatusEvents(left, right) {
  const timestampDelta = Number(left?.timestamp || 0) - Number(right?.timestamp || 0);
  if (timestampDelta !== 0) return timestampDelta;
  return String(left?.id || '').localeCompare(String(right?.id || ''));
}

export function mergeStatusEvents(existing = [], incoming = []) {
  const merged = new Map();
  for (const event of [...existing, ...incoming]) {
    const id = String(event?.id || '').trim();
    if (!id) continue;
    merged.set(id, event);
  }
  return Array.from(merged.values()).sort(compareStatusEvents);
}

export async function loadStatusEventPage({ before = null, limit = STATUS_EVENT_PAGE_SIZE } = {}) {
  const events = await loadStatusEvents();
  const cursorTimestamp = Number(before?.timestamp || 0);
  const cursorId = String(before?.id || '');
  const eligible = before
    ? events.filter((event) => (
      Number(event.timestamp || 0) < cursorTimestamp
      || (Number(event.timestamp || 0) === cursorTimestamp && String(event.id || '').localeCompare(cursorId) < 0)
    ))
    : events;
  const pageSize = Math.max(1, Math.min(STATUS_EVENT_PAGE_SIZE, Number(limit) || STATUS_EVENT_PAGE_SIZE));
  const items = eligible.slice(-pageSize).sort(compareStatusEvents);
  const first = items[0] || null;
  return {
    items,
    hasMore: eligible.length > items.length,
    nextCursor: first ? { timestamp: first.timestamp, id: first.id } : null,
  };
}

export async function clearStatusEvents() {
  memoryEvents = [];
  const database = await openDatabase();
  if (database) {
    await new Promise((resolve) => {
      const request = database.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).clear();
      request.onsuccess = resolve;
      request.onerror = resolve;
    });
  }
  emit({ type: 'status-cleared', timestamp: Date.now() });
}

export function subscribeStatusEvents(listener) {
  if (typeof listener !== 'function') return () => {};
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function recordStatusEvent(type, details = {}) {
  const event = {
    id: `status-${Date.now()}-${nextMemoryId++}`,
    timestamp: Date.now(),
    type: String(type || 'event'),
    details: sanitize(details),
  };
  memoryInsert(event);
  void persistEvent(event);
  emit(event);
  return event;
}

export function publishStatusEvent(event) {
  const id = String(event?.id || '').trim();
  if (!id) return null;
  const published = {
    ...event,
    id,
    timestamp: Number(event.timestamp) || Date.now(),
    type: String(event.type || 'event'),
    source: String(event.source || 'server'),
    details: sanitize(event.details || {}),
  };
  emit(published);
  return published;
}

export function recordRelayLifecycleEvent(online) {
  const nextOnline = !!online;
  if (lastRelayOnline === nextOnline) return;
  const previous = lastRelayOnline;
  lastRelayOnline = nextOnline;
  recordStatusEvent(nextOnline ? 'relay-connected' : 'relay-unreachable', {
    previous,
    online: nextOnline,
  });
}

export function recordCliLifecycleEvent(online) {
  const nextOnline = !!online;
  if (lastCliOnline === nextOnline) return;
  const previous = lastCliOnline;
  lastCliOnline = nextOnline;
  recordStatusEvent(nextOnline ? 'cli-connected' : 'cli-unreachable', {
    previous,
    online: nextOnline,
  });
}

function formatConsoleArguments(args) {
  return args.slice(0, 12).map((value) => sanitize(value));
}

export function initClientDiagnostics() {
  if (diagnosticsInitialized) return;
  diagnosticsInitialized = true;
  nativeConsole = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };
  for (const level of ['log', 'warn', 'error']) {
    const original = nativeConsole[level];
    console[level] = (...args) => {
      original(...args);
      recordStatusEvent(`console-${level}`, { arguments: formatConsoleArguments(args) });
    };
  }
  window.addEventListener('error', (event) => {
    recordStatusEvent('client-error', {
      message: event.message,
      source: event.filename,
      line: event.lineno,
      column: event.colno,
      error: event.error,
    });
  });
  window.addEventListener('unhandledrejection', (event) => {
    recordStatusEvent('unhandled-rejection', { reason: event.reason });
  });
}

export function getNativeConsole() {
  return nativeConsole || console;
}
