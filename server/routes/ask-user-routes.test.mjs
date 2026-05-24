import test from "node:test";
import assert from "node:assert/strict";
import { registerAskUserRoutes } from "./ask-user-routes.mjs";

function createFakeApp() {
  const routes = new Map();
  return {
    routes,
    get(path, ...handlers) {
      routes.set(`GET ${path}`, handlers[handlers.length - 1]);
    },
    post(path, ...handlers) {
      routes.set(`POST ${path}`, handlers[handlers.length - 1]);
    },
  };
}

function createFakeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

test("relay question creation uses timeout overrides from the active turn", () => {
  const app = createFakeApp();
  let capturedTimeoutMs = null;
  const insertedQuestions = new Map();
  const db = {
    prepare(query) {
      const sql = String(query || '');
      if (sql.includes('PRAGMA table_info(relay_questions)')) {
        return { all: () => [] };
      }
      if (sql.includes('SELECT * FROM relay_questions WHERE id = ?')) {
        return { get: (id) => insertedQuestions.get(id) || null };
      }
      if (sql.includes("UPDATE relay_questions")) {
        return { run: () => ({ changes: 1 }) };
      }
      if (sql.includes('WHERE sdk_session_id = ? AND message_id = ?')) {
        return { get: () => null };
      }
      return { get: () => null, run: () => ({ changes: 0 }), all: () => [] };
    },
  };

  registerAskUserRoutes(app, {
    auth: (_req, _res, next) => next?.(),
    io: { emit: () => {} },
    db,
    stmts: {
      listQuestions: { all: () => [] },
      getQuestion: { get: (id) => insertedQuestions.get(id) || null },
      findQById: { get: () => ({ id: "msg-1", status: "processing", conversation_id: "conv-1", relay_mode: "agent", owner_sdk_session_id: "sdk-1" }) },
      findPendingQuestionByMessage: { get: () => null },
      insertQuestion: {
        run: (id, queueId, conversationId, messageId, relayMode, prompt, choicesJson, requestJson, sdkSessionId, ownerWorkerId, continuationId, continuationQuestionId, createdAt, expiresAt) => {
          insertedQuestions.set(id, {
            id,
            queue_id: queueId,
            conversation_id: conversationId,
            message_id: messageId,
            relay_mode: relayMode,
            prompt,
            choices_json: choicesJson,
            request_json: requestJson,
            sdk_session_id: sdkSessionId,
            owner_worker_id: ownerWorkerId,
            continuation_id: continuationId,
            continuation_question_id: continuationQuestionId,
            created_at: createdAt,
            expires_at: expiresAt,
          });
        },
      },
      timeoutQuestion: { run: () => ({ changes: 1 }) },
    },
    runtimeState: { featureFlags: { SESSION_WORKER_CONTINUATION_ROUTING_ENABLED: false, SESSION_WORKER_ROUTING_ENABLED: true } },
    uuidv4: () => "question-1",
    ts: () => "ts",
    questionExpiresAt: (_createdAt, timeoutMs) => {
      capturedTimeoutMs = timeoutMs;
      return "expires-at";
    },
    sanitizeRelayQuestionPrompt: ({ prompt }) => String(prompt || "").trim(),
    sanitizeRelayQuestionRequest: ({ request, context, allowFreeform }) => JSON.stringify({ request, context, allowFreeform }),
    sanitizeRelayQuestionContext: (context) => context,
    parseQuestionRequest: (request) => request,
    normalizeQuestionChoices: (choices) => Array.isArray(choices) ? choices : [],
    formatQuestionRow: (row) => ({
      id: row.id,
      conversationId: row.conversation_id,
      expiresAt: row.expires_at,
    }),
    normalizeRelayMode: (mode) => mode,
    DEFAULT_RELAY_MODE: "agent",
    sessionWorkerRegistry: {
      getWorker: () => ({ workerId: "worker-1" }),
    },
  });

  const handler = app.routes.get("POST /api/relay-question");
  const res = createFakeRes();
  handler({
    body: {
      queueId: "msg-1",
      prompt: "Need input",
      choices: ["Yes", "No"],
      timeout_ms: 7_200_000,
    },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(capturedTimeoutMs, 7_200_000);
  assert.equal(res.body?.question?.expiresAt, "expires-at");
});
