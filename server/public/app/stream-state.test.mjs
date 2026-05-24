import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeStreamSeq,
  deriveLatestInFlightStreamEvent,
  computeNextRelayStreamState,
} from './stream-state.mjs';

test('normalizeStreamSeq returns null for empty and invalid values', () => {
  assert.equal(normalizeStreamSeq(null), null);
  assert.equal(normalizeStreamSeq(undefined), null);
  assert.equal(normalizeStreamSeq(''), null);
  assert.equal(normalizeStreamSeq('abc'), null);
});

test('deriveLatestInFlightStreamEvent uses first-wins for duplicate seq', () => {
  const inFlight = {
    streamEvents: [
      { seq: 1, text: 'a', done: false },
      { seq: 2, text: 'b-first', done: false },
      { seq: 2, text: 'b-second', done: true },
    ],
  };
  const latest = deriveLatestInFlightStreamEvent(inFlight);
  assert.deepEqual(latest, { seq: 2, text: 'b-first', done: false });
});

test('computeNextRelayStreamState rejects stale and duplicate seq', () => {
  const current = { seq: 5, done: false };
  const stale = computeNextRelayStreamState(current, { seq: 4, done: false });
  assert.equal(stale.accept, false);
  const duplicate = computeNextRelayStreamState(current, { seq: 5, done: false });
  assert.equal(duplicate.accept, false);
});

test('computeNextRelayStreamState prevents post-done non-terminal updates', () => {
  const current = { seq: 6, done: true };
  const regressive = computeNextRelayStreamState(current, { seq: 7, done: false });
  assert.equal(regressive.accept, false);
  const terminal = computeNextRelayStreamState(current, { seq: 7, done: true });
  assert.equal(terminal.accept, true);
  assert.deepEqual(terminal.state, { seq: 7, done: true });
});

test('hydration and live path stay consistent for same-seq duplicates', () => {
  const inFlight = {
    streamEvents: [
      { seq: 3, text: 'alpha', done: false },
      { seq: 4, text: 'winner', done: false },
      { seq: 4, text: 'should-be-ignored', done: false },
    ],
  };
  const hydrated = deriveLatestInFlightStreamEvent(inFlight);
  assert.deepEqual(hydrated, { seq: 4, text: 'winner', done: false });
  const liveDuplicate = computeNextRelayStreamState(
    { seq: hydrated.seq, done: hydrated.done },
    { seq: 4, done: false },
  );
  assert.equal(liveDuplicate.accept, false);
});
