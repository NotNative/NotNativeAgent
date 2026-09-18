// SPDX-License-Identifier: Apache-2.0
/**
 * Relay host dispatcher (doc 08 section 3.9, `createTunnelHost`): one
 * instance per relay leg. It consumes decrypted tunnel frames and
 * forwards to the local server over loopback, streaming responses back
 * through the §3.8 downstream scheduler. It NEVER injects credentials -
 * tunneled requests authenticate exactly like any remote client (bearer /
 * ?oc_url_token=); the relay grants reachability, not authorization.
 * HTTP + WS path allowlists (defense in depth) keep the tunnel from
 * becoming a generic loopback port bouncer; WS sub-streams live in
 * `dispatcher-ws.ts` (bridged here).
 */
import { Buffer } from 'node:buffer';
import { MAX_TUNNEL_PAYLOAD_BYTES } from './crypto.ts';
import {
  TunnelFrameType, chunkPayload, encodeJsonPayload, encodeTunnelFrame, isFragmentableType,
  isHttpRequestPayload, isWsClosePayload, parseJsonPayload,
  type HttpRequestPayload, type TunnelFrame,
} from './tunnel-codec.ts';
import { createDownstreamScheduler, SchedulerError, STREAM_ZERO } from './downstream.ts';
import {
  createWsBridge, clampWsCloseCode, loopbackQueryOf,
  type RelayHostSocketLikeFactory, type WsStreamLink,
} from './dispatcher-ws.ts';
import {
  requestInitOf, normalizeRequestHeaders, normalizeResponseHeaders, defaultLoopbackFetch,
  unavailableSocketFactory, type LoopbackRequestInit, type LoopbackResponseLike,
} from './loopback-adapters.ts';

export type { LoopbackRequestInit, LoopbackResponseLike } from './loopback-adapters.ts';

export const RESPONSE_BODY_CHUNK_BYTES = MAX_TUNNEL_PAYLOAD_BYTES; // legacy budget when flow control is off
export const BODY_BUFFER_MAX_BYTES = 512 * 1024;
export const BODY_DELIVERY_TIMEOUT_MS = 15_000;
export const DOWNSTREAM_CHUNK_BYTES = 8 * 1024;

const HTTP_HOST_ALLOWLIST_PREFIXES = ['/api', '/auth', '/health'];
const HTTP_HOST_ALLOWLIST_EXACT = new Set(['/health', '/api', '/auth']);

export function isAllowedRelayHttpPath(path: string): boolean {
  const clean = (path.split('?')[0] ?? '').replace(/\/{2,}/gu, '/');
  if (HTTP_HOST_ALLOWLIST_EXACT.has(clean)) return true;
  return HTTP_HOST_ALLOWLIST_PREFIXES.some((prefix) => clean.startsWith(`${prefix}/`) || clean === prefix);
}

interface LiveBodyController {
  enqueue(chunk: Uint8Array): void;
  close(): void;
  error(reason?: unknown): void;
}

/** Client request body in the buffering phase. Bodies ≤ 512 KiB land as
 * ONE concatenated loopback body (content-length framing) when the
 * client's StreamEnd arrives; crossing the cap switches to a live web
 * ReadableStream fed by the body itself (the buffered prefix enqueues
 * first). While buffering, frames must keep arriving before the delivery
 * deadline; past the switch the deadline does not apply. */
class TunnelRequestBody {
  chunks: Buffer[] = [];
  bytes = 0;
  crossed = false;
  framesReceived = 0;
  deadlineTimer: NodeJS.Timeout | null = null;
  private controller: LiveBodyController | null = null;
  private arrived: Buffer[] = []; // live chunks seen before `start` ran
  private closed = false;

  /** Single concatenated body (content-length framing, never chunked). */
  bufferedBody(): Buffer {
    return Buffer.concat(this.chunks);
  }

