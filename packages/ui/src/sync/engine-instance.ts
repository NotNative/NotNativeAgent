// SPDX-License-Identifier: Apache-2.0
/**
 * Engine instance parts (doc 04 §I): the concrete wiring of manager + loader +
 * routing + recovery + materializer + watchdog + settle poll + side effects.
 * createSyncEngine (sync-engine.ts) stays a thin facade over these parts.
 */
import type { StoreApi } from 'zustand/vanilla';
import { getRuntimeKey, onRuntimeEndpointChanged } from '../lib/runtime-switch.ts';
import { normalizeDirectory } from '../lib/nnd/client.ts';
import type { HarnessEvent } from '../lib/nnd/events.ts';
import type { Session } from '../lib/nnd/types.ts';
import type { DirectoryStore, MaterializationRequest } from './types.ts';

import { BOOT_DEBOUNCE_MS, CONNECTION_GRACE_MS } from './types.ts';
import { ChildStoreManager, type Bootstrapper } from './child-store.ts';
import { SessionMessageLoader } from './session-message-loader.ts';
import { createRoutingIndex, registerSessionDirectory, resolveDirectoryFromRoutingIndex, GLOBAL_DIRECTORY, type EventRoutingIndex } from './routing-index.ts';
import { DirectoryEventBatch } from './event-reducer.ts';
import { createEventPipeline, type EventPipeline } from './event-pipeline.ts';
import { bootstrapDirectory } from './bootstrap-directory.ts';
import { runGlobalBootstrap } from './bootstrap.ts';
import { mergeBootstrapLists } from './session-actions.ts';
import { adoptPersistedActivity, resetActivityTiming, useStreamingStore } from './activity-streaming.ts';
import { createMaterializationScheduler } from './engine-materialization.ts';
import { createRecovery } from './engine-recovery.ts';
import { startWatchdog } from './engine-watchdog.ts';
import { createMessageCompletionPoll } from './engine-message-poll.ts';
import { applySideEffects, type SideEffectDeps } from './engine-side-effects.ts';
import { useGlobalSessionsStore, useGlobalSessionStatusStore, useGlobalSyncStore } from './global-stores.ts';
import { useSessionOrderingStore } from './session-ordering.ts';
import { installPersistLifecycleFlush, writeCachedSessions, readLastActiveSession } from './persist-cache.ts';
import { useConfigStore } from '../stores/useConfigStore.ts';
import { useSessionViewStore } from './view-store.ts';
import { defaultHarnessDirectory, recoverInterruptedTurnAfterMessageLoad, reconcileStreaming } from './engine-support.ts';
import { createSessionActions } from './engine-actions.ts';

const evictionTimerStop: { timer: ReturnType<typeof setInterval> | null } = { timer: null };
const EVICTION_SWEEP_INTERVAL_MS = 30_000;

interface EngineParts {
  manager: ChildStoreManager;
  loader: SessionMessageLoader;
  routing: EventRoutingIndex;
  isRecentBoot: () => boolean;
  start: () => Promise<void>;
  dispose: () => void;
  resetAll: () => void;
  waitForConnection: () => Promise<void>;
  handleFlush: (directory: string, events: readonly HarnessEvent[]) => void;
  routeEvent: (event: HarnessEvent) => string;
  pipelineRef: () => EventPipeline | null;
  resyncAfterStreamGap: (reason: string) => Promise<void>;
  materializerPending: () => number;
  actions: import('./engine-actions.ts').SessionActionsApi;
}

class EngineCtx {
  transport!: 'auto' | 'ws' | 'sse';
  manager!: ChildStoreManager;
  loader!: SessionMessageLoader;
  routing!: EventRoutingIndex;
  messagePoll!: ReturnType<typeof createMessageCompletionPoll>;
  recovery!: ReturnType<typeof createRecovery>;
  materializer!: ReturnType<typeof createMaterializationScheduler>;
  deps!: SideEffectDeps;
  pipelineRef: EventPipeline | null = null;
  watchdogStop: (() => void) | null = null;
  runtimeUnwatch: (() => void) | null = null;
  disposed = false;
  finalized = false;
  bootedAt = 0;
}

