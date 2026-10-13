// SPDX-License-Identifier: Apache-2.0
type TunnelWebSocket = {
  readyState: number;
  send(data: Buffer | string, options?: { binary: boolean }): void;
  on(event: string, listener: (...args: unknown[]) => void): void;
  once(event: string, listener: (...args: unknown[]) => void): void;
  off(event: string, listener: (...args: unknown[]) => void): void;
  terminate?(): void;
  close?(): void;
};

export interface DevTunnelOpenInput {
  baseUrl: string;
  port: number;
  clientToken?: string | null;
  requestHeaders?: Record<string, string>;
}

export interface DevTunnelCloseInput {
  baseUrl: string;
  port: number;
}

export interface DevTunnelOpenResult {
  localPort: number;
  reused: boolean;
  url: string;
}

export interface DevTunnelClient {
  open(input: DevTunnelOpenInput): Promise<DevTunnelOpenResult>;
  close(input: DevTunnelCloseInput): { closed: boolean };
  closeAll(): void;
  mappingCount(): number;
}

export interface DevTunnelClientOptions {
  handshakeTimeoutMs?: number;
  maxPendingBytes?: number;
  onListenerError?: (port: number, error: Error) => void;
  connectWebSocket?: (url: URL, headers: Record<string, string>) => TunnelWebSocket;
}

export function toWebSocketUrl(baseUrl: string): URL;
export function validateTunnelPort(port: unknown): void;
export function createDevTunnelClient(options?: DevTunnelClientOptions): DevTunnelClient;