  /** Live web stream: the buffered prefix flushes first, then chunks
   * arrive through `push`; `close` ends it; `fail` surfaces an abort so
   * the loopback transfer dies with the tunnel stream. */
  requestStream(prefix: Buffer): ReadableStream<Uint8Array> {
    const body = this;
    return new ReadableStream<Uint8Array>({
      start(controller) {
        body.controller = controller as unknown as LiveBodyController;
        if (prefix.length === 0) controller.enqueue(new Uint8Array(0));
        else for (const piece of chunkPayload(prefix, RESPONSE_BODY_CHUNK_BYTES)) controller.enqueue(piece);
        for (const chunk of body.arrived.splice(0)) controller.enqueue(chunk);
        if (body.closed) body.controller = null;
      },
      pull() { /* chunks enqueue eagerly; undici paces the transfer */ },
    });
  }

  push(chunk: Buffer): void {
    if (this.closed) return; // StreamEnd already passed; late frames never reach the loopback
    const controller = this.controller;
    if (controller === null) {
      this.arrived.push(chunk);
      return;
    }
    try {
      controller.enqueue(chunk);
    } catch {
      this.closed = true; // the transfer died server-side; keep client frames dropping
    }
  }

  close(): void {
    this.closed = true;
    const controller = this.controller;
    this.controller = null;
    if (controller === null) return;
    try {
      controller.close();
    } catch {
      // already closed by the consumer
    }
  }

  fail(reason: string): void {
    const controller = this.controller;
    this.controller = null;
    this.arrived = [];
    if (controller === null) return;
    this.closed = true;
    try {
      controller.error(new Error(reason));
    } catch {
      // already errored/closed
    }
  }

  clearDeadline(): void {
    if (this.deadlineTimer === null) return;
    clearTimeout(this.deadlineTimer);
    this.deadlineTimer = null;
  }
}

interface StreamState {
  id: number;
  kind: 'http' | 'ws';
  controller: AbortController;
  body: TunnelRequestBody | null;
  requestHead: HttpRequestPayload | null;
  ws: WsStreamLink | null;
  aborted: boolean;
}

export interface TunnelHost {
  handleFrame(frame: TunnelFrame): Promise<void>;
  dispose(): void;
  stats(): { streams: number; open: number };
}

export interface CreateTunnelHostInput {
  localPort: number;
  connectionId: string;
  /** L3 carrier: the leg's sendToClient (one encrypted message per call). */
  send: (plaintext: Uint8Array) => Promise<void> | void;
  flowControl?: boolean;
  fetchImpl?: (url: string, init: LoopbackRequestInit) => Promise<LoopbackResponseLike>;
  wsFactory?: RelayHostSocketLikeFactory;
  bodyDeliveryTimeoutMs?: number;
  responseChunkBytes?: number;
}

export function createTunnelHost(input: CreateTunnelHostInput): TunnelHost {
  return new TunnelHostImpl(input);
}

class TunnelHostImpl implements TunnelHost {
  private readonly localPort: number;
  private readonly connectionId: string;
  private readonly send: (plaintext: Uint8Array) => Promise<void> | void;
  private readonly flowControl: boolean;
  private readonly bodyTimeout: number;
  private readonly responseChunkBytes: number;
  private readonly fetchImpl: (url: string, init: LoopbackRequestInit) => Promise<LoopbackResponseLike>;
  private readonly scheduler: ReturnType<typeof createDownstreamScheduler>;
  private readonly wsBridge: ReturnType<typeof createWsBridge>;
  private readonly streams = new Map<number, StreamState>();
  private disposed = false;

  constructor(input: CreateTunnelHostInput) {
    this.localPort = input.localPort;
    this.connectionId = input.connectionId;
    this.send = input.send;
    this.flowControl = input.flowControl !== false;
    this.bodyTimeout = input.bodyDeliveryTimeoutMs ?? BODY_DELIVERY_TIMEOUT_MS;
    this.responseChunkBytes = input.responseChunkBytes ?? (this.flowControl ? DOWNSTREAM_CHUNK_BYTES : RESPONSE_BODY_CHUNK_BYTES);
    this.fetchImpl = input.fetchImpl ?? defaultLoopbackFetch();
    this.scheduler = createDownstreamScheduler({
      emit: (frameBytes) => void this.send(frameBytes),
      streamZeroEmit: (frameBytes) => void this.send(frameBytes),
      onError: () => undefined, // the leg owns channel closure (1011)
    });
    this.wsBridge = createWsBridge({
      localPort: this.localPort,
      connectionId: this.connectionId,
      wsFactory: input.wsFactory ?? unavailableSocketFactory(),
      sendFrame: (frame) => this.sendFrame(frame),
      releaseStream: (streamId) => this.releaseStream(streamId),
      killStream: (streamId, reason) => void this.failStream(streamId, reason),
    });
  }

