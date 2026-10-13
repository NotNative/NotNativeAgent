// SPDX-License-Identifier: Apache-2.0
/** Clear device-local pins for a parent delete and its known child cascade. */
import type { Session } from '../lib/nnd/types.ts';
import { useSessionPinnedStore } from '../stores/useSessionPinnedStore.ts';

export function clearKnownSessionTreePins(session: Session, known: Session[], runtimeKey: string): void {
  const children = new Map<string, Session[]>();
  for (const candidate of known) {
    if (!candidate.parentID) continue;
    const list = children.get(candidate.parentID) ?? [];
    list.push(candidate);
    children.set(candidate.parentID, list);
  }
  const pending = [session];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const entry = pending.pop()!;
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    useSessionPinnedStore.getState().clear(entry.directory ?? session.directory ?? 'global', entry.id, runtimeKey);
    pending.push(...(children.get(entry.id) ?? []));
  }
}
