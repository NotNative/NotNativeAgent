// SPDX-License-Identifier: Apache-2.0
/**
 * Transport attempts (doc 04 §D.1): SSE stream with Last-Event-ID cursor and
 * yield cadence; WS with ready-frame handshake, backpressure widening, and
 * token clearing on pre-ready close. Both resolve when their stream ENDS and
 * report establishment through onEstablished({replayReset}).
 */
import { runtimeFetch } from '../lib/runtime-fetch.ts';
import { unwrapEventFrame, type HarnessEvent } from '../lib/nnd/events.ts';
import { foldEventType, isHeartbeatType, type PipelineQueues } from './pipeline-queues.ts';
import { BACKPRESSURE_MODE_MS, STREAM_YIELD_MS } from './types.ts';

export interface AttemptContext {
  lastEventId(): string | null;
  setLastEventId(id: string | null): void;
  noteActivity(): void;
  queues: PipelineQueues;
}

export interface EstablishedInfo {
  replayReset: boolean;
}

export interface AttemptResult {
  status?: number;
}

export function createDeliver(ctx: AttemptContext): (raw: unknown, directoryHint?: unknown) => void {
  return (raw, directoryHint) => {
    const unwrapped = unwrapEventFrame(raw);
    if (!unwrapped) return;
    ctx.noteActivity();
    const event: HarnessEvent = { ...unwrapped, type: foldEventType(unwrapped.type) };
    if (directoryHint && event.directory === undefined) event.directory = String(directoryHint);
    if (event.id) ctx.setLastEventId(event.id);
    if (isHeartbeatType(event.type)) return;
    ctx.queues.push(event);
  };
}

/** SSE attempt: resolves when the stream ends; `status` set on HTTP failures. */
export async function attemptSse(
  ctx: AttemptContext,
  url: string,
  signal: AbortSignal,
  onEstablished: (info: EstablishedInfo) => void,
): Promise<AttemptResult> {
  const headers = new Headers({ accept: 'text/event-stream', 'cache-control': 'no-cache' });
  const cursor = ctx.lastEventId();
  if (cursor) headers.set('last-event-id', cursor);
  const response = await runtimeFetch(url, { headers, signal });
  if (!response.ok) return { status: response.status };
  if (!response.body) return { status: undefined };
  onEstablished({ replayReset: false });
  await readSseStream(ctx, response, signal);
  return { status: undefined };
}

async function readSseStream(ctx: AttemptContext, response: Response, signal: AbortSignal): Promise<void> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let bufferText = '';
  let yieldedAt = Date.now();
  const deliver = createDeliver(ctx);
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) return;
    ctx.noteActivity();
    bufferText += decoder.decode(chunk.value, { stream: true });
    let boundary = bufferText.indexOf('\n\n');
    while (boundary >= 0) {
      const frame = bufferText.slice(0, boundary);
      bufferText = bufferText.slice(boundary + 2);
      processSseFrame(ctx, deliver, frame);
      if (Date.now() - yieldedAt >= STREAM_YIELD_MS) {
        await Promise.resolve().then(); // keeps the event loop responsive under burst
        yieldedAt = Date.now();
      }
      boundary = bufferText.indexOf('\n\n');
    }
    if (signal.aborted) {
      await reader.cancel().catch(() => undefined);
      return;
    }
  }
}

type SseDeliver = (raw: unknown, directoryHint?: unknown) => void;

export function processSseFrame(ctx: AttemptContext, deliver: SseDeliver, frame: string): void {
  let dataLine: string | null = null;
  let idLine: string | null = null;
  for (const line of frame.split('\n')) {
    if (line.startsWith(':')) continue; // comment heartbeat: activity stamp only
    if (line.startsWith('data:')) dataLine = (dataLine ?? '') + line.slice(5).trimStart();
    else if (line.startsWith('id:')) idLine = line.slice(3).trim();
  }
  if (idLine) ctx.setLastEventId(idLine);
  if (!dataLine) return;
  try {
    deliver(JSON.parse(dataLine));
  } catch {
    /* malformed frame: activity stamp only */
  }
}

