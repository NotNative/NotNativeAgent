// SPDX-License-Identifier: Apache-2.0
/**
 * Relay client fetch pipeline (doc 08 §3.10). Inputs normalize to the
 * HttpRequest wire payload with the path+query inline (the payload guard
 * makes the separate query record optional; the host dials
 * `path` plus `loopbackQueryOf(query ?? undefined)`, so an inline query
 * keeps every search param byte-faithful and the query record stays
 * empty). Bodies: string/ArrayBuffer/view = one chunk; ReadableStream =
 * streamed; Blob/FormData/URLSearchParams serialize through a probe
 * Request so the derived content-type (multipart boundary included) is
 * preserved. An empty stream body emits ONE empty HttpBody frame. Host
 * side failures after the request head reached the wire (StreamAbort,
 * StreamEnd before head, channel death, malformed head) reject/error
 * AMBIGUOUS; caller aborts reject with plain AbortError semantics and
 * `response.body.cancel()` sends StreamAbort upstream.
 */
import {
  chunkPayload, encodeJsonPayload, type HttpRequestPayload, type HttpResponsePayload,
} from './tunnel-codec.ts';
import { tunnelPathOf, TUNNEL_PARSE_BASE, encodeHttpRequestPayload } from './tunnel-payloads.ts';
import { MAX_TUNNEL_PAYLOAD_BYTES } from './crypto.ts';
import { ambiguousTransportError, markAmbiguousTransportFailure, tunnelResetError } from './transport-error.ts';
import { TunnelFrameType } from './protocol.ts';
import type { FetchLane, TunnelClientCore } from './tunnel-client-types.ts';

export interface RelayBodyClassification {
  hasBody: boolean;
  bytes?: Uint8Array;
  stream?: ReadableStream<Uint8Array>;
  contentType?: string;
}

export interface NormalizedRelayRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  clause: RelayBodyClassification;
}

/** Body shapes both DOM and node typings produce for request bodies. */
type RelayBodyInit = NonNullable<RequestInit['body']>;

/** Byte/string bodies are one logical chunk; ReadableStream bodies
 * stream; Blob/FormData/URLSearchParams go through a probe Request so the
 * derived content-type (and multipart boundary) is preserved (§3.10). */
export function classifyRequestBody(body: RelayBodyInit | undefined): RelayBodyClassification {
  if (body === undefined || body === null) return { hasBody: false };
  if (body instanceof ReadableStream) return { hasBody: true, stream: body as ReadableStream<Uint8Array> };
  if (typeof body === 'string' || body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    return { hasBody: true, bytes: bodyViewToBytes(body) };
  }
  return classifyThroughProbe(body);
}

function bodyViewToBytes(body: string | ArrayBuffer | ArrayBufferView): Uint8Array {
  if (typeof body === 'string') return new TextEncoder().encode(body);
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  const view = body as ArrayBufferView<ArrayBuffer>;
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

function classifyThroughProbe(body: unknown): RelayBodyClassification {
  // The non-bytes remainder across platforms: Blob/FormData/URLSearchParams
  // probe through a Request so the derived content-type (multipart
  // boundary included) is preserved; iterables (node's streaming bodies)
  // become a plain stream with no content type.
  if (typeof (body as { getReader?: unknown }).getReader === 'function') {
    return { hasBody: true, stream: body as ReadableStream<Uint8Array> };
  }
  if (isProbeShape(body)) {
    const probe = new Request(`${TUNNEL_PARSE_BASE}/probe`, { method: 'POST', body: body as never });
    return {
      hasBody: true,
      stream: probe.body as ReadableStream<Uint8Array> | null ?? emptyStream(),
      contentType: probe.headers.get('content-type') ?? undefined,
    };
  }
  return { hasBody: true, stream: iterableToStream(body) };
}

function isProbeShape(body: unknown): body is Blob | FormData | URLSearchParams {
  return typeof Blob !== 'undefined' && body instanceof Blob
    || (typeof FormData !== 'undefined' && body instanceof FormData)
    || (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams);
}

function iterableToStream(source: unknown): ReadableStream<Uint8Array> {
  let started = false;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (started) return;
      started = true;
      void (async (): Promise<void> => {
        try {
          for await (const chunk of source as AsyncIterable<Uint8Array> | Iterable<Uint8Array>) {
            controller.enqueue(new Uint8Array(chunk));
          }
          controller.close();
        } catch (error) {
          controller.error(error instanceof Error ? error : new Error(String(error)));
        }
      })();
    },
    cancel() { /* the iterable dies with the consumer */ },
  });
}

function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({ pull(controller) { controller.close(); } });
}

/** Absolute URL or path: both normalize onto the throwaway base (the
 * origin is virtual mid-relay, so absolute URLs ride the tunnel too). */
