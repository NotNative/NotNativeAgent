// SPDX-License-Identifier: Apache-2.0
import type { Session } from '../lib/nnd/types.ts';
import { orderSessionsByLifecycle } from '../sync/session-ordering.ts';

export function orderSessionsByLifecycleWrap(sessions: Session[]): Session[] {
  return orderSessionsByLifecycle(sessions);
}

/** Missing or cyclic parents render as roots. */
export function sessionDepths(sessions: Session[]): Map<string, number> {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const depths = new Map<string, number>();
  for (const session of sessions) {
    let depth = 0;
    let parentID = session.parentID;
    const seen = new Set<string>([session.id]);
    while (parentID && byId.has(parentID) && !seen.has(parentID)) {
      seen.add(parentID);
      depth += 1;
      parentID = byId.get(parentID)?.parentID;
    }
    depths.set(session.id, parentID && (!byId.has(parentID) || seen.has(parentID)) ? 0 : depth);
  }
  return depths;
}

export function shortDirectory(directory: string): string {
  const segments = directory.split('/').filter(Boolean);
  if (segments.length === 0) return directory || 'general';
  return segments.at(-1) ?? directory;
}

export function filterSessions(sessions: Session[], query: string): Session[] {
  const text = query.trim();
  if (text.length === 0) return sessions;
  if (text.toLowerCase().startsWith('ses_')) {
    const needle = text.toLowerCase();
    return sessions.filter((session) => session.id.toLowerCase() === needle);
  }
  const needle = text.toLowerCase();
  return sessions.filter((session) => (session.title ?? '').toLowerCase().includes(needle) || session.id.toLowerCase().includes(needle));
}
