// SPDX-License-Identifier: Apache-2.0
/**
 * Event pipeline supervisor (doc 04 §D.1/§D.5): transport selection with
 * auto fallback, heartbeat timeout, bounded backoff with early resume, and
 * the per-directory coalescing queues. One pipeline per runtime.
 */
import type { HarnessEvent } from '../lib/nnd/events.ts';
import { appendAuthTokenToUrl, clearCachedUrlAuthToken } from '../lib/runtime-auth.ts';
import { getRealtimeBaseUrl } from '../lib/runtime-url.ts';
import { PipelineQueues, computeRetryDelay, isPermanent4xx } from './pipeline-queues.ts';
import { attemptSse, attemptWs, type AttemptContext, type EstablishedInfo } from './pipeline-attempts.ts';
import { DEFAULT_HEARTBEAT_TIMEOUT_MS, DEFAULT_WS_READY_TIMEOUT_MS, WS_FALLBACK_WINDOW_MS } from './types.ts';

export interface PipelineOptions {
  transport: 'auto' | 'ws' | 'sse';
  onEvents: (directory: string, events: readonly HarnessEvent[]) => void;
  onConnected: (info: { replayReset: boolean; skipResync: boolean; signal: AbortSignal }) => void | Promise<void>;
  onDisconnected: (reason: string) => void;
  onTransportSwitch: (reason: string) => void;
  isRecentBoot: () => boolean;
  globalEventUrl?: string; // default: /api/global/event on the runtime origin
}

export interface EventPipeline {
  cleanup: () => void;
  reconnect: (reason: string) => void;
  noteStreamActivity: (at?: number) => void;
  lastStreamActivityAt: () => number;
  cursor: () => string | null;
}

const SYSTEM_RESUME_EVENT = 'openchamber:system-resume';

interface PipelineState {
  options: PipelineOptions;
  context: AttemptContext;
  queues: PipelineQueues;
  stopped: boolean;
  currentAbort: AbortController | null;
  lastEventId: string | null;
  failures: number;
  firstConnect: boolean;
  disconnectedBeforeFirstConnect: boolean;
  lastActivityAt: number;
  wsFallbackUntil: number;
  pendingRetryResolve: (() => void) | null;
  everConnected: boolean;
  intentionalAbort: boolean;
}

export function createEventPipeline(options: PipelineOptions): EventPipeline {
  const queues = new PipelineQueues((directory, events) => {
    state.lastEventId = replayCursorAfterFlush(state.lastEventId, events);
    options.onEvents(directory, events);
  });
  const state: PipelineState = {
    options,
    context: {
      lastEventId: () => state.lastEventId,
      setLastEventId: (id) => { state.lastEventId = id; },
      noteActivity: () => { state.lastActivityAt = Date.now(); },
      queues,
    },
    queues,
    stopped: false,
    currentAbort: null,
    lastEventId: null,
    failures: 0,
    firstConnect: true,
    disconnectedBeforeFirstConnect: false,
    lastActivityAt: 0,
    wsFallbackUntil: 0,
    pendingRetryResolve: null,
    everConnected: false,
    intentionalAbort: false,
  };
  void pipeLoop(state);
  const listeners = pipeInstallListeners(state);
  const heartbeatTimer = pipeHeartbeat(state);
  return pipeCreateApi(state, heartbeatTimer, listeners);
}

export function replayCursorAfterFlush(current: string | null, events: readonly HarnessEvent[]): string | null {
  let cursor = current;
  for (const event of events) {
    if (event.type !== 'server.connected' && typeof event.id === 'string') cursor = event.id;
  }
  return cursor;
}

function pipeGlobalUrl(state: PipelineState): string {
  return state.options.globalEventUrl ?? `${getRealtimeBaseUrl()}/api/global/event`;
}

function pipePageVisible(): boolean {
  return typeof document === 'undefined' ? true : document.visibilityState !== 'hidden';
}

function pipeNavigatorOnline(): boolean {
  return typeof navigator === 'undefined' ? true : navigator.onLine !== false;
}