export function normalizeRelayRequest(input: string | URL | Request, init?: RequestInit): NormalizedRelayRequest {
  let rawUrl: string;
  if (typeof input === 'string') rawUrl = input;
  else if (input instanceof URL) rawUrl = input.href;
  else rawUrl = (input as Request).url;
  const requestInit = init ?? {};
  const isRequestObject = !(typeof input === 'string' || input instanceof URL);
  const sourceHeaders = requestInit.headers ?? (isRequestObject ? (input as Request).headers : undefined);
  const headersSet = new Headers(sourceHeaders);
  const method = (requestInit.method ?? (isRequestObject ? (input as Request).method : 'GET')).toUpperCase();
  // NATIVE fetch parity: a Request input carries its own body/signal when
  // the init does not (an unconsumed Request body is still readable).
  const bodySource = requestInit.body ?? (isRequestObject ? (input as Request).body ?? undefined : undefined);
  const clause = classifyRequestBody(bodySource ?? undefined);
  if (clause.contentType !== undefined && !headersSet.has('content-type')) headersSet.set('content-type', clause.contentType);
  const headerRecord: Record<string, string> = {};
  for (const [name, value] of headersSet.entries()) headerRecord[name] = value;
  return { method, path: tunnelPathOf(rawUrl), query: {}, headers: headerRecord, clause };
}

function safeResponseStatus(status: number): number {
  return status >= 200 && status <= 599 ? status : 500;
}

export function requestPayloadOf(request: NormalizedRelayRequest): HttpRequestPayload {
  const payload: HttpRequestPayload = {
    method: request.method,
    path: request.path,
    query: request.query,
    headers: request.headers,
  };
  if (request.clause.hasBody) payload.hasBody = true;
  return payload;
}

export function startRelayFetch(core: TunnelClientCore, request: NormalizedRelayRequest, signal?: AbortSignal): { lane: FetchLane; promise: Promise<Response> } {
  core.assertConnected();
  const streamId = core.allocateStreamId();
  let resolveFn: ((response: Response) => void) | null = null;
  let rejectFn: ((error: Error) => void) | null = null;
  const lane: FetchLane = {
    id: streamId, requestSent: false, head: null, resolve: (r) => { resolveFn?.(r); }, reject: (e) => { rejectFn?.(e); },
    bodyController: null, preHeadChunks: [], finished: false,
  };
  const promise = new Promise<Response>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  core.registerFetchLane(lane);
  lane.requestSent = true;
  core.sendFrame(TunnelFrameType.HttpRequest, streamId, encodeHttpRequestPayload(requestPayloadOf(request)));
  if (request.clause.hasBody) sendBodyFrames(core, streamId, request.clause);
  if (signal !== undefined) attachAbortListener(core, lane, signal);
  return { lane, promise };
}

/** Aborts reject with plain AbortError semantics (caller-initiated, not a
 * transport failure) and detach the listener the moment the lane settles. */
function attachAbortListener(core: TunnelClientCore, lane: FetchLane, signal: AbortSignal): void {
  const onAbort = (): void => {
    detachAbortListener(lane);
    abortFetchLaneByCaller(core, lane);
  };
  signal.addEventListener('abort', onAbort, { once: true });
  lane.onAbortDetach = (): void => { signal.removeEventListener('abort', onAbort); };
}

function detachAbortListener(lane: FetchLane | undefined): void {
  if (lane === undefined) return;
  lane.onAbortDetach?.();
  lane.onAbortDetach = undefined;
}

/** Body frames then StreamEnd; every read chunk splits through the
 * tunnel payload budget; a stream that ends before any chunk shipped
 * emits one empty HttpBody frame (§3.9 truth). */
function sendBodyFrames(core: TunnelClientCore, streamId: number, clause: RelayBodyClassification): void {
  const sendChunk = (chunk: Uint8Array): void => {
    core.sendFrame(TunnelFrameType.HttpBody, streamId, chunk);
  };
  if (clause.bytes !== undefined) {
    for (const chunk of chunkPayload(clause.bytes, MAX_TUNNEL_PAYLOAD_BYTES)) sendChunk(chunk);
    core.sendFrame(TunnelFrameType.StreamEnd, streamId, new Uint8Array(0));
    return;
  }
  const body = clause.stream;
  if (body === undefined) {
    core.sendFrame(TunnelFrameType.StreamEnd, streamId, new Uint8Array(0));
    return;
  }
  void (async (): Promise<void> => {
    const reader = body.getReader();
    try {
      let sentAny = false;
      for (;;) {
        const read = await reader.read();
        if (read.done) break;
        for (const chunk of chunkPayload(read.value, MAX_TUNNEL_PAYLOAD_BYTES)) sendChunk(chunk);
        sentAny = true;
      }
      if (!sentAny) sendChunk(new Uint8Array(0));
      core.sendFrame(TunnelFrameType.StreamEnd, streamId, new Uint8Array(0));
    } catch (error: unknown) {
      core.sendFrame(TunnelFrameType.StreamAbort, streamId, encodeJsonPayload({ reason: 'request body read failed' }));
      // The head already reached the wire: the failure classifies as ambiguous.
      const settledLane = core.fetchLaneFor(streamId);
      if (settledLane !== null) laneChannelReset(settledLane, 'request body read failed');
      detachAbortListener(settledLane ?? undefined);
      core.releaseFetchLane(streamId);
    }
  })();
}

