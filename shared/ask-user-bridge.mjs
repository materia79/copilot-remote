import {
  DEFAULT_QUESTION_TIMEOUT_MS,
  QUESTION_TIMEOUT_CONTINUATION_TEXT,
} from './question-timeout.mjs';

function sleepDefault(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeQuestions(input) {
  const questions = Array.isArray(input?.questions) ? input.questions : [];
  return questions
    .map((entry) => ({
      question: String(entry?.question || '').trim(),
      // The SDK joins answers back by EXACT question text; a model question
      // with stray whitespace must still match its answer key.
      rawQuestion: String(entry?.question || ''),
      header: String(entry?.header || '').trim(),
      multiSelect: entry?.multiSelect === true,
      // Structured-elicitation parity: a schema object rides through to the
      // create payload untouched (the server normalizes and validates it).
      requestedSchema: entry?.requestedSchema && typeof entry.requestedSchema === 'object'
        && !Array.isArray(entry.requestedSchema)
        ? entry.requestedSchema
        : null,
      options: (Array.isArray(entry?.options) ? entry.options : [])
        .map((option) => ({
          label: String(option?.label || '').trim(),
          description: String(option?.description || '').trim(),
        }))
        .filter((option) => option.label),
    }))
    .filter((entry) => entry.question);
}

/**
 * Bridge a provider worker's ask-user tool onto the relay question cards.
 *
 * `handleAskUserQuestion(input, { signal })` posts one relay question per
 * question entry, waits for the answers, and returns the collected `answers`
 * map (question text -> answer string). Provider workers identify themselves
 * via `questionSource` / `questionRationale` (defaults preserve the Claude
 * worker's original wire payload).
 */
export function createAskUserBridge({
  api,
  getActiveMessage,
  sdkSessionId = '',
  sleep = sleepDefault,
  questionPollMs = 1500,
  questionTimeoutMs = DEFAULT_QUESTION_TIMEOUT_MS,
  questionSource = 'AskUserQuestion',
  questionRationale = 'Claude requested clarification to continue this turn.',
  dbg = () => {},
} = {}) {
  // `timeoutMs` overrides the bridge-wide default for one wait (a structured
  // elicitation may carry its own deadline). Additive: existing callers pass
  // only `signal` and behave exactly as before.
  async function waitForRelayQuestionAnswer(questionId, { signal, timeoutMs } = {}) {
    const started = Date.now();
    const deadlineMs = timeoutMs ?? questionTimeoutMs;
    while (true) {
      if (signal?.aborted) {
        await api('POST', `/api/relay-question/${questionId}/timeout`, {}).catch(() => {});
        return { answer: QUESTION_TIMEOUT_CONTINUATION_TEXT, timedOut: true, aborted: true };
      }
      const { question } = await api('GET', `/api/relay-question/${questionId}`);
      if (!question) throw new Error('Relay question missing');
      if (question.status === 'answered') {
        return {
          answer: String(question.answer || '').trim(),
          // The validated structured submission, when the card carried a
          // `requestedSchema` and the relay stored one. Null otherwise — flat
          // consumers read `answer` and never see a shape change.
          structuredAnswer: question.structuredAnswer && typeof question.structuredAnswer === 'object'
            && !Array.isArray(question.structuredAnswer)
            ? question.structuredAnswer
            : null,
          timedOut: false,
        };
      }
      if (question.status === 'timed_out' || question.status === 'cancelled') {
        return { answer: QUESTION_TIMEOUT_CONTINUATION_TEXT, timedOut: true };
      }
      if (Date.now() - started >= deadlineMs) {
        await api('POST', `/api/relay-question/${questionId}/timeout`, {}).catch(() => {});
        return { answer: QUESTION_TIMEOUT_CONTINUATION_TEXT, timedOut: true };
      }
      await sleep(questionPollMs);
    }
  }

  async function askSingleQuestion(entry, { signal } = {}) {
    const activeMsg = typeof getActiveMessage === 'function' ? getActiveMessage() : null;
    const choices = entry.options.map((option) => option.label);
    const promptParts = [entry.question];
    const optionDetails = entry.options
      .filter((option) => option.description)
      .map((option) => `- ${option.label}: ${option.description}`);
    if (optionDetails.length) promptParts.push(optionDetails.join('\n'));
    const questionPayload = {
      queueId: activeMsg?.id,
      messageId: activeMsg?.id,
      conversationId: activeMsg?.conversationId,
      mode: activeMsg?.relayMode || 'agent',
      prompt: promptParts.join('\n\n'),
      choices,
      allowFreeform: true,
      // Top-level, as the create route reads it (elicitation parity; absent
      // for the flat question shape every existing caller sends).
      ...(entry.requestedSchema ? { requestedSchema: entry.requestedSchema } : {}),
      sdk_session_id: sdkSessionId || undefined,
      // Fences the card to the delivering attempt: the server refuses creation
      // once the row has been requeued to a newer attempt.
      attemptId: activeMsg?.attemptId || undefined,
      timeout_ms: questionTimeoutMs,
      context: {
        source: questionSource,
        rationale: questionRationale,
        queueMessageId: activeMsg?.id || null,
        conversationId: activeMsg?.conversationId || null,
        relayMode: activeMsg?.relayMode || 'agent',
        header: entry.header || undefined,
        multiSelect: entry.multiSelect || undefined,
      },
    };
    const created = await api('POST', '/api/relay-question', questionPayload);
    const questionId = created?.question?.id;
    if (!questionId) throw new Error('Relay question could not be created');
    dbg('relay question created', questionId, 'prompt=', entry.question.slice(0, 80));
    return waitForRelayQuestionAnswer(questionId, { signal });
  }

  async function handleAskUserQuestion(input, { signal } = {}) {
    const questions = normalizeQuestions(input);
    if (!questions.length) {
      return { answers: {}, structuredAnswers: {}, timedOut: false };
    }
    const answers = {};
    // Validated structured submissions, keyed like `answers`, present only for
    // questions that carried a `requestedSchema`. Flat consumers keep reading
    // `answers` unchanged.
    const structuredAnswers = {};
    let timedOut = false;
    for (const entry of questions) {
      const result = await askSingleQuestion(entry, { signal });
      answers[entry.question] = result.answer;
      if (result.structuredAnswer) structuredAnswers[entry.question] = result.structuredAnswer;
      if (entry.rawQuestion && entry.rawQuestion !== entry.question) {
        answers[entry.rawQuestion] = result.answer;
        if (result.structuredAnswer) structuredAnswers[entry.rawQuestion] = result.structuredAnswer;
      }
      if (result.timedOut) timedOut = true;
      if (result.aborted) break;
    }
    return { answers, structuredAnswers, timedOut };
  }

  return {
    handleAskUserQuestion,
    waitForRelayQuestionAnswer,
  };
}
