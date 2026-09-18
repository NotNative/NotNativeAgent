// SPDX-License-Identifier: Apache-2.0
/**
 * TerminalTransport (doc 07 section 6.1): one socket per runtime, per-
 * session projections for instant re-subscribe replays, q-dedupe per
 * subscriber, write-once-then-reconnect-once, reconnect matrix per 3.6
 * (500*2^(n-1) cap 8 s; 60 s hidden/offline slow path w/ instant wake; 10 s
 * connect timeout; 45 s app ping; 15 s idle socket hold; pre-open failure
 * invalidates the URL token -> onTokenExpired slot, E-07-3 registered).
 */
import {
  CLIENT_APP_PING_MS, CONNECT_TIMEOUT_MS, IDLE_SOCKET_HOLD_MS, MAX_INPUT_CHARS,
  MAX_PROJECTION_BYTES, RECONNECT_BASE_MS, RECONNECT_CAP_MS, SLOW_PATH_MS, TERMINAL_WS_PATH,
  decodeTerminalFrameAsync, encodeTerminalFrame, trimHead,
  type TerminalEventFrame, type TerminalProjection, type TerminalStreamEvent, type WireSocket, type WebSocketFactory,
} from './wire.ts';

export interface TerminalHandlers {
  onEvent(frame: TerminalEventFrame, sessionId: string): void;
}

interface Subscription {
  sessionId: string;
  handlers: TerminalHandlers;
  lastQ: number;
}

