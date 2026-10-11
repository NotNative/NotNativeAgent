// SPDX-License-Identifier: Apache-2.0
/**
 * AI rename suggestion (W-24.ai-rename): ask the web server's Small Model
 * seam for a session title. The suggestion is returned to the caller — the
 * operator confirms it through the normal rename flow, so nothing is applied
 * without an explicit decision.
 */
import { runtimeFetch } from '../lib/runtime-fetch.ts';
import { toast } from 'sonner';

export interface SuggestedName { name: string }

/** Sidebar wiring: ask for a suggestion, then apply it only through the
 *  operator-confirmed rename prompt (never silently). */
export function suggestAndApplyRename(sessionID: string, directory: string,
  rename: (id: string, title: string) => Promise<void>): void {
  toast.message('Asking the small model for a name…');
  void suggestSessionName(sessionID, directory)
    .then((name) => {
      const title = prompt(`Suggested name:\n${name}\n\nRename session to:`, name); // eslint-disable-line no-alert
      if (title !== null) return rename(sessionID, title);
    })
    .catch((error: unknown) => toast.error(error instanceof Error ? error.message : 'Name suggestion failed'));
}

export async function suggestSessionName(sessionID: string, directory: string): Promise<string> {
  const response = await runtimeFetch(
    `/api/sessions/${encodeURIComponent(sessionID)}/suggest-name?directory=${encodeURIComponent(directory)}`,
    { method: 'POST' });
  if (!response.ok) throw new Error(await failureMessage(response));
  const body = await response.json().catch(() => null) as { name?: unknown } | null;
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  if (name === '') throw new Error('The suggestion was empty');
  return name;
}

async function failureMessage(response: { status: number; json(): Promise<unknown> }): Promise<string> {
  const body = await response.json().catch(() => null) as { error?: unknown } | null;
  const text = typeof body?.error === 'string' ? body.error : '';
  if (response.status === 503) return 'No small model is available for suggestions';
  return text !== '' ? text : `Name suggestion failed (${response.status})`;
}
