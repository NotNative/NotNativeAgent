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
  /** Handles any request under the /api namespace (path already includes /api). */
  handle(request: Request): Promise<Response>;
}

export const harnessJson = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify({ data }), {
    status,
    headers: { 'content-type': 'application/json' },
  });

export const harnessError = (message: string, status = 400): Response =>
  new Response(JSON.stringify({ error: { message } }), {
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
