// SPDX-License-Identifier: Apache-2.0
/**
 * Relay tunnel client state machine (doc 08 §3.10/§3.11). One broker leg:
 * connects to `?role=client&serverId=…[&grant=…]`, runs the §3.4 E2EE
 * handshake (hello on 1 s retries, 30 s deadline), then speaks Layer 3
 * through the fetch/WS/inbound modules. Keepalive is INBOUND-driven:
 * after 30 s without inbound frames send Ping (stream 0) and arm a
 * one-shot 15 s pong deadline; any inbound frame (including Pong) clears
 * it. Reconnect: 1 s ×2 attempts capped 30 s (60 s offline/hidden), wake
 * listeners connect immediately; terminal close codes (4010/4002/4029)
 * retain the error and fail fast forever. A stream dying with the channel
 * rejects every waiter with a NEW tagged ambiguous error ("relay tunnel
 * reset:…"); requests whose head never reached the wire fail untagged.
 * Fetches racing the current connect attempt are queued; a failed attempt
 * rejects the queue untagged. The §3.8 DeliveryAck ledger counts decoded
 * raw frame bytes on nonzero streams and never awaits credit.
 */
import { createAckLedger, type AckLedger } from './tunnel-acks.ts';
import { createClientInitiator, type ClientInitiator } from './handshake.ts';
import { decryptFrame, encryptFrame, decodeHandshakeReady, type OpenedSession } from './crypto.ts';
import { createFragmentAssembler, encodeTunnelFrame, type TunnelFrame } from './tunnel-codec.ts';
import { buildClientRelaySocketUrl } from './tunnel-payloads.ts';
import { platformWireSocket, messageToBytes, wireSendData } from './wire-socket.ts';
import { utf8Text } from './bytes.ts';
import {
  CLIENT_CLOSE_CHANNEL, HIDDEN_OR_OFFLINE_MAX_DELAY_MS, HELLO_RETRY_MS, HELLO_TIMEOUT_MS,
  PING_INTERVAL_MS, PING_TIMEOUT_MS, RECONNECT_BASE_DELAY_MS, RECONNECT_MAX_DELAY_MS,
  RECONNECT_MAX_ATTEMPTS, STREAM_ZERO, TERMINAL_CLOSE_CODES, TunnelFrameType,
} from './protocol.ts';
import {
  startRelayFetch, normalizeRelayRequest, laneChannelReset,
} from './tunnel-client-fetch.ts';
import { openTunnelWebSocket, channelDeathAllWs } from './tunnel-client-ws.ts';
import { abortSignalOf, queueFetchDuringConnect, type QueuedFetch } from './tunnel-client-queue.ts';
import { routeDecryptedPlaintext, type InboundSinks } from './tunnel-client-inbound.ts';
import { createClientOutboundBatcher, DEFAULT_CLIENT_BATCH_WINDOW_MS, type ClientOutboundBatcher } from './tunnel-client-outbound.ts';
import type {
  RelayTunnelClient, RelayTunnelClientOptions, RelayTunnelStatus, RelayTunnelState,
  RelayTunnelWebSocket, RelayWireSocket, FetchLane, WsLink, TunnelClientCore,
} from './tunnel-client-types.ts';

type StatusListener = (status: RelayTunnelStatus) => void;

export function createRelayTunnelClient(options: RelayTunnelClientOptions): RelayTunnelClient & TunnelClientCore {
  const client = new RelayTunnelClientImpl(options);
  client.connectNow();
  return client;
}

