'use strict';

export function createAskUserRoutingService(db) {
  const findQuestion = db.prepare(`SELECT * FROM relay_questions WHERE id = ?`);
  const updateAnswered = db.prepare(`
    UPDATE relay_questions
    SET status = 'answered', answer = ?, answered_at = datetime('now')
    WHERE id = ?
  `);
  const findBySdkSessionAndMessage = db.prepare(`
    SELECT * FROM relay_questions
    WHERE sdk_session_id = ? AND message_id = ?
    LIMIT 1
  `);

  function routeAnswer({ question_id, sdk_session_id, answer }) {
    const row = findQuestion.get(question_id);
    if (!row) return { ok: false, error: 'Question not found' };

    if (sdk_session_id) {
      const rowSession = String(row.sdk_session_id || '').trim();
      const incomingSession = String(sdk_session_id || '').trim();
      if (rowSession && incomingSession && rowSession !== incomingSession) {
        return { ok: false, error: 'session mismatch' };
      }
    }

    updateAnswered.run(answer, question_id);
    return { ok: true };
  }

  function lookupQuestion({ sdk_session_id, message_id }) {
    if (!sdk_session_id || !message_id) return null;
    return findBySdkSessionAndMessage.get(sdk_session_id, message_id) || null;
  }

  return { routeAnswer, lookupQuestion };
}
