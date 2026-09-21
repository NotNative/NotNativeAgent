// SPDX-License-Identifier: Apache-2.0
/**
 * Internal harness calls for the message queue (doc 12 §D.3): every call
 * rides the harness adapter seam exactly like a proxied client request
 * (`/api`-prefixed paths — HP-1). Nothing may bypass the adapter.
 */
import { getHarnessAdapter } from '../harness/adapter.ts';
import { DIRECTORY_HEADER } from '../lib/harnessNaming.ts';

/** Loopback-only origin: the adapter reads paths, never dials this host. */
export const HARNESS_INTERNAL_ORIGIN = 'http://harness.internal';

export function harnessRequest(path: string, directory: string | null, init?: RequestInit): Request {
  const headers = new Headers(init?.headers);
  if (directory) headers.set(DIRECTORY_HEADER, directory);
  return new Request(`${HARNESS_INTERNAL_ORIGIN}/api${path}`, { ...init, headers });
}

/** Adapter dispatch with failure mapping: adapter throw = HTTP 502-shared
 *  unknown so callers treat every failure path identically. */
export async function callHarness(request: Request): Promise<Response> {
  try {
    return await getHarnessAdapter().handle(request);
  } catch {
    return new Response(JSON.stringify({ error: { message: 'harness adapter unavailable' } }), {
      status: 502,
      headers: { 'content-type': 'application/json' },
    });
  }
}

export async function callHarnessJson(request: Request): Promise<unknown | null> {
  const response = await callHarness(request);
  if (!response.ok) return null;
  try {
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
}