export function buildEngineParts(transport: 'auto' | 'ws' | 'sse'): EngineParts {
  const ctx = new EngineCtx();
  ctx.transport = transport;
  ctx.manager = new ChildStoreManager();
  ctx.loader = new SessionMessageLoader();
  ctx.routing = createRoutingIndex();
  wireEngineModules(ctx);
  ctx.manager.configure(bootstrapperFor(ctx));
  const actions = createSessionActions(
    buildEngineServices(ctx, () => partsWaitForConnection(ctx)),
    () => ctx.manager.children,
  );
  return {
    manager: ctx.manager,
    loader: ctx.loader,
    routing: ctx.routing,
    isRecentBoot: () => partsIsRecentBoot(ctx),
    start: () => partsStart(ctx),
    dispose: () => partsDispose(ctx),
    resetAll: () => partsResetAll(ctx),
    waitForConnection: () => partsWaitForConnection(ctx),
    handleFlush: (directory, events) => partsHandleFlush(ctx, directory, events),
    routeEvent: (event) => partsRouteEvent(ctx, event),
    pipelineRef: () => ctx.pipelineRef,
    resyncAfterStreamGap: ctx.recovery.resyncAfterStreamGap,
    materializerPending: () => ctx.materializer.stats().pending,
    actions,
  };
}

function wireEngineModules(ctx: EngineCtx): void {
  ctx.recovery = createRecovery({
    disposed: () => ctx.disposed,
    manager: ctx.manager,
    loader: ctx.loader,
    routing: ctx.routing,
    afterMessageLoad: afterMaterializedLoad,
  });
  installChildPlumbing(ctx.manager, ctx.loader, ctx.recovery);
  ctx.messagePoll = createMessageCompletionPoll({ disposed: () => ctx.disposed, manager: ctx.manager });
  ctx.materializer = createMaterializationScheduler({
    disposed: () => ctx.disposed,
    storeOf: (directory) => ctx.manager.children.get(normalizeDirectory(directory)),
    statusResync: (directory, sessionIDs) => ctx.recovery.authoritativeStatusResync(directory, sessionIDs),
    refreshTail: (store, directory, sessionID, limit) => ctx.loader.refreshTail({ directory, sessionID, store }, limit),
    afterLoad: afterMaterializedLoad,
  });
  ctx.deps = {
    disposed: () => ctx.disposed,
    viewCurrentSessionId: () => useSessionViewStore.getState().currentSessionId,
    enqueueMaterialization: (request, directory) => ctx.materializer.enqueue(request as MaterializationRequest, directory),
    loaderInvalidate: (directory, sessionID) => {
      const store = ctx.manager.peekChild(directory);
      if (store) ctx.loader.invalidateSession({ directory, sessionID, store });
    },
    messagePoll: (directory, sessionID) => ctx.messagePoll.schedule(directory, sessionID),
    onGlobalRefresh: async () => {
      if (ctx.bootedAt !== 0 && Date.now() - ctx.bootedAt < BOOT_DEBOUNCE_MS) return;
      await runGlobalBootstrap();
      useGlobalSyncStore.getState().set({ reload: 'pending' });
      forceBootstrapChildren(ctx.manager);
    },
    storeOf: (directory) => ctx.manager.children.get(normalizeDirectory(directory)),
  };
}

function bootstrapperFor(ctx: EngineCtx): Bootstrapper {
  return (dir, store, isCurrent) => bootstrapDirectory(dir, store, isCurrent, {
    activeProjectFor: () => null, // layout demand-driver arrives with doc 05
    mergeBootstrap: (mergeDir, mergeStore, rootSessions, allSessions) => mergeAuthoritative(ctx.routing, mergeDir, mergeStore, rootSessions, allSessions),
  });
}

function partsIsRecentBoot(ctx: EngineCtx): boolean {
  return ctx.bootedAt !== 0 && Date.now() - ctx.bootedAt < BOOT_DEBOUNCE_MS;
}

