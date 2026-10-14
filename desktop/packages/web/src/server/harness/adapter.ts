// SPDX-License-Identifier: Apache-2.0
/**
 * ──────────────────────────────────────────────────────────────────────────
 *  HARNESS SEAM — the single isolation boundary (doc 02 owns the contract).
 *
 *  The NotNativeDesktop server addresses its agentic harness ONLY through this
 *  interface. `mock.ts` implements it in-process today; the NotNativeAgent
 *  (NNA) integration adds `nna.ts` and flips NOTNATIVE_HARNESS=nna. Nothing
 *  else in the server — and nothing in the UI — may know which adapter is
 *  active. When doc 02 lands (phase P1), its port catalog P-01…P-24 becomes
 *  the checklist for this interface.
 * ──────────────────────────────────────────────────────────────────────────
 */

export interface HarnessAdapter {
  /** In-process fixture routes have no NNA admission authority. */
  mode?: 'mock';
  /** Handles any request under the /api namespace (path already includes /api). */
  handle(request: Request): Promise<Response>;
}

/**
 * Harness wire responses are BARE payloads (doc 02 / D12) — no {data} wrapper.
 * Why: NNA's error contract is `{ error: { code, message } }` (e.g. NNA
 * src/nnd-harness-routes.js and src/secret-broker-server.js error sends), so
 * every emitted envelope carries a stable snake_case code; callers may pass a
 * specific one and unclassified sites default to `harness_error`.
 */
export const harnessError = (message: string, status = 400, code = 'harness_error'): Response =>
  new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { 'content-type': 'application/json' },
  });

let active: HarnessAdapter | null = null;

export function registerHarnessAdapter(adapter: HarnessAdapter): void {
  active = adapter;
}

export function getHarnessAdapter(): HarnessAdapter {
  if (!active) throw new Error('no harness adapter registered');
  return active;
}