class RelayTunnelClientImpl implements RelayTunnelClient, TunnelClientCore {
  private readonly options: RelayTunnelClientOptions;
  private state: RelayTunnelState = 'idle';
  private lastError: string | undefined;
  private readonly listeners = new Set<StatusListener>();
  private session: OpenedSession | null = null;
  private initiator: ClientInitiator | null = null;
  private socket: RelayWireSocket | null = null;
  private socketGeneration = 0;
  private explicitClose = false;
  private attemptIndex = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingDeadline: ReturnType<typeof setTimeout> | null = null;
  private keepaliveTimer: ReturnType<typeof setTimeout> | null = null;
  private lastInboundAt = 0;
  private streamIdCounter = 1;
  private readonly lanes = new Map<number, FetchLane>();
  private readonly wsStreams = new Map<number, WsLink>();
  private readonly queuedFetches: QueuedFetch[] = [];
  private sendChain: Promise<void> = Promise.resolve();
  private recvChain: Promise<void> = Promise.resolve();
  private readonly ledger: AckLedger;
  private readonly fragments = createFragmentAssembler();
  private readonly outbound: ClientOutboundBatcher;
  private batch = true; // advertised default; re-armed to the NEGOTIATED cap on each handshake
  private readonly pingIntervalOptionMs: number;
  private readonly pingTimeoutOptionMs: number;
  private wakeUnsubscribe: (() => void) | null = null;
  private terminalRetained = false;
  private lastClosedGeneration = 0;

  constructor(options: RelayTunnelClientOptions) {
    this.options = options;
    this.pingIntervalOptionMs = options.pingIntervalMs ?? PING_INTERVAL_MS;
    this.pingTimeoutOptionMs = options.pingTimeoutMs ?? PING_TIMEOUT_MS;
    this.ledger = createAckLedger({
      sendAck: (payload) => { this.sendFrame(TunnelFrameType.DeliveryAck, STREAM_ZERO, payload); },
    });
    const batched = (): boolean => this.batch;
    const windowMs = options.batchWindowMs ?? DEFAULT_CLIENT_BATCH_WINDOW_MS;
    this.outbound = createClientOutboundBatcher({
      isBatched: batched,
      sendPlaintext: (bytes) => { this.chainEncryptAndSend(bytes); },
      windowMs,
    });
    if (options.wakeHooks !== undefined) {
      this.wakeUnsubscribe = options.wakeHooks.onWake(() => {
        if (this.explicitClose || this.state === 'connected') return;
        if (this.reconnectTimer !== null) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
        this.connectNow();
      });
    }
  }

  private sinks(): InboundSinks {
    return {
      core: this,
      ledger: this.ledger,
      fragments: this.fragments,
      failChannel: (reason) => { this.failChannel(reason); },
    };
  }

