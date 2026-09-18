// SPDX-License-Identifier: Apache-2.0
/**
 * Relay host broker (doc 08 sections 3.3/3.11, host side): ONE outbound
 * wss control socket per host (ping 30 s, quiet window beyond interval +
 * 10 s grace terminates -> exponential reconnect 1s x2 cap 30s; a nonzero
 * close code becomes lastError) driving the data legs. Each connected
 * client triggers a host-data socket (open timeout 15 s) that runs the
 * E2EE handshake responder, then carries only encrypted frames: inbound
 * decrypts fail closed (1011 on any failure), outbound encrypts through a
 * serialized send chain so the counter hits the wire in order. Data legs
 * ride their own relay connections and SURVIVE a control blink (30 s
 * grace); the idle reaper closes any leg silent for 90 s (every inbound
 * frame refreshes it) so the connectedClients count stays honest. The
 * machine claim / demand lifecycle (§3.12) sits in the service slice —
 * the broker assumes it already holds the claim.
 */
import { WebSocket } from 'ws';
import { RelayIdentityStore, type RelayIdentity, type RelayJwk } from './identity.ts';
import { encryptFrame, decryptFrame, MAX_PLAINTEXT_FRAME_BYTES, type OpenedSession } from './crypto.ts';
import { createHostResponder, type CapabilityOptions, type HostEstablished, type HostResponder } from './handshake.ts';

export const RELAY_CLOSE = {
  IdleTimeout: 1001,
  HostWentAway: 1012,
  RekeyMismatch: 1008,
  ChannelFailure: 1011,
  ControlReplaced: 4001,
  DuplicateClient: 4002,
  StuckControlReset: 4003,
  HostUnavailable: 4008,
  AuthFailed: 4010,
  LimitExceeded: 4029,
} as const;

export const DEFAULT_HOST_BROKER_TIMING = {
  controlPingMs: 30_000,
  controlPongGraceMs: 10_000,
  dataOpenTimeoutMs: 15_000,
  dataIdleMs: 90_000,
  dataSweepMs: 30_000,
  reconnectBaseMs: 1000,
  reconnectCapMs: 30_000,
};

export type HostBrokerState = 'disabled' | 'connecting' | 'connected' | 'reconnecting';

export type RelayHostTiming = typeof DEFAULT_HOST_BROKER_TIMING;

export interface RelayLegEvent {
  (connectionId: string, payload: Uint8Array): void;
}

export interface RelayHostBrokerOptions {
  identity: RelayIdentityStore;
  capabilities?: Partial<CapabilityOptions>;
  timing?: Partial<RelayHostTiming>;
  onLegFrame?: RelayLegEvent;
  onLegEstablished?: (connectionId: string) => void;
  onLegClosed?: (connectionId: string, code: number, reason: string) => void;
}

export interface RelayHostStatus {
  state: HostBrokerState;
  serverId: string | null;
  connectedClients: number;
  relayUrl: string | null;
  lastError: string | null;
}

interface ControlMessage {
  type?: unknown;
  connectionId?: unknown;
  connectionIds?: unknown;
}

interface DataLeg {
  connectionId: string;
  ws: WebSocket;
  responder: HostResponder;
  established: boolean;
  session?: OpenedSession;
  openTimer: NodeJS.Timeout | null;
  lastActivityAt: number;
  sendChain: Promise<void>; // outbound counter discipline (§3.4)
  receiveChain: Promise<void>; // inbound counter-discipline chain (host `processing`)
}

export class RelayHostBroker {
  private readonly identity: RelayIdentityStore;
  private readonly timing: RelayHostTiming;
  private readonly caps: CapabilityOptions;
  private readonly onLegFrame?: RelayLegEvent;
  private readonly onLegEstablished?: (connectionId: string) => void;
  private readonly onLegClosed?: (connectionId: string, code: number, reason: string) => void;

