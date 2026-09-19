// SPDX-License-Identifier: Apache-2.0
/**
 * Relay tunnel client contracts (doc 08 §3.10): public client surface,
 * options, native-shaped WS surface, wire socket seam, and the internal
 * core plumbing the fetch/WS modules are built over. Types only — see
 * tunnel-client.ts for the state machine.
 */

export interface RelayIdentityLike {
  hostEncPubJwk: { kty: string; crv: string; x: string; y: string };
}

export interface WakeHooks {
  isOnline: () => boolean;
  isHidden: () => boolean;
  onWake: (cb: () => void) => () => void;
}

export interface RelayTunnelClientOptions {
  relayUrl: string;
  serverId: string;
  hostEncPubJwk: { kty: string; crv: string; x: string; y: string };
  /** One-time pairing admission token: rides THIS connection's URL only
   * and is never persisted (§3.3). */
  grant?: string;
  /** Additional broker-leg query params (worker-evolution/test hooks). */
  wireQuery?: Record<string, string>;
  /** Test/worker hook for the broker leg transport (default: platform WS). */
  createWireSocket?: (url: string) => RelayWireSocket;
  /** Client platform label for the broker leg URL (§3.3; default 'web'). */
  platform?: string;
  appVersion?: string;
  appId?: string;
  helloRetryMs?: number;
  helloTimeoutMs?: number;
  pingIntervalMs?: number;
  pingTimeoutMs?: number;
  batch?: boolean;
  flowControl?: boolean;
  batchWindowMs?: number;
  reconnectBaseDelayMs?: number;
  reconnectMaxDelayMs?: number;
  hiddenOrOfflineMaxDelayMs?: number;
  /** DOM-free wake integration (online/visibility) for reconnect fast-paths. */
  wakeHooks?: WakeHooks;
}

export type RelayTunnelState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error';

export interface RelayTunnelStatus {
  state: RelayTunnelState;
  lastError?: string;
}

export interface RelayTunnelClient {
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
  openWebSocket(url: string, protocols?: string | string[]): RelayTunnelWebSocket;
  getStatus(): RelayTunnelStatus;
  subscribeStatus(listener: (status: RelayTunnelStatus) => void): () => void;
  close(): void;
}

export interface RelayTunnelWebSocket {
  readonly url: string; // the request path this socket speaks (tunnel path)
  readonly readyState: number;
  readonly protocol: string; // '' until the host's WsOpened answers
  onopen: (() => void) | null;
  onmessage: ((event: { data: string | ArrayBuffer }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  send(data: string | ArrayBuffer | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
}

export const WS_CONNECTING = 0;
export const WS_OPEN = 1;
export const WS_CLOSING = 2;
export const WS_CLOSED = 3;

/** Minimal body-controller surface (structural over DOM/node shapes). */
export interface LaneBodyController {
  enqueue(chunk: Uint8Array): void;
  close(): void;
  error(reason?: unknown): void;
}

export interface RelayWireSocket {
  readyState: number;
  binaryType: string;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: { code: number; reason: string | undefined }) => void) | null;
  send(data: string | ArrayBuffer | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
}

/** Internal live request-response lane for one tunnel HTTP stream. */
export interface FetchLane {
  id: number;
  requestSent: boolean;
  head: { status: number; headers: Record<string, string> } | null;
  resolve: (response: Response) => void;
  reject: (error: Error) => void;
  bodyController: LaneBodyController | null;
  preHeadChunks: Uint8Array[];
  finished: boolean;
  /** Detaches the caller abort listener (set by the fetch pipeline). */
  onAbortDetach?: () => void;
}

/** Minimal ReadableStream controller shape shared across hosts/lib deps. */
export type StreamController = LaneBodyController;

/** Internal WS sub-stream record. */
export interface WsLink {
  id: number;
  url: string;
  socket: RelayTunnelWebSocket;
  opened: boolean;
  closed: boolean;
  /** Local close underway: WsClose sent, waiting for the host echo; no
   * message/open delivery and a local close() short-circuits. */
  closing: boolean;
}

/** Core plumbing the fetch/WS modules reach through (owned by tunnel-client). */
export interface TunnelClientCore {
  allocateStreamId(): number;
  sendFrame(type: number, streamId: number, payload: Uint8Array, hasMore?: boolean): void;
  registerFetchLane(lane: FetchLane): void;
  releaseFetchLane(id: number): void;
  fetchLaneFor(id: number): FetchLane | null;
  fetchLanes(): Iterable<FetchLane>;
  registerWsLink(link: WsLink): void;
  releaseWsLink(id: number): void;
  wsLinkFor(id: number): WsLink | null;
  wsLinks(): Iterable<WsLink>;
  channelDeath(cause: string): void;
  statusNow(): RelayTunnelStatus;
  assertConnected(): void;
}
