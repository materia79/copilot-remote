'use strict';

export function createQuestionRepository(db) {
    return {
        // relay questions
        insertQuestion: db.prepare(`INSERT INTO relay_questions (id, queue_id, conversation_id, message_id, relay_mode, prompt, choices, request, request_schema, status, answer, structured_answer, sdk_session_id, owner_worker_id, continuation_id, continuation_question_id, created_at, answered_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, ?, ?, ?, ?, NULL, ?)`),
        getQuestion:    db.prepare(`SELECT * FROM relay_questions WHERE id = ?`),
        findPendingQuestionByMessage: db.prepare(`SELECT * FROM relay_questions WHERE message_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1`),
        findRecentlyAnsweredQuestionByMessage: db.prepare(`SELECT * FROM relay_questions WHERE message_id = ? AND status = 'answered' AND answered_at >= ? ORDER BY answered_at DESC LIMIT 1`),
        listQuestions:  db.prepare(`SELECT * FROM relay_questions WHERE status = ? AND (? IS NULL OR conversation_id = ?) ORDER BY created_at ASC`),
        timeoutQuestion:db.prepare(`UPDATE relay_questions SET status = 'timed_out' WHERE id = ? AND status = 'pending'`),
        deleteConvQuestions: db.prepare(`DELETE FROM relay_questions WHERE conversation_id = ?`),
        expireQuestions: db.prepare(`UPDATE relay_questions SET status = 'timed_out' WHERE status = 'pending' AND expires_at < ?`),

        // relay activity
        insertActivity: db.prepare(`INSERT INTO relay_activity (queue_message_id, response_message_id, conversation_id, relay_mode, text, created_at) VALUES (?, ?, ?, ?, ?, ?)`),
        linkActivityToResponse: db.prepare(`UPDATE relay_activity SET response_message_id = ? WHERE queue_message_id = ? AND response_message_id IS NULL`),
        listActivityByResponse: db.prepare(`SELECT text FROM relay_activity WHERE response_message_id = ? ORDER BY id ASC`),
        listActivityByQueueMessage: db.prepare(`SELECT text FROM relay_activity WHERE queue_message_id = ? ORDER BY id ASC`),
        deleteConvActivity: db.prepare(`DELETE FROM relay_activity WHERE conversation_id = ?`),

        // relay stream events
        getLastStreamSeqByQueueMessage: db.prepare(`SELECT COALESCE(MAX(seq), 0) AS max_seq FROM relay_stream_events WHERE queue_message_id = ?`),
        insertStreamEvent: db.prepare(`INSERT INTO relay_stream_events (queue_message_id, response_message_id, conversation_id, relay_mode, seq, text, done, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
        linkStreamEventsToResponse: db.prepare(`UPDATE relay_stream_events SET response_message_id = ? WHERE queue_message_id = ? AND response_message_id IS NULL`),
        listStreamEventsByResponse: db.prepare(`SELECT seq, text, done, created_at FROM relay_stream_events WHERE response_message_id = ? ORDER BY seq ASC, id ASC`),
        listStreamEventsByQueueMessage: db.prepare(`SELECT seq, text, done, created_at FROM relay_stream_events WHERE queue_message_id = ? ORDER BY seq ASC, id ASC`),
        deleteConvStreamEvents: db.prepare(`DELETE FROM relay_stream_events WHERE conversation_id = ?`),

        // relay thoughts (agent reasoning)
        getLastThoughtSeqByQueueMessage: db.prepare(`SELECT COALESCE(MAX(seq), 0) AS max_seq FROM relay_thought WHERE queue_message_id = ?`),
        insertThought: db.prepare(`INSERT INTO relay_thought (queue_message_id, response_message_id, conversation_id, relay_mode, reasoning_id, seq, text, done, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
        linkThoughtsToResponse: db.prepare(`UPDATE relay_thought SET response_message_id = ? WHERE queue_message_id = ? AND response_message_id IS NULL`),
        listThoughtsByResponse: db.prepare(`SELECT reasoning_id, seq, text, done, created_at FROM relay_thought WHERE response_message_id = ? ORDER BY seq ASC, id ASC`),
        listThoughtsByQueueMessage: db.prepare(`SELECT reasoning_id, seq, text, done, created_at FROM relay_thought WHERE queue_message_id = ? ORDER BY seq ASC, id ASC`),
        deleteConvThoughts: db.prepare(`DELETE FROM relay_thought WHERE conversation_id = ?`),

        // relay boards
        insertBoard: db.prepare(`INSERT INTO relay_boards (id, queue_id, conversation_id, message_id, board_type, relay_mode, title, body, actions_json, recommended_action, context_json, status, selected_action, acted_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, ?)`),
        getBoard: db.prepare(`SELECT * FROM relay_boards WHERE id = ?`),
        findBoardByMessageType: db.prepare(`SELECT * FROM relay_boards WHERE message_id = ? AND board_type = ? ORDER BY created_at DESC LIMIT 1`),
        listBoards: db.prepare(`SELECT * FROM relay_boards WHERE status = ? AND (? IS NULL OR conversation_id = ?) ORDER BY created_at ASC`),
        markBoardAction: db.prepare(`UPDATE relay_boards SET status = 'acted', selected_action = ?, acted_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'`),
        dismissBoard: db.prepare(`UPDATE relay_boards SET status = 'dismissed', selected_action = ?, acted_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'`),
        deleteConvBoards: db.prepare(`DELETE FROM relay_boards WHERE conversation_id = ?`),
    };
}