/** `sse` when WebSocket is absent; auto prefers ws unless in fallback window. */
function pipeResolveTransport(state: PipelineState): 'ws' | 'sse' {
  if (typeof WebSocket !== 'function') return 'sse';
  const choice = state.options.transport;
  if (choice === 'ws' || choice === 'sse') return choice;
  return Date.now() < state.wsFallbackUntil ? 'sse' : 'ws';
}

export function shouldSkipConnectedResync(firstConnect: boolean, disconnectedBeforeFirstConnect: boolean,
  replayReset: boolean, transport: 'sse' | 'ws', recentBoot: boolean,
  replayStatus?: EstablishedInfo['replayStatus']): boolean {
  if (replayReset) return false;
  // A complete event suffix proves continuity for emitted events, but cannot
  // prove the global catalog has no offline idle create/delete or correction.
  // Keep the authoritative reconnect reconciliation from the v16 baseline.
  void replayStatus;
  if (firstConnect && !disconnectedBeforeFirstConnect) return true;
  // An SSE server may have lost or evicted the cursor without signalling it.
  // A recent boot is not enough to trust a reconnect's replay suffix.
  return transport === 'ws' && recentBoot;
}

async function pipeOnEstablished(state: PipelineState, info: EstablishedInfo, transport: 'sse' | 'ws', signal: AbortSignal): Promise<void> {
  state.failures = 0;
  state.context.noteActivity();
  const skipResync = shouldSkipConnectedResync(state.firstConnect, state.disconnectedBeforeFirstConnect,
    info.replayReset, transport, state.options.isRecentBoot(), info.replayStatus);
  await state.options.onConnected({ replayReset: info.replayReset, skipResync, signal });
  if (state.stopped || signal.aborted) return;
  state.firstConnect = false;
  state.everConnected = true;
}

/** true = transport switched to SSE (not a disconnection; retry delay 0). */
async function pipeTryWsRound(state: PipelineState, abort: AbortController): Promise<boolean> {
  const http = getRealtimeBaseUrl();
  const ws = http.replace(/^http/, 'ws');
  const cursor = encodeURIComponent(state.lastEventId ?? '');
  const query = state.lastEventId ? `?lastEventId=${cursor}` : '';
  const url = await appendAuthTokenToUrl(`${ws}/api/global/event/ws${query}`); // mint BEFORE connect
  try {
    await attemptWs(state.context, url, abort.signal, DEFAULT_WS_READY_TIMEOUT_MS, (info) => pipeOnEstablished(state, info, 'ws', abort.signal));
    return false;
  } catch (error) {
    clearCachedUrlAuthToken(); // token may have been replayed against a rejecting server
    if (state.options.transport === 'auto') {
      state.wsFallbackUntil = Date.now() + WS_FALLBACK_WINDOW_MS;
      state.options.onTransportSwitch(`ws_fallback:${String(error)}`);
      return true;
    }
    throw error;
  }
}

async function pipeTrySseRound(state: PipelineState, abort: AbortController, transport: string): Promise<void> {
  const result = await attemptSse(state.context, pipeGlobalUrl(state), abort.signal, (info) => pipeOnEstablished(state, info, 'sse', abort.signal));
  if (result.status !== undefined && !abort.signal.aborted) {
    throw Object.assign(new Error(`${transport}_http_${result.status}`), {
      status: result.status,
      permanent: isPermanent4xx(result.status),
    });
  }
}

function pipeWaitForRetry(state: PipelineState, ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    const finish = (): void => {
      clearTimeout(timer);
      state.pendingRetryResolve = null;
      resolvePromise();
    };
    const timer = setTimeout(finish, ms);
    state.pendingRetryResolve = finish;
  });
}