  async handleFrame(frame: TunnelFrame): Promise<void> {
    if (this.disposed) return;
    try {
      if (frame.streamId === STREAM_ZERO) {
        await this.handleControlFrame(frame);
        return;
      }
      if (frame.hasMore && !isFragmentableType(frame.type)) {
        // §3.6: any other frame type arriving fragmented is a hard channel error
        this.failLegSafe(`non-fragmentable frame type ${frame.type} arrived fragmented; channel closes`);
        return;
      }
      await this.handleStreamFrame(frame);
    } catch (error) {
      this.failLegSafe(`tunnel frame handling failed: ${messageOf(error)}`);
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const state of [...this.streams.values()]) this.abortStream(state, 'tunnel disposed');
    this.streams.clear();
    this.scheduler.dispose();
  }

  stats(): { streams: number; open: number } {
    return { streams: this.streams.size, open: [...this.streams.values()].filter((state) => !state.aborted).length };
  }

  private async handleControlFrame(frame: TunnelFrame): Promise<void> {
    if (frame.type === TunnelFrameType.Ping) {
      await this.sendFrame({ type: TunnelFrameType.Pong, streamId: STREAM_ZERO, hasMore: false, payload: Buffer.alloc(0) });
      return;
    }
    if (frame.type === TunnelFrameType.DeliveryAck) {
      if (this.flowControl) this.scheduler.onAck(frame.payload); // §3.8 payload: 8B BE cumulative raw frame bytes
      return;
    }
    // Pong and unexpected HttpResponse / WsOpened inbound are ignored (§3.9)
  }

  private async handleStreamFrame(frame: TunnelFrame): Promise<void> {
    const state = this.streams.get(frame.streamId);
    switch (frame.type) {
      case TunnelFrameType.HttpRequest: return await this.handleHttpRequest(frame, state);
      case TunnelFrameType.HttpBody: return await this.handleHttpBody(frame, state);
      case TunnelFrameType.StreamEnd: return await this.handleStreamEnd(frame, state);
      case TunnelFrameType.StreamAbort: return this.handleStreamAbort(frame, state);
      case TunnelFrameType.WsOpen: return await this.handleWsOpen(frame, state);
      case TunnelFrameType.WsText:
      case TunnelFrameType.WsBinary: return this.handleWsMessage(frame, state);
      case TunnelFrameType.WsClose: return this.handleWsClientClose(frame, state);
      default: return; // HttpResponse / WsOpened inbound are never host-sent; ignored
    }
  }

  private async handleHttpRequest(frame: TunnelFrame, state: StreamState | undefined): Promise<void> {
    if (state !== undefined) {
      this.abortStream(state, 'duplicate stream id');
      await this.upstreamAbort(state, 'duplicate stream id');
      return;
    }
    const head = parseJsonPayload(frame.payload, isHttpRequestPayload);
    if (head === null) {
      await this.refuseStream(frame.streamId, 400, 'malformed tunnel request', 'bad-request-shape');
      return;
    }
    if (!isAllowedRelayHttpPath(head.path)) {
      await this.refuseStream(frame.streamId, 403, 'relay tunnel path is not allowed', 'path-not-allowed');
      return;
    }
    const fresh: StreamState = {
      id: frame.streamId, kind: 'http', controller: new AbortController(),
      body: null, requestHead: head, ws: null, aborted: false,
    };
    this.streams.set(frame.streamId, fresh);
    if (head.hasBody === true) {
      fresh.body = new TunnelRequestBody();
      this.armBodyDeadline(fresh.body, fresh.id); // frames must keep arriving (or StreamEnd) before the deadline
      return; // the fetch runs when the body finishes
    }
    void this.runRequest(fresh, head); // detached: the frame pump keeps serving (aborts, keepalives, other streams)
  }

