import test from 'node:test';
import assert from 'node:assert/strict';

import {
  clearStatusEvents,
  loadStatusEventPage,
  mergeStatusEvents,
  recordStatusEvent,
} from './status-store.mjs';

test('loadStatusEventPage returns newest events first and paginates older events', async () => {
  const prefix = `status-store-test-${Date.now()}`;
  recordStatusEvent(`${prefix}-one`, { value: 1 });
  recordStatusEvent(`${prefix}-two`, { value: 2 });
  recordStatusEvent(`${prefix}-three`, { value: 3 });

  const first = await loadStatusEventPage({ limit: 2 });
  const firstItems = first.items.filter((event) => event.type.startsWith(prefix));
  assert.equal(firstItems.length, 2);
  assert.equal(firstItems.at(-1).type, `${prefix}-three`);

  const second = await loadStatusEventPage({
    before: { timestamp: firstItems[0].timestamp, id: firstItems[0].id },
    limit: 2,
  });
  assert.ok(second.items.some((event) => event.type === `${prefix}-one`));
});

test('mergeStatusEvents deduplicates by id and preserves stable timeline order', () => {
  const merged = mergeStatusEvents(
    [
      { id: 'client-1', timestamp: 100, source: 'client', type: 'console-log' },
      { id: 'server-1', timestamp: 200, source: 'server', type: 'shared-access-opened' },
    ],
    [
      { id: 'server-1', timestamp: 200, source: 'server', type: 'shared-access-opened', details: { viewerIp: '203.0.113.24' } },
      { id: 'client-2', timestamp: 200, source: 'client', type: 'console-log' },
    ],
  );
  assert.deepEqual(merged.map((event) => event.id), ['client-1', 'client-2', 'server-1']);
  assert.equal(merged.filter((event) => event.id === 'server-1').length, 1);
});

test('clearing client status storage does not alter server timeline events', async () => {
  const serverEvent = { id: 'server-persisted', timestamp: 1, source: 'server', type: 'shared-access-opened' };
  recordStatusEvent('client-event', { value: 1 });
  await clearStatusEvents();
  const cleared = await loadStatusEventPage();
  const merged = mergeStatusEvents(cleared.items, [serverEvent]);
  assert.deepEqual(merged, [serverEvent]);
});
