// SPDX-License-Identifier: Apache-2.0
/**
 * Runtime socket op (doc 08 §3.10 runtime integration). `openRuntimeWebSocket`
 * is the ONLY sanctioned socket op in relay mode; raw `new WebSocket(url)`
 * against the tunnel-virtual origin is a caller defect (the browser's own
 * URL parser rejects the empty origin — the doc's "The string did not match
 * the expected pattern" outcome). Direct mode resolves the platform
 * WebSocket; relay mode returns the tunnel
 * surface (native-WS-compatible shape).
 */
import { isRelayModeActive, getActiveRelayTunnel } from './runtime-tunnel.ts';
import { wsUrlToTunnelPath } from './relay/tunnel-payloads.ts';
import type { RelayTunnelWebSocket } from './relay/tunnel-client-types.ts';

export type RuntimeSocket = RelayTunnelWebSocket | (WebSocket & { binaryType: string });

export function openRuntimeWebSocket(url: string, protocols?: string | string[]): RuntimeSocket {
  if (isRelayModeActive()) {
    const tunnel = getActiveRelayTunnel();
    if (tunnel === null) throw new Error('relay tunnel is not active');
    return tunnel.openWebSocket(url, protocols) as RelayTunnelWebSocket;
  }
  const WS = (globalThis as { WebSocket?: { new(url: string, protocols?: string | string[]): WebSocket } }).WebSocket;
  if (WS === undefined) throw new Error('WebSocket unavailable on this platform');
  const socket = new WS(url, protocols);
  socket.binaryType = 'arraybuffer';
  return socket as RuntimeSocket;
}

/** The tunnel-path form a relay socket speaks (for status/telemetry only). */
export function runtimeSocketPathOf(url: string): string {
  return wsUrlToTunnelPath(url);
}