// ── WS attempt ───────────────────────────────────────────────────────────────

interface WsState {
  readySeen: boolean;
  settled: boolean;
  openedAt: number;
}

export function attemptWs(
  ctx: AttemptContext,
  url: string,
  signal: AbortSignal,
  readyTimeoutMs: number,
  onEstablished: (info: EstablishedInfo) => void,
): Promise<AttemptResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const socket = new WebSocket(url);
    const state: WsState = { readySeen: false, settled: false, openedAt: 0 };
    const readyTimer = setTimeout(() => failEarly(socket, state, rejectPromise, new Error('ws_ready_timeout'), readyTimer), readyTimeoutMs);
    const abort = (): void => { try { socket.close(); } catch { /* already closed */ } };
    signal.addEventListener('abort', abort);
    socket.addEventListener('open', () => { state.openedAt = Date.now(); });
    socket.addEventListener('message', (message: { data: unknown }) => handleWsMessage(ctx, state, message, readyTimer, onEstablished, socket));
    socket.addEventListener('close', () => {
      signal.removeEventListener('abort', abort);
      clearTimeout(readyTimer);
      settleClose(state, resolvePromise, rejectPromise);
    });
    socket.addEventListener('error', () => {
      if (state.readySeen || state.settled) return;
      state.settled = true;
      clearTimeout(readyTimer);
      rejectPromise(new Error('ws_error'));
    });
  });
}

function failEarly(socket: WebSocket, state: WsState, rejectPromise: (reason: Error) => void, error: Error, timer: ReturnType<typeof setTimeout>): void {
  if (state.settled) return;
  state.settled = true;
  try { socket.close(); } catch { /* already closed */ }
  clearTimeout(timer);
  rejectPromise(error);
}

function handleWsMessage(
  ctx: AttemptContext,
  state: WsState,
  message: { data: unknown },
  readyTimer: ReturnType<typeof setTimeout>,
  onEstablished: (info: EstablishedInfo) => void,
  socket: WebSocket,
): void {
  let frame: Record<string, unknown>;
  try { frame = JSON.parse(String(message.data)) as Record<string, unknown>; }
  catch { return; }
  ctx.noteActivity();
  const kind = String(frame['type'] ?? '');
  if (kind === 'ready') {
    if (frame['replayReset'] === true) ctx.setLastEventId(null);
    if (state.settled) return;
    state.settled = true;
    state.readySeen = true;
    clearTimeout(readyTimer);
    onEstablished({ replayReset: frame['replayReset'] === true });
    return;
  }
  if (kind === 'heartbeat' || !state.readySeen) return; // server sends `ready` first
  if (kind === 'backpressure') {
    ctx.queues.backpressureUntil = Date.now() + BACKPRESSURE_MODE_MS;
    return;
  }
  if (kind === 'error') {
    try { socket.close(); } catch { /* already closed */ }
    return;
  }
  if (kind === 'event') deliverWsEvent(ctx, frame);
}

function deliverWsEvent(ctx: AttemptContext, frame: Record<string, unknown>): void {
  createDeliver(ctx)({
    directory: frame['directory'],
    payload: { ...((frame['payload'] ?? {}) as Record<string, unknown>), id: frame['eventId'] },
  }, frame['directory']);
}

function settleClose(
  state: WsState,
  resolvePromise: (value: { status?: number }) => void,
  rejectPromise: (reason: Error) => void,
): void {
  if (!state.readySeen) {
    rejectPromise(new Error('ws_closed_before_ready'));
    return;
  }
  if (state.openedAt && Date.now() - state.openedAt < 2_000) {
    rejectPromise(new Error('ws_closed_quickly')); // prefer SSE for the fallback window
    return;
  }
  resolvePromise({ status: undefined });
}