  connectNow(): void {
    if (this.explicitClose || this.terminalRetained) return;
    if (this.reconnectTimer !== null) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.state === 'connecting' && this.socketGeneration > 0) return; // an attempt is racing
    this.resetCycle();
    this.state = 'connecting';
    this.emitStatus();
    this.socketGeneration += 1;
    const generation = this.socketGeneration;
    const url = buildClientRelaySocketUrl(this.options.relayUrl, {
      serverId: this.options.serverId,
      grant: this.options.grant,
      appId: this.options.appId,
      appVersion: this.options.appVersion,
      platform: this.options.platform ?? 'web',
      extra: this.options.wireQuery,
    });
    let socket: RelayWireSocket;
    try {
      socket = (this.options.createWireSocket ?? platformWireSocket)(url);
    } catch (error) {
      this.failChannel(error instanceof Error ? error.message : 'relay wire socket unavailable');
      return;
    }
    this.socket = socket;
    socket.onopen = () => { if (generation === this.socketGeneration) this.onWireOpen(); };
    socket.onclose = (event: { code: number; reason: string | undefined }) => {
      if (generation === this.socketGeneration) this.handleWireClose(event.code, event.reason ?? '', generation);
    };
    socket.onerror = () => { if (generation === this.socketGeneration) this.failChannel('relay tunnel wire socket error'); };
    socket.onmessage = (event: { data: unknown }) => {
      if (generation !== this.socketGeneration) return;
      this.handleWireMessage(event.data);
    };
    this.refreshInboundClock();
  }

  private resetCycle(): void {
    this.session = null;
    this.initiator = null;
    this.fragments.reset();
    this.ledger.reset();
    this.outbound.reset();
  }



  private onWireOpen(): void {
    this.refreshInboundClock();
    const generation = this.socketGeneration;
    this.initiator = createClientInitiator({
      hostEncPublicJwk: this.options.hostEncPubJwk,
      capabilities: { batch: this.options.batch ?? true, flowControl: this.options.flowControl ?? true },
      sendText: (bytes) => {
        const socket = this.socket;
        if (socket !== null) socket.send(utf8Text(bytes));
      },
      onClose: (code, reason) => { if (generation === this.socketGeneration) this.failChannel(reason || 'relay handshake failed', code); },
      onEstablished: (established) => { if (generation === this.socketGeneration) this.onHandshakeEstablished(established.session, established.capabilities); },
      helloRetryMs: this.options.helloRetryMs ?? HELLO_RETRY_MS,
      helloTimeoutMs: this.options.helloTimeoutMs ?? HELLO_TIMEOUT_MS,
    });
    void this.initiator.start().catch((error: unknown): void => {
      this.failChannel(error instanceof Error ? error.message : 'relay handshake crypto unavailable');
    });
  }

  private onHandshakeEstablished(session: OpenedSession, capabilities: { batch: boolean; flowControl: boolean }): void {
    this.session = session;
    this.batch = capabilities.batch; // negotiated only when BOTH peers advertise
    this.state = 'connected';
    this.lastError = undefined;
    this.attemptIndex = 0;
    this.ledger.reset();
    this.fragments.reset();
    this.refreshInboundClock();
    this.emitStatus();
    for (const op of this.queuedFetches.splice(0)) op.run();
  }

  private handleWireMessage(data: unknown): void {
    const bytes = messageToBytes(data);
    if (bytes === null) { this.failChannel('unsupported relay wire message shape'); return; }
    this.refreshInboundClock();
    if (typeof data === 'string') { this.handleWireText(bytes); return; }
    this.handleWireBinary(bytes);
  }

  private handleWireText(bytes: Uint8Array): void {
    if (this.session !== null) {
      if (decodeHandshakeReady(bytes) !== null) return; // duplicate ready is ignored
      this.failChannel('plaintext frame on established channel');
      return;
    }
    void this.initiator?.onText(bytes);
  }

  private handleWireBinary(bytes: Uint8Array): void {
    const session = this.session;
    if (session === null) {
      if (this.initiator === null) { this.failChannel('encrypted frame before handshake completed'); return; }
      this.initiator.onBinary();
      return;
    }
    // Serialize decryption so the counter check always rides wire order.
    this.recvChain = this.recvChain.then(async (): Promise<void> => {
      const plaintext = await decryptFrame(session.hostToClient, bytes);
      routeDecryptedPlaintext(this.sinks(), plaintext);
    }).catch((error: unknown): void => {
      this.onWireError(error instanceof Error ? error : new Error(String(error)));
    });
  }

  private onWireError(error: Error): void {
    this.failChannel(error.message);
  }

  /** §3.4/§3.7 frame emission: the outbound batcher groups consecutive
   * stream payloads into containers; every plaintext rides ONE promise
   * chain so one encrypt() == one WS message == one counter tick in wire
   * order. Crypto or wire send failures are fail-closed. */
  sendFrame(type: number, streamId: number, payload: Uint8Array, hasMore = false): void {
    this.outbound.offer({ type, streamId, hasMore, payload });
  }

  /** One encrypted WS message per chain link: `plain` is a tunnel frame
   * body or a §3.7 batch container. */
  private chainEncryptAndSend(plain: Uint8Array): void {
    const run = this.sendChain.then(async (): Promise<void> => {
      const session = this.session;
      const socket = this.socket;
      if (session === null || socket === null || this.explicitClose) return;
      const encrypted = await encryptFrame(session.clientToHost, plain);
      if (this.socket !== socket) return;
      wireSendData(socket, encrypted);
    });
    run.catch((error: unknown) => {
      this.failChannel(error instanceof Error ? error.message : 'relay frame send failed');
    });
    this.sendChain = run.catch(() => undefined);
  }

  private failChannel(reason: string, closeCode = CLIENT_CLOSE_CHANNEL): void {
    if (this.explicitClose) return;
    const generation = this.socketGeneration;
    const socket = this.socket;
    this.clearTimers();
    if (socket !== null) {
      this.socket = null;
      try { socket.close(closeCode, reason.slice(0, 120)); } catch { /* already closing */ }
    }
    this.handleWireClose(closeCode, reason, generation);
  }

  private handleWireClose(code: number, reason: string, generation = this.socketGeneration): void {
    if (generation <= this.lastClosedGeneration) return;
    this.lastClosedGeneration = generation;
    this.socket = null;
    this.clearTimers();
    this.initiator?.stop();
    if (this.explicitClose) { this.state = 'idle'; this.emitStatus(); return; }
    if (code > 0 && TERMINAL_CLOSE_CODES.has(code)) {
      this.terminalRetained = true;
      this.state = 'error';
      this.lastError = reason || `relay tunnel closed (terminal ${code})`;
      this.teardownStreams(`relay tunnel closed (terminal ${code}: ${this.lastError})`);
      this.rejectQueuedFetches(this.notConnectedError(this.state));
      this.emitStatus();
      return;
    }
    this.scheduleReconnect(reason || `relay tunnel closed (${code})`);
  }

  private teardownStreams(cause: string): void {
    for (const lane of [...this.lanes.values()]) {
      laneChannelReset(lane, cause);
      this.releaseFetchLane(lane.id);
    }
    channelDeathAllWs(this, this.wsStreams.values(), cause);
  }

  private scheduleReconnect(reason: string): void {
    this.teardownStreams(`relay tunnel reset: ${reason}`);
    this.rejectQueuedFetches(this.notConnectedError('reconnecting'));
    this.resetCycle();
    // §3.11: base × 2^attempt starting AT base (1 s ×2 attempts, cap 30 s;
    // 60 s offline/hidden) — the exponent counts COMPLETED cycles.
    const delay = this.reconnectDelay(this.attemptIndex);
    this.attemptIndex = Math.min(this.attemptIndex + 1, RECONNECT_MAX_ATTEMPTS);
    this.state = 'reconnecting';
    this.lastError = reason;
    this.emitStatus();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectNow();
    }, delay);
  }

  private reconnectDelay(failedCycles: number): number {
    const hooks = this.options.wakeHooks;
    const offlineOrHidden = hooks !== undefined && (!hooks.isOnline() || hooks.isHidden());
    const base = this.options.reconnectBaseDelayMs ?? RECONNECT_BASE_DELAY_MS;
    const ceiling = offlineOrHidden
      ? (this.options.hiddenOrOfflineMaxDelayMs ?? HIDDEN_OR_OFFLINE_MAX_DELAY_MS)
      : (this.options.reconnectMaxDelayMs ?? RECONNECT_MAX_DELAY_MS);
    const exponent = Math.min(failedCycles, RECONNECT_MAX_ATTEMPTS);
    return Math.min(ceiling, base * (2 ** exponent));
  }

  private rejectQueuedFetches(error: Error): void {
    for (const op of this.queuedFetches.splice(0)) op.reject(error);
  }

  // ---- §3.10 keepalive ------------------------------------------------------

  /** Any inbound frame refreshes the clock; the pong deadline (armed only
   * by this client's own Ping) clears on any inbound frame. */
  private refreshInboundClock(): void {
    this.lastInboundAt = Date.now();
    if (this.pingDeadline !== null) { clearTimeout(this.pingDeadline); this.pingDeadline = null; }
    this.armKeepaliveCheck(this.pingIntervalOptionMs);
  }

  private armKeepaliveCheck(delayMs: number): void {
    if (this.keepaliveTimer !== null) { clearTimeout(this.keepaliveTimer); this.keepaliveTimer = null; }
    this.keepaliveTimer = setTimeout(() => {
      this.keepaliveTimer = null;
      this.checkIdlePing();
    }, delayMs);
  }

  private checkIdlePing(): void {
    if (this.session === null || this.socket === null || this.explicitClose) return;
    if (this.pingDeadline !== null) return;
    const elapsed = Date.now() - this.lastInboundAt;
    if (elapsed < this.pingIntervalOptionMs) {
      this.armKeepaliveCheck(this.pingIntervalOptionMs - elapsed);
      return;
    }
    this.sendFrame(TunnelFrameType.Ping, STREAM_ZERO, new Uint8Array(0));
    this.pingDeadline = setTimeout(() => {
      this.pingDeadline = null;
      this.failChannel('relay tunnel ping timeout');
    }, this.pingTimeoutOptionMs);
  }

  // ---- core plumbing --------------------------------------------------------

  allocateStreamId(): number {
    const id = this.streamIdCounter;
    this.streamIdCounter += 2;
    return id;
  }

  registerFetchLane(lane: FetchLane): void { this.lanes.set(lane.id, lane); }

  releaseFetchLane(id: number): void { this.lanes.delete(id); }

  fetchLaneFor(id: number): FetchLane | null { return this.lanes.get(id) ?? null; }

  fetchLanes(): Iterable<FetchLane> { return this.lanes.values(); }

  registerWsLink(link: WsLink): void { this.wsStreams.set(link.id, link); }

  releaseWsLink(id: number): void { this.wsStreams.delete(id); }

  wsLinkFor(id: number): WsLink | null { return this.wsStreams.get(id) ?? null; }

  wsLinks(): Iterable<WsLink> { return this.wsStreams.values(); }

  channelDeath(cause: string): void { this.failChannel(cause); }

  statusNow(): RelayTunnelStatus {
    const status: RelayTunnelStatus = { state: this.state };
    if (this.lastError !== undefined) status.lastError = this.lastError;
    return status;
  }

  assertConnected(): void {
    if (this.state === 'connected' && this.session !== null) return;
    throw this.notConnectedError(this.state);
  }

  notConnectedError(state: RelayTunnelState): Error {
    const fallback = 'auth or capacity failure';
    if (this.terminalRetained) {
      return new Error(`relay tunnel is unavailable (terminal close): ${this.lastError ?? fallback}`);
    }
    return new Error(`relay tunnel is not connected (state ${state})`);
  }

  // ---- public surface -------------------------------------------------------

  async fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    if (this.state === 'connecting' && !this.explicitClose && !this.terminalRetained) {
      return await this.queueFetchDuringConnect(input, init);
    }
    if (this.state !== 'connected') throw this.notConnectedError(this.state);
    const signal = abortSignalOf(input, init);
    if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
    const attempt = startRelayFetch(this, normalizeRelayRequest(input, init), signal);
    return attempt.promise;
  }

  private queueFetchDuringConnect(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const signal = abortSignalOf(input, init);
    return queueFetchDuringConnect(this.queuedFetches, signal, () => {
      if (this.state !== 'connected' || this.session === null) throw this.notConnectedError(this.state);
      return startRelayFetch(this, normalizeRelayRequest(input, init), signal).promise;
    });
  }

  openWebSocket(url: string, protocols?: string | string[]): RelayTunnelWebSocket {
    return openTunnelWebSocket(this, url, protocols);
  }

  getStatus(): RelayTunnelStatus {
    return this.statusNow();
  }

  subscribeStatus(listener: (status: RelayTunnelStatus) => void): () => void {
    this.listeners.add(listener);
    listener({ state: this.state, ...(this.lastError !== undefined ? { lastError: this.lastError } : {}) });
    return () => { this.listeners.delete(listener); };
  }

  close(): void {
    if (this.explicitClose) return;
    this.explicitClose = true;
    this.wakeUnsubscribe?.();
    this.wakeUnsubscribe = null;
    this.clearTimers();
    if (this.reconnectTimer !== null) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.initiator?.stop();
    if (this.socket !== null) { try { this.socket.close(1000, 'client closed'); } catch { /* closing already */ } }
    this.socket = null;
    this.resetCycle();
    for (const lane of [...this.lanes.values()]) {
      laneChannelReset(lane, 'relay tunnel closed by client');
      this.releaseFetchLane(lane.id);
    }
    for (const link of [...this.wsStreams.values()]) (link.socket as { close: (code: number, reason: string) => void }).close(1000, 'client closed');
    this.rejectQueuedFetches(this.notConnectedError('idle'));
    this.ledger.dispose();
    this.outbound.dispose();
    this.state = 'idle';
    this.emitStatus();
  }

  private clearTimers(): void {
    if (this.pingDeadline !== null) { clearTimeout(this.pingDeadline); this.pingDeadline = null; }
    if (this.keepaliveTimer !== null) { clearTimeout(this.keepaliveTimer); this.keepaliveTimer = null; }
  }

  private emitStatus(): void {
    const status = this.statusNow();
    for (const listener of [...this.listeners]) {
      try { listener(status); } catch { /* listener failures never break the client */ }
    }
  }
}
