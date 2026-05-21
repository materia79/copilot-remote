import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getSessionWorkerFeatureFlags,
  isFeatureEnabled,
  normalizeFeatureFlags,
  resolveFeatureFlags,
} from './features.mjs';

test('normalizeFeatureFlags defaults rollout gates to false and ignores unknown/invalid values', () => {
  const flags = normalizeFeatureFlags({
    SESSION_WORKER_ROUTING_ENABLED: 'invalid',
    SESSION_WORKER_CONTINUATION_ROUTING_ENABLED: true,
    SOME_UNKNOWN_GATE: true,
  });

  assert.deepEqual(flags, {
    SESSION_WORKER_ROUTING_ENABLED: false,
    SESSION_WORKER_CONTINUATION_ROUTING_ENABLED: true,
    SESSION_WORKER_FALLBACK_RESTART_ENABLED: false,
  });
});

test('resolveFeatureFlags applies config first and env overrides with strict boolean parsing', () => {
  const flags = resolveFeatureFlags({
    configFeatures: {
      SESSION_WORKER_ROUTING_ENABLED: true,
      SESSION_WORKER_CONTINUATION_ROUTING_ENABLED: 'off',
      SESSION_WORKER_FALLBACK_RESTART_ENABLED: 'bogus',
      IGNORED_GATE: true,
    },
    env: {
      COPILOT_REMOTE_SESSION_WORKER_ROUTING_ENABLED: 'false',
      COPILOT_REMOTE_SESSION_WORKER_CONTINUATION_ROUTING_ENABLED: '1',
      COPILOT_REMOTE_SESSION_WORKER_FALLBACK_RESTART_ENABLED: 'maybe',
    },
  });

  assert.deepEqual(flags, {
    SESSION_WORKER_ROUTING_ENABLED: false,
    SESSION_WORKER_CONTINUATION_ROUTING_ENABLED: true,
    SESSION_WORKER_FALLBACK_RESTART_ENABLED: false,
  });
});

test('session worker status flags surface as booleans and are consumable by helper checks', () => {
  const flags = resolveFeatureFlags({
    configFeatures: { SESSION_WORKER_FALLBACK_RESTART_ENABLED: 'true' },
    env: {},
  });
  const sessionWorker = getSessionWorkerFeatureFlags(flags);

  assert.deepEqual(sessionWorker, {
    enabled: false,
    continuationRoutingEnabled: false,
    fallbackRestartEnabled: true,
  });
  assert.equal(isFeatureEnabled('SESSION_WORKER_FALLBACK_RESTART_ENABLED', flags), true);
  assert.equal(isFeatureEnabled('SESSION_WORKER_ROUTING_ENABLED', flags), false);
});

