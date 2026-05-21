'use strict';

export function createQuestionRepository(db) {
    return {
        // relay questions
        insertQuestion: db.prepare(`INSERT INTO relay_questions (id, queue_id, conversation_id, message_id, relay_mode, prompt, choices, request, status, answer, sdk_session_id, owner_worker_id, continuation_id, continuation_question_id, created_at, answered_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?, ?, ?, ?, NULL, ?)`),
        getQuestion:    db.prepare(`SELECT * FROM relay_questions WHERE id = ?`),
        findPendingQuestionByMessage: db.prepare(`SELECT * FROM relay_questions WHERE message_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1`),
        listQuestions:  db.prepare(`SELECT * FROM relay_questions WHERE status = ? AND (? IS NULL OR conversation_id = ?) ORDER BY created_at ASC`),
        answerQuestion: db.prepare(`UPDATE relay_questions SET status = 'answered', answer = ?, answered_at = ? WHERE id = ? AND status = 'pending'`),
        timeoutQuestion:db.prepare(`UPDATE relay_questions SET status = 'timed_out' WHERE id = ? AND status = 'pending'`),
        deleteConvQuestions: db.prepare(`DELETE FROM relay_questions WHERE conversation_id = ?`),
        expireQuestions: db.prepare(`UPDATE relay_questions SET status = 'timed_out' WHERE status = 'pending' AND expires_at < ?`),

        // relay activity
        insertActivity: db.prepare(`INSERT INTO relay_activity (queue_message_id, response_message_id, conversation_id, relay_mode, text, created_at) VALUES (?, ?, ?, ?, ?, ?)`),
        linkActivityToResponse: db.prepare(`UPDATE relay_activity SET response_message_id = ? WHERE queue_message_id = ? AND response_message_id IS NULL`),
        listActivityByResponse: db.prepare(`SELECT text FROM relay_activity WHERE response_message_id = ? ORDER BY id ASC`),
        listActivityByQueueMessage: db.prepare(`SELECT text FROM relay_activity WHERE queue_message_id = ? ORDER BY id ASC`),
        deleteConvActivity: db.prepare(`DELETE FROM relay_activity WHERE conversation_id = ?`),
    };
}
