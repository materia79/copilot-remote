// Owns the CopilotClient / CopilotSession lifecycle for one relay conversation
// and runs the delivered turns through them.
//
// Contract-wise this is the Cursor/Claude worker's `handlePendingPayload`
// runner with a different engine underneath: same relay channels, same
// response/requeue/abort semantics, same terminal-error record shape. The
// engine-specific part is that the Copilot SDK does not hand back an async
// iterator for a turn — `send()` resolves as soon as the prompt is accepted —
// so the turn is driven as a small state machine over the session's event
// callback. `sendAndWait()` is deliberately unused: it has a hard 60s internal
// timeout after which it merely stops waiting, which would silently strand
// every long turn.
//
// ## Self-initiated turns
//
// The runtime does not only answer prompts. A detached background shell
// (`bash{mode:"async", detach:true}`) settles on its own clock, and the runtime
// then re-invokes the model with NO prompt behind it — a `system.notification`
// followed by a fresh `assistant.turn_start`, tool calls and a durable
// `assistant.message`. Live burn-in (session `10a1a9ad`, 2026-08-31: "set a
// timer to 1 minute") caught the whole of that second turn being dropped
// because no relay row was open to publish it into, and the user never saw the
// answer they had been promised.
//
// So a turn here is one of two kinds:
//
//  - `delivered`     — a queue row arrived, `runTurn` sends its prompt;
//  - `continuation`  — the runtime started work by itself. The worker mints a
//    synthetic queue row (`POST /api/continuation-turn`) and runs the SAME
//    state machine over the events, so the turn gets the full relay surface:
//    stream, thoughts, activity, questions, usage and a response of its own.
//    Actions produced before the row exists are buffered and flushed in order.
//
// Three rules keep that safe, and each is enforced in `routeEvent`:
//
//  1. **Replay is not new work.** `session.resume` can replay persisted history
//     through the same callback; `createReplayGate` drops it (see that module
//     for why `resumeTime` and `eventCount` are used together).
//  2. **Liveness pins the runtime.** Idle shutdown must not stop a runtime that
//     has a detached shell running or a settled shell's continuation still due
//     — stopping it kills the shell. `createBackgroundShellTracker` supplies
//     the set; `backgroundTaskTimeoutMs` caps how long it may pin.
//  3. **A continuation is a turn like any other.** It ends on `session.idle`,
//     its usage is captured and posted, and a user message delivered while it
//     runs is steered into it (answered from its own prompt segment) rather
//     than cross-published into the continuation's row.
import { randomUUID } from 'crypto';

import {
  USER_INPUT_UNSUPPORTED_ANSWER,
  classifyCopilotSessionError,
  classifyCopilotTurnException,
  copilotAgentModeForRelayMode,
  createCopilotPermissionHandler,
  isReadOnlyPermissionRequest,
  isSessionNotFoundError,
  observeRuntimeExit,
  resolveCopilotSdkPaths,
  startCopilotClient,
} from './copilot-sdk-adapter.mjs';
import { buildCopilotMessageOptions } from './copilot-attachments.mjs';
import { resolveCopilotProviderConfig } from './copilot-byok-provider.mjs';
import {
  createBackgroundShellTracker,
  createReplayGate,
  describeSettledShell,
  isContinuationOpeningEvent,
} from './copilot-continuation-signals.mjs';
import { createCopilotEventNormalizer } from './copilot-sdk-event-normalizer.mjs';
import {
  DEFAULT_MODEL_SWITCH_TIMEOUT_MS,
  createCopilotModelSwitcher,
  isModelSwitchUnconfirmedError,
  normalizeRelayEffort,
} from './copilot-model-switch.mjs';
import { createCopilotQuestionBridge } from './copilot-question-bridge.mjs';
import {
  EXIT_PLAN_BOARD_POSTED_FEEDBACK,
  EXIT_PLAN_NO_BOARD_FEEDBACK,
  buildCopilotPlanReadyBoardPayload,
  planTextFromExitRequest,
  shouldPostPlanBoard,
} from './copilot-plan-board.mjs';
import {
  createCopilotPromptContextBuilder,
  createPreviewInstructionsProvider,
  loadDefaultRelayToolInstructions,
  withRelayContext,
} from './copilot-prompt-context.mjs';
import { EMPTY_TURN_COMPLETION_NOTE } from '../../shared/empty-turn-completion.mjs';
import { buildModelSnapshotFields, extractModelDescriptors } from '../../shared/model-descriptors.mjs';

// How long the runtime may sit with no session activity before the worker
// closes it. The worker process itself stays up and reconnects lazily on the
// next delivery — same trade the Claude worker makes (`gracefulShutdown('idle')`
// ends the CLI, not the worker), because holding the ws link is cheap while
// holding a runtime subprocess per idle conversation is not.
const DEFAULT_IDLE_SHUTDOWN_MS = 10 * 60_000;
const DEFAULT_LIFECYCLE_POLL_MS = 5_000;
// Mirrors the Cursor adapter's `stallTimeoutMs`. Emphatically NOT 0: the
// worker's 10s heartbeat keeps renewing the relay's processing lease
// (messages-routes.mjs), so without a stall ceiling a turn whose runtime went
// quiet holds its queue row open indefinitely and no watchdog can free it.
const DEFAULT_TURN_STALL_TIMEOUT_MS = 120_000;
/**
 * How long live background shells ALONE may keep the runtime up (0 = no limit).
 *
 * Deliberately not the relay's `background_task_timeout_minutes` slider, whose
 * default is 0/unlimited: that slider governs Claude's background tasks, which
 * have ids, a composer panel and a stop button, so "no limit" there is a choice
 * the user can see and undo. A Copilot detached shell has none of that — the
 * runtime exposes no RPC to stop one and the relay has no surface listing them
 * — so an unlimited default would let a single forgotten `sleep 99999` pin a
 * runtime subprocess for the life of the relay with nothing to point at. 30
 * minutes is well past any timer a user would sit and wait for, and the cap
 * only ever costs the shell, never a turn.
 */
const DEFAULT_BACKGROUND_TASK_TIMEOUT_MS = 30 * 60_000;
/**
 * How long after a shell settles the runtime is held up waiting for the
 * continuation it should trigger.
 *
 * The live capture had 3ms between the `system.notification` and the
 * `assistant.turn_start`. This window only has to survive a runtime that
 * notifies and then decides there is nothing to say — mirrors the Claude
 * worker's `notificationGraceMs`, same value.
 */
const DEFAULT_CONTINUATION_GRACE_MS = 60_000;
/** Retry spacing for the synthetic-row registration (3 attempts). */
const DEFAULT_CONTINUATION_RETRY_DELAY_MS = 500;
/** How long a continuation's actions may buffer before its row is abandoned. */
const CONTINUATION_REGISTRATION_TIMEOUT_MS = 10_000;
/** Cap on activity lines carried between turns, so a chatty runtime cannot grow them. */
const MAX_PENDING_ACTIVITIES = 20;

/**
 * Appended to the partial answer when the RUNTIME interrupted the turn on its
 * own (as opposed to the user aborting through the relay). The row has to be
 * settled by this worker in that case, because nothing server-side is waiting
 * to settle it.
 */
export const RUNTIME_INTERRUPTED_NOTE =
  'System note: the Copilot runtime interrupted this turn before it finished. '
  + 'Resend the message to continue.';

/**
 * Published to a steered queue row whose prompt the runtime accepted but never
 * opened work on before the interaction ended. The prompt is still queued
 * INSIDE the runtime, so it will be answered at the start of the next turn —
 * requeuing the row would run it twice. Mirrors the Claude worker's
 * handed-off-context note, which exists for the same reason.
 */
export const STEERED_ROW_MERGED_NOTE =
  '_(This message was delivered while the previous turn was still running; the reply continues in '
  + 'the next turn.)_';

/**
 * The `trigger` reported to `POST /api/continuation-turn`, matching the value
 * the Claude worker sends so the relay's `CONTINUATION … trigger=` log line and
 * any future per-trigger handling read the same for both engines.
 */
export const CONTINUATION_TRIGGER = 'background_task';

/**
 * Compaction / infinite-session policy.
 *
 * These are the runtime's OWN documented defaults for `InfiniteSessionConfig`
 * (enabled, background compaction at 0.80 of the context window, blocking
 * compaction at 0.95) — they are set explicitly rather than left unset so a
 * future change to the runtime's defaults cannot silently move the point at
 * which a long relay conversation starts compacting. Compaction is what makes
 * a resumable, long-lived relay conversation possible at all: the alternative
 * is a turn that fails on context overflow with the whole history intact and
 * no way forward.
 */
export const DEFAULT_INFINITE_SESSION_CONFIG = Object.freeze({
  enabled: true,
  backgroundCompactionThreshold: 0.8,
  bufferExhaustionThreshold: 0.95,
});

/** `steerIntoActiveTurn` could not adopt the row; run it as a normal turn. */
const NOT_STEERED = Symbol('not-steered');

/**
 * The attempt-fencing echo for a row's write bodies. Every publish that names
 * a `messageId` also names the attempt it belongs to, so the relay can refuse
 * writes from a superseded attempt (a requeued row re-delivered elsewhere).
 * Omitted entirely when the row carries no attempt id (a pre-fencing relay).
 */
function attemptFields(message) {
  return message?.attemptId ? { attemptId: message.attemptId } : {};
}

/** A 409 whose detail names `stale_attempt`: this attempt was superseded. */
function isStaleAttemptError(error) {
  if (Number(error?.status) !== 409) return false;
  const detail = typeof error?.detail === 'string' ? error.detail : JSON.stringify(error?.detail || '');
  return detail.includes('stale_attempt');
}