async function partsStart(ctx: EngineCtx): Promise<void> {
  if (ctx.disposed || ctx.finalized) return;
  await runGlobalBootstrap(); // §C.1: global bootstrap FIRST (per mount / runtime switch)
  ctx.bootedAt = Date.now(); // the suppression window measures from COMPLETION
  adoptPersistedActivity();
  const directory = normalizeDirectory(await defaultHarnessDirectory());
  useSessionViewStore.getState().setActiveDirectory(directory);
  ctx.manager.ensureChild(directory);
  void readLastActiveSession(); // confirm-before-open lands with doc 05 layout
  void ctx.recovery.resyncDirectory(directory, 'initial');
  ctx.watchdogStop?.();
  ctx.watchdogStop = startWatchdog({
    disposed: () => ctx.disposed,
    manager: ctx.manager,
    pipeline: () => ctx.pipelineRef,
    resyncDirectory: ctx.recovery.resyncDirectory,
    enqueueMaterialization: (request, directory) => ctx.materializer.enqueue(request as MaterializationRequest, directory),
  });
  ctx.pipelineRef?.cleanup();
  ctx.pipelineRef = createEventPipeline({
    transport: ctx.transport,
    onEvents: (eventDirectory, events) => partsHandleFlush(ctx, eventDirectory, events),
    onConnected: ({ replayReset, skipResync }) => {
      useConfigStore.setState({ isConnected: true, haveEverConnected: true, connectionPhase: 'connected', lastDisconnectReason: null });
      if (skipResync) return;
      void ctx.recovery.resyncAfterStreamGap(replayReset ? 'replay-reset' : 'stream-reconnect');
    },
    onDisconnected: (reason) => {
      useConfigStore.setState({ isConnected: false, connectionPhase: 'reconnecting', lastDisconnectReason: reason as never });
      // evidence preserved: the real reason reaches the store (POWER10 #5)
    },
    onTransportSwitch: (reason) => {
      void ctx.recovery.resyncAfterStreamGap(`transport-switch:${reason}`);
    },
    isRecentBoot: () => partsIsRecentBoot(ctx),
  });
  ctx.runtimeUnwatch?.();
  ctx.runtimeUnwatch = onRuntimeEndpointChanged(() => {
    partsResetAll(ctx);
    void partsStart(ctx);
  });
  // §F.5 eviction pass: coalesced periodic sweep (pins/grace/TTL rules inside)
  endEvictionSweep(evictionTimerStop);
  evictionTimerStop.timer = setInterval(() => {
    if (!ctx.disposed && !ctx.finalized) ctx.manager.runEviction();
  }, EVICTION_SWEEP_INTERVAL_MS);
}

function partsDispose(ctx: EngineCtx): void {
  ctx.finalized = true;
  ctx.disposed = true;
  endEvictionSweep(evictionTimerStop);
  endEvictionSweep(evictionTimerStop);
  ctx.runtimeUnwatch?.();
  ctx.runtimeUnwatch = null;
  ctx.watchdogStop?.();
  ctx.watchdogStop = null;
  ctx.pipelineRef?.cleanup();
  ctx.pipelineRef = null;
  ctx.manager.dispose();
  ctx.loader.dispose();
  ctx.messagePoll.reset();
  ctx.materializer.reset();
  ctx.recovery.reset();
  resetActivityTiming();
}

function partsResetAll(ctx: EngineCtx): void {
  ctx.loader.configure(getRuntimeKey());
  ctx.manager.reset(); // reversible reset: the runtime switch re-arms this manager
  useGlobalSessionStatusStore.getState().reset();
  useGlobalSessionsStore.getState().reset();
  useGlobalSyncStore.getState().reset();
  useSessionOrderingStore.getState().reset();
  useStreamingStore.getState().reset();
  resetActivityTiming();
  ctx.messagePoll.reset();
  ctx.materializer.reset();
  ctx.recovery.reset();
}