  private async refuseStream(streamId: number, status: number, error: string, reason: string): Promise<void> {
    await this.sendFrame({
      type: TunnelFrameType.HttpResponse, streamId, hasMore: false,
      payload: encodeJsonPayload({ status, headers: { 'content-type': 'application/json' } }),
    });
    await this.sendFrame({
      type: TunnelFrameType.HttpBody, streamId, hasMore: false,
      payload: encodeJsonPayload({ error, reason, source: 'relay-tunnel-host' }),
    });
    await this.sendFrame({ type: TunnelFrameType.StreamEnd, streamId, hasMore: false, payload: Buffer.alloc(0) });
  }

  private async handleHttpBody(frame: TunnelFrame, state: StreamState | undefined): Promise<void> {
    if (state === undefined || state.kind !== 'http' || state.body === null || state.aborted) return;
    const body = state.body;
    body.framesReceived += 1;
    this.armBodyDeadline(body, state.id);
    if (body.crossed) {
      body.push(frame.payload); // live streaming carries the loopback request
      return;
    }
    body.chunks.push(frame.payload);
    body.bytes += frame.payload.length;
    if (body.bytes > BODY_BUFFER_MAX_BYTES) {
      const head = state.requestHead;
      if (head === null) return;
      void this.goLive(state, head, body); // detached transfer: late pushes + StreamEnd reach the pump meanwhile
    }
  }

  private async handleStreamEnd(frame: TunnelFrame, state: StreamState | undefined): Promise<void> {
    if (state === undefined) return;
    if (state.kind === 'http' && state.body !== null && !state.aborted) {
      await this.finishRequestBody(state);
      return;
    }
    if (state.ws !== null && state.ws.socket !== null) state.ws.socket.close(1000, 'stream end');
    this.releaseStream(state.id);
  }

  private handleStreamAbort(frame: TunnelFrame, state: StreamState | undefined): void {
    if (state === undefined) {
      this.releaseStream(frame.streamId); // queued downstream work dies with the client abort
      return;
    }
    this.abortStream(state, 'client abort');
  }

  private async handleWsOpen(frame: TunnelFrame, state: StreamState | undefined): Promise<void> {
    if (state !== undefined) {
      this.abortStream(state, 'duplicate stream id');
      await this.upstreamAbort(state, 'duplicate stream id');
      return;
    }
    const link = this.wsBridge.link();
    const fresh: StreamState = {
      id: frame.streamId, kind: 'ws', controller: new AbortController(),
      body: null, requestHead: null, ws: link, aborted: false,
    };
    this.streams.set(frame.streamId, fresh);
    this.wsBridge.open(frame.streamId, link, frame.payload);
  }

  private handleWsMessage(frame: TunnelFrame, state: StreamState | undefined): void {
    if (state === undefined || state.ws === null) return;
    const assembled = state.ws.assembler.push(frame); // CodecError on fragment flood -> handleFrame catch (channel close)
    if (assembled === null) return;
    state.ws.socket?.send(assembled.payload, assembled.type === TunnelFrameType.WsBinary);
  }

  private handleWsClientClose(frame: TunnelFrame, state: StreamState | undefined): void {
    if (state === undefined) return;
    const close = parseJsonPayload(frame.payload, isWsClosePayload);
    const code = close !== null ? clampWsCloseCode(close.code) : 1000;
    const reason = close !== null && close.reason !== undefined ? close.reason : '';
    if (state.ws !== null && state.ws.socket !== null) state.ws.socket.close(code, reason);
    this.releaseStream(state.id);
  }

  private async runRequest(state: StreamState, head: HttpRequestPayload, requestBody?: unknown): Promise<void> {
    const url = `http://127.0.0.1:${this.localPort}${head.path}${loopbackQueryOf(head.query)}`;
    const headers = normalizeRequestHeaders(head.headers);
    headers['x-openchamber-relay-connection'] = this.connectionId;
    headers.origin = `http://127.0.0.1:${this.localPort}`; // overwrite: client origins are unreliable (§3.9)
    let response: LoopbackResponseLike;
    try {
      response = await this.fetchImpl(url, requestInitOf(head, headers, requestBody, state.controller.signal));
    } catch {
      this.failStream(state.id, 'loopback request failed after transfer');
      return;
    }
    await this.sendResponseFrames(state, response);
  }

  private async goLive(state: StreamState, head: HttpRequestPayload, body: TunnelRequestBody): Promise<void> {
    body.clearDeadline(); // the delivery deadline watches the buffering phase only
    body.crossed = true;
    const prefix = Buffer.concat(body.chunks);
    body.chunks = [];
    body.bytes = 0;
    await this.runRequest(state, head, body.requestStream(prefix));
  }

