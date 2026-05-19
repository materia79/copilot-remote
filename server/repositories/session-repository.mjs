'use strict';

export function createSessionRepository(db) {
    return {
        // conversations
        getConv:        db.prepare(`SELECT * FROM conversations WHERE id = ? AND status != 'deleted'`),
        getConvAnyStatus: db.prepare(`SELECT * FROM conversations WHERE id = ?`),
        listConvIdsMissingRuntimeSession: db.prepare(`SELECT c.id AS id FROM conversations c LEFT JOIN runtime_sessions rs ON rs.conversation_id = c.id WHERE rs.id IS NULL AND c.status != 'deleted'`),
        listConvs:      db.prepare(`SELECT c.id, c.title, c.archived, c.compacted_into, c.compacted_from, c.created_at, c.updated_at, rs.id AS runtime_session_id, rs.strategy AS runtime_strategy, rs.status AS runtime_status, rs.last_used_at AS runtime_last_used_at, COUNT(m.id) as message_count FROM conversations c LEFT JOIN messages m ON m.conversation_id = c.id LEFT JOIN runtime_sessions rs ON rs.conversation_id = c.id WHERE c.status != 'deleted' AND (? = 1 OR c.archived = 0) GROUP BY c.id ORDER BY c.updated_at DESC`),
        insertConv:     db.prepare(`INSERT OR IGNORE INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`),
        updateConvTime: db.prepare(`UPDATE conversations SET updated_at = ? WHERE id = ?`),
        updateConvSeed: db.prepare(`UPDATE conversations SET summary_seed = ?, seed_pending = ?, compacted_from = ?, updated_at = ? WHERE id = ?`),
        markConvCompacted: db.prepare(`UPDATE conversations SET archived = 1, compacted_into = ?, updated_at = ? WHERE id = ?`),
        getConvSeed:    db.prepare(`SELECT summary_seed, seed_pending FROM conversations WHERE id = ?`),
        clearConvSeed:  db.prepare(`UPDATE conversations SET seed_pending = 0, updated_at = ? WHERE id = ?`),
        archiveConv:    db.prepare(`UPDATE conversations SET archived = 1, updated_at = ? WHERE id = ?`),
        deleteConv:     db.prepare(`DELETE FROM conversations WHERE id = ?`),

        // messages
        getMessages:    db.prepare(`SELECT * FROM messages WHERE conversation_id = ? ORDER BY timestamp ASC`),
        getLatestConversationModel: db.prepare(`SELECT model FROM messages WHERE conversation_id = ? AND model IS NOT NULL AND model != '' ORDER BY timestamp DESC LIMIT 1`),
        getRecentMessagesDesc: db.prepare(`SELECT role, text, timestamp FROM messages WHERE conversation_id = ? ORDER BY timestamp DESC LIMIT ?`),
        insertMsg:      db.prepare(`INSERT INTO messages (id, conversation_id, role, text, model, mode, attachments, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),

        // queue
        insertQ:        db.prepare(`INSERT INTO queue (id, conversation_id, runtime_session_id, is_new_conversation, model, relay_mode, text, attachments, status, timestamp, retry_count, next_attempt_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, 0, NULL)`),
        findPending:    db.prepare(`SELECT * FROM queue WHERE status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY retry_count ASC, CASE WHEN next_attempt_at IS NULL THEN 0 ELSE 1 END ASC, COALESCE(next_attempt_at, timestamp) ASC, timestamp ASC LIMIT 1`),
        countStatus:    db.prepare(`SELECT status, COUNT(*) as cnt FROM queue WHERE status IN ('pending','processing') GROUP BY status`),
        countRuntimeSessions: db.prepare(`SELECT COUNT(*) AS cnt FROM runtime_sessions WHERE status = 'active'`),
        setProcessing:  db.prepare(`UPDATE queue SET status = 'processing', processing_at = ? WHERE id = ?`),
        setQueueRuntimeSession: db.prepare(`UPDATE queue SET runtime_session_id = ? WHERE id = ?`),
        setDone:        db.prepare(`UPDATE queue SET status = 'done', response = ?, processing_at = NULL, next_attempt_at = NULL WHERE id = ? AND status IN ('processing', 'pending')`),
        setFailed:      db.prepare(`UPDATE queue SET status = 'failed', response = ?, processing_at = NULL, next_attempt_at = NULL WHERE id = ?`),
        deleteConvQ:    db.prepare(`DELETE FROM queue WHERE conversation_id = ?`),
        findQById:      db.prepare(`SELECT * FROM queue WHERE id = ?`),
        pruneQueue:     db.prepare(`DELETE FROM queue WHERE status = 'done' AND id NOT IN (SELECT id FROM queue WHERE status = 'done' ORDER BY timestamp DESC LIMIT 200)`),
        recoverStale:   db.prepare(`UPDATE queue SET status = 'pending', processing_at = NULL, next_attempt_at = ? WHERE status = 'processing' AND processing_at < ?`),
        listRecoverableProcessing: db.prepare(`SELECT id, conversation_id FROM queue WHERE status = 'processing' AND processing_at < ?`),
        recoverProcessingBefore: db.prepare(`UPDATE queue SET status = 'pending', processing_at = NULL, next_attempt_at = ? WHERE status = 'processing' AND processing_at < ?`),
        listQueueForPauseDrop: db.prepare(`SELECT id, conversation_id FROM queue WHERE status IN ('pending', 'processing')`),
        deleteQueueById: db.prepare(`DELETE FROM queue WHERE id = ?`),
        getLatestProcessingQueueByConversation: db.prepare(`SELECT id, relay_mode, timestamp, processing_at FROM queue WHERE conversation_id = ? AND status = 'processing' ORDER BY COALESCE(processing_at, timestamp) DESC LIMIT 1`),

        // runtime sessions
        getRuntimeSessionByConversation: db.prepare(`SELECT * FROM runtime_sessions WHERE conversation_id = ?`),
        getRuntimeSessionById: db.prepare(`SELECT * FROM runtime_sessions WHERE id = ?`),
        listRuntimeSessions: db.prepare(`SELECT rs.*, c.title AS conversation_title, c.updated_at AS conversation_updated_at FROM runtime_sessions rs LEFT JOIN conversations c ON c.id = rs.conversation_id ORDER BY rs.last_used_at DESC`),
        insertRuntimeSession: db.prepare(`INSERT INTO runtime_sessions (id, conversation_id, strategy, runtime_key, model, status, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`),
        touchRuntimeSession: db.prepare(`UPDATE runtime_sessions SET model = ?, last_used_at = ?, status = 'active' WHERE id = ?`),
        deleteRuntimeSessionByConversation: db.prepare(`DELETE FROM runtime_sessions WHERE conversation_id = ?`),
    };
}
