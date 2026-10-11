// SPDX-License-Identifier: Apache-2.0
import { registerHarnessAdapter } from './adapter.ts';
import { createNnaHarnessAdapter } from './nna.ts';
import { guardLocalNnaHarness, type LocalNnaHarness } from './nna-local.ts';

export interface NativeHarnessOptions {
  endpoint: string;
  token: string;
  /** The supervisor-renewable capability supplier (guide 02 L3): the native
   *  listener enforces the header, so every forwarded request must present
   *  the current grant. */
  capabilitySupplier?: () => string | null;
  signal?: AbortSignal;
}

/** Only the dedicated native listener may interpret this fixed, non-authoritative envelope. */
export function configureNativeHarness(options: NativeHarnessOptions): LocalNnaHarness {
  const endpoint = new URL(options.endpoint);
  if (endpoint.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(endpoint.hostname)
    || endpoint.origin !== options.endpoint) throw new Error('Native harness requires a literal loopback origin');
  if (typeof options.capabilitySupplier !== 'function') throw new Error('Native harness requires a renewable capability supplier');
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  if (signal.aborted) throw new Error('Native generation has ended');
  const local = { endpoint: options.endpoint, token: options.token, principal: () => 'bm5k',
    isRunning: () => !signal.aborted, dispose: () => controller.abort() };
  registerHarnessAdapter(guardLocalNnaHarness(createNnaHarnessAdapter({
    endpoint: local.endpoint, token: local.token, principal: local.principal, signal,
    capabilitySupplier: options.capabilitySupplier,
  }), local));
  return local;
}
