import test from 'node:test';
import assert from 'node:assert/strict';
import { registerRelayBoardRoutes } from './relay-board-routes.mjs';

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

function createHarness() {
  const app = createFakeApp();
  const emitted = [];
  const boards = new Map();
  const queueMessages = [];
  const userMessages = [];
  const queueRows = new Map();
  const conversations = new Map();

  const stmts = {
    listBoards: {
      all: (status, _conversationA, _conversationB) =>
        Array.from(boards.values()).filter((row) => row.status === status),
    },
    getBoard: {
      get: (id) => boards.get(id) || null,
    },
    findQById: {
      get: (id) => queueRows.get(id) || null,
    },
    findBoardByMessageType: {
      get: (messageId, boardType) =>
        Array.from(boards.values()).find((row) => row.message_id === messageId && row.board_type === boardType) || null,
    },
    insertBoard: {
      run: (id, queueId, conversationId, messageId, boardType, relayMode, title, body, actionsJson, recommendedAction, contextJson, createdAt, updatedAt) => {
        boards.set(id, {
          id,
          queue_id: queueId,
          conversation_id: conversationId,
          message_id: messageId,
          board_type: boardType,
          relay_mode: relayMode,
          title,
          body,
          actions_json: actionsJson,
          recommended_action: recommendedAction,
          context_json: contextJson,
          status: 'pending',
          selected_action: null,
          acted_at: null,
          created_at: createdAt,
          updated_at: updatedAt,
        });
      },
    },
    markBoardAction: {
      run: (selectedAction, actedAt, updatedAt, id) => {
        const row = boards.get(id);
        if (!row || row.status !== 'pending') return { changes: 0 };
        row.status = 'acted';
        row.selected_action = selectedAction;
        row.acted_at = actedAt;
        row.updated_at = updatedAt;
        boards.set(id, row);
        return { changes: 1 };
      },
    },
    dismissBoard: {
      run: (selectedAction, actedAt, updatedAt, id) => {
        const row = boards.get(id);
        if (!row || row.status !== 'pending') return { changes: 0 };
        row.status = 'dismissed';
        row.selected_action = selectedAction;
        row.acted_at = actedAt;
        row.updated_at = updatedAt;
        boards.set(id, row);
        return { changes: 1 };
      },
    },
    getRuntimeSessionByConversation: {
      get: (conversationId) => conversations.get(conversationId)?.runtimeSession || null,
    },
    getLatestConversationModel: {
      get: (conversationId) => conversations.get(conversationId)?.latestModel || null,
    },
    insertMsg: {
      run: (id, conversationId, role, text, model, mode, attachments, timestamp) => {
        userMessages.push({ id, conversationId, role, text, model, mode, attachments, timestamp });
      },
    },
    updateConvTime: {
      run: (updatedAt, conversationId) => {
        const entry = conversations.get(conversationId) || {};
        entry.updatedAt = updatedAt;
        conversations.set(conversationId, entry);
      },
    },
    insertQ: {
      run: (...args) => {
        queueMessages.push(args);
      },
    },
  };

  registerRelayBoardRoutes(app, {
    auth: (_req, _res, next) => next?.(),
    io: {
      emit(event, payload) {
        emitted.push({ event, payload });
      },
    },
    stmts,
    uuidv4: (() => {
      let i = 0;
      return () => `id-${++i}`;
    })(),
    normalizeRelayMode: (mode) => String(mode || '').trim().toLowerCase() || null,
    DEFAULT_RELAY_MODE: 'agent',
    formatRelayBoardRow: (row) => {
      if (!row) return null;
      return {
        id: row.id,
        queueId: row.queue_id,
        conversationId: row.conversation_id,
        messageId: row.message_id,
        boardType: row.board_type,
        mode: row.relay_mode,
        title: row.title,
        body: row.body,
        actions: row.actions_json ? JSON.parse(row.actions_json) : [],
        recommendedAction: row.recommended_action || null,
        status: row.status,
        selectedAction: row.selected_action || null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    },
  });

  return {
    app,
    emitted,
    boards,
    queueRows,
    queueMessages,
    userMessages,
    conversations,
  };
}

test('relay board create dedupes by message+board_type', () => {
  const harness = createHarness();
  harness.queueRows.set('msg-1', {
    id: 'msg-1',
    status: 'processing',
    conversation_id: 'conv-1',
    relay_mode: 'plan',
  });
  const createHandler = harness.app.routes.get('POST /api/relay-board');
  const req = {
    body: {
      queueId: 'msg-1',
      messageId: 'msg-1',
      conversationId: 'conv-1',
      mode: 'plan',
      boardType: 'plan_ready',
      title: 'Plan ready for review',
      body: '- item',
      actions: ['autopilot', 'exit_only'],
      recommendedAction: 'autopilot',
    },
  };

  const firstRes = createFakeRes();
  createHandler(req, firstRes);
  assert.equal(firstRes.statusCode, 200);
  assert.equal(firstRes.body?.reused, undefined);
  assert.equal(harness.boards.size, 1);

  const secondRes = createFakeRes();
  createHandler(req, secondRes);
  assert.equal(secondRes.statusCode, 200);
  assert.equal(secondRes.body?.reused, true);
  assert.equal(harness.boards.size, 1);
  assert.equal(harness.emitted.filter((entry) => entry.event === 'relay_board').length, 1);
});

test('relay board action queues follow-up for non-exit action', () => {
  const harness = createHarness();
  harness.conversations.set('conv-2', {
    runtimeSession: { id: 'runtime-2' },
    latestModel: { model: 'gpt-5.4-mini' },
  });
  harness.boards.set('board-1', {
    id: 'board-1',
    queue_id: 'msg-2',
    conversation_id: 'conv-2',
    message_id: 'msg-2',
    board_type: 'plan_ready',
    relay_mode: 'plan',
    title: 'Plan ready for review',
    body: '- do work',
    actions_json: JSON.stringify([{ id: 'autopilot', label: 'Implement in autopilot' }]),
    recommended_action: 'autopilot',
    context_json: null,
    status: 'pending',
    selected_action: null,
    acted_at: null,
    created_at: 'ts',
    updated_at: 'ts',
  });

  const actionHandler = harness.app.routes.get('POST /api/relay-board/:id/action');
  const res = createFakeRes();
  actionHandler({
    params: { id: 'board-1' },
    body: { actionId: 'autopilot', clientId: 'client-1' },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body?.ok, true);
  assert.equal(String(res.body?.queuedMessageId || '').startsWith('id-'), true);
  assert.equal(harness.queueMessages.length, 1);
  assert.equal(harness.userMessages.length, 1);
  assert.equal(harness.boards.get('board-1')?.status, 'acted');
  assert.equal(harness.emitted.some((entry) => entry.event === 'relay_board_updated'), true);
});
