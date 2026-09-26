// SPDX-License-Identifier: Apache-2.0
/**
 * Snippet source store (P9-4e-ii): the browser-side cache behind the
 * composer's `#` picker and the editor's snippet source. Backed by the
 * config-entity family (`listSnippets`); the map instance is replaced
 * wholesale on every successful load so `useSyncExternalStore` can see the
 * change, and send-time expansion keeps reading the SAME reference the
 * store published. Failures keep the current roster silently — the picker
 * is best-effort, and unknown `#tokens` already keep their bytes at send.
 */
import { listSnippets } from './snippets-api.ts';

let roster: Map<string, string> = new Map();
const listeners = new Set<() => void>();

function publish(next: Map<string, string>): void {
  roster = next;
  for (const listener of listeners) listener();
}

export function snippetSubscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The getSnapshot for useSyncExternalStore: a stable Map between loads. */
export function snippetMap(): Map<string, string> {
  return roster;
}

/** Snapshot-at-open names for non-subscribed readers (editor pickers). */
export function snippetNames(): string[] {
  return [...roster.keys()];
}

/** Refresh from the server; resolves the published map. A failed request
 * resolves the CURRENT roster (nothing republishes). Never rejects. */
export function refreshSnippets(): Promise<Map<string, string>> {
  return listSnippets().then(
    (outcome) => {
      if (!outcome.ok || !Array.isArray(outcome.snippets)) return roster;
      publish(new Map(outcome.snippets.map((entry) => [entry.name, entry.text])));
      return roster;
    },
    () => roster,
  );
}

/** Test seam: restore the pristine empty-roster state. */
export function __resetSnippetsSourceForTests(): void {
  listeners.clear();
  roster = new Map();
}
