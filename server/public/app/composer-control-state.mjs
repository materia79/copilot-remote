export function hasComposerDraft({ text = '', attachmentCount = 0 } = {}) {
  return String(text || '').trim().length > 0 || Math.max(0, Number(attachmentCount) || 0) > 0;
}

export function deriveComposerControlState({
  hasActiveTurn = false,
  cancelRequested = false,
  hasDraft = false,
  sendInFlight = false,
  modelMetadataBlocked = false,
} = {}) {
  const active = !!hasActiveTurn;
  const stopping = !!cancelRequested;
  const draft = !!hasDraft;
  const metadataBlocked = !!modelMetadataBlocked;

  if (metadataBlocked && !active) {
    return {
      action: 'send',
      label: 'Send',
      title: 'Refresh model metadata to send',
      disabled: true,
    };
  }

  if (sendInFlight) {
    if (active && draft) {
      return {
        action: 'queue',
        label: 'Queue',
        title: 'Queue message behind current turn',
        disabled: true,
      };
    }
    if (active) {
      return {
        action: 'stop',
        label: stopping ? 'Stopping…' : 'Stop',
        title: stopping ? 'Stopping the current turn' : 'Stop the current turn',
        disabled: true,
      };
    }
    return {
      action: 'send',
      label: 'Send',
      title: 'Send message',
      disabled: true,
    };
  }

  if (active && draft) {
    return {
      action: 'queue',
      label: 'Queue',
      title: 'Queue message behind current turn',
      disabled: false,
    };
  }

  if (active) {
    return {
      action: 'stop',
      label: stopping ? 'Stopping…' : 'Stop',
      title: stopping ? 'Stopping the current turn' : 'Stop the current turn',
      disabled: stopping,
    };
  }

  return {
    action: 'send',
    label: 'Send',
    title: 'Send message',
    disabled: false,
  };
}
