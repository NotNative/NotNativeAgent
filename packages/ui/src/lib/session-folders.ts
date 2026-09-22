// SPDX-License-Identifier: Apache-2.0
/**
 * Session-folders client (doc 03 §5.22): the NND server route family lives at
 * `/api/session-folders` (app origin — NOT the harness proxy). One full
 * snapshot per runtime user-shape, last-writer-wins by `updatedAt`; the
 * client always sends the WHOLE snapshot and reports `ignored:true`.
 */
import { runtimeFetch } from './runtime-fetch.ts';

export interface SessionFolder {
  id: string;
  name: string;
  sessionIds: string[];
  createdAt: number;
  parentId?: string;
}

export interface SessionFoldersSnapshot {
  version: 1;
  foldersMap: Record<string, SessionFolder[]>;
  collapsedFolderIds: string[];
  updatedAt: number;
}

export type FolderWrite =
  | { ok: true; ignored?: boolean }
  | { ok: false; error: string; status?: number };

const EMPTY_SNAPSHOT: SessionFoldersSnapshot = { version: 1, foldersMap: {}, collapsedFolderIds: [], updatedAt: 0 };

type WireSnapshot = { version?: number; exists?: boolean; foldersMap?: Record<string, SessionFolder[]>; collapsedFolderIds?: string[]; updatedAt?: number; error?: string };

/** GET: absent disk file → `{version, exists:false}` empty shape (§5.22). */
export async function loadSessionFolders(): Promise<{ snapshot: SessionFoldersSnapshot; error: string | null }> {
  let response: Response;
  try {
    response = await runtimeFetch('/api/session-folders');
  } catch (error: unknown) {
    return { snapshot: EMPTY_SNAPSHOT, error: `session-folders fetch failed: ${String(error)}` };
  }
  const body = await response.json().catch(() => null) as WireSnapshot | null;
  if (!response.ok || body === null || typeof body !== 'object') {
    return { snapshot: EMPTY_SNAPSHOT, error: body?.error ?? `session-folders read failed (${response.status})` };
  }
  if (body.exists === false) return { snapshot: EMPTY_SNAPSHOT, error: null };
  if (body.version !== 1 || typeof body.updatedAt !== 'number' || !body.foldersMap || typeof body.foldersMap !== 'object') {
    return { snapshot: EMPTY_SNAPSHOT, error: 'stored session folders snapshot is malformed' };
  }
  return {
    snapshot: {
      version: 1,
      foldersMap: body.foldersMap,
      collapsedFolderIds: Array.isArray(body.collapsedFolderIds) ? body.collapsedFolderIds : [],
      updatedAt: body.updatedAt,
    },
    error: null,
  };
}

/** POST: full snapshot; `{success:true, ignored:true}` means an OLDER writer
 *  won the LWW race and our local view must be refetched. */
export async function saveSessionFolders(snapshot: SessionFoldersSnapshot): Promise<FolderWrite> {
  let response: Response;
  try {
    response = await runtimeFetch('/api/session-folders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...snapshot, version: 1, exists: true }),
    });
  } catch (error: unknown) {
    return { ok: false, error: `session-folders save failed: ${String(error)}` };
  }
  const body = await response.json().catch(() => null) as { success?: boolean; ignored?: boolean; error?: string } | null;
  if (!response.ok) return { ok: false, error: body?.error ?? `session-folders write failed (${response.status})`, status: response.status };
  if (body?.success !== true) return { ok: false, error: 'session-folders write answered an unexpected shape', status: response.status };
  return body.ignored === true ? { ok: true, ignored: true } : { ok: true };
}
