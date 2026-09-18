// SPDX-License-Identifier: Apache-2.0
/**
 * Terminal transport singleton (doc 07 section 6.1): one transport per
 * runtime instance; tests inject a fake WebSocket factory via
 * setTerminalTransportFactory; runtime switch calls disposeTerminalTransport
 * (section F6 step 5: totals, store cleared separately).
 */
import { TerminalTransport } from './transport.ts';
import type { WebSocketFactory } from './wire.ts';

let transport: TerminalTransport | null = null;
let factoryOverride: WebSocketFactory | null = null;

export function getTerminalTransport(): TerminalTransport {
  if (transport === null) {
    const factory: WebSocketFactory = factoryOverride ?? ((url) => new WebSocket(url) as never);
    transport = new TerminalTransport(factory);
  }
  return transport;
}

export function setTerminalTransportFactory(factory: WebSocketFactory | null): void {
  factoryOverride = factory;
}

export function disposeTerminalTransport(): void {
  transport?.dispose();
  transport = null;
}

export function __resetTerminalTransportForTests(): void {
  disposeTerminalTransport();
}
