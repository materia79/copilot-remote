import {
  currentConvId,
  conversations,
  escHtml,
  openSummaryModal,
  closeSummaryModal,
  setSummaryModalLoading,
  showTransientRelayNotice,
} from './store.js';
import {
  killSessionWorker,
  requestRelayRestart,
  requestHostSuspend,
  requestQueueEmpty,
  refreshWorkspaceRootHints,
} from './api-client.js';
import { isSuspendHostActionVisible } from './settings-modal.js';

let killSessionInFlight = false;
let restartRelayInFlight = false;
let suspendHostInFlight = false;
let emptyQueueInFlight = false;

let menuDeps = {
  lockChatActionsMenuShield: () => {},
  closeChatActionsMenu: () => {},
  syncQueueStatusMenuEntry: () => {},
  refreshSessionWorkerStatus: () => Promise.resolve(),
};

function getCurrentConversationSessionInfo() {
  const convId = String(currentConvId || '').trim();
  if (!convId) return null;
  const conversation = conversations[convId] || {};
  const sdkSessionId = String(conversation.sdkSessionId || '').trim();
  if (!sdkSessionId) return null;
  const title = String(conversation.title || document.getElementById('chat-title')?.textContent || convId).trim() || convId;
  return {
    conversationId: convId,
    sdkSessionId,
    title,
  };
}

export function openKillSessionConfirmation() {
  const info = getCurrentConversationSessionInfo();
  if (!info) {
    showTransientRelayNotice('No active session is bound to this conversation.');
    return;
  }
  const escapedTitle = escHtml(info.title);
  openSummaryModal({
    title: 'Kill session',
    subtitle: info.sdkSessionId,
    kind: 'kill-session',
    bodyHtml: `
      <p>Kill the session for <strong>${escapedTitle}</strong>?</p>
      <p>This stops the current worker and any active turn will need a manual retry or a new message.</p>
      <div class="summary-modal-actions">
        <button class="chat-title-action-btn danger-btn" type="button" onclick="confirmKillCurrentSession()">☠️ Kill session</button>
        <button class="chat-title-action-btn" type="button" onclick="closeSummaryModal()">Cancel</button>
      </div>
    `,
  });
}

export async function confirmKillCurrentSession() {
  if (killSessionInFlight) return;
  const info = getCurrentConversationSessionInfo();
  if (!info) {
    closeSummaryModal();
    showTransientRelayNotice('No active session is bound to this conversation.');
    return;
  }
  killSessionInFlight = true;
  setSummaryModalLoading(true);
  try {
    const result = await killSessionWorker(info.sdkSessionId, {
      conversationId: info.conversationId,
      title: info.title,
    });
    closeSummaryModal();
    if (!result?.ok) {
      alert('Failed to kill session');
      return;
    }
    const statusText = result.processStatus === 'killed'
      ? 'Session killed.'
      : 'Session state cleared; no live worker process was found.';
    showTransientRelayNotice(statusText);
    await menuDeps.refreshSessionWorkerStatus().catch(() => {});
  } finally {
    killSessionInFlight = false;
    setSummaryModalLoading(false);
  }
}

export function openRestartRelayConfirmation() {
  openSummaryModal({
    title: 'Restart web relay',
    subtitle: 'Queues restart via /api/relay/shutdown',
    kind: 'restart-relay',
    bodyHtml: `
      <p>Queue a manual relay restart now?</p>
      <p>The restart waits until the current turn is idle, so it does not interrupt an in-flight turn immediately.</p>
      <div class="summary-modal-actions">
        <button class="chat-title-action-btn" type="button" onclick="confirmRestartWebRelay()">🌄 Restart web relay</button>
        <button class="chat-title-action-btn" type="button" onclick="closeSummaryModal()">Cancel</button>
      </div>
    `,
  });
}

export function openEmptyQueueConfirmation() {
  menuDeps.lockChatActionsMenuShield(350);
  menuDeps.closeChatActionsMenu();
  openSummaryModal({
    title: 'Empty queue',
    subtitle: 'Calls localhost /api/queue/empty',
    kind: 'empty-queue',
    bodyHtml: `
      <p>Drop all queue rows in pending, processing, and parked states?</p>
      <p>This is a local maintenance action and cannot be undone.</p>
      <div class="summary-modal-actions">
        <button class="chat-title-action-btn danger-btn" type="button" onclick="confirmEmptyQueue()">🚮 Empty queue</button>
        <button class="chat-title-action-btn" type="button" onclick="closeSummaryModal()">Cancel</button>
      </div>
    `,
  });
}

