// SPDX-License-Identifier: Apache-2.0
/**
 * Broker-leg wire socket seam (doc 08 §3.10). The real client resolves
 * the platform WebSocket via `globalThis` (node undici and the DOM both
 * expose `WebSocket`; the host bundles pick their own). Tests inject a
 * fake through `createWireSocket`. Data arrives as string | ArrayBuffer;
 * the default forces `binaryType = 'arraybuffer'` so the E2EE frames are
 * always bytes, never Blob (E2EE stream framing requires exact bytes).
 */
import type { RelayWireSocket } from './tunnel-client-types.ts';

export interface WireSocketMessageDataCarrier {
  data: unknown;
}

export function platformWireSocket(url: string): RelayWireSocket {
  const WSGlobal = (globalThis as { WebSocket?: { new(url: string, protocols?: string[]): RelayWireSocket } }).WebSocket;
  if (!WSGlobal) throw new Error('WebSocket unavailable on this platform');
  const socket = new WSGlobal(url);
  socket.binaryType = 'arraybuffer';
  return socket;
}

/** Normalizes a wire message payload into bytes for the decrypt chain. */
export function messageToBytes(data: unknown): Uint8Array | null {
  if (typeof data === 'string') return new TextEncoder().encode(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array((data as ArrayBufferView<ArrayBuffer>).buffer, (data as ArrayBufferView<ArrayBuffer>).byteOffset, (data as ArrayBufferView<ArrayBuffer>).byteLength);
  return null; // Blob or unrecognizable shapes are not relay frames
}

export function wireSendData(socket: RelayWireSocket, bytes: Uint8Array): void {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  socket.send(buffer);
}