  private async finishRequestBody(state: StreamState): Promise<void> {
    const body = state.body;
    const head = state.requestHead;
    if (body === null || head === null) return;
    body.clearDeadline();
    if (body.crossed) {
      body.close(); // half-close the live web stream: the loopback request completes here
      return;
    }
    if (body.framesReceived === 0) {
      this.failStream(state.id, 'tunnel request body frames were lost');
      return;
    }
    this.releaseStream(state.id); // the response borrows the id; the body died with its StreamEnd
    void this.runRequest(state, head, body.bufferedBody()); // detached transfer
  }

  private armBodyDeadline(body: TunnelRequestBody, streamId: number): void {
    if (body.deadlineTimer !== null) return;
    body.deadlineTimer = setTimeout(() => {
      body.deadlineTimer = null;
      const owner = this.streams.get(streamId);
      if (owner === undefined) return;
      this.failStream(owner.id, 'tunnel request body delivery deadline');
    }, this.bodyTimeout);
    body.deadlineTimer.unref?.();
  }

  private async sendResponseFrames(state: StreamState, response: LoopbackResponseLike): Promise<void> {
    await this.sendFrame({
      type: TunnelFrameType.HttpResponse, streamId: state.id, hasMore: false,
      payload: encodeJsonPayload({ status: response.status, headers: normalizeResponseHeaders(response.headers) }),
    });
    if (response.body === null) {
      await this.sendFrame({ type: TunnelFrameType.StreamEnd, streamId: state.id, hasMore: false, payload: Buffer.alloc(0) });
      this.releaseStream(state.id);
      return;
    }
    try {
      for await (const chunk of response.body) {
        for (const piece of chunkPayload(Buffer.from(chunk), this.responseChunkBytes)) {
          await this.sendFrame({ type: TunnelFrameType.HttpBody, streamId: state.id, hasMore: false, payload: piece });
        }
      }
      await this.sendFrame({ type: TunnelFrameType.StreamEnd, streamId: state.id, hasMore: false, payload: Buffer.alloc(0) });
      this.releaseStream(state.id);
    } catch {
      this.abortStream(state, 'loopback response failed');
      await this.upstreamAbort(state, 'loopback response failed');
    }
  }

  private async sendFrame(frame: TunnelFrame): Promise<void> {
    if (this.disposed) return;
    if (!this.flowControl) {
      await this.send(encodeTunnelFrame(frame)); // no credit plane: one frame per encrypted message
      return;
    }
    try {
      await this.scheduler.send(frame);
    } catch (error) {
      if (error instanceof SchedulerError && error.message === 'stream cancelled') return; // §3.8 client abort released the queue
      this.failLegSafe(`dispatcher send failed: ${messageOf(error)}`);
    }
  }

  private failLegSafe(reason: string = 'dispatcher failure'): void {
    // channel-level failures belong to the leg; the dispatcher opens no more work
    void reason;
  }

  /** Stream-level failure: abort both sides, frame the client with the
   * named ambiguous-failure reason (§3.10 surfaces it as retryable). */
  private failStream(streamId: number, reason: string): void {
    const state = this.streams.get(streamId);
    if (state === undefined) return;
    this.abortStream(state, reason);
    void this.upstreamAbort(state, reason);
  }

  private abortStream(state: StreamState, reason: string): void {
    if (state.aborted) return;
    state.aborted = true;
    state.controller.abort();
    state.body?.clearDeadline();
    if (state.body !== null) state.body.fail(reason);
    if (state.ws !== null && state.ws.socket !== null) state.ws.socket.terminate();
    this.scheduler.cancelStream(state.id);
    this.streams.delete(state.id);
  }

  private async upstreamAbort(state: StreamState, reason: string): Promise<void> {
    await this.sendFrame({
      type: TunnelFrameType.StreamAbort, streamId: state.id, hasMore: false,
      payload: encodeJsonPayload({ reason }),
    });
  }

  private releaseStream(streamId: number): void {
    this.scheduler.cancelStream(streamId);
    this.streams.delete(streamId);
  }
}

// —— module helpers ----------------------------------------------------------

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
