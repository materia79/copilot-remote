import assert from 'node:assert/strict';
import test from 'node:test';
import { createRelayBridgeOwnerService } from './relay-bridge-owner-service.mjs';

test('bridge owner stays sticky until stale', () => {
  let nowMs = Date.parse('2026-05-20T20:00:00.000Z');
  const service = createRelayBridgeOwnerService({
    staleMs: 5_000,
    now: () => nowMs,
  });

  const first = service.observe({ pid: 111, sessionId: 'bab3' });
  assert.equal(first.accepted, true);
  assert.equal(first.owner?.pid, 111);

  nowMs += 1_000;
  const second = service.observe({ pid: 222, sessionId: '0bb' });
  assert.equal(second.accepted, false);
  assert.equal(service.getOwner()?.pid, 111);

  nowMs += 6_000;
  const third = service.observe({ pid: 222, sessionId: '0bb' });
  assert.equal(third.accepted, true);
  assert.equal(third.owner?.pid, 222);
});
