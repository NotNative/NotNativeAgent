// SPDX-License-Identifier: Apache-2.0
/** Present active child sessions beneath their known parent without changing NNA data. */
import type { Session } from '../lib/nnd/types.ts';
import type { SessionFolder } from '../lib/session-folders.ts';

export interface SidebarHierarchy {
  byId: Map<string, Session>;
  depth: Map<string, number>;
  folder: Map<string, string>;
  unfiled: string[];
  unavailableParent: string[];
  unavailableIds: Set<string>;
  visible: string[];
}

export function sidebarHierarchy(ordered: Session[], folders: SessionFolder[], limit: number): SidebarHierarchy {
  const all = new Map(ordered.map((session) => [session.id, session]));
  const included = expandRecentWithAncestors(ordered, all, limit);
  const byId = new Map(ordered.filter((session) => included.has(session.id)).map((session) => [session.id, session]));
  const directFolder = new Map<string, string>();
  for (const group of folders) for (const id of group.sessionIds) {
    if (!directFolder.has(id)) directFolder.set(id, group.id);
  }
  const parent = new Map<string, string>();
  const unavailable = new Set<string>();
  for (const session of byId.values()) {
    if (!session.parentID) continue;
    if (!byId.has(session.parentID)) { unavailable.add(session.id); continue; }
    const seen = new Set([session.id]);
    let cursor: string | undefined = session.parentID;
    while (cursor && byId.has(cursor) && !seen.has(cursor)) {
      seen.add(cursor);
      cursor = byId.get(cursor)?.parentID;
    }
    if (cursor && seen.has(cursor)) continue; // malformed cycle: keep as a root
    parent.set(session.id, session.parentID);
  }
  const children = new Map<string, Session[]>();
  for (const session of byId.values()) {
    const owner = parent.get(session.id);
    if (!owner) continue;
    const list = children.get(owner) ?? [];
    list.push(session);
    children.set(owner, list);
  }
  const visible: string[] = [];
  const depth = new Map<string, number>();
  const folder = new Map<string, string>();
  const visit = (session: Session, at: number, inheritedFolder?: string, inheritedUnavailable = false): void => {
    const targetFolder = directFolder.get(session.id) ?? inheritedFolder;
    const displayDepth = targetFolder === inheritedFolder ? at : 0;
    const parentUnavailable = inheritedUnavailable || unavailable.has(session.id);
    visible.push(session.id);
    depth.set(session.id, displayDepth);
    if (targetFolder) folder.set(session.id, targetFolder);
    if (parentUnavailable) unavailable.add(session.id);
    for (const child of children.get(session.id) ?? []) visit(child, displayDepth + 1, targetFolder, parentUnavailable);
  };
  for (const session of byId.values()) if (!parent.has(session.id)) visit(session, 0);
  return {
    byId, depth, folder, visible, unavailableIds: unavailable,
    unfiled: visible.filter((id) => !folder.has(id) && !unavailable.has(id)),
    // A directly filed orphan (and its inherited descendants) still belongs
    // in that folder. Only unfiled subtrees need the unavailable-parent lane.
    unavailableParent: visible.filter((id) => unavailable.has(id) && !folder.has(id)),
  };
}

function expandRecentWithAncestors(ordered: Session[], all: Map<string, Session>, limit: number): Set<string> {
  const included = new Set(ordered.slice(0, limit).map((session) => session.id));
  // A recent child must not become an "orphan" merely because its older
  // parent falls outside the recent-session cap.
  for (const id of [...included]) {
    let parentID = all.get(id)?.parentID;
    const seen = new Set([id]);
    while (parentID && all.has(parentID) && !seen.has(parentID)) {
      seen.add(parentID);
      included.add(parentID);
      parentID = all.get(parentID)?.parentID;
    }
  }
  return included;
}
