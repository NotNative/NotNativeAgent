// SPDX-License-Identifier: Apache-2.0
/**
 * Phase-2 enrichment (doc 04 §C.3 step 6): commands/mcp/lsp/vcs plus the
 * SIGNATURE-GUARDED blocking-request merge — response-omitted entries may be
 * deleted ONLY when the id-set signature proves the live set did not move.
 */
import type { StoreApi } from 'zustand/vanilla';
import { harnessClient } from '../lib/nnd/client.ts';
import type { PermissionRequest, QuestionRequest } from '../lib/nnd/types.ts';
import type { DirectoryStore, SyncState } from './types.ts';
import { useGlobalSessionStatusStore } from './global-stores.ts';
import type { SessionStatus } from '../lib/nnd/types.ts';

export async function runPhase2(directory: string, store: StoreApi<DirectoryStore>, isCurrent: () => boolean): Promise<void> {
  // Why (uniformity audit #4): the vcs fetch was removed with the dead
  // getVcs client — NNA serves no /vcs route; the lapsed branch chip degrades
  // honestly instead of requesting a 404 each boot.
  const [commands, mcp, lsp] = await Promise.allSettled([
    harnessClient.listCommands({ directory }),
    harnessClient.getMcp({ directory }),
    harnessClient.getLsp({ directory }),
  ]);
  if (!isCurrent()) return; // deferred phase gated on isCurrent too
  const patch: Partial<SyncState> = {};
  if (commands.status === 'fulfilled' && !commands.value.error && commands.value.data) patch.command = commands.value.data as SyncState['command'];
  if (mcp.status === 'fulfilled' && !mcp.value.error) patch.mcp = mcp.value.data ?? null;
  if (lsp.status === 'fulfilled' && !lsp.value.error && lsp.value.data) patch.lsp = lsp.value.data as SyncState['lsp'];
  store.setState(patch);
  await Promise.allSettled([
    loadBlockingInto(store, directory, 'question', isCurrent),
    loadBlockingInto(store, directory, 'permission', isCurrent),
  ]);
}

function requestSignature(requests: { id: string }[]): string {
  return requests.map((request) => request.id).sort().join('|');
}

function mapOf(state: SyncState, kind: 'question' | 'permission'): Record<string, { id: string }[]> {
  return kind === 'question' ? state.question : state.permission;
}

/** Signature-guarded blocking-request merge (doc 04 §C.3 step 6). */
async function loadBlockingInto(
  store: StoreApi<DirectoryStore>,
  directory: string,
  kind: 'question' | 'permission',
  isCurrent: () => boolean,
): Promise<boolean> {
  const mapOf = (state: SyncState): Record<string, { id: string }[]> =>
    kind === 'question' ? state.question : state.permission;
  const signatureBefore = requestSignature(Object.values(mapOf(store.getState())).flat());
  const result = kind === 'question'
    ? await harnessClient.listQuestions({ directory })
    : await harnessClient.listPermissions({ directory });
  if (!isCurrent() || result.error || !Array.isArray(result.data)) return false; // failure is not empty success
  // merge against the CURRENT state (post-fetch): live SSE arrivals that moved
  // the set mid-flight are protected; a stable signature proves the response's
  // omissions are real deletions, never a resurrection of a pre-read snapshot
  const currentAfter = mapOf(store.getState());
  const signatureAfter = requestSignature(Object.values(currentAfter).flat());
  const stable = signatureAfter === signatureBefore;
  const grouped = new Map<string, { id: string; sessionID: string }[]>();
  for (const request of result.data as { id: string; sessionID: string }[]) {
    const list = grouped.get(request.sessionID) ?? [];
    list.push(request);
    grouped.set(request.sessionID, list);
  }
  const next = {} as Record<string, QuestionRequest[] & PermissionRequest[]>;
  for (const sessionID of new Set([...Object.keys(currentAfter), ...grouped.keys()])) {
    const response = grouped.get(sessionID);
    if (response) {
      next[sessionID] = [...response].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) as QuestionRequest[] & PermissionRequest[];
      continue;
    }
    // response omitted this bucket: delete only when untouched since pre-read
    if (stable) continue;
    const liveBucket = currentAfter[sessionID];
    if (liveBucket) next[sessionID] = liveBucket as QuestionRequest[] & PermissionRequest[];
  }
  store.setState(kind === 'question' ? { question: next } : { permission: next });
  return true;
}

/** Fetch + signature-guarded merge for one blocking-request kind. */
export async function resyncBlockingKind(
  store: StoreApi<DirectoryStore>,
  directory: string,
  kind: 'question' | 'permission',
  isCurrent: () => boolean,
): Promise<boolean> {
  return loadBlockingInto(store, directory, kind, isCurrent);
}

/** Feeds the global live-status index from an authoritative snapshot. */
export function emitSessionStatus(snapshot: Record<string, SessionStatus>, directory: string): void {
  void directory;
  useGlobalSessionStatusStore.getState().applySnapshot(snapshot, Object.keys(snapshot), 'authoritative');
}
