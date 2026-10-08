// SPDX-License-Identifier: Apache-2.0
/**
 * Transport attempts (doc 04 §D.1): SSE stream with Last-Event-ID cursor and
 * yield cadence; WS with ready-frame handshake, backpressure widening, and
 * token clearing on pre-ready close. Both resolve when their stream ENDS and
 * report establishment only after the transport's replay opener is verified.
 */
import { runtimeFetch } from '../lib/runtime-fetch.ts';
import { unwrapEventFrame, type HarnessEvent } from '../lib/nnd/events.ts';
import { foldEventType, isHeartbeatType, type PipelineQueues } from './pipeline-queues.ts';
import { BACKPRESSURE_MODE_MS, DEFAULT_SSE_OPENER_TIMEOUT_MS, STREAM_YIELD_MS } from './types.ts';

// Native transcript previews can exceed 64 KiB. Keep a bounded parser while
// accepting a single event as large as the native replay ring's byte budget.
const MAX_SSE_FRAME_CHARS = 16 * 1024 * 1024;

export interface AttemptContext {
  lastEventId(): string | null;
  setLastEventId(id: string | null): void;
  noteActivity(): void;
  queues: PipelineQueues;
}

export interface EstablishedInfo {
  replayReset: boolean;
  replayStatus?: 'fresh' | 'complete' | 'gap';
  /** True only when the opener itself explicitly reports a replay gap. */
  explicitGap?: boolean;
}

export interface AttemptResult {
  status?: number;
}

export function createDeliver(ctx: AttemptContext): (raw: unknown, directoryHint?: unknown) => void {
  return (raw, directoryHint) => {
    const unwrapped = unwrapEventFrame(raw);
    if (!unwrapped || !validEvent(unwrapped)) return;
    ctx.noteActivity();
    const event: HarnessEvent = { ...unwrapped, type: foldEventType(unwrapped.type) };
    if (directoryHint && event.directory === undefined) event.directory = String(directoryHint);
    // A server.connected receipt is per-connection, not retained in the
    // replay ring. Its payload ID must not replace the last resumable cursor.
    if (isHeartbeatType(event.type)) return;
    ctx.queues.push(event);
    if (event.id && event.type !== 'server.connected') ctx.setLastEventId(event.id);
  };
}

function validEvent(event: HarnessEvent): boolean {
  return typeof event.type === 'string' && event.type.length > 0
    && (event.id === undefined || event.id.length > 0)
    && (event.properties === undefined || typeof event.properties === 'object'
      && event.properties !== null && !Array.isArray(event.properties));
}

/** SSE attempt: resolves when the stream ends; `status` set on HTTP failures. */
export async function attemptSse(
  ctx: AttemptContext,
  url: string,
  signal: AbortSignal,
  onEstablished: (info: EstablishedInfo) => void | Promise<void>,
): Promise<AttemptResult> {
  const headers = new Headers({ accept: 'text/event-stream', 'cache-control': 'no-cache' });
  const cursor = ctx.lastEventId();
  if (cursor) headers.set('last-event-id', cursor);
  const response = await runtimeFetch(url, { headers, signal });
  if (!response.ok) return { status: response.status };
  if (!response.body) return { status: undefined };
  await readSseStream(ctx, response, signal, cursor !== null, onEstablished);
  return { status: undefined };
}

