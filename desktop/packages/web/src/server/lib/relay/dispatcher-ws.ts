// SPDX-License-Identifier: Apache-2.0
/**
 * Relay §3.9 WS sub-stream bridge (sliced out of the host dispatcher so
 * the dispatcher file stays under the size gate). `WsOpen` dials
 * `ws://127.0.0.1:<localPort><path>?<query>` with the loopback origin and
 * `x-openchamber-relay-connection` injected (never a credential). Host->
 * client messages re-chunk with fragment flags through the tunnel codec;
 * client->host fragments are reassembled by the stream's assembler in the
 * dispatcher before the socket write. Serpentine details: unknown/refused
 * paths answer a 1008 close without dialing; server-side closes answer a
 * clamped `WsClose`; a socket failure aborts the whole stream. Stream ids
 * stay owned by the dispatcher's registry - the bridge only receives the
 * per-stream link and narrowly-scoped callbacks.
 */
import { Buffer } from 'node:buffer';
import { MAX_TUNNEL_PAYLOAD_BYTES } from './crypto.ts';
import {
  TunnelFrameType, createFragmentAssembler, decodeTunnelFrame, encodeFragmentedMessage,
  encodeJsonPayload, isWsOpenPayload, parseJsonPayload, type TunnelFrame,
} from './tunnel-codec.ts';

export const DEFAULT_WS_CHUNK_BYTES = MAX_TUNNEL_PAYLOAD_BYTES;
export const WS_HOST_ALLOWLIST = new Set([
  '/api/global/event/ws',
  '/api/event/ws',
  '/api/terminal/ws',
  '/api/dictation/ws',
  '/api/dev-tunnel',
]);

export function isAllowedRelayWebSocketPath(path: string): boolean {
  return WS_HOST_ALLOWLIST.has(path.split('?')[0] ?? '');
}

/** WS codes clamp to the 1000..4999 window; junk defaults to 1000. */
export function clampWsCloseCode(code: number): number {
  return Number.isSafeInteger(code) ? Math.min(4999, Math.max(1000, code)) : 1000;
}

export function loopbackQueryOf(query: Record<string, string> | undefined): string {
  if (query === undefined) return '';
  const value = new URLSearchParams(Object.entries(query).filter(([, entry]) => typeof entry === 'string')).toString();
  return value === '' ? '' : `?${value}`;
}

/** Minimal loopback socket surface; the real adapter (host service slice)
 * wraps the `ws` client with origin + relay-connection headers and a
 * 16 MiB maxPayload. */
export interface RelayHostSocketLike {
  send(data: Buffer, isBinary: boolean): void;
  close(code: number, reason?: string): void;
  terminate(): void;
  on(event: 'message', handler: (data: Buffer, isBinary: boolean) => void): void;
  on(event: 'close', handler: (code: number, reason: string) => void): void;
  on(event: 'error', handler: (error: Error) => void): void;
  on(event: 'open', handler: () => void): void;
  readonly protocol: string;
}

export type RelayHostSocketLikeFactory = (url: string, protocols: string[], extraHeaders: Record<string, string>) => RelayHostSocketLike;

/** Per-stream state: the dialed socket plus the fragment assembler the
 * dispatcher drives for client->host messages. */
export interface WsStreamLink {
  socket: RelayHostSocketLike | null;
  assembler: ReturnType<typeof createFragmentAssembler>;
}

export interface WsBridge {
  link(): WsStreamLink;
  open(streamId: number, link: WsStreamLink, payload: Buffer): void;
}

export interface WsBridgeDeps {
  localPort: number;
  connectionId: string;
  wsFactory: RelayHostSocketLikeFactory;
  sendFrame: (frame: TunnelFrame) => Promise<void>;
  /** Terminal close rows: refuse 1008 + upstream-close mirror must
   * survive their own releaseStream cancel (bypasses the §3.8 queue).
   * Defaults to `sendFrame` for direct drivers. */
  sendFrameNow?: (frame: TunnelFrame) => Promise<void>;
  releaseStream: (streamId: number) => void;
  killStream: (streamId: number, reason: string) => void;
}

export function createWsBridge(deps: WsBridgeDeps): WsBridge {
  const sendNow = (frame: TunnelFrame): Promise<void> => (deps.sendFrameNow ?? deps.sendFrame)(frame);
  const sendClose = (streamId: number, code: number, reason: string): Promise<void> => sendNow({
    type: TunnelFrameType.WsClose, streamId, hasMore: false,
    payload: encodeJsonPayload({ code, reason: reason.slice(0, 120) }),
  });

  const pumpDownlink = async (streamId: number, data: Buffer, isBinary: boolean): Promise<void> => {
    const type = isBinary ? TunnelFrameType.WsBinary : TunnelFrameType.WsText;
    for (const raw of encodeFragmentedMessage(type, streamId, data, DEFAULT_WS_CHUNK_BYTES)) {
      await deps.sendFrame(decodeTunnelFrame(raw));
    }
  };

  const open = (streamId: number, link: WsStreamLink, payload: Buffer): void => {
    const head = parseJsonPayload(payload, isWsOpenPayload);
    if (head === null || !isAllowedRelayWebSocketPath(head.path)) {
      void sendClose(streamId, 1008, 'relay tunnel path is not allowed');
      deps.releaseStream(streamId);
      return;
    }
    const socket = deps.wsFactory(
      `ws://127.0.0.1:${deps.localPort}${head.path}${loopbackQueryOf(head.query)}`,
      head.protocols ?? [],
      {
        'x-openchamber-relay-connection': deps.connectionId,
        origin: `http://127.0.0.1:${deps.localPort}`,
      },
    );
    link.socket = socket;
    socket.on('open', () => {
      const protocol = socket.protocol !== '' ? { protocol: socket.protocol } : {};
      void deps.sendFrame({ type: TunnelFrameType.WsOpened, streamId, hasMore: false, payload: encodeJsonPayload(protocol) });
    });
    socket.on('message', (data, isBinary) => {
      void pumpDownlink(streamId, Buffer.from(data), isBinary);
    });
    socket.on('close', (code, reason) => {
      void sendClose(streamId, clampWsCloseCode(code), reason ?? '');
      deps.releaseStream(streamId);
    });
    socket.on('error', () => deps.killStream(streamId, 'loopback websocket failed'));
  };

  return {
    link: () => ({ socket: null, assembler: createFragmentAssembler() }),
    open,
  };
}