export function abortFetchLaneByCaller(core: TunnelClientCore, lane: FetchLane): void {
  if (lane.finished) return;
  lane.finished = true;
  detachAbortListener(lane);
  const abortError = new Error('relay fetch aborted');
  abortError.name = 'AbortError';
  if (lane.head === null) lane.reject(abortError);
  else try { lane.bodyController?.error(abortError); } catch { /* already closed */ }
  core.sendFrame(TunnelFrameType.StreamAbort, lane.id, encodeJsonPayload({ reason: 'caller abort' }));
  core.releaseFetchLane(lane.id);
}

export function bodyCancelStreamAbort(core: TunnelClientCore, lane: FetchLane): void {
  if (lane.finished) return;
  lane.finished = true;
  detachAbortListener(lane);
  core.sendFrame(TunnelFrameType.StreamAbort, lane.id, encodeJsonPayload({ reason: 'response body cancelled' }));
  core.releaseFetchLane(lane.id);
}

export function dispatchHttpResponseToLane(core: TunnelClientCore, lane: FetchLane, headPayload: HttpResponsePayload): void {
  if (lane.finished || lane.head !== null) return; // duplicate/late heads are ignored
  lane.head = { status: headPayload.status, headers: headPayload.headers };
  const body = new ReadableStream<Uint8Array>({
    start(controller) { lane.bodyController = controller; },
    cancel() { bodyCancelStreamAbort(core, lane); },
  });
  const status = safeResponseStatus(headPayload.status);
  // 204/205/304 responses cannot carry a body (fetch spec; undici throws).
  const bodyless = status === 204 || status === 205 || status === 304;
  if (!bodyless) {
    const controller = lane.bodyController;
    for (const chunk of lane.preHeadChunks.splice(0)) {
      try { controller?.enqueue(chunk); } catch { /* deliver as stream-late */ break; }
    }
  } else {
    lane.preHeadChunks = [];
    lane.bodyController = null;
  }
  const response = new Response(bodyless ? null : body, {
    status,
    headers: new Headers(headPayload.headers),
  });
  lane.resolve(response);
}

function lateBodyChunk(lane: FetchLane, chunk: Uint8Array): boolean {
  const controller = lane.bodyController;
  if (controller === null) {
    lane.preHeadChunks.push(chunk);
    return true;
  }
  try {
    controller.enqueue(chunk);
    return true;
  } catch {
    return false; // the consumer walked away; keep the ledger running
  }
}

export function dispatchHttpBodyToLane(lane: FetchLane, chunk: Uint8Array): void {
  if (lane.finished) return;
  if (lane.head === null) {
    lane.preHeadChunks.push(chunk);
    return;
  }
  lateBodyChunk(lane, chunk);
}

export function laneChannelReset(lane: FetchLane, cause: string): void {
  if (lane.finished) return;
  lane.finished = true;
  detachAbortListener(lane);
  const error = markAmbiguousTransportFailure(new Error(`relay tunnel reset: ${cause ?? 'channel failure'}`));
  if (lane.head === null) lane.reject(error);
  else try { lane.bodyController?.error(error); } catch { /* already closed */ }
}

export function dispatchStreamEndToLane(lane: FetchLane): void {
  if (lane.finished) return;
  lane.finished = true;
  detachAbortListener(lane);
  if (lane.head === null) {
    lane.reject(ambiguousTransportError('relay tunnel: StreamEnd before response head'));
    return;
  }
  try { lane.bodyController?.close(); } catch { /* consumer closed first */ }
}

export function dispatchStreamAbortToLane(lane: FetchLane, reason: string): void {
  if (lane.finished) return;
  lane.finished = true;
  detachAbortListener(lane);
  const error = ambiguousTransportError(`relay tunnel: stream aborted (${reason ?? 'host abort'})`);
  if (lane.head === null) lane.reject(error);
  else try { lane.bodyController?.error(error); } catch { /* already closed */ }
}

export function channelResetLanes(lanes: Iterable<FetchLane>, cause: string): void {
  for (const lane of lanes) laneChannelReset(lane, cause);
}

export { tunnelResetError };