async function readSseStream(ctx: AttemptContext, response: Response, signal: AbortSignal,
  hadCursor: boolean, onEstablished: (info: EstablishedInfo) => void | Promise<void>): Promise<void> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let bufferText = '', yieldedAt = Date.now(), established = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const openerDeadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error('sse_opener_timeout')), DEFAULT_SSE_OPENER_TIMEOUT_MS);
  });
  const deliver = createDeliver(ctx);
  try {
    for (;;) {
      const chunk = established ? await reader.read() : await Promise.race([reader.read(), openerDeadline]);
      if (chunk.done) {
        if (!established) throw new Error('sse_missing_opener');
        return;
      }
      ctx.noteActivity();
      bufferText += decoder.decode(chunk.value, { stream: true });
      let boundary = /\r?\n\r?\n/u.exec(bufferText);
      while (boundary) {
        if (boundary.index > MAX_SSE_FRAME_CHARS) throw new Error('sse_frame_too_large');
        const frame = bufferText.slice(0, boundary.index);
        bufferText = bufferText.slice(boundary.index + boundary[0].length);
        const parsed = parseSseFrame(frame);
        if (!established) {
          if (parsed.kind === 'invalid') { ctx.setLastEventId(null); throw new Error('sse_invalid_opener'); }
          if (parsed.kind === 'event') {
            if (parsed.event.type !== 'server.connected') {
              ctx.setLastEventId(null); throw new Error('sse_missing_opener');
            }
            const replayStatus = openerStatus(parsed.event, hadCursor);
            if (replayStatus === 'gap') { ctx.queues.clear(); ctx.setLastEventId(null); }
            clearTimeout(timeout); // deadline bounds finding an opener, not its recovery
            await onEstablished({ replayReset: replayStatus === 'gap', replayStatus,
              explicitGap: parsed.event.properties?.['replayStatus'] === 'gap' });
            if (signal.aborted) return;
            established = true;
            deliver(parsed.raw);
          }
        } else if (parsed.kind === 'event') deliver(parsed.raw);
        else if (parsed.kind === 'invalid') {
          resetSseCursor(ctx);
          throw new Error('sse_invalid_frame');
        }
        if (Date.now() - yieldedAt >= STREAM_YIELD_MS) {
          await Promise.resolve().then();
          yieldedAt = Date.now();
        }
        boundary = /\r?\n\r?\n/u.exec(bufferText);
      }
      if (bufferText.length > MAX_SSE_FRAME_CHARS) throw new Error('sse_frame_too_large');
      if (signal.aborted) return;
    }
  } finally {
    clearTimeout(timeout);
    if (!established && !signal.aborted) resetSseCursor(ctx);
    await reader.cancel().catch(() => undefined);
  }
}

function resetSseCursor(ctx: AttemptContext): void {
  ctx.queues.clear();
  ctx.setLastEventId(null);
}

type SseDeliver = (raw: unknown, directoryHint?: unknown) => void;

type ParsedSse = { kind: 'empty' } | { kind: 'invalid' }
  | { kind: 'event'; raw: unknown; event: HarnessEvent };

function parseSseFrame(frame: string): ParsedSse {
  const dataLines: string[] = [];
  let idLine: string | null = null;
  for (const line of frame.split(/\r?\n/u)) {
    if (line.startsWith(':')) continue; // comment heartbeat: activity stamp only
    if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    else if (line.startsWith('id:')) {
      if (idLine !== null) return { kind: 'invalid' };
      idLine = line.slice(3).trim();
      if (!idLine) return { kind: 'invalid' };
    }
  }
  if (!dataLines.length) return { kind: 'empty' };
  try {
    const raw: unknown = JSON.parse(dataLines.join('\n'));
    if (!validRawEvent(raw)) return { kind: 'invalid' };
    const event = unwrapEventFrame(raw);
    if (!event || !validEvent(event) || idLine !== null && event.id !== idLine) return { kind: 'invalid' };
    return { kind: 'event', raw, event: { ...event, type: foldEventType(event.type) } };
  } catch {
    return { kind: 'invalid' };
  }
}

function validRawEvent(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const envelope = raw as Record<string, unknown>;
  const value = envelope['payload'] === undefined ? envelope : envelope['payload'];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const payload = value as Record<string, unknown>;
  if (typeof payload['type'] !== 'string' || !payload['type']) return false;
  if (payload['id'] !== undefined && (typeof payload['id'] !== 'string' || !payload['id'])) return false;
  if (payload['properties'] !== undefined && (!payload['properties']
    || typeof payload['properties'] !== 'object' || Array.isArray(payload['properties']))) return false;
  return envelope['directory'] === undefined || typeof envelope['directory'] === 'string';
}

