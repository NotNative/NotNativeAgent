// SPDX-License-Identifier: Apache-2.0
/**
 * Renderer side of the relay dev tunnel (doc 13 §H.3). The trusted renderer
 * refreshes its own runtime URL token, opens the host /api/dev-tunnel socket
 * through the active E2EE relay, and then bridges bytes to the main-process
 * MessagePort. The 15-second budget covers the whole readiness exchange.
 */
import { getApiBaseUrl } from '../runtime-url.ts';
import { getActiveRelayTunnel } from '../runtime-tunnel.ts';
import { setDesktopTunnelBridge } from './dev-tunnel.ts';
import {
  clearCachedUrlAuthToken, getCurrentUrlToken, refreshRuntimeUrlAuthToken,
} from '../runtime-auth.ts';

const DEFAULT_READINESS_TIMEOUT_MS = 15_000;
const CONNECT_CHANNEL = 'notnative:relay-dev-tunnel';

export interface RelayDevTunnelPort {
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose?: (() => void) | null;
  addEventListener?: (type: 'close', listener: () => void) => void;
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
  target?: Pick<Window, 'addEventListener' | 'removeEventListener' | 'location'>;
  onConnect: (connection: { connectionId: string; remotePort: number; bridgePort: RelayDevTunnelPort }) => void;
}): () => void {
  const target = options.target ?? window;
  const listener = (event: MessageEvent): void => {
    if (event.source !== target || event.origin !== target.location.origin) return;
    const envelope = event.data as { channel?: unknown; payload?: Record<string, unknown> } | null;
    const payload = envelope?.payload;
    const port = event.ports?.[0];
    if (envelope?.channel !== CONNECT_CHANNEL || payload?.type !== 'connect'
      || typeof payload.connectionId !== 'string' || payload.connectionId.length === 0 || payload.connectionId.length > 128
      || !Number.isInteger(payload.remotePort) || (payload.remotePort as number) < 1 || (payload.remotePort as number) > 65535
      || !port) return;
    options.onConnect({ connectionId: payload.connectionId, remotePort: payload.remotePort as number,
      bridgePort: port as unknown as RelayDevTunnelPort });
  };
  target.addEventListener('message', listener);
  return () => target.removeEventListener('message', listener);
}

/** Install the Electron relay tunnel bridge once before UI consumers can open previews. */
export function installDesktopRelayDevTunnel(): () => void {
  const api = window.__NOTNATIVE_RELAY_DEV_TUNNEL__;
  if (!api) return () => {};
  setDesktopTunnelBridge({
    async open({ baseUrl, port }) {
      const targetKey = new URL(baseUrl).origin;
      const reply = await api.open({ relay: true, targetKey, remotePort: port });
      if (!reply.ok || !reply.result || !Number.isInteger(reply.result.localPort)) {
        throw new Error(reply.error ?? 'Relay dev tunnel could not be opened.');
      }
      return { localPort: reply.result.localPort, reused: reply.result.reused === true,
        url: `http://127.0.0.1:${reply.result.localPort}` };
    },
    close({ baseUrl, port }) {
      void api.close({ relay: true, targetKey: new URL(baseUrl).origin, remotePort: port });
      return { closed: true };
    },
  });
  const removeListener = installRelayDevTunnelListener({ onConnect: ({ connectionId, remotePort, bridgePort }) => {
    const relayTunnel = getActiveRelayTunnel();
    if (!relayTunnel) { bridgePort.close?.(); return; }
    void connectRelayDevTunnel({ connectionId, remotePort, bridgePort,
      relayTunnel: relayTunnel as unknown as RelayDevTunnelConnectInput['relayTunnel'],
      apiBaseUrl: getApiBaseUrl() }).catch(() => bridgePort.close?.());
  } });
  return () => {
    removeListener();
    setDesktopTunnelBridge(null);
    void api.closeAll();
  };
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
  if (connectPort.onclose !== undefined) connectPort.onclose = finish;
  else connectPort.addEventListener?.('close', finish);
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