async function partsWaitForConnection(ctx: EngineCtx): Promise<void> {
  const graceDeadline = Date.now() + CONNECTION_GRACE_MS;
  let probeInFlight = false;
  let lastProbeAt = 0;
  for (;;) {
    if (useConfigStore.getState().isConnected) return;
    if (Date.now() >= graceDeadline) throw new Error('server unavailable');
    if (!probeInFlight && Date.now() - lastProbeAt > 500) {
      probeInFlight = true;
      lastProbeAt = Date.now();
      void useConfigStore.getState().checkConnection().catch(() => undefined).then(() => { probeInFlight = false; });
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
}

function partsRouteEvent(ctx: EngineCtx, event: HarnessEvent): string {
  const props = (event.properties ?? {}) as Record<string, unknown>;
  const sessionID = pickString(props['sessionID'])
    ?? pickString((props['info'] as Record<string, unknown> | undefined)?.['sessionID'])
    ?? pickString((props['part'] as Record<string, unknown> | undefined)?.['sessionID']);
  const messageID = pickString(props['messageID'])
    ?? pickString((props['part'] as Record<string, unknown> | undefined)?.['messageID']);
  const view = useSessionViewStore.getState();
  const rawDirectory = event.directory ?? (typeof props['directory'] === 'string' ? props['directory'] : '');
  const activeDir = normalizeDirectory(view.activeDirectory || GLOBAL_DIRECTORY);
  const singleStore = ctx.manager.children.size === 1 ? [...ctx.manager.children.keys()][0]! : null;
  return resolveDirectoryFromRoutingIndex(ctx.routing, {
    rawDirectory,
    sessionID,
    messageID,
    storeHasSession: (directory, id) => ctx.manager.children.get(directory)?.getState().session.some((session) => session.id === id) ?? false,
    storeHasMessageParts: (directory, id) => ctx.manager.children.get(directory)?.getState().part[id] !== undefined,
    findSessionStore: (id) => ctx.routing.sessionDirectoryById.get(id) ?? null,
    findPartStore: (id) => {
      for (const [dir, store] of ctx.manager.children) if (store.getState().part[id] !== undefined) return dir;
      return null;
    },
    activeDirectory: activeDir,
    activeSessionID: view.currentSessionId,
    activeStoreExists: ctx.manager.children.has(activeDir),
    singleStore,
  });
}

function partsHandleFlush(ctx: EngineCtx, directoryOverride: string, events: readonly HarnessEvent[]): void {
  if (ctx.disposed) return;
  const byStore = new Map<string, HarnessEvent[]>();
  for (const event of events) {
    const dir = normalizeDirectory(directoryOverride || partsRouteEvent(ctx, event));
    const list = byStore.get(dir) ?? [];
    list.push(event);
    byStore.set(dir, list);
  }
  for (const [dir, list] of byStore) partsApplyDirectoryBatch(ctx, dir, list);
}

function partsApplyDirectoryBatch(ctx: EngineCtx, dir: string, events: HarnessEvent[]): void {
  const store = ctx.manager.ensureChild(dir);
  const batch = new DirectoryEventBatch(store);
  for (const event of events) batch.apply(event, Date.now());
  batch.commit();
  applySideEffects(dir, store, batch.out, ctx.deps, ctx.routing);
}

function buildEngineServices(
  ctx: EngineCtx,
  waitForConnection: () => Promise<void>,
): import('./session-lifecycle.ts').EngineServices {
  return {
    activeDirectory: () => useSessionViewStore.getState().activeDirectory,
    directoryForSession: (sessionID) => buildServiceDirectoryOf(ctx, sessionID),
    currentSessionId: () => useSessionViewStore.getState().currentSessionId,
    isConnected: () => useConfigStore.getState().isConnected,
    ensureChild: (directory) => ctx.manager.ensureChild(directory),
    peekChild: (directory) => ctx.manager.peekChild(directory),
    registerSessionRoute: (sessionID, directory) => registerSessionDirectory(ctx.routing, sessionID, directory),
    registerMessageRoute: () => undefined,
    enqueueMaterialization: (request, directory) => ctx.materializer.enqueue(request, directory),
    onStatusEvent: (sessionID, status, directory) => {
      const store = ctx.manager.children.get(normalizeDirectory(directory));
      if (store) store.setState({ session_status: { ...store.getState().session_status, [sessionID]: status } });
    },
    loaderInitializeCreated: (directory, sessionID, store) => ctx.loader.initializeCreatedSession({ directory, sessionID, store }),
    loaderOptimisticAdd: (directory, sessionID, store, item) => ctx.loader.optimisticAdd({ directory, sessionID, store }, item),
    loaderOptimisticRemove: (directory, sessionID, store, messageID) => ctx.loader.optimisticRemove({ directory, sessionID, store }, messageID),
    loaderOptimisticConfirm: (directory, sessionID, store, messageID) => ctx.loader.optimisticConfirm({ directory, sessionID, store }, messageID),
    loaderRefreshTail: (directory, sessionID, store) => ctx.loader.refreshTail({ directory, sessionID, store }, 30),
    waitForConnection,
    onSelectSession: (sessionID, directory) => {
      useSessionViewStore.setState({ currentSessionId: sessionID, activeDirectory: normalizeDirectory(directory) });
      registerSessionDirectory(ctx.routing, sessionID, directory);
    },
  };
}

/** Routing-index lookup; falls back to the ACTIVE directory only when that
 * store actually exists (doc 04 §D.3 rule 4 — never a bare guess). */
function buildServiceDirectoryOf(ctx: EngineCtx, sessionID: string): string | null {
  const indexed = ctx.routing.sessionDirectoryById.get(sessionID);
  if (indexed) return indexed;
  const active = normalizeDirectory(useSessionViewStore.getState().activeDirectory);
  return ctx.manager.children.has(active) ? active : null;
}
function forceBootstrapChildren(manager: ChildStoreManager): void {
  for (const [dir, store] of [...manager.children]) {
    if (store.getState().status === 'loading') continue;
    manager.requestBootstrap({ directory: dir, priority: 3, reason: 'server-connected', force: true });
  }
}

function afterMaterializedLoad(store: StoreApi<DirectoryStore>, sessionID: string): void {
  recoverInterruptedTurnAfterMessageLoad(store, sessionID);
  reconcileStreaming(sessionID, store);
}

/** The authoritative merge (§C.3 step 7d): closed hierarchy + overlays. */
function mergeAuthoritative(
  routing: EventRoutingIndex,
  dir: string,
  store: StoreApi<DirectoryStore>,
  rootSessions: Session[],
  allSessions: Session[] | null,
): void {
  const before = store.getState();
  const baseline = before.sessionRevision;
  const liveEventIds = new Set<string>();
  for (const [sessionID, revision] of Object.entries(before.sessionEventRevision ?? {})) {
    if ((revision ?? 0) > baseline) liveEventIds.add(sessionID);
  }
  const merged = mergeBootstrapLists(before.session, rootSessions, allSessions, liveEventIds);
  store.setState({
    session: merged,
    sessionTotal: merged.filter((session) => !session.parentID).length,
    sessionListSource: 'authoritative',
    limit: Math.max(merged.length, 50),
  });
  for (const session of merged) registerSessionDirectory(routing, session.id, dir);
  writeCachedSessions(dir, merged);
  for (const session of merged) useGlobalSessionsStore.getState().upsertSession(session);
}

/** Instance-grade child loader/eviction plumbing (§F.5): disposal churns the
 * loader and recovery, and blocking requests pin a directory against eviction. */
function installChildPlumbing(
  manager: ChildStoreManager,
  loader: SessionMessageLoader,
  recovery: ReturnType<typeof createRecovery>,
): void {
  manager.onDispose = (dir) => {
    loader.invalidateDirectory(dir);
    recovery.forget(dir);
  };
  manager.hasPendingBlockingRequests = (store) => {
    const state = store.getState();
    return Object.values(state.permission).some((bucket) => bucket.length > 0)
      || Object.values(state.question).some((bucket) => bucket.length > 0);
  };
}

function pickString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}


function endEvictionSweep(holder: { timer: ReturnType<typeof setInterval> | null }): void {
  if (holder.timer !== null) clearInterval(holder.timer);
  holder.timer = null;
}
