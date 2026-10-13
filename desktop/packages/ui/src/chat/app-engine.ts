// SPDX-License-Identifier: Apache-2.0
/**
 * App engine mount (doc 05 P3a): ONE SyncEngine per runtime window; SSE
 * harness + control frames dispatch into the engine's batch pipeline;
 * runtime switch resets the engine. Replaces the P1 interim store wiring.
 */
import { createSyncEngine, type SyncEngine } from '../sync/sync-engine.ts';
import { subscribeControlEvents, subscribeHarnessEvents, unwrapEventFrame } from '../lib/nnd/events.ts';
import { useMessageQueueStore } from '../stores/useMessageQueueStore.ts';
import { toast } from 'sonner';
import { createDesktopNotificationEventHandler } from '../sync/desktop-notifications.ts';
import { useSettingsStore } from '../lib/settings/store.ts';
import { useSessionViewStore } from '../sync/view-store.ts';
import { normalizeDirectory } from '../lib/nnd/client.ts';

const notifyDesktop = createDesktopNotificationEventHandler({
  settings: () => useSettingsStore.getState().doc,
  notify: (payload) => window.__NOTNATIVE_RUNTIME_APIS__?.notifications.notifyAgentCompletion(payload) ?? false,
  resolveDirectory: (sessionId) => engineSingleton?.routingDirectoryOf(sessionId),
  shouldNotify: (event, kind, sessionId) => {
    const engine = engineSingleton;
    const directory = typeof event.directory === 'string' && event.directory
      ? normalizeDirectory(event.directory) : undefined;
    const store = directory ? engine?.childStoreOf(directory) : undefined;
    if (kind === 'completion' || kind === 'error') {
      // Session settle notifications are only meaningful for top-level sessions.
      // Without an authoritative session record, fail closed rather than alert
      // on an event whose hierarchy cannot be determined.
      const session = store?.getState().session.find((item) => item.id === sessionId);
      if (!session || session.parentID) return false;
    }
    const view = useSessionViewStore.getState();
    const viewed = !!directory && normalizeDirectory(view.activeDirectory) === directory
      && view.currentSessionId === sessionId && typeof document !== 'undefined' && document.hasFocus();
    return !viewed;
  },
});

/** Doc 12 §D.5/§D.6: the message-queue fanout rides the control stream as a
 *  REVISION notification — the store re-reads the snapshot (coalesced). */
const MESSAGE_QUEUE_UPDATED = 'notnative:message-queue.updated';

export function handleQueueBroadcast(type: string, properties: Record<string, unknown> | undefined): void {
  if (type !== MESSAGE_QUEUE_UPDATED) return;
  const revision = typeof properties?.['revision'] === 'number' ? properties['revision'] : 0;
  void useMessageQueueStore.getState().applyRevisionNotification(revision);
}

let engineSingleton: SyncEngine | null = null;
let subscriptionCleanups: Array<() => void> = [];

export function mountEngine(): SyncEngine {
  if (engineSingleton) return engineSingleton;
  const engine = createSyncEngine('auto');
  engineSingleton = engine;
  void wireStreams(engine);
  void engine.start().catch((error) => {
    console.warn('[engine] start failed', error);
  });
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', () => unmountEngine());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushDrafts();
    });
  }
  return engine;
}

function unmountEngine(): void {
  engineSingleton?.dispose();
  engineSingleton = null;
  for (const cleanup of subscriptionCleanups) cleanup();
  subscriptionCleanups = [];
}

export function dispatchRawEvent(engine: SyncEngine, raw: unknown): void {
  const event = unwrapEventFrame(raw);
  if (!event) return;
  engine.handleHarnessEventDirect({ type: event.type, properties: event.properties, directory: event.directory });
}

async function wireStreams(engine: SyncEngine): Promise<void> {
  try {
    const stopHarness = await subscribeHarnessEvents((event) => {
      engine.handleHarnessEventDirect(event);
      surfaceInterruptions(event.type, event.properties);
      notifyDesktop(event);
    });
    subscriptionCleanups.push(stopHarness);
    const stopControl = await subscribeControlEvents((event) => {
      engine.handleHarnessEventDirect(event);
      handleQueueBroadcast(event.type, event.properties);
    });
    subscriptionCleanups.push(stopControl);
  } catch (error) {
    console.warn('[engine] stream attach failed', error);
  }
}

/** The P1-era friendly toasts, retired per U§05 F.3 — surfaces only, cards render. */
function surfaceInterruptions(type: string, properties: Record<string, unknown> | undefined): void {
  if (type === 'session.error') {
    const error = (properties?.['error'] ?? {}) as { name?: string };
    if (error.name !== 'MessageAbortedError') toast.error(`Turn error: ${error.name ?? 'unknown'}`);
  }
}

function flushDrafts(): void {
  // drafts module flushes on pagehide of its own; kept as an explicit hook
  void engineSingleton;
}