export function createCopilotSdkSessionRunner({
  api,
  sdkSessionId,
  cwd,
  defaultModel = '',
  controlPoller = null,
  env = process.env,
  clientName = 'copilot-web-relay',
  logLevel = 'error',
  // Injection seams. Tests pass a fake client/session pair; nothing in this
  // module imports the real SDK (that lives in copilot-sdk-adapter.mjs).
  resolvePathsImpl = resolveCopilotSdkPaths,
  startClientImpl = startCopilotClient,
  createNormalizerImpl = createCopilotEventNormalizer,
  buildMessageOptionsImpl = buildCopilotMessageOptions,
  // BYOK: `COPILOT_PROVIDER_*` in this worker's env become
  // `SessionConfig.provider`. Injected so tests can drive the branch without
  // mutating process.env.
  resolveProviderConfigImpl = resolveCopilotProviderConfig,
  // Threading seam for `MessageOptions.mode` ("enqueue" | "immediate").
  //
  // A BYOK probe against runtime 1.0.82 ran a mid-turn send three ways —
  // "enqueue", "immediate" and unset — and all three behaved IDENTICALLY: the
  // send resolves in ~2ms with a message id, the prompt is queued
  // (`pending_messages.modified`), the in-flight model call runs to completion
  // untouched, and the prompt is picked up at the NEXT model-call boundary with
  // its own `user.message`. Neither mode interrupts anything. "enqueue" is the
  // documented default and preserves FIFO order, which is what the relay queue
  // contract wants, so it is what this sends. See §5 of the plan doc.
  resolveSendModeImpl = () => 'enqueue',
  // Interactive surfaces. Tests inject a fake bridge; nothing here reaches the
  // relay without one.
  createQuestionBridgeImpl = createCopilotQuestionBridge,
  questionPollMs = undefined,
  questionTimeoutMs = undefined,
  // Preview-lane guidance. Advisory — a failure costs the block, not the turn.
  relayToolInstructions = undefined,
  getPreviewInstructionsImpl = undefined,
  infiniteSessionConfig = DEFAULT_INFINITE_SESSION_CONFIG,
  idleShutdownMs = DEFAULT_IDLE_SHUTDOWN_MS,
  lifecyclePollMs = DEFAULT_LIFECYCLE_POLL_MS,
  // 0 disables (matching the background-task timeout's 0 = no-limit
  // convention). When set, a turn that goes this long without a single event
  // fails terminally instead of holding the queue row until the relay's own
  // delivery watchdog gives up.
  turnStallTimeoutMs = DEFAULT_TURN_STALL_TIMEOUT_MS,
  // How long a `deferred: true` model switch may wait for its
  // `session.model_change` drain before the explicit selection counts as
  // unconfirmed and fails the row (`COPILOT_SDK_RELAY_MODEL_SWITCH_TIMEOUT_MS`).
  modelSwitchTimeoutMs = DEFAULT_MODEL_SWITCH_TIMEOUT_MS,
  // How long live detached shells alone may keep the runtime up (0 = no
  // limit). Read through a getter, like the Claude worker's
  // `getBackgroundTaskTimeoutMs`, so a future settings push can move it without
  // a worker restart.
  getBackgroundTaskTimeoutMs = () => DEFAULT_BACKGROUND_TASK_TIMEOUT_MS,
  continuationGraceMs = DEFAULT_CONTINUATION_GRACE_MS,
  continuationRetryDelayMs = DEFAULT_CONTINUATION_RETRY_DELAY_MS,
  // How long a settled continuation waits for its row before giving up on it.
  // Must outlast the registration's own retries; a test shortens it.
  continuationRegistrationTimeoutMs = CONTINUATION_REGISTRATION_TIMEOUT_MS,
  dbg = () => {},
} = {}) {
  let client = null;
  let session = null;
  let sdkPaths = null;
  // The single owner of "what model/effort is the live session CONFIRMED to be
  // on" (audit #9/#13): tracks the last confirmed pair, caches the per-session
  // model catalog for effort validation, and observes `session.model_change`
  // drains for deferred switches. `appliedModel()` is the runner-side read.
  const modelSwitch = createCopilotModelSwitcher({ switchTimeoutMs: modelSwitchTimeoutMs, dbg });
  const appliedModel = () => modelSwitch.current().model;
  let activeTurn = null;
  // Turns that have SETTLED but whose relay publishes have not all landed yet.
  // Ownership of a turn is split in two: `activeTurn` is runtime-EVENT
  // ownership (which turn the session callback feeds), this set is QUEUE-ROW
  // ownership (which rows the heartbeat must keep claiming and the crash guard
  // must requeue). The split exists because the runtime does not wait for the
  // relay: a fast follow-on continuation can open, run and terminate while the
  // previous turn's `/api/response` is still in flight, and holding the event
  // stream hostage to that POST is exactly how a whole continuation vanished
  // (audit #5). A Set, not a slot: the follow-on turn's own publish can block
  // too, so several turns can be publishing at once.
  const publishingTurns = new Set();
  let lifecycleTimer = null;
  let lastActivityAt = Date.now();
  let lastTurnUsage = null;
  // The snapshot object already handed to the ingest. Identity, not a flag, so
  // a turn that captured nothing new cannot re-post the previous turn's numbers
  // (every settle path runs `postTurnUsage`, including the ones that publish no
  // fresh usage at all).
  let postedTurnUsage = null;
  // The in-flight ingest POST, exposed only as a test seam. Never awaited by
  // the turn path — that is the entire point of it.
  let usagePostChain = Promise.resolve();
  // The last catalog content this worker POSTed to `/api/models/snapshot`,
  // as a serialized signature. Identity of CONTENT, not of session: an idle
  // shutdown and resume onto the same catalog must not re-publish it.
  let lastModelSnapshotSignature = '';
  // The in-flight snapshot POST — a chain like `usagePostChain`, and equally a
  // test seam only: the turn path never awaits a snapshot.
  let modelSnapshotChain = Promise.resolve();
  let starting = null;
  let disposed = false;
  let detachRuntimeExit = () => {};
  // Prompts this worker sent that the runtime accepted but had not started work
  // on when the interaction ended. They stay in the runtime's pending queue and
  // are picked up FIRST in the next interaction, ahead of that turn's own
  // prompt — so the next turn's segments are shifted by this many, and without
  // it the primary row would be answered with a leftover prompt's reply.
  let carriedPrompts = 0;
  // Blocking handlers currently waiting on a human (`ask_user`, an ask-mode
  // tool approval). The runtime emits NO events while blocked in one, and the
  // question timeout is 8 hours against a 120s stall ceiling — so without this
  // every unanswered card would fail its row after two minutes and then hand
  // the human's eventual answer to a runtime whose row is already settled.
  // Same guard the Cursor worker's `hasPendingClientWork` provides.
  let pendingHumanRequests = 0;
  // The `SessionConfig.provider` block this session was BUILT with, or null for
  // a hosted (`github`) session. Set by `buildSessionConfig` rather than by a
  // second throwaway resolve here, so "is this BYOK?" and "what did the runtime
  // actually get?" can never disagree — which matters because the block's token
  // ceilings are model-specific and the session is rebuilt when the model
  // changes.
  let byokProvider = null;
  // Drops the history a `session.resume` replays through the live callback, so
  // a two-day-old `assistant.message` can never mint a continuation row.
  const replayGate = createReplayGate();
  // The detached shells this session has running. The lifecycle's pin, and the
  // reason a settled one is worth waiting for.
  const backgroundShells = createBackgroundShellTracker();
  // When a shell settled and the continuation it should trigger has not opened
  // yet. Holds the runtime for `continuationGraceMs`; cleared by the
  // continuation opening, or by the grace expiring on a runtime that decided it
  // had nothing to say.
  let continuationDueSince = 0;
  // Transcript lines produced between turns (a settled shell's notification).
  // They belong to the turn they trigger, so they are carried into it rather
  // than dropped — the same trade the Claude worker's `pendingActivities`
  // makes.
  let pendingActivities = [];
  // The relay mode of the last delivered turn. A self-initiated turn has no
  // delivery to read a mode off, and it is a continuation OF that turn's work,
  // so it inherits it — which is what keeps the permission handler and the
  // plan-board gating behaving the same either side of a background wait.
  let lastRelayMode = 'agent';

  async function whileAwaitingHuman(run) {
    pendingHumanRequests += 1;
    try {
      return await run();
    } finally {
      pendingHumanRequests -= 1;
      // The clock restarts from the answer, not from before the wait.
      touch();
      activeTurn?.armStall?.();
    }
  }

  /**
   * Hold an interactive callback until the active turn's queue row exists.
   *
   * A continuation becomes the active turn synchronously but gets its row
   * asynchronously, and the runtime can block on `user_input.requested` (or an
   * ask-mode approval) in that gap — the question bridge would then see no
   * active message and degrade to an unsupported answer / local rejection for
   * a card that was milliseconds from having a real row id. Bounded by the
   * registration timeout (the registration itself can hang on a dead relay);
   * on expiry — or on a registration that gave up (`rowReady` → false) — the
   * caller proceeds and degrades exactly as before. Delivered turns are
   * registered from birth and skip straight through.
   */
  async function awaitInteractiveRow() {
    const turn = activeTurn;
    if (!turn || turn.registered || !turn.rowReady) return;
    let timer = null;
    await Promise.race([
      turn.rowReady,
      new Promise((resolve) => {
        timer = setTimeout(resolve, continuationRegistrationTimeoutMs);
        timer.unref?.();
      }),
    ]);
    clearTimeout(timer);
  }

  // The relay question bridge serves `ask_user` and (in ask mode) tool
  // approvals. `getActiveMessage` must resolve to the row that is CURRENTLY
  // `processing`, because `/api/relay-question` 409s otherwise.
  const questionBridge = createQuestionBridgeImpl({
    api,
    sdkSessionId,
    // A continuation's message has no `id` until its synthetic row is
    // registered; posting a card against a null id would 409. Reporting "no
    // active message" instead lets the bridge take its own degraded path.
    getActiveMessage: () => (activeTurn?.message?.id ? activeTurn.message : null),
    ...(questionPollMs === undefined ? {} : { questionPollMs }),
    ...(questionTimeoutMs === undefined ? {} : { questionTimeoutMs }),
    dbg,
  });

  const buildRelayContextPrefix = createCopilotPromptContextBuilder({
    toolInstructions: relayToolInstructions === undefined
      ? loadDefaultRelayToolInstructions({ env })
      : relayToolInstructions,
    getPreviewInstructions: getPreviewInstructionsImpl === undefined
      ? createPreviewInstructionsProvider({ api })
      : getPreviewInstructionsImpl,
  });
  // Every event is handled on one chain so the relay POSTs for a turn land in
  // the order the runtime produced them; the SDK's callback is synchronous and
  // would otherwise interleave awaits.
  let dispatchChain = Promise.resolve();

  function touch() {
    lastActivityAt = Date.now();
  }

  /**
   * A turn's terminal event ends its runtime-event ownership IMMEDIATELY, while
   * queue-row ownership persists until every publish has landed.
   *
   * Called from `settle`/`fail`, so it runs the instant the terminator is
   * dispatched: from here on `routeEvent` sees no active turn and a genuinely
   * new event can open the next continuation — it must not wait out a blocked
   * `/api/response`. The row itself stays owned (heartbeat lease, crash-guard
   * requeue) via `publishingTurns` until `releaseTurnOwnership`.
   */
  function beginPublishing(turn) {
    publishingTurns.add(turn);
    if (activeTurn === turn) activeTurn = null;
  }

  /**
   * Every publish for the turn has landed (or terminally failed); nothing owns
   * its rows any more. Guarded on identity: by the time a publish window
   * closes, `activeTurn` may already belong to a NEWER turn, and clearing it
   * unconditionally would strip that turn's heartbeat ownership mid-flight.
   */
  function releaseTurnOwnership(turn) {
    publishingTurns.delete(turn);
    if (activeTurn === turn) activeTurn = null;
  }

  // ---------------------------------------------------------------- publish --

  async function postActivity(message, text, subagentRunId = null) {
    if (!text) return;
    await api('POST', '/api/activity', {
      messageId: message.id,
      conversationId: message.conversationId,
      mode: message.relayMode || 'agent',
      text,
      ...(subagentRunId ? { subagentRunId } : {}),
      ...attemptFields(message),
    }).catch(() => {});
  }

  async function dispatchAction(message, action, state) {
    const { channel, payload } = action;
    if (channel === 'init') {
      // Inert: the response's model is read straight off the normalizer when
      // the turn settles, so there is nothing to mirror into turn state here.
      return;
    }
    if (channel === 'stream') {
      // Only main-thread text can stand in for the answer on the abort/error
      // fallback paths; subagent text would publish as the reply.
      if (!payload.subagentRunId) state.lastStreamedText = payload.text;
      await api('POST', '/api/stream', {
        messageId: message.id,
        conversationId: message.conversationId,
        mode: message.relayMode || 'agent',
        text: payload.text,
        done: payload.done === true,
        ...(payload.subagentRunId ? { subagentRunId: payload.subagentRunId } : {}),
        ...attemptFields(message),
      }).catch(() => {});
      return;
    }
    if (channel === 'thought') {
      await api('POST', '/api/thought', {
        messageId: message.id,
        conversationId: message.conversationId,
        mode: message.relayMode || 'agent',
        reasoningId: payload.reasoningId,
        text: payload.text,
        done: payload.done === true,
        ...(payload.subagentRunId ? { subagentRunId: payload.subagentRunId } : {}),
        ...attemptFields(message),
      }).catch(() => {});
      return;
    }
    if (channel === 'activity') {
      await postActivity(message, payload.text, payload.subagentRunId);
      return;
    }
    if (channel === 'subagent') {
      // Same body as every sibling worker's, so the lane bubbles, the
      // `subagent_status` broadcast and the UI's grouping behave identically
      // whichever provider produced the run.
      await api('POST', '/api/subagent-run', {
        messageId: message.id,
        conversationId: message.conversationId,
        subagentRunId: payload.subagentRunId,
        ...(payload.parentSubagentId ? { parentSubagentId: payload.parentSubagentId } : {}),
        ...(payload.displayName ? { displayName: payload.displayName } : {}),
        status: payload.status,
        ...attemptFields(message),
      }).catch(() => {});
    }
  }

  /**
   * Force-close any subagent still marked running.
   *
   * The normalizer closes strays when it builds a terminal `result`, but the
   * paths that kill a turn WITHOUT one — a user abort, the runtime exiting, a
   * thrown exception — never get there. The relay only reconciles open runs
   * when the queue row is FAILED, so on the abort path (where the row is
   * settled server-side) an un-closed run would render as a bubble spinning
   * forever.
   */
  async function closeStraySubagentRuns(turn) {
    const runs = turn?.normalizer?.activeSubagentRuns?.() || [];
    for (const run of runs) {
      await emitAction(turn, {
        channel: 'subagent',
        payload: {
          subagentRunId: run.subagentRunId,
          parentSubagentId: null,
          displayName: run.displayName,
          status: 'failed',
        },
      });
    }
  }

  /**
   * Publish an action, or hold it if the turn has no queue row yet.
   *
   * The single gate every producer goes through. A continuation's row is
   * created asynchronously, and a POST carrying `messageId: null` is not merely
   * useless — the relay's activity/stream routes key on it, so it would be
   * attributed to nothing at all.
   */
  async function emitAction(turn, action) {
    if (!turn.registered) {
      turn.bufferedActions.push(action);
      return;
    }
    await dispatchAction(turn.message, action, turn.state);
  }

  async function publishFinalStream(message, text) {
    await api('POST', '/api/stream', {
      messageId: message.id,
      conversationId: message.conversationId,
      mode: message.relayMode || 'agent',
      text: String(text || ''),
      done: true,
      ...attemptFields(message),
    }).catch(() => {});
  }

  async function publishResponse(message, { text, model, terminalError = null, modelOrigin }) {
    await api('POST', '/api/response', {
      messageId: message.id,
      conversationId: message.conversationId,
      text: String(text || ''),
      model: model || null,
      modelOrigin: modelOrigin
        || (String(message?.model || '').trim().toLowerCase() === 'auto' ? 'auto' : 'manual'),
      ...(terminalError ? { terminalError } : {}),
      ...attemptFields(message),
    }).catch(async (error) => {
      // A stale_attempt 409 means the row already moved on to another attempt
      // (requeued and re-delivered); the requeue would 409 the same way, and
      // the newer attempt owes the row its answer — drop this one.
      if (isStaleAttemptError(error)) {
        dbg('response refused as stale_attempt; dropping', message.id);
        return;
      }
      await api('POST', '/api/requeue', { messageId: message.id, ...attemptFields(message) }).catch(() => {});
    });
  }

  function terminalErrorRecord(message, classified) {
    return {
      kind: 'copilot-turn-failed',
      code: classified.code,
      stableCode: classified.stableCode,
      message: classified.text,
      failedAt: new Date().toISOString(),
      queueMessageId: String(message.id || '') || null,
    };
  }

  /**
   * Per-turn usage capture, recorded on the runner.
   *
   * Synchronous and side-effect-only: it decides WHAT to report, never when.
   * The POST is `postTurnUsage`'s job and runs after the row is published.
   */
  function captureTurnUsage(message, result) {
    const usage = result?.usage || null;
    const contextUsage = result?.contextUsage || null;
    if (!usage && !contextUsage) return;
    lastTurnUsage = {
      conversationId: message.conversationId,
      sdkSessionId,
      messageId: message.id,
      model: result?.model || appliedModel() || defaultModel || '',
      usage,
      contextUsage,
      capturedAt: new Date().toISOString(),
    };
    dbg('turn usage', JSON.stringify({
      model: lastTurnUsage.model,
      inputTokens: usage?.inputTokens ?? null,
      outputTokens: usage?.outputTokens ?? null,
      // The premium MULTIPLIER, not money.
      cost: usage?.cost ?? null,
      // Real spend, and the field a usage card should show.
      totalNanoAiu: usage?.totalNanoAiu ?? null,
      modelCalls: usage?.modelCalls ?? null,
      subagentModelCalls: usage?.subagentModelCalls ?? null,
      timeToFirstTokenMs: usage?.timeToFirstTokenMs ?? null,
      contextTokens: contextUsage?.currentTokens ?? null,
      // Overage lives at `quotaSnapshots.cfi_overage`; `account.getQuota()`
      // reads a stale cache and will not show it.
      hasQuotaSnapshots: !!usage?.quotaSnapshots,
      cfiOverage: usage?.quotaSnapshots?.cfi_overage ?? null,
    }));
  }

  /**
   * Report the captured turn usage to the relay's `/api/copilot-plan-usage`
   * ingest. Fire-and-forget, deliberately, and always AFTER the row has been
   * published.
   *
   * The plan card's meters come from the account-level quota API the relay
   * fetches itself, and those already cover SDK sessions. What only the worker
   * can see is the per-turn detail: `totalNanoAiu` (real spend — the event's
   * `cost` is the premium multiplier, not money) and
   * `quotaSnapshots.cfi_overage` (overage, invisible to `account.getQuota()`'s
   * cached read). None of that is worth one millisecond of a finished reply.
   *
   * Awaiting it was actively dangerous: by this point the stall watchdog is
   * disarmed and the relay client has no request timeout, so an unresponsive
   * relay could hold a COMPLETED turn — its text already generated, its queue
   * row still open — for as long as the socket stayed up. The result is unused
   * and the failure is already swallowed, so there was nothing to wait for.
   *
   * BYOK sessions do not post at all: they spend the user's own OpenAI key
   * rather than Copilot quota, and their usage events report `cost: 0`, so
   * their numbers would only mislead on a card about the Copilot plan.
   */
  function postTurnUsage() {
    if (byokProvider || !lastTurnUsage || lastTurnUsage === postedTurnUsage) return;
    postedTurnUsage = lastTurnUsage;
    // Held so a test (and only a test) can await the settle; nothing in the
    // turn path ever reads it.
    usagePostChain = api('POST', '/api/copilot-plan-usage', lastTurnUsage)
      .catch((error) => { dbg('usage ingest failed', error?.message || String(error)); });
  }

  /**
   * Publish the session's model catalog to `/api/models/snapshot` (Phase 5A:
   * with the extension retired, worker snapshots and the server-side discovery
   * service are what keep the relay's catalog populated).
   *
   * Fire-and-forget on a chain, exactly like `postTurnUsage`: a catalog is
   * never worth a millisecond of a turn, and the failure mode is "the relay
   * keeps its previous catalog" — swallowed after a debug line. The entries
   * come from the switcher's cached per-session `rpc.model.list()`, so the
   * common case adds zero RPCs; an unchanged catalog is deduped by content
   * signature rather than re-POSTed on every resume.
   *
   * BYOK sessions never publish: their list is the OpenAI-compatible
   * endpoint's per-key lineup, not the Copilot catalog, and a snapshot from
   * one would overwrite the relay-wide picker with it.
   */
  function publishModelSnapshot(reason) {
    if (byokProvider || !session) return;
    const target = session;
    modelSnapshotChain = modelSnapshotChain
      .then(async () => {
        const entries = await modelSwitch.catalogEntries(target);
        const descriptors = extractModelDescriptors(entries);
        // An empty list is the runtime refusing to answer, not an empty
        // catalog — publishing it would only blank the pickers' metadata.
        if (!descriptors.length) return;
        // The shared builder decides every per-model metadata field (vendor,
        // picker category, real context window, the runtime's own effort
        // list, ...) so this raw-CAPI list and the discovery service's typed
        // list publish identical metadata for the same model.
        const { models, contextLimitsByModel, modelMetadataByModel } = buildModelSnapshotFields(descriptors);
        const currentModel = appliedModel() || defaultModel || null;
        const payload = {
          // Same field set the extension and the standalone relay publish;
          // the route reads exactly these seven keys and nothing else.
          source: `copilot-sdk-worker:${reason}`,
          models,
          contextLimitsByModel,
          modelMetadataByModel,
          currentModel,
          defaultModel: currentModel || models[0] || null,
          error: null,
        };
        const signature = JSON.stringify([models, contextLimitsByModel, modelMetadataByModel, currentModel]);
        if (signature === lastModelSnapshotSignature) return;
        await api('POST', '/api/models/snapshot', payload);
        // Recorded only after the POST lands, so a transient relay failure
        // retries on the next trigger instead of being deduped away.
        lastModelSnapshotSignature = signature;
        dbg('model snapshot published', reason, `models=${models.length}`, `current=${currentModel || 'unknown'}`);
      })
      .catch((error) => { dbg('model snapshot publish failed', reason, error?.message || String(error)); });
  }

  // ---------------------------------------------------------------- session --

  function routeEvent(event) {
    // A replayed event is history the relay already has. It must not touch the
    // idle clock, the shell set, an active turn's normalizer, or — the reason
    // this gate exists at all — open a continuation row for work that finished
    // days ago.
    if (replayGate.isReplay(event)) {
      dbg('dropping a replayed event', String(event?.type || ''), String(event?.timestamp || ''));
      return;
    }
    touch();
    observeBackgroundShells(event);
    // Keeps the confirmed-model tracking truthful for switches this worker did
    // not ask for, and resolves the bounded wait on a deferred switch's drain.
    // Behind the replay gate on purpose: a historical `session.model_change`
    // must not confirm a pending switch.
    modelSwitch.observeEvent(event);
    // A LIVE model change moves the catalog's currentModel; replays cannot get
    // here (the gate above), so this cannot re-publish days-old state.
    if (event?.type === 'session.model_change') publishModelSnapshot('model-change');
    let turn = activeTurn;
    if (!turn) {
      // The runtime started work with no row open. Anything that is not the
      // START of work (terminators, connection bookkeeping) stays a no-op:
      // opening a row for one would leave a synthetic turn in the transcript
      // that only the stall watchdog could close.
      if (!isContinuationOpeningEvent(event)) return;
      turn = openContinuationTurn();
    }
    // The owner is captured HERE, synchronously, but settlement happens later
    // on the dispatch chain — so an event can be captured to a turn that is
    // settled by the time its link runs. `handleTurnEvent`'s settled guard
    // re-routes such an event (in arrival order, on the same chain) to
    // whatever now owns the stream, opening a continuation if the event is an
    // opener. A settled turn that is still publishing holds only its QUEUE
    // rows (`publishingTurns`); it never holds the event stream.
    dispatchChain = dispatchChain
      .then(() => handleTurnEvent(turn, event))
      .catch((error) => { dbg('event dispatch failed', error?.message || String(error)); });
  }

  /**
   * Keep the detached-shell set current and note when one settles.
   *
   * Runs for every live event, in or out of a turn: shells are OPENED inside a
   * delivered turn (that is where the model calls `bash`) and SETTLE outside
   * one, which is the whole asymmetry this fix exists for.
   */
  /**
   * Mirror the live detached-shell set into the relay's background-tasks
   * panel (REPLACE semantics, the same route the Claude worker publishes on),
   * so a runaway `npm test` in a detached shell is visible as a card instead
   * of only as tool rows. `stoppable: false` because the runtime exposes no
   * host-side shell stop (`stop_bash` is a tool the MODEL calls) — see
   * backgroundWorkHoldsRuntime. Advisory: a failed post never disturbs events.
   */
  function publishBackgroundShellTasks() {
    const tasks = backgroundShells.live().map((shell) => ({
      taskId: shell.shellId,
      taskType: 'local_bash',
      description: shell.description || 'Detached shell',
      startedAt: shell.startedAt || null,
      stoppable: false,
    }));
    api('POST', '/api/background-tasks', { conversationId: sdkSessionId, tasks })
      .catch((error) => dbg('background task publish failed', error?.message || String(error)));
  }

  function observeBackgroundShells(event) {
    let changed;
    try {
      changed = backgroundShells.observe(event);
    } catch (error) {
      dbg('background shell tracking failed', String(event?.type || ''), error?.message || String(error));
      return;
    }
    if (changed.opened.length || changed.settled.length) publishBackgroundShellTasks();
    for (const shell of changed.opened) {
      dbg('detached shell started', shell.shellId, shell.description || '(no description)');
    }
    for (const shell of changed.settled) {
      dbg('detached shell settled', shell.shellId);
      const note = describeSettledShell(shell);
      // Only carried when there is no turn to publish into: inside a turn the
      // normalizer already narrates the `read_bash` that reads the output. A
      // settled turn mid-publish does NOT count as a turn here — its row is
      // closed to new lines, so the note belongs to the continuation this
      // notification is about to trigger.
      if (note && !activeTurn && pendingActivities.length < MAX_PENDING_ACTIVITIES) {
        pendingActivities.push(note);
      }
    }
    // Only the runtime's own `system.notification` heralds a continuation. A
    // `read_bash` that reports an exit code closes the same shell, but it
    // happens inside a turn that already knows — pinning on it would hold the
    // runtime for the grace window after every ordinary background command.
    //
    // Set even when a turn is active: the gap that matters is the one AFTER
    // that turn closes.
    if (changed.heralded) continuationDueSince = Date.now();
  }

  /**
   * A live event was captured to a turn that settled before its chain link
   * ran. It is NOT history — it belongs to whatever the runtime is doing now:
   * an already-open successor turn, or a continuation this very event should
   * open. Runs on the dispatch chain, so re-routed events keep arrival order
   * relative to everything captured after them.
   */
  async function redispatchSettledEvent(event) {
    let turn = activeTurn;
    // A settled `activeTurn` cannot happen — `settle`/`fail` release the slot
    // — but it is guarded anyway: re-routing INTO a settled turn would recurse
    // through this function forever, so it is treated as "no owner".
    if (!turn || turn.settled) {
      // Same rule as `routeEvent`: only the start of work opens a row.
      if (!isContinuationOpeningEvent(event)) return;
      turn = openContinuationTurn();
    }
    await handleTurnEvent(turn, event);
  }

  async function handleTurnEvent(turn, event) {
    if (turn.settled) {
      await redispatchSettledEvent(event);
      return;
    }
    turn.armStall?.();
    let actions = [];
    try {
      actions = turn.normalizer.normalize(event);
    } catch (error) {
      dbg('normalize failed', String(event?.type || ''), error?.message || String(error));
      return;
    }
    for (const action of actions) {
      if (action.channel === 'result') {
        turn.result = action.payload;
        turn.settle();
        return;
      }
      // A continuation's actions buffer until its synthetic row exists; the
      // registration drains them in arrival order and only then flips
      // `registered`, so a later action can never overtake an earlier one.
      // Delivered turns are registered from birth and take the direct path.
      await emitAction(turn, action);
    }
  }

  /** Publish everything a not-yet-registered turn buffered, in order. */
  async function flushBufferedActions(turn) {
    while (turn.bufferedActions.length) {
      const batch = turn.bufferedActions.splice(0);
      for (const action of batch) {
        await dispatchAction(turn.message, action, turn.state).catch(() => {});
      }
    }
  }

  function buildSessionConfig(model, relayMode, reasoningEffort = null) {
    // Built once per session, not per request. Reads the mode off the LIVE turn
    // rather than closing over the one the session was built with, because one
    // session serves every turn and the user can switch modes between them.
    const decidePermission = createCopilotPermissionHandler({
      // Only the ask-mode branch actually blocks on a human; wrapping it keeps
      // the stall watchdog off a turn where someone is deciding.
      bridge: {
        askToolApproval: (permissionRequest, options) => whileAwaitingHuman(async () => {
          // An ask-mode approval raised the moment a continuation opens must
          // wait for the row its card will hang off — see `awaitInteractiveRow`.
          await awaitInteractiveRow();
          return questionBridge.askToolApproval(permissionRequest, options);
        }),
      },
      getRelayMode: () => activeTurn?.message?.relayMode || relayMode,
      // An aborted turn must not leave the human staring at a card whose answer
      // nothing will read; the bridge times the card out instead.
      getSignal: () => activeTurn?.abortController?.signal || null,
      dbg,
    });
    // BYOK sessions must carry their provider IN the session config: the
    // runtime's `COPILOT_PROVIDER_*` startup layer does not run for
    // SDK-created sessions, so without this an OpenAI-provider conversation
    // would silently run on hosted Copilot models instead. Null for every
    // hosted (`github`) session, which is the common case.
    //
    // The resolved block is remembered: its token ceilings describe THIS model,
    // and no model-switch RPC can update them (see `applySelection`).
    const provider = resolveProviderConfigImpl({ env, model: model || defaultModel, dbg });
    byokProvider = provider;
    const effort = normalizeRelayEffort(reasoningEffort);
    return {
      // The relay session id IS the SDK session id, so the runtime's own state
      // under ~/.copilot/session-state/<id> is addressable by conversation and
      // survives worker restarts without a side table.
      sessionId: sdkSessionId,
      ...(model ? { model } : {}),
      ...(provider ? { provider } : {}),
      // BYOK only: the rebuilt config is the switch mechanism for these
      // sessions, so the effort must ride in it or a dispose+resume model
      // switch silently drops it. Hosted sessions apply effort through the
      // validated RPC path instead (`SessionConfigBase.reasoningEffort` is
      // only valid for models that support it, which cannot be checked before
      // the session exists).
      ...(provider && effort ? { reasoningEffort: effort } : {}),
      // Not a default: without this the SDK emits no deltas at all and the
      // transcript only updates when the whole message lands.
      streaming: true,
      workingDirectory: cwd,
      clientName,
      // The runtime's own defaults, pinned. See DEFAULT_INFINITE_SESSION_CONFIG.
      ...(infiniteSessionConfig ? { infiniteSessions: { ...infiniteSessionConfig } } : {}),
      onEvent: routeEvent,
      // Permission policy follows the conversation's relay mode: agent and
      // autopilot auto-approve, plan denies non-read tools with feedback, and
      // ask asks the human through a relay question card. The handler reads the
      // mode from the LIVE turn rather than closing over the mode the session
      // was built with, because one session serves every turn of a conversation
      // and the user can switch modes between them.
      onPermissionRequest: async (request) => {
        const decision = await decidePermission(request);
        // Remember that this turn actually changed something: it is what tells
        // a described plan apart from work already done, which is the
        // difference between a useful handoff board and a nonsensical one.
        if (decision?.kind === 'approve-once' && !isReadOnlyPermissionRequest(request) && activeTurn) {
          activeTurn.acted = true;
        }
        return decision;
      },
      // `ask_user` → a relay question card. The runtime BLOCKS the turn on this
      // handler, so it must always settle: a throw would fail the tool call
      // silently, and a hang would hold the queue row until the delivery
      // watchdog gives up. `wasFreeform` is required by `UserInputResponse` and
      // the deserializer is strict, so it is always a real boolean.
      onUserInputRequest: async (request) => {
        try {
          const { answer, wasFreeform } = await whileAwaitingHuman(async () => {
            // Same gate as the approval path: an `ask_user` fired straight
            // after a continuation opened must get the row, not a null id.
            await awaitInteractiveRow();
            return questionBridge.askUserInput(request, {
              signal: activeTurn?.abortController?.signal || null,
            });
          });
          return { answer, wasFreeform };
        } catch (error) {
          dbg('user input question failed', error?.message || String(error));
          return { answer: USER_INPUT_UNSUPPORTED_ANSWER, wasFreeform: true };
        }
      },
      // The agent finished planning. Post the board and REFUSE the exit:
      // approving it tells the runtime the plan was accepted and the same turn
      // rolls straight into implementing while the board sits unanswered.
      onExitPlanModeRequest: async (request) => {
        const posted = await publishPlanBoard(activeTurn, planTextFromExitRequest(request), 'exit_plan_mode');
        return {
          approved: false,
          feedback: posted ? EXIT_PLAN_BOARD_POSTED_FEEDBACK : EXIT_PLAN_NO_BOARD_FEEDBACK,
        };
      },
      // Structured elicitation (audit #17): a form-mode request with a schema
      // becomes a relay question card carrying `requestedSchema`; the relay's
      // answer route validates the submission and stores `structuredAnswer`,
      // which maps 1:1 onto the SDK's `ElicitationResult.content`. Everything
      // that cannot round-trip — url mode (a browser redirect), a missing or
      // non-object schema, a bridge without the structured surface, a timeout,
      // a closing bridge, an answer the relay could not validate — declines
      // in-band exactly as before, which lets the model continue where a hang
      // or a throw would fail the tool call silently.
      onElicitationRequest: (request) => handleElicitationRequest(request),
    };
  }

  /**
   * `onElicitationRequest` → a schema-carrying relay question card →
   * `{ action: 'accept', content }` with the validated structured answer, or
   * `{ action: 'decline' }` for everything that cannot round-trip.
   *
   * Runs under the same human-gating as `ask_user`: the stall watchdog is held
   * off while the card waits, and an elicitation raised the moment a
   * continuation opens waits for the row its card will hang off (`rowReady`)
   * instead of minting a card against a null message id.
   */
  async function handleElicitationRequest(request) {
    try {
      const mode = String(request?.mode || 'form').trim().toLowerCase();
      const schema = request?.requestedSchema;
      const hasSchema = !!schema && typeof schema === 'object' && !Array.isArray(schema)
        && !!schema.properties && typeof schema.properties === 'object';
      if (mode === 'url' || !hasSchema || typeof questionBridge.askStructured !== 'function') {
        return { action: 'decline' };
      }
      const source = String(request?.elicitationSource || '').trim();
      const message = String(request?.message || '').trim()
        || 'Copilot needs structured input to continue this turn.';
      const result = await whileAwaitingHuman(async () => {
        await awaitInteractiveRow();
        return questionBridge.askStructured({
          prompt: source ? `${message}\n\n(Requested by ${source}.)` : message,
          requestedSchema: schema,
        }, { signal: activeTurn?.abortController?.signal || null });
      });
      const content = result?.structuredAnswer;
      if (result?.timedOut || !content || typeof content !== 'object' || Array.isArray(content)) {
        return { action: 'decline' };
      }
      return { action: 'accept', content };
    } catch (error) {
      dbg('elicitation bridging failed, declining', error?.message || String(error));
      return { action: 'decline' };
    }
  }

  /**
   * Post the `plan_ready` board for a turn. Returns whether a board went out,
   * which the exit-plan handler turns into the feedback the agent sees.
   *
   * Marks the turn so the completion path's text-shape fallback does not post a
   * second board — the relay would dedupe it (`UNIQUE(message_id, board_type)`)
   * but only after a pointless round trip.
   */
  async function publishPlanBoard(turn, planText, source) {
    if (!turn?.message?.id) return false;
    const payload = buildCopilotPlanReadyBoardPayload({ message: turn.message, planText, source });
    if (!payload) return false;
    // The failure is swallowed (a relay that refused the board must not fail a
    // turn that otherwise succeeded) but it is REPORTED: telling the agent the
    // plan is "shown to the user for review" when it is not would end the turn
    // with the plan visible nowhere, and would also latch off the text-shape
    // fallback that could still have posted it.
    try {
      await api('POST', '/api/relay-board', payload);
    } catch (error) {
      dbg('plan board publish failed', error?.message || String(error));
      return false;
    }
    turn.planBoardPosted = true;
    return true;
  }

  /**
   * The runtime process died under us. Nothing the SDK is waiting on will ever
   * resolve, so the active turn is failed terminally-but-retryably rather than
   * left to hold its queue row open behind a heartbeat that keeps renewing the
   * processing lease.
   */
  function handleRuntimeExit(detail) {
    dbg('copilot runtime exited', detail);
    const turn = activeTurn;
    if (turn && !turn.settled) {
      // handlePendingPayload's catch tears the runtime down and publishes the
      // failure record.
      turn.fail(new Error(`the Copilot runtime exited before the turn completed (${detail})`));
      return;
    }
    // No turn to fail: drop the dead handles so the next delivery rebuilds
    // instead of sending into a corpse.
    void stopRuntime('runtime-exit').catch(() => {});
  }

  async function ensureClient() {
    if (client) return client;
    if (starting) return starting;
    starting = (async () => {
      sdkPaths = resolvePathsImpl({ env });
      const started = await startClientImpl({ paths: sdkPaths, cwd, clientName, logLevel, dbg });
      client = started.client;
      detachRuntimeExit = observeRuntimeExit(client, handleRuntimeExit);
      // Diagnostics only, and deliberately not awaited — see startCopilotClient.
      Promise.resolve(started.versionReady)
        .then((info) => {
          if (info?.versionSkewWarning) dbg(info.versionSkewWarning);
          else dbg(`copilot runtime ready (version ${info?.runtimeVersion || sdkPaths.version || 'unknown'})`);
        })
        .catch(() => {});
      startLifecycleTimer();
      return client;
    })();
    try {
      return await starting;
    } finally {
      starting = null;
    }
  }

  /**
   * Bring the live session onto the dequeued row's (model, effort) selection.
   *
   * Hosted sessions go through `modelSwitch.apply` and its OBSERVED RPCs
   * (audit #9/#13): a selection the runtime does not confirm — a thrown
   * switchTo, a confirmation-required result, a deferred switch that never
   * drains, an unsupported effort level — THROWS the unconfirmed error, which
   * fails the row terminally before the prompt is ever sent. The common path
   * (same model, same effort) costs zero RPCs.
   *
   * BYOK sessions try the same RPCs first, but only when the freshly resolved
   * `SessionConfig.provider` block for the target model matches the one the
   * session was built with: the block carries MODEL-SPECIFIC token ceilings
   * that no RPC can update (runtime 1.0.82 has no setProvider, and the
   * registry surface is rejected alongside the singular whole-session
   * `provider`), so an in-place switch is only sufficient when the ceilings do
   * not move. A block that differs — or an RPC the runtime rejects — falls
   * back to the dispose+resume rebuild, which carries the effort in the
   * rebuilt config. Nothing is lost either way: the relay session id IS the
   * SDK session id, so the rebuild takes the ordinary resume path.
   */
  async function applySelection(model, effort, relayMode) {
    if (!byokProvider) {
      await modelSwitch.apply(session, { model, effort, byok: false });
      return session;
    }
    const nextProvider = resolveProviderConfigImpl({ env, model: model || defaultModel, dbg });
    const ceilingsMatch = JSON.stringify(nextProvider) === JSON.stringify(byokProvider);
    if (ceilingsMatch) {
      const attempt = await modelSwitch.apply(session, { model, effort, byok: true });
      if (attempt.ok) return session;
      dbg('BYOK model RPC not honoured, rebuilding the session', model, attempt.detail || '');
    } else {
      dbg('BYOK ceilings differ for the target model; rebuilding the session', model);
    }
    return rebuildByokSession(model, effort, relayMode);
  }

  /**
   * Dispose the BYOK session and rebuild it with freshly resolved ceilings —
   * the switch mechanism of last resort for a session whose
   * `SessionConfig.provider` is immutable. The rebuilt config carries the
   * requested model AND effort, and the resumed session is trusted to be on
   * them by construction (`ProviderConfig.modelId` falls back to
   * `SessionConfig.model`), so this path never re-enters the RPC attempt —
   * which is also what makes it terminate: RPC refusal → rebuild → done.
   */
  async function rebuildByokSession(model, effort, relayMode) {
    dbg('rebuilding the copilot session for a BYOK model/effort switch', model);
    const closing = session;
    session = null;
    modelSwitch.reset();
    // Disconnect first so the runtime is not holding two handles on one
    // session id while the resume runs.
    try { await closing?.disconnect?.(); } catch (error) {
      dbg('session disconnect before model switch failed', error?.message || String(error));
    }
    return ensureSession(model, effort, relayMode);
  }

  async function ensureSession(model, effort, relayMode) {
    await ensureClient();
    if (!session) {
      const config = buildSessionConfig(model, relayMode, effort);
      // Resume first, always. On a brand-new conversation this costs one
      // failed RPC; on every other path (worker restart, idle shutdown,
      // relay restart) it is the difference between continuing the
      // conversation and silently starting a fresh one. A negative result is
      // deliberately not cached: once `createSession` succeeds, the state
      // exists and the NEXT reconnect must resume it.
      let resumed = false;
      try {
        session = await client.resumeSession(sdkSessionId, config);
        resumed = true;
        dbg(`resumed copilot session ${sdkSessionId.slice(0, 8)}`);
      } catch (error) {
        // ONLY a definitive "no such session" may fall through to creating a
        // blank one. A dropped connection or an unrecognised failure is
        // transient, and starting fresh over live state would silently throw
        // the conversation's whole history away — so it fails the turn
        // instead, which is retryable and loses nothing.
        if (!isSessionNotFoundError(error)) {
          dbg('copilot session resume failed transiently', error?.message || String(error));
          throw error;
        }
        dbg('copilot session state not found, creating', error?.message || String(error));
        session = await client.createSession(config);
        dbg(`created copilot session ${sdkSessionId.slice(0, 8)}`);
      }
      if (resumed && !byokProvider) {
        // A resumed HOSTED session keeps whatever model it was created with —
        // `config.model` is not guaranteed to be honoured on resume — so the
        // selection is applied explicitly (and observably) rather than
        // assumed. Assuming it is what made a mismatch permanent: the tracked
        // model would already equal the request, so the per-turn switch below
        // could never fire.
        modelSwitch.reset();
        await modelSwitch.apply(session, { model, effort, byok: false });
      } else {
        // A created session is on `config.model` by construction; a resumed
        // BYOK session is trusted the same way because `config.model` feeds
        // `ProviderConfig.modelId` — and an RPC attempt here would recurse
        // through the rebuild path that just built this config.
        modelSwitch.noteApplied(model || '', byokProvider ? effort : null);
        if (!byokProvider) {
          // A hosted CREATE carries no effort in the config (the field is only
          // valid for models that support it, unknowable pre-session), so an
          // explicit level on the conversation's first turn still goes through
          // the validated effort-only RPC. `null` effort is a no-op here.
          await modelSwitch.apply(session, { model, effort, byok: false });
        }
      }
      // The freshly (re)built session is the first chance to see the runtime's
      // catalog — publish it so a restarted relay repopulates without waiting
      // for a model switch. Off the turn's critical path (fire-and-forget) and
      // deduped, so an unchanged catalog on every resume costs one list() and
      // no POST.
      publishModelSnapshot(resumed ? 'session-resume' : 'session-start');
      return session;
    }
    return applySelection(model, effort, relayMode);
  }

  async function stopRuntime(reason) {
    stopLifecycleTimer();
    try { detachRuntimeExit(); } catch { /* the observer is best-effort */ }
    detachRuntimeExit = () => {};
    const closingSession = session;
    const closingClient = client;
    session = null;
    client = null;
    modelSwitch.reset();
    // Detached shells are children of the runtime process, so stopping it ends
    // them: the tracked set is state about a process that no longer exists and
    // must not pin the next one. The replay gate is reset for the same reason —
    // the next connection resumes and arms its own window.
    if (backgroundShells.size()) {
      backgroundShells.reset();
      // The shells died with the runtime; clear their panel cards too.
      publishBackgroundShellTasks();
    }
    replayGate.reset();
    continuationDueSince = 0;
    pendingActivities = [];
    if (!closingSession && !closingClient) return;
    dbg(`stopping the copilot runtime (${reason})`);
    try { await closingSession?.disconnect?.(); } catch (error) {
      dbg('session disconnect failed', error?.message || String(error));
    }
    try { await closingClient?.stop?.(); } catch (error) {
      dbg('client stop failed', error?.message || String(error));
    }
  }

  // -------------------------------------------------------------- lifecycle --

  /**
   * Whether background work is holding the runtime open.
   *
   * `stopRuntime` ends the CLI runtime process, and a detached shell is a child
   * of it — so stopping while one is live does not merely postpone the
   * continuation, it KILLS the command. The live capture's 1-minute timer
   * survived only because it was shorter than the 10-minute idle window; a
   * 15-minute one would have been silently destroyed.
   *
   * Two holds, both bounded:
   *
   *  - a settled shell whose continuation has not opened yet
   *    (`continuationGraceMs`), because the runtime is about to re-invoke the
   *    model and closing it in that gap loses the reply;
   *  - live shells, until `getBackgroundTaskTimeoutMs()` (0 = no limit). On
   *    expiry the shells are FORGOTTEN rather than stopped: unlike the Claude
   *    SDK, runtime 1.0.82 exposes no way to stop a shell from the host side
   *    (`stop_bash` is a tool the *model* calls), so the honest choice is to
   *    stop pretending they will report back and let the runtime — and with it
   *    the shells — go. Logged, because it means a command was cut short.
   */
  function backgroundWorkHoldsRuntime() {
    const now = Date.now();
    if (continuationDueSince) {
      if (now - continuationDueSince < continuationGraceMs) return true;
      // The runtime notified and then decided it had nothing to say. Stop
      // pinning; this is the Claude worker's `notificationGraceMs` backstop.
      dbg('continuation grace expired with no continuation turn');
      continuationDueSince = 0;
    }
    if (!backgroundShells.size()) return false;
    const capMs = Number(getBackgroundTaskTimeoutMs()) || 0;
    let expiredAny = false;
    for (const shell of backgroundShells.expireOlderThan(capMs)) {
      expiredAny = true;
      dbg(
        'background shell cap reached; it no longer holds the runtime open',
        shell.shellId,
        shell.description || '(no description)',
      );
    }
    if (expiredAny) publishBackgroundShellTasks();
    return backgroundShells.size() > 0;
  }

  function evaluateLifecycle() {
    // A pending question card means a human is mid-answer; tearing the runtime
    // down under them would discard the session the answer belongs to. A turn
    // that is still publishing counts too: it settled, but its rows are live.
    if (disposed || activeTurn || publishingTurns.size > 0 || pendingHumanRequests > 0 || !client) return;
    if (!(idleShutdownMs > 0)) return;
    // Evaluated before the idle clock so the caps still expire on a runtime
    // that has been quiet far longer than the idle window.
    if (backgroundWorkHoldsRuntime()) return;
    if (Date.now() - lastActivityAt < idleShutdownMs) return;
    void stopRuntime('idle').catch(() => {});
  }

  function startLifecycleTimer() {
    if (lifecycleTimer || !(idleShutdownMs > 0)) return;
    lifecycleTimer = setInterval(evaluateLifecycle, lifecyclePollMs);
    lifecycleTimer.unref?.();
  }

  function stopLifecycleTimer() {
    if (!lifecycleTimer) return;
    clearInterval(lifecycleTimer);
    lifecycleTimer = null;
  }

  // ------------------------------------------------------------------- turn --

  function resolvePerTurnModel(message) {
    const requested = String(message?.model || '').trim();
    if (requested && requested.toLowerCase() !== 'auto') return requested;
    return String(message?.providerModel || '').trim() || defaultModel;
  }

  function createTurn(message, { kind = 'delivered' } = {}) {
    const continuation = kind === 'continuation';
    const turn = {
      // 'delivered' (a queue row arrived) | 'continuation' (the runtime started
      // work by itself and this worker minted a synthetic row for it).
      kind,
      message,
      normalizer: createNormalizerImpl(),
      state: { lastStreamedText: '' },
      result: null,
      settled: false,
      aborted: false,
      stallTimer: null,
      planBoardPosted: false,
      // Set when a mutating tool was actually approved and run this turn.
      acted: false,
      // A delivered row exists before the turn does, so its actions publish
      // straight away. A continuation's row is created asynchronously, so its
      // actions buffer here until it has an id.
      registered: !continuation,
      bufferedActions: [],
      // Set when the synthetic row could not be created; the turn's relay
      // output is dropped (it still lands in the runtime's own transcript)
      // rather than failing the worker.
      discarded: false,
      controlState: null,
      // How many prompts have been SENT into this interaction. The runtime
      // consumes queued prompts in order, and opens one `user.message` segment
      // per prompt as it picks each up, so send order IS segment order.
      //
      // Deliberately not derived from the normalizer's live segment count: at
      // the moment a steering send happens the runtime may not have opened the
      // previous prompt's segment yet, and the steered row would then be
      // attributed the PREVIOUS prompt's answer.
      //
      // Starts at 1, not 0: this turn's own prompt is always its first, and
      // counting it here rather than after `send()` resolves closes the race
      // where a steering delivery lands between the two. A continuation sent no
      // prompt at all, so it starts at 0.
      promptsSent: continuation ? 0 : 1,
      // The segment this turn's OWN reply lands in. For a delivered turn that
      // is where its prompt is picked up — non-zero when a previous interaction
      // left prompts queued inside the runtime, which are consumed first. A
      // continuation has no `user.message` of its own, so the normalizer's
      // implicit first segment is its own.
      baseSegment: continuation ? 0 : carriedPrompts,
      // The segment the NEXT prompt steered into this interaction will be
      // answered in. Tracked explicitly rather than derived, because the two
      // kinds differ: a delivered turn's own prompt occupies `baseSegment`, so
      // the next is `baseSegment + 1`; a continuation occupies segment 0
      // without having sent anything, so the first steered prompt opens
      // segment 1. Getting this wrong cross-publishes the continuation's reply
      // into the user's row.
      nextSegmentIndex: continuation ? 1 : carriedPrompts + 1,
      // The lowest segment index any prompt SENT by this turn can occupy — the
      // floor for the carried-prompt arithmetic when the interaction ends.
      firstSentSegment: continuation ? 1 : carriedPrompts,
      // Cancels any relay question card this turn is blocked on, so an aborted
      // turn does not leave a human answering into the void.
      abortController: new AbortController(),
      // Queue rows delivered mid-turn and steered into this interaction. Each
      // one is owed a response by THIS turn — the runtime answers them all
      // under a single `session.idle`, so nothing else will settle them.
      steeredRows: [],
    };
    if (continuation) {
      // The single in-flight registration for this turn's synthetic row, and
      // the signal that abandons it. One promise, stored ON the turn, so the
      // drive path and a late HTTP response reason about the SAME attempt —
      // registration and abandonment used to run blind of each other, and a
      // registration resolving after the local deadline would adopt a row into
      // a turn already torn down (audit #6).
      turn.registration = null;
      turn.registrationAbort = new AbortController();
      // Resolves `true` once the row exists, `false` once registration gave up
      // or was abandoned. Interactive handlers gate question creation on it: a
      // `user_input.requested` in the gap between "continuation opened" and
      // "row registered" would otherwise mint its card against no row id and
      // degrade to an unsupported answer (audit #7).
      turn.rowReady = new Promise((resolve) => { turn.resolveRowReady = resolve; });
    }
    turn.done = new Promise((resolve, reject) => {
      turn.resolveDone = resolve;
      turn.rejectDone = reject;
    });
    // The stall watchdog and the runtime-exit observer can reject `turn.done`
    // before `runTurn` reaches its `await` — an unhandled rejection that the
    // worker crash guard would escalate into a whole-worker failure. This
    // handler exists only to mark the promise as handled; the real await path
    // still sees the rejection.
    turn.done.catch(() => {});
    turn.settle = () => {
      if (turn.settled) return;
      turn.settled = true;
      turn.disarmStall();
      // The terminal event releases the event stream at once — see
      // `beginPublishing`. The queue row stays owned until the publish lands.
      beginPublishing(turn);
      turn.resolveDone();
    };
    turn.fail = (error) => {
      if (turn.settled) return;
      turn.settled = true;
      turn.disarmStall();
      beginPublishing(turn);
      turn.rejectDone(error);
    };
    turn.disarmStall = () => {
      if (!turn.stallTimer) return;
      clearTimeout(turn.stallTimer);
      turn.stallTimer = null;
    };
    turn.armStall = () => {
      if (!(turnStallTimeoutMs > 0) || turn.settled) return;
      turn.disarmStall();
      turn.stallTimer = setTimeout(() => {
        // A human staring at a question card is not a stalled runtime. Re-arm
        // rather than fail: the card has its own (much longer) timeout, and
        // failing the row here would settle it while the answer is still coming.
        if (pendingHumanRequests > 0) {
          turn.armStall();
          return;
        }
        turn.fail(new Error(
          `copilot worker watchdog: the runtime produced no events for ${Math.round(turnStallTimeoutMs / 1000)}s; `
          + 'the row is failed — resend the message to retry',
        ));
      }, turnStallTimeoutMs);
      turn.stallTimer.unref?.();
    };
    return turn;
  }

  async function runTurn(turn) {
    const { message } = turn;
    const model = resolvePerTurnModel(message);
    // The dequeued row's reasoning effort (audit #9). Normalisation happens in
    // the switcher: `none`/absent mean "the model's default".
    const effort = message?.reasoningEffort ?? null;
    const relayMode = message?.relayMode || 'agent';
    lastRelayMode = relayMode;
    // Set before the session is touched: the heartbeat's owner-recovery guard
    // reads the active ids, so a cold-start delivery must already own its row.
    activeTurn = turn;

    const controlState = controlPoller?.start?.({
      queueMessageId: message.id,
      onAbortTurn: async () => {
        turn.aborted = true;
        // While `ensureSession` is still connecting there is no session to
        // abort and this would be a silent no-op; `runTurn` re-checks
        // `turn.aborted` once the session exists and settles there instead.
        if (!session) return;
        // The runtime answers an abort with `abort` → `agent.interrupted` →
        // `assistant.turn_end` → `session.idle{aborted:true}`, which settles
        // the turn through the normal terminator; this only asks for it.
        await session.abort?.();
      },
    });

    try {
      await ensureSession(model, effort, relayMode);
      if (turn.aborted) {
        // The abort landed while the session was still being built. Nothing
        // was sent, so there is no runtime turn to interrupt — ask anyway (a
        // queued prompt from a previous delivery could still be running) and
        // settle locally rather than sending a prompt the user just cancelled.
        dbg('turn aborted before send', message.id);
        try { await session?.abort?.(); } catch (error) {
          dbg('abort during session setup failed', error?.message || String(error));
        }
        turn.settle();
      } else {
        turn.armStall();
        const sendMode = String(resolveSendModeImpl(message) || '').trim();
        const { prompt: body, attachments } = buildMessageOptionsImpl(message);
        // Relay mode marker + (on a mode change) the standing mode instructions,
        // the relay tool guidance and the live preview-lane block.
        const context = await buildRelayContextPrefix(message).catch(() => null);
        const prompt = withRelayContext(context?.prefix, body);
        // `mode` and `attachments` are FIELDS of the single MessageOptions
        // argument — `send()` takes no second parameter, so passing options
        // positionally drops them silently.
        await session.send({
          prompt,
          ...(attachments?.length ? { attachments } : {}),
          ...(sendMode ? { mode: sendMode } : {}),
          agentMode: copilotAgentModeForRelayMode(relayMode),
        });
        // Committed only now that `send()` accepted the prompt (audit #32): a
        // failed send means the runtime never READ the mode guidance, and
        // committing before it would make the same-mode retry omit it.
        context?.commit();
        // `send()` resolves once the runtime accepted the prompt — it is NOT
        // the turn's completion; the event stream is.
        await turn.done;
      }
    } finally {
      controlPoller?.stop?.(controlState);
      await quiesceTurn(turn);
    }

    return finishTurn(turn, model);
  }

  /**
   * Everything that must happen between "the turn stopped producing events" and
   * "its state may be read": stop the watchdog, release anything blocked on a
   * question card, drain in-flight relay POSTs, and close subagent runs the
   * normalizer never got to close.
   */
  async function quiesceTurn(turn) {
    turn.disarmStall();
    // The card's answer can no longer reach the runtime.
    turn.abortController.abort();
    // Drain in-flight dispatches before the turn's state is read, so a stream
    // POST cannot land after the response.
    await dispatchChain.catch(() => {});
    // Any subagent still open at this point never will be. The normalizer
    // closes strays when it produces a terminal result; these are the paths
    // that never produced one.
    await closeStraySubagentRuns(turn).catch(() => {});
  }

  /**
   * Publish a finished turn's outcome onto its queue row (and every row steered
   * into it).
   *
   * Shared by both turn kinds. A continuation reaches it through
   * `driveContinuation` instead of `runTurn`, but the outcomes are identical:
   * the runtime does not distinguish a turn it started from one it was asked
   * for, so neither does the reporting.
   */
  async function finishTurn(turn, model) {
    const { message } = turn;
    const result = turn.result;
    const responseModel = result?.model || turn.normalizer.model || model || null;
    // Capture only. The POST fires from `handlePendingPayload`'s `finally`,
    // after this row has been published.
    captureTurnUsage(message, result);

    // Whatever this interaction did not get to stays queued in the runtime and
    // shifts the NEXT interaction's segments: the prompts this turn sent occupy
    // `[firstSentSegment, nextSegmentIndex)`, and the ones the runtime never
    // opened a segment for are still in its pending queue.
    //
    // The `max` against `firstSentSegment` is what makes this correct for a
    // continuation, which occupies segment 0 without having sent anything: a
    // continuation that opened no segment at all (an empty self-initiated turn)
    // would otherwise report one carried prompt and shift the next real turn's
    // answer by one.
    const segmentsOpened = turn.normalizer.promptCount();
    carriedPrompts = Math.max(0, turn.nextSegmentIndex - Math.max(turn.firstSentSegment, segmentsOpened));

    // This row's own reply. Falls back to the whole composed text when the
    // runtime opened no segment at all (an empty or immediately-failed turn),
    // which is strictly better than publishing nothing.
    const ownText = String(
      turn.normalizer.segmentText(turn.baseSegment) || result?.text || turn.state.lastStreamedText || '',
    ).trim();

    // A user-initiated abort publishes the partial text and nothing else: the
    // queue row's fate belongs to the server-side abort control, exactly as in
    // the Claude and Cursor workers. Publishing a response here would
    // double-settle the row.
    if (turn.aborted) {
      dbg('turn aborted', message.id);
      // This row's segment only: the steered rows publish their own, and
      // publishing the composed text here would show their replies twice.
      await publishFinalStream(message, ownText);
      // A steered row is NOT covered by the abort control (which knows only
      // about the row the user aborted), so it still has to be settled here or
      // it holds `processing` forever behind a renewing lease.
      await settleSteeredRows(turn, result, responseModel);
      return true;
    }

    // The runtime aborted on its own (`result.aborted` with no relay-side
    // abort control in flight). Nothing server-side is waiting to settle this
    // row, so returning here would leave it pending until the delivery
    // watchdog fails it with a misleading "Relay timeout" — the row has to be
    // settled with a record that says what actually happened.
    if (result?.aborted) {
      dbg('turn interrupted by the runtime', message.id);
      const text = ownText ? `${ownText}\n\n${RUNTIME_INTERRUPTED_NOTE}` : RUNTIME_INTERRUPTED_NOTE;
      await publishFinalStream(message, text);
      await publishResponse(message, { text, model: responseModel });
      await settleSteeredRows(turn, result, responseModel);
      return true;
    }

    if (result?.isError) {
      const classified = classifyCopilotSessionError(result.errorData || { message: result.errorMessage });
      dbg('turn failed', message.id, classified.stableCode);
      await publishFinalStream(message, turn.state.lastStreamedText);
      await publishResponse(message, {
        text: classified.text,
        model: responseModel,
        terminalError: terminalErrorRecord(message, classified),
      });
      // The steered rows failed with it — they were being answered by the same
      // interaction. They get the same terminal record so each row says why.
      await settleSteeredRows(turn, result, responseModel, classified);
      return true;
    }

    // The turn produced a plan but never called exit-plan-mode (or the runtime
    // build has no such hook). Same text-shape fallback the siblings use, and
    // it must go out BEFORE the response: `/api/relay-board` 409s once the
    // queue row leaves `processing`.
    if (shouldPostPlanBoard({
      relayMode: message.relayMode,
      finalText: ownText,
      alreadyPosted: turn.planBoardPosted,
      acted: turn.acted === true,
    })) {
      await publishPlanBoard(turn, ownText, 'plan-mode-fallback');
    }

    // A terminal, non-error turn with no prose is COMPLETE, not a failed
    // delivery — requeuing re-runs deterministically empty work until the
    // retry cap fails the row with a misleading "Relay timeout".
    const publishedText = ownText || EMPTY_TURN_COMPLETION_NOTE;
    await publishFinalStream(message, publishedText);
    await publishResponse(message, { text: publishedText, model: responseModel });
    await settleSteeredRows(turn, result, responseModel);
    return true;
  }

  // ----------------------------------------------------------- continuation --

  /**
   * The runtime started a turn nobody asked for. Give it a relay row.
   *
   * Called synchronously from `routeEvent`, so `activeTurn` is set before the
   * triggering event is dispatched — which is what stops a second opener in the
   * same batch from minting a second row for the same turn, and what makes idle
   * shutdown and the heartbeat see the work immediately.
   *
   * The row itself is created asynchronously (`POST /api/continuation-turn`);
   * everything the turn produces meanwhile buffers on the turn and flushes in
   * order once the row has an id.
   */
  function openContinuationTurn() {
    const turn = createTurn({
      id: null,
      conversationId: sdkSessionId,
      // A self-initiated turn has no delivery to read a mode off, so it runs in
      // the mode the conversation was last driven in — the permission handler
      // and the plan-board gating both read the live turn's mode.
      relayMode: lastRelayMode,
      model: '',
    }, { kind: 'continuation' });
    activeTurn = turn;
    // The gap this pin covers has closed.
    continuationDueSince = 0;
    turn.armStall();
    // Lines produced between turns (a settled shell's notification) belong to
    // the turn they triggered.
    if (pendingActivities.length) {
      for (const text of pendingActivities.splice(0)) {
        turn.bufferedActions.push({ channel: 'activity', payload: { text, subagentRunId: null } });
      }
    }
    dbg('opening a continuation turn for runtime-initiated work');
    // Both are fire-and-forget by design (the SDK's event callback is
    // synchronous and cannot await a turn), so both must swallow: an unhandled
    // rejection here would reach the worker crash guard and take the whole
    // process down over one lost continuation. The caught chain is what lives
    // on the turn, so `awaitContinuationRow` can race it without re-handling.
    turn.registration = registerContinuationRow(turn).catch((error) => {
      dbg('continuation registration threw', error?.message || String(error));
      if (turn.message.id) {
        // The row was created and only the bookkeeping after it failed. Release
        // the buffer to the drive path rather than throwing away a turn that
        // has somewhere to go.
        turn.registered = true;
        turn.resolveRowReady?.(true);
        return;
      }
      abandonContinuationRegistration(turn, 'registration threw');
    });
    driveContinuation(turn).catch((error) => {
      dbg('continuation driver threw', error?.message || String(error));
    });
    return turn;
  }

  /**
   * Give up on a continuation's synthetic row: nothing buffered will ever
   * publish, and a registration still in flight must not adopt a row into this
   * turn when it finally answers. The one place all three abandonment paths
   * (retries exhausted, local deadline expired, registration threw) converge,
   * so none of them can forget the abort signal or leave `rowReady` hanging.
   */
  function abandonContinuationRegistration(turn, reason) {
    turn.discarded = true;
    turn.bufferedActions = [];
    turn.registrationAbort?.abort?.();
    // Interactive handlers stop waiting and take their degraded path.
    turn.resolveRowReady?.(false);
    dbg('continuation registration abandoned:', reason);
  }

  /**
   * Create the synthetic queue row and release the turn's buffered output.
   *
   * Retries on any response that produced no message id — a truthy but empty
   * body must not end the loop early. Giving up discards the turn's relay
   * output (it still lands in the runtime's own transcript) rather than failing
   * the worker: a continuation nobody can see is a lost message, not a broken
   * session.
   */
  async function registerContinuationRow(turn) {
    // One idempotency key for the whole loop: a retry whose predecessor was
    // created server-side but whose response was lost must get the SAME row
    // back, not mint a sibling nobody will ever settle.
    const operationId = randomUUID();
    // Abandonment is decided elsewhere (the drive path's deadline) while this
    // loop is parked on an HTTP await, so the state is RE-checked after every
    // await — the transport has no abort plumbing, which makes these recheck
    // points the only cancellation this request has.
    const signal = turn.registrationAbort?.signal || null;
    const abandoned = () => turn.discarded || signal?.aborted === true;
    let response = null;
    for (let attempt = 0; attempt < 3 && !response?.messageId; attempt += 1) {
      if (abandoned()) return;
      response = await api('POST', '/api/continuation-turn', {
        conversationId: sdkSessionId,
        sdkSessionId,
        relayMode: turn.message.relayMode,
        trigger: CONTINUATION_TRIGGER,
        operationId,
      }).catch((error) => {
        dbg('continuation turn registration failed', error?.message || String(error));
        return null;
      });
      if (!response?.messageId) {
        if (abandoned()) return;
        await new Promise((resolve) => { setTimeout(resolve, continuationRetryDelayMs); });
      }
    }
    if (!response?.messageId) {
      abandonContinuationRegistration(turn, 'no relay message id after 3 attempts');
      return;
    }
    const messageId = String(response.messageId);
    const attemptId = String(response.attemptId || '') || null;
    if (abandoned()) {
      // The drive path gave up on this turn while the request was in flight,
      // and the server has just created a row nobody will publish into.
      // Starting controls or flushing output here would resurrect an abandoned
      // turn; instead the orphan row is settled explicitly — the requeue
      // route's continuation branch tears a processing continuation down as
      // `dropped: 'continuation'` (the same teardown the Claude worker uses
      // for a registration that outlived its hand-off).
      dbg('late continuation registration; tearing the orphan row down', messageId);
      await api('POST', '/api/requeue', {
        messageId,
        ...(attemptId ? { attemptId } : {}),
      }).catch(() => {});
      return;
    }
    turn.message.id = messageId;
    // The attempt the row was minted under; every publish echoes it, exactly
    // as a delivered row echoes the attempt id its delivery carried.
    turn.message.attemptId = attemptId;
    // The route reports which conversation the synthetic row landed on;
    // trusting it beats assuming worker session id === conversation id.
    const conversationId = String(response.conversationId || '').trim();
    if (conversationId) turn.message.conversationId = conversationId;
    // Only now is there a row to abort, so this is where the control poller can
    // start.
    turn.controlState = controlPoller?.start?.({
      queueMessageId: turn.message.id,
      onAbortTurn: async () => {
        turn.aborted = true;
        if (!session) return;
        await session.abort?.();
      },
    }) || null;
    await flushBufferedActions(turn);
    turn.registered = true;
    turn.resolveRowReady?.(true);
  }

  /**
   * Resolve once the continuation's row exists, its registration gave up, or
   * the local deadline expires — in which case the turn is ABANDONED, so the
   * registration cannot later adopt a row into it (it tears the row down
   * instead; see `registerContinuationRow`'s late-response branch).
   */
  async function awaitContinuationRow(turn, timeoutMs = continuationRegistrationTimeoutMs) {
    if (turn.registered || turn.discarded) return;
    let timer = null;
    const expired = new Promise((resolve) => {
      timer = setTimeout(() => resolve('expired'), timeoutMs);
      timer.unref?.();
    });
    // `turn.registration` is the caught chain and never rejects.
    const outcome = await Promise.race([turn.registration || Promise.resolve(), expired]);
    clearTimeout(timer);
    if (outcome === 'expired' && !turn.registered && !turn.message.id) {
      abandonContinuationRegistration(turn, 'registration outlived the local deadline');
    }
  }

  /**
   * Run a continuation to its terminator and publish it, mirroring
   * `handlePendingPayload`'s outer shape.
   *
   * Row ownership is released only after every publish has landed, exactly as
   * for a delivered turn: a heartbeat firing inside the publish window with no
   * active ids would tell the relay this worker owns nothing, and the
   * still-`processing` synthetic row would be recovered underneath it. (The
   * EVENT stream was already released at the terminator — see
   * `beginPublishing` — so the runtime's next self-initiated turn can open
   * while this one is still writing.)
   */
  async function driveContinuation(turn) {
    let failure = null;
    try {
      await turn.done;
    } catch (error) {
      failure = error;
    }
    try {
      await quiesceTurn(turn);
      // Nothing can be published before the row exists. The buffer is drained
      // by the registration itself; this only covers actions that arrived
      // during the drain.
      await awaitContinuationRow(turn);
      // The invariant is the id, not the flag: registration can also give up by
      // throwing, or by taking longer than `awaitContinuationRow` waits, and
      // publishing against `messageId: null` would attribute the whole turn to
      // nothing at all.
      if (!turn.message.id) {
        if (!turn.discarded) abandonContinuationRegistration(turn, 'no relay row at publish time');
        dbg('continuation output dropped (no relay row)');
        // The steering path is still waiting on any row it handed us, and it
        // has no row of its own to fall back to.
        await settleSteeredRows(turn, null, null, classifyCopilotTurnException(
          failure || new Error('the relay refused a continuation row for this turn'),
        )).catch(() => {});
        return;
      }
      await flushBufferedActions(turn);
      if (failure) {
        const classified = classifyCopilotTurnException(failure);
        dbg('continuation turn failed', turn.message.id, classified.detail);
        await publishResponse(turn.message, {
          text: classified.text,
          model: null,
          terminalError: terminalErrorRecord(turn.message, classified),
        });
        await settleSteeredRows(turn, null, null, classified).catch(() => {});
        return;
      }
      await finishTurn(turn, '');
    } catch (error) {
      dbg('continuation publish failed', error?.message || String(error));
    } finally {
      controlPoller?.stop?.(turn.controlState);
      turn.controlState = null;
      releaseTurnOwnership(turn);
      touch();
      // A continuation spends real quota (the live capture burned a premium
      // request on `read_bash` + the reply), so its numbers ride the same
      // fire-and-forget ingest as a delivered turn's.
      postTurnUsage();
    }
  }

  /**
   * Settle every queue row that was steered into this interaction.
   *
   * The runtime answers the original prompt AND every prompt queued behind it
   * under ONE `session.idle` (live-verified — see the plan doc §5), so no
   * second turn will ever settle these rows. Each one is answered with the text
   * of ITS OWN prompt segment, which the normalizer separates using the
   * `user.message` events that mark where the runtime picked each prompt up.
   *
   * A row whose prompt the runtime accepted but never started work on has no
   * segment. It is NOT requeued: the prompt is still sitting in the runtime's
   * pending queue and will be answered at the start of the next turn, so
   * redelivering it would run the same prompt twice. It gets a note instead —
   * the same trade the Claude worker makes for a handed-off context.
   */
  async function settleSteeredRows(turn, result, responseModel, classified = null) {
    if (!turn.steeredRows.length) return;
    for (const steered of turn.steeredRows) {
      const { message: steeredMessage, segmentIndex } = steered;
      let text = String(turn.normalizer.segmentText(segmentIndex) || '').trim();
      if (classified) {
        text = classified.text;
      } else if (!text) {
        text = STEERED_ROW_MERGED_NOTE;
      }
      await publishFinalStream(steeredMessage, text);
      await publishResponse(steeredMessage, {
        text,
        model: responseModel,
        ...(classified ? { terminalError: terminalErrorRecord(steeredMessage, classified) } : {}),
      });
      steered.settle?.();
    }
    turn.steeredRows.length = 0;
  }

  /**
   * A delivery arrived while a turn was already running.
   *
   * The relay's worker socket is single-flight — it will not deliver a second
   * row until `onDeliver` resolves — so this is not the normal path. It is
   * reachable on a socket reconnect that redelivers, and it is the path a
   * future relay change would take, so it steers rather than corrupting the
   * turn: the prompt is queued into the SAME interaction (which is all
   * `mode: "enqueue"` can do — it cannot interrupt an in-flight model call),
   * and the row is adopted so the interaction's terminator settles it too.
   *
   * The row is registered BEFORE the send so a failure between the two cannot
   * leave a row nobody owns.
   */
  async function steerIntoActiveTurn(turn, message) {
    const { prompt: body, attachments } = buildMessageOptionsImpl(message);
    // A real relay round trip on the first turn of a mode — long enough for the
    // turn to finish underneath us.
    const context = await buildRelayContextPrefix(message).catch(() => null);
    const prompt = withRelayContext(context?.prefix, body);
    // Re-checked AFTER the awaits and before anything is sent or registered.
    // `settleSteeredRows` has already run if the turn settled during them, so a
    // row pushed now would never be settled and its caller would wait forever —
    // wedging the single-flight delivery socket. Nothing has been sent yet, so
    // handing the row back to the normal path is free.
    if (turn.settled) {
      dbg('turn settled while steering was preparing; running it as a fresh turn', message.id);
      return NOT_STEERED;
    }
    // Prompts are consumed in the order they were sent, and each opens its own
    // `user.message` segment as it is picked up, so this prompt's send position
    // (after any prompts carried over from a previous interaction, and after
    // whatever the interaction itself occupies) is its segment index.
    const segmentIndex = turn.nextSegmentIndex;
    turn.nextSegmentIndex += 1;
    turn.promptsSent += 1;
    const steered = { message, segmentIndex };
    steered.done = new Promise((resolve) => { steered.settle = resolve; });
    turn.steeredRows.push(steered);
    dbg('steering a mid-turn delivery into the running turn', message.id, `segment=${segmentIndex}`);
    try {
      await session.send({
        prompt,
        ...(attachments?.length ? { attachments } : {}),
        mode: 'enqueue',
        agentMode: copilotAgentModeForRelayMode(message?.relayMode || 'agent'),
      });
    } catch (error) {
      // The prompt never reached the runtime, so nothing will answer it and the
      // row is safe to requeue — unlike an accepted one.
      turn.steeredRows = turn.steeredRows.filter((entry) => entry !== steered);
      dbg('steering send failed, requeuing the row', message.id, error?.message || String(error));
      await api('POST', '/api/requeue', { messageId: message.id, ...attemptFields(message) }).catch(() => {});
      return true;
    }
    // Same commit-after-send rule as `runTurn` (audit #32): a steered prompt
    // whose send failed never delivered its guidance, so the retry must
    // include it again.
    context?.commit();
    // Resolves when the interaction settles this row in `settleSteeredRows`.
    await steered.done;
    return true;
  }

  async function handlePendingPayload(pending) {
    const message = pending?.message || null;
    if (!message) return false;
    // A delivery that lands while a turn is running is steered into it rather
    // than starting a second one: the runtime has a single conversation and a
    // concurrent `send` would interleave into the same interaction anyway —
    // this way the row is owned and settled instead of orphaned.
    //
    // Deliberately OUTSIDE the try/finally below: that `finally` clears
    // `activeTurn`, and a steered call returns while the turn it was steered
    // into is still publishing. Clearing there would tell the heartbeat this
    // worker owns nothing and the relay would recover the live row.
    if (activeTurn && !activeTurn.settled && session) {
      const turn = activeTurn;
      try {
        const outcome = await steerIntoActiveTurn(turn, message);
        if (outcome !== NOT_STEERED) return outcome;
      } catch (error) {
        dbg('steering failed', message.id, error?.message || String(error));
        const classified = classifyCopilotTurnException(error);
        await publishResponse(message, {
          text: classified.text,
          model: null,
          terminalError: terminalErrorRecord(message, classified),
        });
        return true;
      }
    }
    // Created here rather than inside `runTurn` so the catch and finally below
    // act on THIS turn by identity: under split ownership, `activeTurn` may
    // already belong to a newer turn (a continuation the runtime opened while
    // this one was publishing) by the time they run.
    const turn = createTurn(message);
    try {
      return await runTurn(turn);
    } catch (error) {
      const classified = classifyCopilotTurnException(error);
      dbg('copilot turn failed', message.id, classified.detail);
      // A failure that killed the session (or came from starting it) leaves a
      // handle nothing else can use; drop it so the next delivery rebuilds and
      // resumes rather than sending into a dead runtime. An UNCONFIRMED MODEL
      // SWITCH is the exception: the session is healthy and merely still on
      // its previous model, and tearing the runtime down over it would kill
      // any live detached shells for a selection problem the user fixes by
      // picking another model.
      if (!isModelSwitchUnconfirmedError(error)) {
        await stopRuntime('turn-failure').catch(() => {});
      }
      await publishResponse(message, {
        text: classified.text,
        model: null,
        terminalError: terminalErrorRecord(message, classified),
      });
      // Rows steered into the turn that just threw are owed a response too —
      // and, more urgently, `steerIntoActiveTurn` is still awaiting their
      // settle. Skipping this would wedge that caller (and its queue row)
      // forever behind a heartbeat that keeps renewing the lease.
      await settleSteeredRows(turn, null, null, classified).catch(() => {});
      await closeStraySubagentRuns(turn).catch(() => {});
      return true;
    } finally {
      // Released only once every publish for this row has landed. A heartbeat
      // that fired during the publish window with the row unowned would tell
      // the relay this worker owns nothing, and the still-processing row would
      // be recovered (`owner-heartbeat-idle`) and re-delivered — a duplicate
      // execution racing the response that was already on its way.
      releaseTurnOwnership(turn);
      touch();
      // Every path through the turn — published, failed, aborted, threw — has
      // finished by here, which is the only safe place for the ingest: it is
      // advisory, it is not awaited, and it must never be able to delay a reply
      // that is already written.
      postTurnUsage();
    }
  }

  // --------------------------------------------------------------- teardown --

  function getActiveQueueMessageId() {
    if (activeTurn) return String(activeTurn.message?.id || '');
    // A settled turn still publishing owns its row every bit as much: the
    // heartbeat's owner-recovery guard must keep seeing it until the publish
    // lands, or the relay recovers the row underneath the response in flight.
    for (const turn of publishingTurns) {
      const id = String(turn.message?.id || '');
      if (id) return id;
    }
    return '';
  }

  /**
   * Every row this worker owns — the running turn's own plus any steered into
   * it, and the same for every settled turn still publishing — as
   * `{ id, attemptId }` entries. A steered row missing from it would be
   * recovered mid-flight as `owner-heartbeat-mismatch` and re-delivered while
   * the runtime was still answering it; a publishing row missing from it would
   * be recovered as `owner-heartbeat-idle` while its response was on the wire.
   *
   * Both the heartbeat (lease renewal) and the crash guard (requeue-on-exit)
   * read this: the crash guard takes the entries whole so its requeues stay
   * fenced to this attempt, while the worker's heartbeat call site unwraps the
   * ids (the claim payload is id-only).
   */
  function getActiveQueueMessageIds() {
    const entries = [];
    const push = (message) => {
      const id = String(message?.id || '');
      if (!id || entries.some((entry) => entry.id === id)) return;
      entries.push({ id, attemptId: message?.attemptId || null });
    };
    const collect = (turn) => {
      if (!turn) return;
      push(turn.message);
      for (const steered of turn.steeredRows || []) push(steered.message);
    };
    collect(activeTurn);
    for (const turn of publishingTurns) collect(turn);
    return entries;
  }

  async function dispose() {
    disposed = true;
    stopLifecycleTimer();
    // A question card left `pending` would sit in the UI inviting an answer
    // that nothing is left to read. Time them out before the socket goes.
    await questionBridge.cancelPendingQuestions?.().catch?.(() => {});
    await stopRuntime('worker-shutdown');
  }

  return {
    handlePendingPayload,
    getActiveQueueMessageId,
    getActiveQueueMessageIds,
    // "Active" spans both ownerships: a settled turn still publishing must
    // keep the worker's idle/shutdown gates closed just like a running one.
    isTurnActive: () => !!activeTurn || publishingTurns.size > 0,
    dispose,
    // The turn's tokens/cost/TTFT, as posted to `/api/copilot-plan-usage`.
    getLastTurnUsage: () => lastTurnUsage,
    // The in-flight usage ingest. A test seam ONLY: the turn path deliberately
    // never awaits this, which is what keeps a slow relay from holding a
    // finished reply.
    whenUsagePosted: () => usagePostChain,
    // The in-flight model-catalog snapshot POST — the same kind of seam.
    whenModelSnapshotPosted: () => modelSnapshotChain,
    // Test seams / observability.
    _getState: () => ({
      hasClient: !!client,
      hasSession: !!session,
      appliedModel: appliedModel(),
      // The confirmed reasoning effort (null = the model's default).
      appliedEffort: modelSwitch.current().effort,
      lastActivityAt,
      // 'delivered' | 'continuation' | '' — which kind of turn, if any, owns
      // the runtime-event stream right now.
      activeTurnKind: activeTurn?.kind || '',
      // Settled turns whose relay publishes have not all landed yet.
      publishingTurnCount: publishingTurns.size,
      backgroundShells: backgroundShells.live(),
      continuationDueSince,
    }),
    _evaluateLifecycle: evaluateLifecycle,
  };
}