function openerStatus(event: HarnessEvent, hadCursor: boolean): 'fresh' | 'complete' | 'gap' {
  const status = event.properties?.['replayStatus'];
  if (status === 'gap') return 'gap';
  if (status === 'fresh' && !hadCursor) return 'fresh';
  if (status === 'complete' && hadCursor) return 'complete';
  return 'gap';
}

export function processSseFrame(_ctx: AttemptContext, deliver: SseDeliver, frame: string): void {
  const parsed = parseSseFrame(frame);
  if (parsed.kind === 'event') deliver(parsed.raw);
}

// ── WS attempt ───────────────────────────────────────────────────────────────

interface WsState {
  readySeen: boolean;
  establishing: boolean;
  closed: boolean;
  pending: Record<string, unknown>[];
  settled: boolean;
  openedAt: number;
}

export function attemptWs(
  ctx: AttemptContext,
  url: string,
  signal: AbortSignal,
  readyTimeoutMs: number,
  onEstablished: (info: EstablishedInfo) => void | Promise<void>,
): Promise<AttemptResult> {
  if (signal.aborted) return Promise.reject(new Error('ws_aborted_before_connect'));
  return new Promise((resolvePromise, rejectPromise) => {
    const socket = new WebSocket(url);
    const state: WsState = { readySeen: false, establishing: false, closed: false, pending: [], settled: false, openedAt: 0 };
    const readyTimer = setTimeout(() => failEarly(socket, state, rejectPromise, new Error('ws_ready_timeout'), readyTimer), readyTimeoutMs);
    const abort = (): void => { try { socket.close(); } catch { /* already closed */ } };
    signal.addEventListener('abort', abort);
    socket.addEventListener('open', () => { state.openedAt = Date.now(); });
    socket.addEventListener('message', (message: { data: unknown }) => handleWsMessage(ctx, state, message, readyTimer, onEstablished, socket, rejectPromise));
    socket.addEventListener('close', () => {
      state.closed = true;
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
  onEstablished: (info: EstablishedInfo) => void | Promise<void>,
  socket: WebSocket,
  rejectPromise: (reason: Error) => void,
): void {
  let frame: Record<string, unknown>;
  try { frame = JSON.parse(String(message.data)) as Record<string, unknown>; }
  catch { return; }
  ctx.noteActivity();
  const kind = String(frame['type'] ?? '');
  if (kind === 'ready') {
    const explicitGap = frame['replayStatus'] === 'gap';
    const replayReset = frame['replayReset'] === true || explicitGap;
    if (replayReset) ctx.setLastEventId(null);
    if (state.settled) return;
    state.settled = true;
    state.establishing = true;
    clearTimeout(readyTimer);
    Promise.resolve().then(() => onEstablished({ replayReset, explicitGap })).then(() => {
      if (state.closed) return;
      state.readySeen = true;
      state.establishing = false;
      for (const pending of state.pending) processReadyWsFrame(ctx, pending, socket);
      state.pending = [];
    }, (error: unknown) => {
      state.pending = [];
      try { socket.close(); } catch { /* already closed */ }
      rejectPromise(error instanceof Error ? error : new Error(String(error)));
    });
    return;
  }
  if (kind === 'heartbeat') return;
  if (state.establishing) {
    // Recovery must finish before live events can overtake its snapshot.
    if (state.pending.length >= 2048) { try { socket.close(); } catch { /* already closed */ } }
    else state.pending.push(frame);
    return;
  }
  if (!state.readySeen) return; // server sends `ready` first
  processReadyWsFrame(ctx, frame, socket);
}

function processReadyWsFrame(ctx: AttemptContext, frame: Record<string, unknown>, socket: WebSocket): void {
  const kind = String(frame['type'] ?? '');
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
