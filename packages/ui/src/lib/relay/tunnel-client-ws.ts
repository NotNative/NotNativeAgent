// SPDX-License-Identifier: Apache-2.0
/**
 * Relay client WS surface (doc 08 §3.10 WS half). `openWebSocket(
 * pathWithQuery, protocols?)` returns a native-WS-shaped surface:
 * readyState 0..3, assignable `on*` handlers, `send(string|ArrayBuffer|
 * view)`, `close(code?, reason?)`; messages deliver string | ArrayBuffer
 * (binary always ArrayBuffer). WsOpen rides its own odd stream id;
 * readyState transitions ONLY through real WsOpened/WsClose frames; send
 * before open throws "relay tunnel socket is not open"; local close does
 * not fabricate a close (the host's WsClose completes the handshake).
 * Host StreamAbort closes 1006 (`errored`); channel death closes 1012
 * ("host went away, retry"). Messages fragment through the payload
 * budget; the host reassembles whole writes.
 */
import { decodeTunnelFrame, encodeFragmentedMessage, encodeJsonPayload } from './tunnel-codec.ts';
import { wsUrlToTunnelPath } from './tunnel-payloads.ts';
import { MAX_TUNNEL_PAYLOAD_BYTES } from './crypto.ts';
import { MAX_ASSEMBLED_MESSAGE_BYTES } from './protocol.ts';
import { TunnelFrameType, WS_LOCAL_SOCKET_KILLED, WS_CHANNEL_DEATH } from './protocol.ts';
import {
  WS_CONNECTING, WS_OPEN, WS_CLOSED,
  type RelayTunnelWebSocket, type TunnelClientCore, type WsLink,
} from './tunnel-client-types.ts';

interface WsSurfaceInternal {
  readyStateValue: number;
  protocolValue: string;
  finishLocal(): void;
}

export type RelayWsSurface = RelayTunnelWebSocket & WsSurfaceInternal;

const textDecoder = new TextDecoder('utf8');
const textEncoder = new TextEncoder();

class RelayClientWsSurface implements RelayWsSurface {
  readonly url: string;
  readyStateValue = WS_CONNECTING;
  protocolValue = '';
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string | ArrayBuffer }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  private readonly core: TunnelClientCore;
  private readonly holder: WsLink;

  constructor(core: TunnelClientCore, holder: WsLink, url: string) {
    this.core = core;
    this.holder = holder;
    this.url = url;
  }

  get readyState(): number {
    return this.readyStateValue;
  }

  get protocol(): string {
    return this.protocolValue;
  }

  send(data: string | ArrayBuffer | ArrayBufferView): void {
    if (this.readyStateValue !== WS_OPEN || this.holder.closed) throw new Error('relay tunnel socket is not open');
    const isBinary = typeof data !== 'string';
    const bytes = isBinary ? wsMessageBytes(data) : textEncoder.encode(data);
    const type = isBinary ? TunnelFrameType.WsBinary : TunnelFrameType.WsText;
    if (bytes.length > MAX_ASSEMBLED_MESSAGE_BYTES) throw new Error(`relay tunnel message exceeds ${MAX_ASSEMBLED_MESSAGE_BYTES} bytes`);
    for (const frameBytes of encodeFragmentedMessage(type, this.holder.id, bytes, MAX_TUNNEL_PAYLOAD_BYTES)) {
      const frame = decodeTunnelFrame(frameBytes);
      this.core.sendFrame(frame.type, frame.streamId, frame.payload, frame.hasMore);
    }
  }

  /** Native-shaped close: the surface is CLOSED locally at once and the
   * WsClose row still rides upstream (it also kills a host dial that has
   * not opened yet); the host's WsClose echo completes the close circle
   * with the onclose event. */
  close(code = 1000, reason = ''): void {
    if (this.readyStateValue === WS_CLOSED) return;
    this.readyStateValue = WS_CLOSED;
    if (!this.holder.closed && !this.holder.closing) {
      this.holder.closing = true;
      // Skip the echo send when the local surface never opened AND the
      // exchange is idle; a pending dial still needs the kill (the host
      // tears the stream down on WsClose for a stream in any state).
      this.core.sendFrame(TunnelFrameType.WsClose, this.holder.id, encodeJsonPayload({ code, reason: reason.slice(0, 120) }));
    }
  }

  /** Local close circuit: linked-socket teardown without WsClose emission
   * (runtime internal resets use this). */
  finishLocal(): void {
    if (this.readyStateValue === WS_CLOSED) return;
    this.readyStateValue = WS_CLOSED;
    this.core.releaseWsLink(this.holder.id);
  }
}