export function openSuspendHostConfirmation() {
  if (!isSuspendHostActionVisible()) return;
  menuDeps.lockChatActionsMenuShield(350);
  menuDeps.closeChatActionsMenu();
  openSummaryModal({
    title: 'Suspend host',
    subtitle: 'Requests suspend-to-RAM',
    kind: 'suspend-host',
    bodyHtml: `
      <p>Put this PC to sleep now?</p>
      <p>This requests suspend-to-RAM immediately.</p>
      <div class="summary-modal-actions">
        <button class="chat-title-action-btn" type="button" onclick="confirmSuspendHost()">💤 Suspend host</button>
        <button class="chat-title-action-btn" type="button" onclick="closeSummaryModal()">Cancel</button>
      </div>
    `,
  });
  window.setTimeout(() => {
    const modal = document.getElementById('summary-modal');
    const classVisible = !!modal?.classList?.contains('visible');
    const ariaVisible = String(modal?.getAttribute('aria-hidden') || 'true') === 'false';
    const displayVisible = modal ? window.getComputedStyle(modal).display !== 'none' : false;
    if (classVisible && ariaVisible && displayVisible) return;
    const confirmed = window.confirm('Put this PC to sleep now?\n\nThis requests suspend-to-RAM.');
    if (!confirmed) return;
    confirmSuspendHost().catch(() => {});
  }, 90);
}

export async function confirmSuspendHost() {
  if (!isSuspendHostActionVisible()) return;
  if (suspendHostInFlight) return;
  suspendHostInFlight = true;
  setSummaryModalLoading(true);
  try {
    const result = await requestHostSuspend({
      reason: 'manual-suspend',
      requestedBy: 'localhost-api',
    });
    closeSummaryModal();
    if (!result?.ok) {
      alert('Failed to suspend host');
      return;
    }
  } finally {
    suspendHostInFlight = false;
    setSummaryModalLoading(false);
  }
}

export async function confirmEmptyQueue() {
  if (emptyQueueInFlight) return;
  emptyQueueInFlight = true;
  setSummaryModalLoading(true);
  try {
    const result = await requestQueueEmpty({
      reason: 'manual-empty-queue',
      requestedBy: 'localhost-api',
    });
    closeSummaryModal();
    if (!result?.ok) {
      alert('Failed to empty queue');
      return;
    }
    const droppedCount = Number(result.droppedCount || 0);
    if (droppedCount <= 0) {
      showTransientRelayNotice('Queue is already empty.');
    } else {
      showTransientRelayNotice(`Queue emptied: dropped ${droppedCount} row${droppedCount === 1 ? '' : 's'}.`, 6000);
    }
    const status = await refreshWorkspaceRootHints();
    menuDeps.syncQueueStatusMenuEntry(status);
  } finally {
    emptyQueueInFlight = false;
    setSummaryModalLoading(false);
  }
}

export async function confirmRestartWebRelay() {
  if (restartRelayInFlight) return;
  restartRelayInFlight = true;
  setSummaryModalLoading(true);
  try {
    const result = await requestRelayRestart({
      reason: 'manual-restart',
      requestedBy: 'localhost-api',
      restart: true,
    });
    closeSummaryModal();
    // Restart can close the connection before the browser receives JSON.
    if (!result) {
      showTransientRelayNotice('Relay restart requested. Connection may briefly drop while it restarts.', 7000);
      return;
    }
    if (!result.ok) {
      alert('Failed to queue relay restart');
      return;
    }
    if (result.accepted === false) {
      showTransientRelayNotice('Relay is already shutting down/restarting.', 7000);
      return;
    }
    const queue = result.queue || {};
    showTransientRelayNotice(
      `Relay restart queued (pending=${Number(queue.pendingCount || 0)}, processing=${Number(queue.processingCount || 0)}).`,
      7000,
    );
  } finally {
    restartRelayInFlight = false;
    setSummaryModalLoading(false);
  }
}

export function initActionConfirmations({
  lockChatActionsMenuShield,
  closeChatActionsMenu,
  syncQueueStatusMenuEntry,
  refreshSessionWorkerStatus,
  exposeOnWindow = true,
} = {}) {
  menuDeps = {
    lockChatActionsMenuShield: typeof lockChatActionsMenuShield === 'function' ? lockChatActionsMenuShield : menuDeps.lockChatActionsMenuShield,
    closeChatActionsMenu: typeof closeChatActionsMenu === 'function' ? closeChatActionsMenu : menuDeps.closeChatActionsMenu,
    syncQueueStatusMenuEntry: typeof syncQueueStatusMenuEntry === 'function' ? syncQueueStatusMenuEntry : menuDeps.syncQueueStatusMenuEntry,
    refreshSessionWorkerStatus: typeof refreshSessionWorkerStatus === 'function' ? refreshSessionWorkerStatus : menuDeps.refreshSessionWorkerStatus,
  };
  if (!exposeOnWindow) return;
  window.openKillSessionConfirmation = openKillSessionConfirmation;
  window.openRestartRelayConfirmation = openRestartRelayConfirmation;
  window.openEmptyQueueConfirmation = openEmptyQueueConfirmation;
  window.openSuspendHostConfirmation = openSuspendHostConfirmation;
  window.confirmKillCurrentSession = confirmKillCurrentSession;
  window.confirmRestartWebRelay = confirmRestartWebRelay;
  window.confirmSuspendHost = confirmSuspendHost;
  window.confirmEmptyQueue = confirmEmptyQueue;
}
