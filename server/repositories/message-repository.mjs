'use strict';

export function createMessageRepository(db) {
    return {
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


        // uploads
        getUploadFile: db.prepare(`SELECT * FROM uploaded_files WHERE sha256 = ?`),
        insertUploadFile: db.prepare(`INSERT OR IGNORE INTO uploaded_files (sha256, original_name, mime_type, size_bytes, created_at) VALUES (?, ?, ?, ?, ?)`),
        insertUploadRef: db.prepare(`INSERT OR IGNORE INTO upload_refs (file_sha256, conversation_id, message_id, created_at) VALUES (?, ?, ?, ?)`),
        listUploadHashesByConversation: db.prepare(`SELECT DISTINCT file_sha256 FROM upload_refs WHERE conversation_id = ?`),
        deleteUploadRefsByConversation: db.prepare(`DELETE FROM upload_refs WHERE conversation_id = ?`),
        countUploadRefsBySha: db.prepare(`SELECT COUNT(*) AS cnt FROM upload_refs WHERE file_sha256 = ?`),
        deleteUploadFile: db.prepare(`DELETE FROM uploaded_files WHERE sha256 = ?`),
    };
}