function holderLink(core: TunnelClientCore, link: WsLink): WsLink {
  const surface = new RelayClientWsSurface(core, link, link.url);
  link.socket = surface as unknown as RelayTunnelWebSocket;
  return link;
}

function surfaceOf(lane: WsLink): RelayWsSurface {
  return lane.socket as unknown as RelayWsSurface;
}

function wsOpenPayload(url: string, protocols?: string | string[]): Uint8Array {
  const protocolList = pureProtocols(protocols);
  return encodeJsonPayload({
    path: wsUrlToTunnelPath(url),
    ...(protocolList.length > 0 ? { protocols: protocolList } : {}),
  });
}

function pureProtocols(protocols?: string | string[]): string[] {
  if (protocols === undefined) return [];
  if (typeof protocols === 'string') return protocols.length > 0 ? [protocols] : [];
  return protocols.filter((value) => value.length > 0);
}

/** Allocates the odd stream id, sends WsOpen, and returns the surface. */
export function openTunnelWebSocket(core: TunnelClientCore, url: string, protocols?: string | string[]): RelayTunnelWebSocket {
  core.assertConnected();
  const id = core.allocateStreamId();
  const link: WsLink = { id, url, socket: null as unknown as RelayTunnelWebSocket, opened: false, closed: false, closing: false };
  const surface = holderLink(core, link).socket as unknown as RelayWsSurface;
  core.registerWsLink(link);
  core.sendFrame(TunnelFrameType.WsOpen, id, wsOpenPayload(url, protocols));
  return surface as unknown as RelayTunnelWebSocket;
}

function wsMessageBytes(data: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  const view = data as ArrayBufferView<ArrayBuffer>;
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

// ---- inbound dispatch (driven by tunnel-client.ts) ------------------------

export function openWsFromPayload(core: TunnelClientCore, link: WsLink, payloadBytes: Uint8Array): void {
  if (link.opened || link.closed || link.closing) return; // a local close already retired this surface
  link.opened = true;
  const surface = surfaceOf(link);
  surface.readyStateValue = WS_OPEN;
  surface.protocolValue = protocolOfPayload(payloadBytes);
  surface.onopen?.();
  void core;
}

function protocolOfPayload(payloadBytes: Uint8Array): string {
  try {
    const parsed = JSON.parse(textDecoder.decode(payloadBytes)) as { protocol?: string };
    return typeof parsed.protocol === 'string' ? parsed.protocol : '';
  } catch {
    return '';
  }
}

export function messageWsFromPayload(link: WsLink, payloadBytes: Uint8Array, isBinary: boolean): void {
  if (!link.opened || link.closed || link.closing) return;
  const surface = surfaceOf(link);
  surface.onmessage?.({
    data: isBinary
      ? payloadBytes.buffer.slice(payloadBytes.byteOffset, payloadBytes.byteOffset + payloadBytes.byteLength) as ArrayBuffer
      : textDecoder.decode(payloadBytes),
  });
}

export function closeWsFromPayload(core: TunnelClientCore, link: WsLink, code: number, reason: string): void {
  if (link.closed) return;
  link.closed = true;
  link.closing = true;
  const surface = surfaceOf(link);
  surface.readyStateValue = WS_CLOSED;
  core.releaseWsLink(link.id);
  surface.onclose?.({ code, reason });
}

/** Host StreamAbort for this WS stream → close 1006 (`errored`). */
export function abortWsFromPayload(core: TunnelClientCore, link: WsLink, reason: string): void {
  if (link.closed) return;
  link.closed = true;
  link.closing = true;
  const surface = surfaceOf(link);
  surface.readyStateValue = WS_CLOSED;
  core.releaseWsLink(link.id);
  surface.onerror?.({ message: `relay tunnel stream aborted (${reason})` });
  surface.onclose?.({ code: WS_LOCAL_SOCKET_KILLED, reason: 'relay tunnel errored' });
}

/** Channel death closes every live socket with 1012 ("host went away"). */
export function channelDeathWs(core: TunnelClientCore, link: WsLink, cause: string): void {
  if (link.closed) {
    surfaceOf(link).finishLocal();
    return;
  }
  link.closed = true;
  link.closing = true;
  const surface = surfaceOf(link);
  surface.readyStateValue = WS_CLOSED;
  core.releaseWsLink(link.id);
  surface.onclose?.({ code: WS_CHANNEL_DEATH, reason: `relay tunnel reset: ${cause}` });
}

/** Close all WS streams on channel death. */
export function channelDeathAllWs(core: TunnelClientCore, links: Iterable<WsLink>, cause: string): void {
  for (const link of [...links]) channelDeathWs(core, link, cause);
}