  private state: HostBrokerState = 'disabled';
  private serverId: string | null = null;
  private relayUrl: string | null = null;
  private meta: { appVersion?: string; platform?: string } = {};
  private controlWs: WebSocket | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;
  private lastControlInbound = 0;
  private attempts = 0;
  private lastError: string | null = null;
  private cachedIdentity: RelayIdentity | null = null;
  private readonly legs = new Map<string, DataLeg>();

  constructor(options: RelayHostBrokerOptions) {
    this.identity = options.identity;
    this.timing = { ...DEFAULT_HOST_BROKER_TIMING, ...options.timing };
    this.caps = { batch: true, flowControl: true, ...options.capabilities };
    this.onLegFrame = options.onLegFrame;
    this.onLegEstablished = options.onLegEstablished;
    this.onLegClosed = options.onLegClosed;
  }

  getStatus(): RelayHostStatus {
    return {
      state: this.state,
      serverId: this.serverId,
      connectedClients: this.legs.size,
      relayUrl: this.relayUrl,
      lastError: this.lastError,
    };
  }

  async start(input: { relayUrl: string; appVersion?: string; platform?: string }): Promise<void> {
    if (this.state !== 'disabled') this.stop();
    this.relayUrl = input.relayUrl;
    this.meta = { appVersion: input.appVersion, platform: input.platform };
    this.cachedIdentity = await this.identity.resolve();
    this.serverId = await this.identity.serverId();
    this.state = 'connecting';
    this.connectControl();
    this.sweepTimer = setInterval(() => this.sweepLegs(), this.timing.dataSweepMs);
    scheduleUnref(this.sweepTimer);
  }

  stop(): void {
    this.state = 'disabled';
    this.relayUrl = null;
    clearTimer(this.reconnectTimer);
    clearTimer(this.pingTimer);
    clearTimer(this.sweepTimer);
    const socket = this.controlWs;
    this.controlWs = null;
    if (socket !== null && socket.readyState <= WebSocket.OPEN) socket.close(1000, 'host stopping');
    for (const leg of [...this.legs.values()]) this.closeLeg(leg.connectionId, 1000, 'host stopping');
  }

  /** §3.8/§3.9 outbound: one encrypt == one counter tick; frames
   * serialize through the leg's send chain. */
  sendToClient(connectionId: string, plaintext: Uint8Array): Promise<void> {
    const leg = this.legs.get(connectionId);
    if (leg === undefined || !leg.established || leg.session === undefined) {
      return Promise.reject(new Error(`no established relay leg for ${connectionId}`));
    }
    if (plaintext.length > MAX_PLAINTEXT_FRAME_BYTES) {
      return Promise.reject(new Error(`relay frame plaintext exceeds ${MAX_PLAINTEXT_FRAME_BYTES} bytes`));
    }
    leg.sendChain = leg.sendChain.then(() => this.encodeAndSend(leg, plaintext)).catch(() => undefined);
    return leg.sendChain;
  }

  private async encodeAndSend(leg: DataLeg, plaintext: Uint8Array): Promise<void> {
    const frame = await encryptFrame((leg.session as OpenedSession).hostToClient, plaintext);
    if (leg.ws.readyState === WebSocket.OPEN) leg.ws.send(frame);
  }

