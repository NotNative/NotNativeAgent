// SPDX-License-Identifier: Apache-2.0
/** Shared HP-1 transport seams and timeouts for session harness ports. */
import { callHarness, harnessRequest } from '../queue/queue-adapter-calls.ts';
import { DISPATCH_TIMEOUT_MS } from './session-harness-port-timeouts.ts';

export function idOf(id: string): string { return encodeURIComponent(id); }

export function status(path: string, directory: string, body?: unknown,
  timeout = DISPATCH_TIMEOUT_MS): Promise<{ ok: boolean; status: number }> {
  return callHarness(harnessRequest(path, directory, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeout),
  })).then((response) => ({ ok: response.ok, status: response.status }));
}
