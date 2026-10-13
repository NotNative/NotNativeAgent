// SPDX-License-Identifier: Apache-2.0
/**
 * Relay client inbound routing (doc 08 §3.10): every decrypted tunnel
 * frame runs the §3.8 ACK ledger (nonzero raw frame bytes, keepalives
 * excluded, counted BEFORE dispatch) then dispatches. Batch containers
 * (§3.7 mixed-mode demux) preserve order; WS message frames
 * fragment-assemble per (streamId, type). Malformed JSON payloads fail
 * the channel (fail closed); well-formed but unexpected frame types are
 * ignored (host parity). Stream-zero frames answer Pings with Pong on
 * stream zero and stay off the ledger.
 */
import type { AckLedger } from './tunnel-acks.ts';
import {
  decodeFrameOrContainer, isHttpResponsePayload, isStreamAbortPayload, isWsClosePayload, isWsOpenedPayload,
  parseJsonPayload, createFragmentAssembler, type AssembledMessage, type TunnelFrame,
} from './tunnel-codec.ts';
import { TunnelFrameType, STREAM_ZERO } from './protocol.ts';
import {
  dispatchHttpResponseToLane, dispatchHttpBodyToLane, dispatchStreamEndToLane,
  dispatchStreamAbortToLane, laneChannelReset,
} from './tunnel-client-fetch.ts';
import {
  openWsFromPayload, messageWsFromPayload, closeWsFromPayload, abortWsFromPayload,
} from './tunnel-client-ws.ts';
import type { TunnelClientCore } from './tunnel-client-types.ts';

export interface InboundSinks {
  core: TunnelClientCore;
  ledger: AckLedger;
  fragments: ReturnType<typeof createFragmentAssembler>;
  failChannel: (reason: string) => void;
}

type FrameDecoder = (plaintext: Uint8Array) =>
  | { kind: 'single'; frames: [TunnelFrame] }
  | { kind: 'batch'; frames: TunnelFrame[] }
  | null;

function envelopeFrames(plaintext: Uint8Array, sinks: InboundSinks, decode: FrameDecoder): TunnelFrame[] {
  const decoded = decode(plaintext);
  if (decoded === null) {
    sinks.failChannel('malformed tunnel frame envelope');
    return [];
  }
  return decoded.frames;
}

export function routeDecryptedPlaintext(sinks: InboundSinks, plaintext: Uint8Array): void {
  for (const frame of envelopeFrames(plaintext, sinks, decodeFrameOrContainer)) {
    sinks.ledger.noteFrame(frame);
    routeFrame(sinks, frame);
  }
  sinks.ledger.afterBatch();
}

export function routeFrame(sinks: InboundSinks, frame: TunnelFrame): void {
  if (frame.streamId === STREAM_ZERO) { routeControlFrame(sinks, frame); return; }
  if (frame.type === TunnelFrameType.WsText || frame.type === TunnelFrameType.WsBinary) {
    const assembled = sinks.fragments.push(frame);
    if (assembled !== null) deliverAssembled(sinks, assembled);
    return;
  }
  routeNonZeroFrame(sinks, frame);
}

function deliverAssembled(sinks: InboundSinks, assembled: AssembledMessage): void {
  const link = sinks.core.wsLinkFor(assembled.streamId);
  if (link === null) return; // unknown stream: bytes stay accountable; delivery drops
  messageWsFromPayload(link, assembled.payload, assembled.type === TunnelFrameType.WsBinary);
}

function routeControlFrame(sinks: InboundSinks, frame: TunnelFrame): void {
  if (frame.type === TunnelFrameType.Ping) {
    sinks.core.sendFrame(TunnelFrameType.Pong, STREAM_ZERO, new Uint8Array(0));
  }
  // Pong / inbound DeliveryAck: no-ops for the client.
}

function routeNonZeroFrame(sinks: InboundSinks, frame: TunnelFrame): void {
  switch (frame.type) {
    case TunnelFrameType.HttpResponse: return routeResponseHead(sinks, frame);
    case TunnelFrameType.HttpBody: return routeBodyChunk(sinks, frame);
    case TunnelFrameType.StreamEnd: return routeStreamEnd(sinks, frame);
    case TunnelFrameType.StreamAbort: return routeStreamAbort(sinks, frame);
    case TunnelFrameType.WsOpened: return routeWsOpened(sinks, frame);
    case TunnelFrameType.WsClose: return routeWsClose(sinks, frame);
    default: return; // unexpected-but-legal frames are ignored (host parity)
  }
}

function routeResponseHead(sinks: InboundSinks, frame: TunnelFrame): void {
  const headPayload = parseJsonPayload(frame.payload, isHttpResponsePayload);
  if (headPayload === null) { sinks.failChannel('malformed HTTP response head'); return; }
  const lane = sinks.core.fetchLaneFor(frame.streamId);
  if (lane === null) return;
  dispatchHttpResponseToLane(sinks.core, lane, headPayload);
}

function routeBodyChunk(sinks: InboundSinks, frame: TunnelFrame): void {
  const lane = sinks.core.fetchLaneFor(frame.streamId);
  if (lane === null) return; // late chunk of a finished stream: ledger already counted it
  dispatchHttpBodyToLane(lane, frame.payload);
}

function routeStreamEnd(sinks: InboundSinks, frame: TunnelFrame): void {
  const lane = sinks.core.fetchLaneFor(frame.streamId);
  if (lane !== null) {
    dispatchStreamEndToLane(lane);
    sinks.core.releaseFetchLane(frame.streamId);
  }
}

function routeStreamAbort(sinks: InboundSinks, frame: TunnelFrame): void {
  const abortPayload = parseJsonPayload(frame.payload, isStreamAbortPayload);
  if (abortPayload === null) { sinks.failChannel('malformed stream abort payload'); return; }
  const lane = sinks.core.fetchLaneFor(frame.streamId);
  if (lane !== null) {
    dispatchStreamAbortToLane(lane, abortPayload.reason);
    sinks.core.releaseFetchLane(frame.streamId);
    return;
  }
  const link = sinks.core.wsLinkFor(frame.streamId);
  if (link !== null && !link.closed) abortWsFromPayload(sinks.core, link, abortPayload.reason);
}

function routeWsOpened(sinks: InboundSinks, frame: TunnelFrame): void {
  const openedPayload = parseJsonPayload(frame.payload, isWsOpenedPayload);
  if (openedPayload === null) { sinks.failChannel('malformed WsOpened payload'); return; }
  const link = sinks.core.wsLinkFor(frame.streamId);
  if (link === null || link.closed) return;
  openWsFromPayload(sinks.core, link, frame.payload);
}

function routeWsClose(sinks: InboundSinks, frame: TunnelFrame): void {
  const closePayload = parseJsonPayload(frame.payload, isWsClosePayload);
  if (closePayload === null) { sinks.failChannel('malformed WsClose payload'); return; }
  const lane = sinks.core.fetchLaneFor(frame.streamId);
  if (lane !== null) {
    laneChannelReset(lane, 'relay response stream closed by host');
    sinks.core.releaseFetchLane(frame.streamId);
    return;
  }
  const link = sinks.core.wsLinkFor(frame.streamId);
  if (link !== null && !link.closed) closeWsFromPayload(sinks.core, link, closePayload.code, closePayload.reason ?? '');
}
