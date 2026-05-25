import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveComposerControlState, hasComposerDraft } from './composer-control-state.mjs';

test('hasComposerDraft detects text and attachments', () => {
  assert.equal(hasComposerDraft({ text: '   ', attachmentCount: 0 }), false);
  assert.equal(hasComposerDraft({ text: 'hello', attachmentCount: 0 }), true);
  assert.equal(hasComposerDraft({ text: '', attachmentCount: 1 }), true);
});

test('deriveComposerControlState returns Stop for an active turn without a draft', () => {
  assert.deepEqual(
    deriveComposerControlState({ hasActiveTurn: true, cancelRequested: false, hasDraft: false, sendInFlight: false }),
    {
      action: 'stop',
      label: 'Stop',
      title: 'Stop the current turn',
      disabled: false,
    },
  );
});

test('deriveComposerControlState returns Queue for an active turn with a draft', () => {
  assert.deepEqual(
    deriveComposerControlState({ hasActiveTurn: true, cancelRequested: false, hasDraft: true, sendInFlight: false }),
    {
      action: 'queue',
      label: 'Queue',
      title: 'Queue message behind current turn',
      disabled: false,
    },
  );
});

test('deriveComposerControlState keeps Queue available while stop is already requested and a draft exists', () => {
  assert.deepEqual(
    deriveComposerControlState({ hasActiveTurn: true, cancelRequested: true, hasDraft: true, sendInFlight: false }),
    {
      action: 'queue',
      label: 'Queue',
      title: 'Queue message behind current turn',
      disabled: false,
    },
  );
});

test('deriveComposerControlState disables the stop action while stopping', () => {
  assert.deepEqual(
    deriveComposerControlState({ hasActiveTurn: true, cancelRequested: true, hasDraft: false, sendInFlight: false }),
    {
      action: 'stop',
      label: 'Stopping…',
      title: 'Stopping the current turn',
      disabled: true,
    },
  );
});