async function pipeLoop(state: PipelineState): Promise<void> {
  while (!state.stopped) {
    const abort = new AbortController();
    state.currentAbort = abort;
    const transport = pipeResolveTransport(state);
    let reason = `${transport}_ended`;
    let permanent = false;
    let backoff = true;
    try {
      if (transport === 'ws') {
        if (await pipeTryWsRound(state, abort)) continue; // transport switch
      } else {
        await pipeTrySseRound(state, abort, transport);
      }
      if (abort.signal.aborted && !pipeHeartbeatedOut(abort)) {
        backoff = false; // supervisor interrupt (online/offline/resume): NOT a connection failure
        reason = `${transport}_interrupted`;
      } else {
        reason = pipeHeartbeatedOut(abort) ? `${transport}_heartbeat_timeout` : `${transport}_closed`;
      }
    } catch (error) {
      if (state.stopped) return;
      if (abort.signal.aborted) {
        if (pipeHeartbeatedOut(abort)) {
          reason = `${transport}_heartbeat_timeout`; // the supervisor is the only quiet aborter
        } else if (state.intentionalAbort) {
          state.intentionalAbort = false; // reconnect()/cleanup accepted: next round immediately
          continue;
        } else {
          backoff = false;
          reason = `${transport}_interrupted`;
        }
      } else {
        reason = String(error);
        permanent = (error as { permanent?: boolean }).permanent === true;
      }
    }
    if (!backoff) continue;
    state.failures += 1;
    if (!state.everConnected) state.disconnectedBeforeFirstConnect = true;
    state.options.onDisconnected(reason);
    const delay = computeRetryDelay(state.failures, pipePageVisible(), pipeNavigatorOnline(), permanent);
    await pipeWaitForRetry(state, delay);
  }
}

/** True only when THIS abort was issued by the heartbeat supervisor. */
function pipeHeartbeatedOut(abort: AbortController): boolean {
  return abort.signal.reason instanceof Error && abort.signal.reason.message === 'heartbeat_timeout';
}

function pipeHeartbeat(state: PipelineState): ReturnType<typeof setInterval> {
  // heartbeat supervision: ANY frame resets the window (§D.1)
  return setInterval(() => {
    if (state.stopped || !state.currentAbort) return;
    if (state.lastActivityAt !== 0 && Date.now() - state.lastActivityAt > DEFAULT_HEARTBEAT_TIMEOUT_MS) {
      state.currentAbort.abort(new Error('heartbeat_timeout'));
    }
  }, 5_000);
}

function pipeInstallListeners(state: PipelineState): Array<[string, EventTarget, (event: Event) => void]> {
  const listeners: Array<[string, EventTarget, (event: Event) => void]> = [];
  if (typeof window === 'undefined') return listeners;
  for (const kind of ['online', 'offline', 'pageshow'] as const) {
    const handler = (): void => pipeInterrupt(state);
    window.addEventListener(kind, handler);
    listeners.push([kind, window, handler]);
  }
  const systemResume = (): void => pipeInterrupt(state); // §C.5: immediate reconnect round
  window.addEventListener(SYSTEM_RESUME_EVENT, systemResume);
  listeners.push([SYSTEM_RESUME_EVENT, window, systemResume]);
  const visibility = (): void => {
    if (pipePageVisible()) state.pendingRetryResolve?.(); // early resume on visible (§D.1)
  };
  document.addEventListener('visibilitychange', visibility);
  listeners.push(['visibilitychange', document, visibility]);
  return listeners;
}

function pipeInterrupt(state: PipelineState): void {
  state.pendingRetryResolve?.();
  state.currentAbort?.abort();
}

function pipeCreateApi(
  state: PipelineState,
  heartbeatTimer: ReturnType<typeof setInterval>,
  listeners: Array<[string, EventTarget, (event: Event) => void]>,
): EventPipeline {
  return {
    cleanup: (): void => {
      state.stopped = true;
      state.intentionalAbort = true;
      state.queues.clear();
      clearInterval(heartbeatTimer);
      for (const [kind, target, handler] of listeners) target.removeEventListener(kind, handler as EventListener);
      state.pendingRetryResolve?.();
      state.currentAbort?.abort();
    },
    reconnect: (reason) => {
      void reason;
      state.failures = 0;
      state.intentionalAbort = true;
      state.pendingRetryResolve?.();
      state.currentAbort?.abort();
    },
    noteStreamActivity: (at) => { state.lastActivityAt = at ?? Date.now(); },
    lastStreamActivityAt: (): number => state.lastActivityAt,
    cursor: (): string | null => state.lastEventId,
  };
}
