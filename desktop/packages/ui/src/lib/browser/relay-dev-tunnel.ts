// SPDX-License-Identifier: Apache-2.0
/**
 * Renderer side of the relay dev tunnel (doc 13 §H.3). The trusted renderer
 * refreshes its own runtime URL token, opens the host /api/dev-tunnel socket
 * through the active E2EE relay, and then bridges bytes to the main-process
 * MessagePort. The 15-second budget covers the whole readiness exchange.
 */
import { getApiBaseUrl } from '../runtime-url.ts';
import {
  clearCachedUrlAuthToken, getCurrentUrlToken, refreshRuntimeUrlAuthToken,
} from '../runtime-auth.ts';

const DEFAULT_READINESS_TIMEOUT_MS = 15_000;
const CONNECT_CHANNEL = 'openchamber:relay-dev-tunnel-connect';

export interface RelayDevTunnelPort {
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  postMessage(message: unknown): void;
  start?: () => void;
  close?: () => void;
}

export interface RelayVirtualWebSocket {
  readonly readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
}

export interface RelayDevTunnelConnectInput {
  connectionId: string;
  remotePort: number;
  bridgePort: RelayDevTunnelPort;
  relayTunnel: { openWebSocket(url: string): RelayVirtualWebSocket };
  apiBaseUrl?: string;
  readinessTimeoutMs?: number;
  refreshRuntimeUrlAuthToken?: (apiBaseUrl?: string) => Promise<void>;
  getCurrentUrlToken?: () => string | null;
  clearCachedUrlAuthToken?: () => void;
}

export function installRelayDevTunnelListener(options: {
  webContents: {
    onConnect: (listener: (event: { data?: unknown; ports?: unknown[] }) => void) => () => void;
    dispatchEvent: (type: string, data?: unknown) => void;
  };
}): () => void {
  return options.webContents.onConnect((event) => {
    const message = event.data as { type?: unknown } | null;
    if (message?.type !== 'connect') return;
    const port = event.ports?.[0];
    if (port) options.webContents.dispatchEvent('relay-dev-tunnel-connect', { ...message, port });
  });
}

function bytesFor(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (data instanceof Uint8Array) return data;
  if (typeof data === 'string') return new TextEncoder().encode(data);
  return null;
}

interface RelayBridgeState {
  timer: ReturnType<typeof setTimeout> | null;
  done: boolean;
}

interface RelayBridgeContext {
  connectionId: string;
  connectPort: RelayDevTunnelPort;
  virtual: RelayVirtualWebSocket;
  preOpen: Uint8Array[];
  state: RelayBridgeState;
  reject: (error: Error) => void;
  tokenFor: () => string | null;
  clearToken: () => void;
  finish: () => void;
}

function finishRelayTransport(connectPort: RelayDevTunnelPort, virtual: RelayVirtualWebSocket, state: { timer: ReturnType<typeof setTimeout> | null; done: boolean }): void {
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
  if (state.done) return;
  state.done = true;
  try { connectPort.close?.(); } catch { /* already closed */ }
  try { if (virtual.readyState !== 3) virtual.close(1000, 'relay dev tunnel closed'); } catch { /* transport owns close */ }
}

function startRelayReadinessTimer(context: {
  timeoutMs: number;
  clearToken: () => void;
  reject: (error: Error) => void;
  finish: () => void;
  state: { timer: ReturnType<typeof setTimeout> | null; done: boolean };
}): void {
  const timer = setTimeout(() => {
    context.clearToken();
    context.finish();
    context.reject(new Error('Relay dev tunnel was not ready in time.'));
  }, context.timeoutMs);
  if (typeof (timer as unknown as { unref?: () => void }).unref === 'function') timer.unref?.();
  context.state.timer = timer;
}

function signalRelayOpen(context: RelayBridgeContext): void {
  const token = context.tokenFor();
  if (!token) {
    context.clearToken();
    context.finish();
    context.reject(new Error('Missing runtime URL token for the relay dev tunnel.'));
    return;
  }
  try { context.connectPort.postMessage({ type: 'ready', connectionId: context.connectionId }); }
  catch { context.finish(); return; }
  if (context.state.timer) clearTimeout(context.state.timer);
  context.state.timer = null;
  for (const bytes of context.preOpen) {
    try { context.virtual.send(bytes); } catch { context.finish(); return; }
  }
  context.preOpen.length = 0;
}

function connectRelayBridgePort(context: RelayBridgeContext): void {
  const { connectPort, virtual, state, finish } = context;
  connectPort.onmessage = (event) => {
    const message = event.data as { type?: string; data?: unknown } | null;
    if (message?.type === 'close') {
      finish();
      return;
    }
    if (message?.type === 'data') {
      const bytes = bytesFor(message.data);
      if (bytes) {
        try { virtual.send(bytes); }
        catch { finish(); }
      }
    }
  };
  connectPort.onclose = finish;
  connectPort.start?.();
  virtual.onopen = () => signalRelayOpen(context);
  if (state.done) signalRelayOpen(context);
}

function connectRelayVirtualSocket(context: RelayBridgeContext): void {
  const { connectPort, virtual, finish } = context;
  virtual.onmessage = (event) => {
    const bytes = bytesFor(event.data);
    if (bytes) connectPort.postMessage({ type: 'data', connectionId: context.connectionId, data: bytes });
  };
  virtual.onerror = () => {
    context.clearToken();
    finish();
  };
  virtual.onclose = finish;
}

export async function connectRelayDevTunnel(input: RelayDevTunnelConnectInput): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    void bridgeRelayDevTunnel(input, reject).then(resolve, reject);
  });
}

async function openRelayWebSocket(input: RelayDevTunnelConnectInput, endpointBase: string): Promise<RelayVirtualWebSocket> {
  const requested = new URL(`${endpointBase}/api/dev-tunnel`);
  requested.searchParams.set('port', String(input.remotePort));
  const authorizedUrl = await import('../runtime-auth.ts').then((module) => module.appendAuthTokenToUrl(requested.href));
  try { return input.relayTunnel.openWebSocket(authorizedUrl); }
  catch (error) { throw error instanceof Error ? error : new Error('Relay dev tunnel is unavailable.'); }
}

async function bridgeRelayDevTunnel(input: RelayDevTunnelConnectInput, reject: (error: Error) => void): Promise<void> {
  const endpointBase = input.apiBaseUrl ?? getApiBaseUrl();
  const refresh = input.refreshRuntimeUrlAuthToken ?? refreshRuntimeUrlAuthToken;
  const tokenFor = input.getCurrentUrlToken ?? getCurrentUrlToken;
  const clearToken = input.clearCachedUrlAuthToken ?? clearCachedUrlAuthToken;
  const timeoutMs = input.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
  await refresh(endpointBase);
  const connectPort = input.bridgePort;
  const virtual = await openRelayWebSocket(input, endpointBase);
  const state: RelayBridgeState = { timer: null, done: false };
  const preOpen: Uint8Array[] = [];
  const finish = () => finishRelayTransport(connectPort, virtual, state);
  const context: RelayBridgeContext = {
    connectionId: input.connectionId, connectPort, virtual, preOpen, state, reject,
    tokenFor, clearToken, finish,
  };
  startRelayReadinessTimer({ timeoutMs, clearToken, reject, finish, state });
  connectRelayBridgePort(context);
  connectRelayVirtualSocket(context);
}