  private connectControl(): void {
    const relayUrl = this.relayUrl;
    if (relayUrl === null) return;
    const stamp = Date.now();
    void this.identity.relaySocketUrl(relayUrl, 'host-control', stamp, {
      appVersion: this.meta.appVersion,
      platform: this.meta.platform,
    }).then((url) => {
      const ws = new WebSocket(url);
      this.controlWs = ws;
      ws.on('open', () => {
        if (this.controlWs !== ws || this.state === 'disabled') return; // a superseded dial must not steer the machine
        this.state = 'connected';
        this.attempts = 0;
        this.lastError = null;
        this.lastControlInbound = Date.now();
        clearTimer(this.pingTimer);
        this.pingTimer = null;
        this.pingTimer = setInterval(() => {
          if (ws.readyState !== WebSocket.OPEN) return;
          ws.ping();
          if (Date.now() - this.lastControlInbound > this.timing.controlPingMs + this.timing.controlPongGraceMs) {
            ws.terminate(); // quiet beyond interval + grace -> reconnect path
          }
        }, this.timing.controlPingMs);
        scheduleUnref(this.pingTimer as NodeJS.Timeout);
      });
      ws.on('pong', () => {
        this.lastControlInbound = Date.now();
      });
      ws.on('error', (error) => {
        // transport failure (refused dial, reset): the close event owns the
        // reconnect decision; this listener only keeps the error label fresh
        if (this.controlWs !== ws || this.state === 'disabled') return;
        this.lastError = `control error: ${error instanceof Error ? error.message : String(error)}`;
      });
      ws.on('message', (data, isBinary) => {
        this.lastControlInbound = Date.now();
        if (isBinary) return;
        this.handleControlMessage(data as Buffer);
      });
      ws.on('close', (code) => {
        if (this.controlWs !== ws) return; // a superseded dial owns its own lifecycle
        this.controlWs = null;
        clearTimer(this.pingTimer);
        this.pingTimer = null;
        if (this.state === 'disabled') return;
        if (code !== 0) this.lastError = `control closed (${code})`;
        this.state = 'reconnecting';
        this.scheduleReconnect();
      });
    }).catch((error) => {
      this.lastError = `control connect failed: ${error instanceof Error ? error.message : String(error)}`;
      this.state = 'reconnecting';
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null || this.state === 'disabled') return;
    this.attempts += 1;
    const delay = this.timing.reconnectBaseMs * Math.pow(2, this.attempts - 1);
    const capped = Math.min(this.timing.reconnectCapMs, delay);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.state === 'disabled') return;
      this.connectControl();
    }, capped);
    scheduleUnref(this.reconnectTimer);
  }

  /** §3.3 control messages (host <- worker, JSON text). */
  private handleControlMessage(data: Buffer): void {
    let message: ControlMessage;
    try {
      message = JSON.parse(data.toString('utf8')) as ControlMessage;
    } catch {
      return; // control noise is ignored, not fatal
    }
    if (message.type === 'connected' && typeof message.connectionId === 'string') {
      this.openDataLeg(message.connectionId);
      return;
    }
    if (message.type === 'disconnected' && typeof message.connectionId === 'string') {
      this.closeLeg(message.connectionId, 1000, 'control disconnected');
      return;
    }
    if (message.type === 'sync' && Array.isArray(message.connectionIds)) {
      const ids = message.connectionIds.filter((id): id is string => typeof id === 'string');
      for (const leg of [...this.legs.values()]) {
        if (!ids.includes(leg.connectionId)) this.closeLeg(leg.connectionId, 1000, 'sync drop');
      }
      for (const id of ids) this.openDataLeg(id);
    }
  }

  private openDataLeg(connectionId: string): void {
    if (this.legs.has(connectionId)) return; // skip if one exists (doc)
    const relayUrl = this.relayUrl;
    if (relayUrl === null) return;
    const stamp = Date.now();
    void this.identity.relaySocketUrl(relayUrl, 'host-data', stamp, {
      connectionId,
      appVersion: this.meta.appVersion,
      platform: this.meta.platform,
    }).then((url) => this.openDataSocket(connectionId, url)).catch(() => {
      this.onLegClosed?.(connectionId, RELAY_CLOSE.HostUnavailable, 'host-data connect failed');
    });
  }

  private openDataSocket(connectionId: string, url: string): void {
    const ws = new WebSocket(url);
    const leg: DataLeg = {
      connectionId,
      ws,
      responder: null as unknown as HostResponder,
      established: false,
      openTimer: null,
      lastActivityAt: Date.now(),
      sendChain: Promise.resolve(),
      receiveChain: Promise.resolve(),
    };
    const finish = (code: number, reason: string): void => {
      if (this.legs.get(connectionId) !== leg) return; // exactly one close decision per leg
      this.legs.delete(connectionId);
      clearTimer(leg.openTimer);
      if (ws.readyState <= WebSocket.OPEN) ws.close(code, reason);
      this.onLegClosed?.(connectionId, code, reason);
    };
    const responder = createHostResponder({
      hostEncPrivateJwk: this.hostEncPrivateJwk,
      capabilities: this.caps,
      sendText: (text) => ws.send(text, { binary: false }), // handshake JSON travels as TEXT frames
      onClose: finish,
      onEstablished: (establishedSession: HostEstablished) => {
        leg.established = true;
        leg.session = establishedSession.session;
        this.onLegEstablished?.(connectionId);
      },
    });
    leg.responder = responder;
    leg.openTimer = setTimeout(() => {
      ws.terminate(); // §3.11: open timeout 15 s teardown on miss
      finish(RELAY_CLOSE.HostWentAway, 'relay data socket open timeout');
    }, this.timing.dataOpenTimeoutMs);
    scheduleUnref(leg.openTimer);
    ws.on('open', () => {
      clearTimer(leg.openTimer); // the socket opened: the open-timeout fires no more
      leg.openTimer = null;
    });
    ws.on('error', () => undefined); // transport abort: the close event owns the leg bookkeeping
    this.legs.set(connectionId, leg);
    ws.on('message', (data, isBinary) => this.routeLegFrame(leg, data, isBinary));
    ws.on('close', (code) => {
      clearTimer(leg.openTimer);
      if (this.legs.get(connectionId) === leg) {
        this.legs.delete(connectionId);
        this.onLegClosed?.(connectionId, code, 'leg closed');
      }
    });
  }

  /** §3.4 frame routing per leg: established binaries decrypt; established
   * TEXT is legal handshake traffic only (identical-hello retry re-answer,
   * rekey attempt -> 1008, stray plaintext -> 1011) — the responder decides,
   * never the broker directly; pre-established frames belong to the
   * responder handshake. */
  private routeLegFrame(leg: DataLeg, data: unknown, isBinary: boolean): void {
    leg.lastActivityAt = Date.now(); // ANY inbound frame refreshes the idle clock
    const responder = leg.responder;
    if (responder.established) {
      if (isBinary) {
        this.enqueueDecrypt(leg, data as Buffer);
        return;
      }
      void responder.onText(data as Buffer).catch(() => undefined);
      return;
    }
    if (isBinary) {
      responder.onBinary();
      return;
    }
    void responder.onText(data as Buffer);
  }

  private enqueueDecrypt(leg: DataLeg, frame: Buffer): void {
    leg.receiveChain = leg.receiveChain.then(async () => {
      if (leg.session === undefined) return;
      const payload = await decryptFrame(leg.session.clientToHost, frame);
      leg.lastActivityAt = Date.now();
      this.onLegFrame?.(leg.connectionId, payload);
    }).catch(() => {
      this.closeLeg(leg.connectionId, RELAY_CLOSE.ChannelFailure, 'decryption failed');
    });
  }

  /** §3.11 idle reaper: 90 s of INBOUND silence closes the leg (attached
   * capacity freed; the connectedClients count stays honest). */
  private sweepLegs(): void {
    const stamp = Date.now();
    for (const leg of [...this.legs.values()]) {
      if (stamp - leg.lastActivityAt > this.timing.dataIdleMs) {
        this.closeLeg(leg.connectionId, RELAY_CLOSE.IdleTimeout, 'client idle timeout');
      }
    }
  }

  private closeLeg(connectionId: string, code: number, reason: string): void {
    const leg = this.legs.get(connectionId);
    if (leg === undefined) return;
    this.legs.delete(connectionId);
    clearTimer(leg.openTimer);
    if (leg.ws.readyState <= WebSocket.OPEN) leg.ws.close(code, reason);
    this.onLegClosed?.(connectionId, code, reason);
  }

  private get hostEncPrivateJwk(): RelayJwk {
    const identity = this.cachedIdentity;
    if (identity === null) throw new Error('relay identity not resolved');
    return identity.encryption.privateJwk;
  }
}

function scheduleUnref(timer: NodeJS.Timeout): void {
  timer.unref?.();
}

function clearTimer(timer: NodeJS.Timeout | null): void {
  if (timer === null) return;
  clearTimeout(timer);
}
