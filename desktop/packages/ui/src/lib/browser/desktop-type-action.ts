// SPDX-License-Identifier: Apache-2.0
/** Host-side transaction for one governed desktop guest type action. */
import { pageTypeScript, parsePageType, type PageTypeResult } from './page-type.ts';

type Guest = HTMLElement & { executeJavaScript?: (script: string, userGesture?: boolean) => Promise<unknown> };
interface TypeContext {
  guest: Guest | null;
  currentUrl: () => string | undefined;
  revision: () => number;
  observationId: () => string | null;
  otherPending: () => boolean;
  pending: { current: Promise<unknown> | null };
  invalidate: () => void;
  currentGuest: () => Guest | null;
}

export async function executeDesktopType(parameters: Record<string, unknown>, state: TypeContext): Promise<PageTypeResult> {
  const { selector, expectedUrl, text, observationRevision, observationId } = parameters;
  if (typeof selector !== 'string' || !selector || selector.length > 500
    || typeof expectedUrl !== 'string' || !expectedUrl || expectedUrl.length > 2048
    || typeof text !== 'string' || text.length > 2000
    || !Number.isSafeInteger(observationRevision) || (observationRevision as number) < 0
    || typeof observationId !== 'string' || !/^[0-9a-f-]{36}$/u.test(observationId))
    throw new Error('A bounded field selector, observed URL, and text are required.');
  const guest = state.guest;
  if (!guest?.executeJavaScript || state.currentUrl() !== expectedUrl
    || state.revision() !== observationRevision || state.observationId() !== observationId)
    throw new Error('The page changed; take a new snapshot before typing.');
  if (state.otherPending() || state.pending.current)
    throw new Error('A prior browser action may still complete; wait before typing.');
  state.invalidate();
  const revision = state.revision();
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let value: unknown;
  try {
    const execution = guest.executeJavaScript(pageTypeScript(selector, expectedUrl, text), false);
    state.pending.current = execution;
    void execution.then(() => { if (state.pending.current === execution) state.pending.current = null; },
      () => { if (state.pending.current === execution) state.pending.current = null; });
    value = await Promise.race([execution,
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('Type result timed out; inspect the page before retrying.')), 15_000); })]);
  } finally { if (timeout) clearTimeout(timeout); }
  if (value && typeof value === 'object' && 'error' in value && typeof value.error === 'string')
    throw new Error(value.error.slice(0, 200));
  const typed = parsePageType(value, selector, expectedUrl);
  if (!typed || state.currentGuest() !== guest || state.revision() !== revision || state.currentUrl() !== expectedUrl)
    throw new Error('Type outcome is uncertain; inspect the page before retrying.');
  return typed;
}
