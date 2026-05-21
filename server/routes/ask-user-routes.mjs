'use strict';

import { createAskUserRoutingService } from '../services/ask-user-routing-service.mjs';

function normalizeId(value) {
  const text = String(value || '').trim();
  return text || null;
}

function resolveNestedValue(source, keyPath) {
  let current = source;
  for (const key of keyPath) {
    if (!current || typeof current !== 'object') return null;
    current = current[key];
  }
  return current;
}

function firstKnownValue(source, keyPaths = []) {
  for (const keyPath of keyPaths) {
    const value = resolveNestedValue(source, keyPath);
    const normalized = normalizeId(value);
    if (normalized) return normalized;
  }
  return null;
}

function extractContinuationOwnership(rawRequest) {
  const parsed = rawRequest && typeof rawRequest === 'object' ? rawRequest : null;
  if (!parsed) {
    return {
      continuationId: null,
      continuationQuestionId: null,
    };
  }

  return {
    continuationId: firstKnownValue(parsed, [
      ['continuationId'],
      ['continuation_id'],
      ['continuation', 'id'],
      ['toolArgs', 'continuationId'],
      ['toolArgs', 'continuation_id'],
      ['toolArgs', 'continuation', 'id'],
      ['input', 'continuationId'],
      ['input', 'continuation_id'],
      ['input', 'continuation', 'id'],
      ['request', 'continuationId'],
      ['request', 'continuation_id'],
      ['request', 'continuation', 'id'],
      ['arguments', 'continuationId'],
      ['arguments', 'continuation_id'],
      ['arguments', 'continuation', 'id'],
    ]),
    continuationQuestionId: firstKnownValue(parsed, [
      ['questionId'],
      ['question_id'],
      ['askUserQuestionId'],
      ['ask_user_question_id'],
      ['continuation', 'questionId'],
      ['continuation', 'question_id'],
      ['toolArgs', 'questionId'],
      ['toolArgs', 'question_id'],
      ['input', 'questionId'],
      ['input', 'question_id'],
      ['request', 'questionId'],
      ['request', 'question_id'],
      ['arguments', 'questionId'],
      ['arguments', 'question_id'],
    ]),
  };
}

