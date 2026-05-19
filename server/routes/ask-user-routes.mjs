'use strict';

export function registerAskUserRoutes(app, deps) {
  const {
    auth,
    io,
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
  } = deps;

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
    const promptText = sanitizeRelayQuestionPrompt({ prompt });
    const normalizedChoices = normalizeQuestionChoices(choices);
    const requestJson = sanitizeRelayQuestionRequest({
      request: parseQuestionRequest(request),
      context: sanitizeRelayQuestionContext(context),
      allowFreeform: typeof allowFreeform === 'boolean' ? allowFreeform : (!normalizedChoices.length),
    });
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
      now,
      expiresAt,
    );

    const question = formatQuestionRow(stmts.getQuestion.get(questionId));
    console.log(`[${ts()}] QUESTION  ${questionId.slice(0,8)} conv=${question.conversationId.slice(0,8)} mode=${relayMode} prompt="${promptText.slice(0,60)}"`);
    io.emit('relay_question', { question });
    res.json({ question });
  });

  app.post('/api/relay-question/:id/answer', auth, (req, res) => {
    const { answer } = req.body;
    const text = String(answer || '').trim();
    if (!text) return res.status(400).json({ error: 'Empty answer' });

    const row = stmts.getQuestion.get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (row.status !== 'pending') return res.status(409).json({ error: `Question already ${row.status}` });

    const now = new Date().toISOString();
    const result = stmts.answerQuestion.run(text, now, row.id);
    if (result.changes === 0) return res.status(409).json({ error: 'Question is no longer pending' });

    const question = formatQuestionRow(stmts.getQuestion.get(row.id));
    console.log(`[${ts()}] QUESTION  ${row.id.slice(0,8)} answered len=${text.length}`);
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
