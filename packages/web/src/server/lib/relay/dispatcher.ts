// SPDX-License-Identifier: Apache-2.0
/**
 * Relay host dispatcher (doc 08 section 3.9, `createTunnelHost`): one
 * instance per relay leg. It consumes decrypted tunnel frames and
 * forwards to the local server over loopback, streaming responses back
 * through the §3.8 downstream scheduler. It NEVER injects credentials —
 * tunneled requests authenticate exactly like any remote client; HTTP+WS
 * allowlists keep the tunnel from becoming a generic port bouncer; WS
 * sub-streams live in `dispatcher-ws.ts` (bridged here).
 */
import { Buffer } from 'node:buffer';
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
import { TunnelRequestBody, RESPONSE_BODY_CHUNK_BYTES } from './request-body.ts';

export type { LoopbackRequestInit, LoopbackResponseLike } from './loopback-adapters.ts';
export { RESPONSE_BODY_CHUNK_BYTES };
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
  /** Channel-level failures close the relay leg 1011 (§3.9 posture: the
   * dispatcher owns no leg socket; the failure is reported once, upstream). */
  onChannelFailure?: (reason: string) => void;
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
  private readonly onChannelFailure?: (reason: string) => void;
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
    this.onChannelFailure = input.onChannelFailure;
    this.fetchImpl = input.fetchImpl ?? defaultLoopbackFetch();
    this.scheduler = createDownstreamScheduler({
      emit: (frameBytes) => void this.send(frameBytes),
      streamZeroEmit: (frameBytes) => void this.send(frameBytes),
      onError: (error) => this.failLegSafe(`downstream scheduler failed: ${messageOf(error)}`),
    });
    this.wsBridge = createWsBridge({
      localPort: this.localPort,
      connectionId: this.connectionId,
      wsFactory: input.wsFactory ?? unavailableSocketFactory(),
      sendFrame: (frame) => this.sendFrame(frame),
      sendFrameNow: (frame) => this.sendFrameNow(frame),
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
        // §3.6 dispatcher-tier guard: refuse the frame, the channel stays
        // alive (the leg-host assembler kills the channel 1011 instead)
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
      try {
        await this.send(encodeTunnelFrame(frame)); // no credit plane: one frame per encrypted message
      } catch (error) {
        // leg-gone on the direct carrier path must never surface as an
        // unhandled rejection (void-forgotten pumps/requests await this)
        this.failLegSafe(`dispatcher send failed: ${messageOf(error)}`);
      }
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
    if (this.disposed) return;
    this.dispose();
    this.onChannelFailure?.(reason);
  }

  /** Terminal close rows (refusal 1008, upstream-close mirror) must reach
   * the client even though their stream releases (cancels) at the same
   * instant: they bypass the §3.8 queue but keep batcher order (the
   * batcher flushes buffered work before a single-frame ship) and stay
   * ACCOUNTED in the §3.8 ack ledger (scheduler.sendNow). */
  sendFrameNow(frame: TunnelFrame): Promise<void> {
    if (this.disposed) return Promise.resolve();
    try {
      if (this.flowControl) {
        this.scheduler.sendNow(frame);
        return Promise.resolve();
      }
      return Promise.resolve(this.send(encodeTunnelFrame(frame))).catch((error: unknown) => {
        // terminal rows ride the direct carrier; a leg-gone reject collapses
        // into the one-shot channel failure instead of an unhandled rejection
        this.failLegSafe(`dispatcher terminal send failed: ${messageOf(error)}`);
      });
    } catch (error) {
      this.failLegSafe(`dispatcher terminal send failed: ${messageOf(error)}`);
      return Promise.resolve();
    }
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
    // failure rows always follow a state release; ship them directly so
    // the release cancel cannot eat the abort notice (§3.10 ambiguity)
    await this.sendFrameNow({
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