export function registerAskUserRoutes(app, deps) {
  const {
    auth,
    io,
    db,
    stmts,
    runtimeState,
    uuidv4,
    ts,
    questionExpiresAt,
    sanitizeRelayQuestionPrompt,
    sanitizeRelayQuestionRequest,
    sanitizeRelayQuestionContext,
    parseQuestionRequest,
    normalizeQuestionChoices,
    formatQuestionRow,
    normalizeRelayMode,
    DEFAULT_RELAY_MODE,
    sessionWorkerRegistry,
  } = deps;

  const continuationRoutingEnabled = runtimeState?.featureFlags?.SESSION_WORKER_CONTINUATION_ROUTING_ENABLED === true;
  const workerRoutingEnabled = runtimeState?.featureFlags?.SESSION_WORKER_ROUTING_ENABLED === true;
  const askUserRoutingService = createAskUserRoutingService(db, {
    continuationRoutingEnabled,
    sessionWorkerRegistry,
  });

  app.get('/api/relay-questions', auth, (req, res) => {
    const conversationId = req.query.conversationId ? String(req.query.conversationId) : null;
    const status = String(req.query.status || 'pending').trim() || 'pending';
    const rows = stmts.listQuestions.all(status, conversationId, conversationId);
    res.json({ questions: rows.map(formatQuestionRow) });
  });

  app.get('/api/relay-question/:id', auth, (req, res) => {
    const row = stmts.getQuestion.get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json({ question: formatQuestionRow(row) });
  });

  app.post('/api/relay-question', auth, (req, res) => {
    const { queueId, messageId, conversationId, mode, prompt, choices, request, context, allowFreeform } = req.body;
    const q = stmts.findQById.get(queueId || messageId);
    if (!q || q.status !== 'processing') {
      return res.status(409).json({ error: 'No active relay turn' });
    }

    const effectiveMessageId = messageId || q.id;
    const existingPending = stmts.findPendingQuestionByMessage.get(effectiveMessageId);
    if (existingPending) {
      const question = formatQuestionRow(existingPending);
      return res.json({ question, reused: true });
    }

    const relayMode = normalizeRelayMode(mode || q.relay_mode) || DEFAULT_RELAY_MODE;
    const now = new Date().toISOString();
    const questionId = uuidv4();
    const requestedSessionId = normalizeId(req.body.sdk_session_id);
    const queueOwnerSessionId = workerRoutingEnabled || continuationRoutingEnabled
      ? normalizeId(q.owner_sdk_session_id)
      : null;
    const sdkSessionId = requestedSessionId || queueOwnerSessionId || null;
    const ownerWorkerId = sdkSessionId
      ? normalizeId(sessionWorkerRegistry?.getWorker?.(sdkSessionId)?.workerId)
      : null;
    const promptText = sanitizeRelayQuestionPrompt({ prompt });
    const parsedQuestionRequest = parseQuestionRequest(request);
    const normalizedChoices = normalizeQuestionChoices(choices);
    const requestJson = sanitizeRelayQuestionRequest({
      request: parsedQuestionRequest,
      context: sanitizeRelayQuestionContext(context),
      allowFreeform: typeof allowFreeform === 'boolean' ? allowFreeform : (!normalizedChoices.length),
    });
    const continuation = continuationRoutingEnabled
      ? extractContinuationOwnership(parsedQuestionRequest)
      : { continuationId: null, continuationQuestionId: null };
    const expiresAt = questionExpiresAt(now);

    stmts.insertQuestion.run(
      questionId,
      q.id,
      conversationId || q.conversation_id,
      effectiveMessageId,
      relayMode,
      promptText,
      normalizedChoices.length ? JSON.stringify(normalizedChoices) : null,
      requestJson,
      sdkSessionId,
      ownerWorkerId,
      continuation.continuationId,
      continuation.continuationQuestionId,
      now,
      expiresAt,
    );

    const question = formatQuestionRow(stmts.getQuestion.get(questionId));
    console.log(`[${ts()}] QUESTION  ${questionId.slice(0,8)} conv=${question.conversationId.slice(0,8)} mode=${relayMode} prompt="${promptText.slice(0,60)}"`);
    io.emit('relay_question', { question });
    res.json({ question });
  });

  app.post('/api/relay-question/:id/answer', auth, (req, res) => {
    const id = String(req.params.id || '').trim();
    const { answer, sdk_session_id, continuation_id, continuation_question_id } = req.body;
    const text = String(answer || '').trim();
    const sdkSessionId = normalizeId(sdk_session_id);
    const continuationId = normalizeId(continuation_id);
    const continuationQuestionId = normalizeId(continuation_question_id);
    if (!text) return res.status(400).json({ error: 'Empty answer' });

    const row = stmts.getQuestion.get(id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (row.status !== 'pending') return res.status(409).json({ error: `Question already ${row.status}` });

    const result = askUserRoutingService.routeAnswer({
      question_id: id,
      sdk_session_id: sdkSessionId,
      continuation_id: continuationId,
      continuation_question_id: continuationQuestionId,
      answer: text,
    });
    if (!result.ok) {
      console.warn(
        `[${ts()}] QUESTION  reject id=${id.slice(0, 8)} reason=${String(result.error || 'unknown').slice(0, 64)} sid=${String(sdkSessionId || 'none').slice(0, 8)}`,
      );
      if (result.error === 'session mismatch' || result.error === 'owner mismatch') {
        const targetSessionId = String(row.sdk_session_id || '').trim() || null;
        return res.status(403).json({ error: result.error, expectedSessionId: targetSessionId });
      }
      return res.status(400).json({ error: result.error });
    }

    const question = formatQuestionRow(stmts.getQuestion.get(id));
    console.log(`[${ts()}] QUESTION  ${id.slice(0,8)} answered len=${text.length}`);
    io.emit('relay_question_updated', { question });
    res.json({ ok: true, question });
  });

  app.post('/api/relay-question/:id/timeout', auth, (req, res) => {
    const row = stmts.getQuestion.get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (row.status !== 'pending') return res.json({ ok: true, question: formatQuestionRow(row) });

    const result = stmts.timeoutQuestion.run(row.id);
    if (result.changes > 0) {
      const question = formatQuestionRow(stmts.getQuestion.get(row.id));
      console.log(`[${ts()}] QUESTION  ${row.id.slice(0,8)} timed out`);
      io.emit('relay_question_updated', { question });
      return res.json({ ok: true, question });
    }

    return res.json({ ok: true, question: formatQuestionRow(stmts.getQuestion.get(row.id)) });
  });
}
