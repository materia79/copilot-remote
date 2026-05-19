'use strict';

export function createSdkSessionSyncService(db, features) {
  void features;

  const updateConversationSession = db.prepare(
    `UPDATE conversations SET sdk_session_id = ? WHERE id = ?`,
  );
  const updateRuntimeSession = db.prepare(
    `UPDATE runtime_sessions SET sdk_session_id = ? WHERE conversation_id = ?`,
  );

  const syncSessionTxn = db.transaction(({ sdkSessionId, conversationId }) => {
    updateConversationSession.run(sdkSessionId, conversationId);
    updateRuntimeSession.run(sdkSessionId, conversationId);
  });

  return {
    syncSession(payload = {}) {
      const sdkSessionId = String(payload.sdk_session_id || '').trim();
      const conversationId = String(payload.conversation_id || '').trim();

      if (!sdkSessionId) {
        throw new Error('Missing sdk_session_id');
      }
      if (!conversationId) {
        throw new Error('Missing conversation_id');
      }

      syncSessionTxn({ sdkSessionId, conversationId });
      return { ok: true };
    },
  };
}
