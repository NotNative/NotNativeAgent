// SPDX-License-Identifier: Apache-2.0
/**
 * Production harness seams for P9-6b orchestration. All calls ride the
 * internal HP-1 adapter; the listener route shapes stay documented.
 */
import { callHarness, harnessRequest } from '../queue/queue-adapter-calls.ts';
import type { SessionHarnessPorts } from './session-orchestration-contract.ts';
import { READY_POLL_MS, READY_WINDOW_MS } from './session-harness-port-timeouts.ts';
import { createSessionReadPorts } from './session-harness-read-ports.ts';
import { createSessionWritePorts } from './session-harness-write-ports.ts';

export function createNnaSessionHarnessPorts(): SessionHarnessPorts {
  return { ...createSessionReadPorts(), ...createSessionWritePorts() };
}

export function createHarnessReadyPoll(): () => Promise<boolean> {
  return async () => {
    const deadline = Date.now() + READY_WINDOW_MS;
    for (;;) {
      const response = await callHarness(harnessRequest('/command', '', { method: 'GET' })).catch(() => null);
      if (response !== null && response.ok) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
    }
  };
}