interface Timeouts {
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const defaultTimeouts: Timeouts = {
  setTimeout: (handler, ms) => globalThis.setTimeout(handler, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
};

export class TerminalTransport {
  private socket: WireSocket | null = null;
  private connecting = false;
  private socketReady = false; // attach/write send only from an OPEN socket; a CONNECTING socket cannot carry frames
  private connectTimer: unknown = null;
  private pingTimer: unknown = null;
  private idleHoldTimer: unknown = null;
  private reconnectAttempt = 0;
  private reconnectTimer: unknown = null;
  private closedIntentionally = false;
  private readonly subscriptions = new Set<Subscription>();
  private readonly projections = new Map<string, TerminalProjection>();

  constructor(
    private readonly socketFactory: WebSocketFactory,
    private readonly resolveUrl: () => string = () => `${typeof window !== 'undefined' ? window.location.origin.replace(/^http/u, 'ws') : 'ws://127.0.0.1'}${TERMINAL_WS_PATH}`,
    private readonly timeouts: Timeouts = defaultTimeouts,
    private readonly onTokenExpired: (() => void) | null = null,
  ) {
  }


  /** One transport per runtime; reconnect policy per doc 07 section 3.6. */
  private slowPath(): boolean {
    return (typeof document !== 'undefined' && document.hidden) || (typeof navigator !== 'undefined' && navigator.onLine === false);
  }


  subscribe(sessionId: string, handlers: TerminalHandlers): () => void {
    if (this.idleHoldTimer !== null) { this.timeouts.clearTimeout(this.idleHoldTimer); this.idleHoldTimer = null; }
    const projection = this.projections.get(sessionId);
    const subscription: Subscription = { sessionId, handlers, lastQ: projection?.q ?? 0 };
    const others = this.countSubscribers(sessionId);
    this.subscriptions.add(subscription);
    if (others === 0) {
      this.projections.set(sessionId, { sessionId, q: projection?.q ?? 0, history: projection?.history ?? '', cols: projection?.cols ?? 80, rows: projection?.rows ?? 24, status: projection?.status ?? 'running' });
    }
    if (this.socketReady) this.sendRawClient({ v: 3, t: 'attach', s: sessionId }); // attach per subscriber; idempotent per socket (section 3.3); a pending dial defers it to onopen
    this.ensureSocket(); // live events need the socket in BOTH branches
    if (others > 0 && projection !== undefined && projection.q > 0) handlers.onEvent(this.snapshotFrame(projection), sessionId); // section 6.1: server-fed projection replays instantly; a blank init projection waits for the server
    return () => {
      if (!this.subscriptions.delete(subscription)) return; // idempotent: a second cleanup call must not re-detach
      if (this.countSubscribers(sessionId) === 0) {
        this.projections.delete(sessionId); // projection dropped with the last subscriber (section 6.1)
        this.sendRawClient({ v: 3, t: 'detach', s: sessionId });
      }
      if (this.subscriptions.size === 0) {
        this.scheduleIdleHold(); // healthy socket held 15 s for tab switches
      }
    };
  }

  private countSubscribers(sessionId: string): number {
    let count = 0;
    for (const subscription of this.subscriptions) if (subscription.sessionId === sessionId) count += 1;
    return count;
  }

  write(sessionId: string, data: string): void {
    if (data.length < 1 || data.length > MAX_INPUT_CHARS) throw new RangeError('terminal input out of range');
    this.ensureSocket();
    const sent = this.sendRawClient({ v: 3, t: 'write', s: sessionId, d: data });
    if (!sent) throw new Error('send failed'); // second failure after the reconnect-once throws (section 6.1)
  }

  noteResize(sessionId: string, cols: number, rows: number): void {
    const projection = this.projections.get(sessionId);
    if (projection !== undefined) {
      projection.cols = cols;
      projection.rows = rows; // server-accepted size rides later replays (section 6.1)
    }
  }

  dispose(): void {
    this.closedIntentionally = true;
    for (const handle of [this.pingTimer, this.connectTimer, this.reconnectTimer, this.idleHoldTimer]) {
      if (handle !== null && handle !== undefined) this.timeouts.clearTimeout(handle);
    }
    this.pingTimer = this.connectTimer = this.reconnectTimer = this.idleHoldTimer = null;
    this.socket?.close();
    this.socket = null;
    this.subscriptions.clear();
    this.projections.clear();
  }

  projectionFor(sessionId: string): TerminalProjection | null {
    return this.projections.get(sessionId) ?? null; // test surface
  }

  private ensureSocket(): void {
    if (this.socket !== null || this.connecting || this.reconnectTimer !== null) return;
    this.dial();
  }

  private dial(): void {
    this.connecting = true;
    this.socketReady = false;
    let socket: WireSocket;
    try {
      socket = this.socketFactory(this.resolveUrl());
    } catch {
      this.connecting = false;
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    let opened = false;
    this.connectTimer = this.timeouts.setTimeout(() => {
      if (!opened) socket.close(); // 10 s dial timeout -> reconnect (section 3.6)
    }, CONNECT_TIMEOUT_MS);
    socket.onopen = () => {
      opened = true;
      this.connecting = false;
      this.socketReady = true;
      if (this.connectTimer !== null) { this.timeouts.clearTimeout(this.connectTimer); this.connectTimer = null; }
      this.reconnectAttempt = 0;
      this.startPingLoop(socket);
      for (const sessionId of this.attachedSessionIds()) this.sendRawClient({ v: 3, t: 'attach', s: sessionId });
      this.deliverToAll(this.reconnectingFrame(0));
    };
    socket.onclose = (event) => {
      opened = this.teardownSocket(socket, event.code, opened);
    };
    socket.onerror = () => {
      // close follows error per WS; nothing extra here (pre-open close invalidates the token, section 3.6)
    };
    socket.onmessage = (event) => { void this.ingest(event.data); };
  }

  private teardownSocket(socket: WireSocket, code: number | undefined, opened: boolean): boolean {
    this.connecting = false;
    this.socketReady = false;
    if (this.connectTimer !== null) { this.timeouts.clearTimeout(this.connectTimer); this.connectTimer = null; }
    this.stopPingLoop();
    if (this.socket === socket) this.socket = null;
    if (this.closedIntentionally) return opened;
    if (!opened && this.onTokenExpired !== null) this.onTokenExpired(); // stale URL-token 401s burn to the cap otherwise
    this.scheduleReconnect();
    return opened;
  }

  private scheduleIdleHold(): void {
    if (this.socket === null) return;
    this.idleHoldTimer = this.timeouts.setTimeout(() => {
      if (this.subscriptions.size > 0) return;
      this.socket?.close();
      this.socket = null;
    }, IDLE_SOCKET_HOLD_MS);
  }

  private scheduleReconnect(): void {
    if (this.closedIntentionally || this.reconnectTimer !== null) return;
    const attempt = this.reconnectAttempt + 1;
    this.reconnectAttempt = attempt;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** (attempt - 1), RECONNECT_CAP_MS); // 500*2^(n-1) cap 8 s (section 3.6)
    const target = this.slowPath() ? SLOW_PATH_MS : delay;
    this.reconnectTimer = this.timeouts.setTimeout(() => {
      this.reconnectTimer = null;
      if (this.subscriptions.size === 0) {
        this.reconnectAttempt = 0; // nobody is waiting; the next subscribe negotiates a fresh backoff
        return;
      }
      this.deliverToAll(this.reconnectingFrame(attempt));
      this.dial();
    }, target);
  }


  private startPingLoop(socket: WireSocket): void {
    this.pingTimer = this.timeouts.setTimeout(() => {
      if (this.socket === socket && this.subscriptions.size > 0) this.sendRawClient({ v: 3, t: 'ping' });
      this.startPingLoop(socket); // 45 s app-level keepalive while healthy
    }, CLIENT_APP_PING_MS);
  }

  private stopPingLoop(): void {
    if (this.pingTimer !== null) { this.timeouts.clearTimeout(this.pingTimer); this.pingTimer = null; }
  }

  private attachedSessionIds(): string[] {
    const ids = new Set<string>();
    for (const subscription of this.subscriptions) ids.add(subscription.sessionId);
    return [...ids];
  }

  private async ingest(data: unknown): Promise<void> {
    const frame = await decodeTerminalFrameAsync(data);
    if (frame === null) return; // text frames / wrong tags are ignored client-side (section 3.1)
    switch (frame.t) {
      case 'snapshot': {
        const projection = projectionFrom(frame);
        this.projections.set(frame.s, projection);
        for (const subscription of this.bySession(frame.s)) {
          subscription.lastQ = frame.q;
          subscription.handlers.onEvent(frame, frame.s);
        }
        return;
      }
      case 'output':
      case 'exit':
      case 'restarted': {
        if (dedupe(this.projections, frame)) return;
        for (const subscription of this.bySession(frame.s)) {
          if (frame.q <= subscription.lastQ) continue; // q-dedupe even on double attach (section 3.4)
          subscription.lastQ = frame.q;
          subscription.handlers.onEvent(frame, frame.s);
        }
        return;
      }
      default: {
        for (const subscription of this.bySession('s' in frame && typeof frame.s === 'string' ? frame.s : '*')) {
          subscription.handlers.onEvent(frame, 's' in frame && typeof frame.s === 'string' ? frame.s : '');
        }
      }
    }
  }

  private bySession(sessionId: string): Subscription[] {
    return [...this.subscriptions].filter((subscription) => subscription.sessionId === sessionId || sessionId === '*');
  }

  private deliverToAll(frame: TerminalEventFrame): void {
    for (const subscription of this.subscriptions) subscription.handlers.onEvent(frame, subscription.sessionId);
  }

  private sendRawClient(frame: unknown): boolean {
    const socket = this.socket;
    if (socket === null) return false;
    try {
      socket.send(encodeTerminalFrame(frame));
      return true;
    } catch {
      socket.close();
      if (this.socket === socket) this.socket = null;
      this.scheduleReconnect();
      return false;
    }
  }

  private snapshotFrame(projection: TerminalProjection): TerminalEventFrame {
    return { v: 3, t: 'snapshot', s: projection.sessionId, q: projection.q, history: projection.history, cols: projection.cols, rows: projection.rows, status: projection.status, exitCode: projection.exitCode, signal: projection.signal, mode: projection.mode, purpose: projection.purpose };
  }

  private reconnectingFrame(attempt: number): TerminalEventFrame {
    return { v: 3, t: 'reconnecting', s: '', attempt } as TerminalEventFrame;
  }
}

function projectionFrom(frame: Extract<TerminalEventFrame, { t: 'snapshot' }>): TerminalProjection {
  return {
    sessionId: frame.s,
    q: frame.q,
    history: trimHead(frame.history, MAX_PROJECTION_BYTES),
    cols: frame.cols,
    rows: frame.rows,
    status: frame.status,
    exitCode: frame.exitCode,
    signal: frame.signal,
    mode: frame.mode,
    purpose: frame.purpose,
  };
}

function dedupe(projections: Map<string, TerminalProjection>, frame: TerminalStreamEvent): boolean {
  if (frame.q <= 0) return false;
  const projection = projections.get(frame.s);
  if (projection === undefined) {
    projections.set(frame.s, {
      sessionId: frame.s, q: frame.q, history: frame.t === 'restarted' ? '' : '', cols: 80, rows: 24, status: frame.t === 'exit' ? 'exited' : 'running',
    });
    return false;
  }
  if (frame.q <= projection.q && frame.t !== 'restarted') return true; // stale event for an unknown replay base: dropped
  projection.q = frame.q;
  if (frame.t === 'restarted') {
    projection.history = '';
    return false;
  }
  if (frame.t === 'exit') {
    projection.status = 'exited';
    projection.exitCode = frame.exitCode;
    projection.signal = frame.signal;
    return false;
  }
  const replayText = frame.r ?? frame.d;
  projection.history = trimHead(projection.history + replayText, MAX_PROJECTION_BYTES);
  return false;
}
