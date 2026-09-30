// SPDX-License-Identifier: Apache-2.0
/** Deterministic walkthrough preview and explicit generation transport. */
import { runtimeFetch } from '../runtime-fetch.ts';

export type WalkthroughScope = 'all' | 'staged' | 'working';
export type WalkthroughSource =
  | { kind: 'working-tree'; scope: WalkthroughScope }
  | { kind: 'branch'; baseRef: string; headRef: string }
  | { kind: 'commit'; hash: string }
  | { kind: 'pr'; number: number; sourceRepo?: { owner: string; repo: string } };

export interface WalkthroughStopPreview {
  id: string;
  scope: WalkthroughScope;
  path: string;
  header: string;
  oldStart: number;
  newStart: number;
  body: string;
}
export interface WalkthroughPreview {
  signature: string;
  stops: WalkthroughStopPreview[];
  fileCount: number;
  binaryFiles: number;
  source?: WalkthroughSource;
}
export interface GeneratedWalkthrough {
  revision: string;
  chapters: { title: string; stops: { id: string; explanation: string }[] }[];
  omittedSensitiveHunks: number;
  providerID: string;
  modelID: string;
}

function jsonError(payload: unknown, fallback: string, status: number): Error {
  const shaped = payload as { error?: unknown } | null;
  return new Error(typeof shaped?.error === 'string' ? shaped.error : `${fallback} (${status}).`);
}

function encodeSource(source: WalkthroughSource | WalkthroughScope): string {
  if (source === 'all' || source === 'staged' || source === 'working') {
    return `source=${encodeURIComponent(JSON.stringify({ kind: 'working-tree', scope: source }))}`;
  }
  return `source=${encodeURIComponent(JSON.stringify(source))}`;
}

function requestSource(source: WalkthroughSource | WalkthroughScope): WalkthroughSource {
  if (source === 'all' || source === 'staged' || source === 'working') return { kind: 'working-tree', scope: source };
  return source;
}

export async function loadWalkthroughPreview(directory: string, selected: WalkthroughScope | WalkthroughSource = 'all', signal?: AbortSignal): Promise<WalkthroughPreview> {
  const response = await runtimeFetch(`/api/git/walkthrough-snapshot?directory=${encodeURIComponent(directory)}&${encodeSource(selected)}`, { signal });
  const payload = await response.json().catch(() => null) as WalkthroughPreview | { error?: string } | null;
  if (!response.ok) throw jsonError(payload, 'Git snapshot failed', response.status);
  if (!payload || !('signature' in payload) || !Array.isArray(payload.stops)) throw new Error('Invalid Git snapshot response.');
  return payload;
}

export async function generateWalkthroughPreview(directory: string, sessionId: string, revision: string,
  source: WalkthroughSource | WalkthroughScope = 'all', signal?: AbortSignal): Promise<GeneratedWalkthrough> {
  const response = await runtimeFetch('/api/git/walkthrough-generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ directory, sessionId, revision, source: requestSource(source) }),
    signal,
  });
  const payload = await response.json().catch(() => null) as GeneratedWalkthrough | { error?: string } | null;
  if (!response.ok) throw jsonError(payload, 'Walkthrough generation failed', response.status);
  if (!payload || !('revision' in payload) || payload.revision !== revision || !Array.isArray(payload.chapters)) {
    throw new Error('Invalid generated walkthrough response.');
  }
  return payload;
}

export function sourceLabel(source: WalkthroughSource): string {
  if (source.kind === 'working-tree') {
    if (source.scope === 'all') return 'All uncommitted';
    if (source.scope === 'staged') return 'Staged';
    return 'Unstaged';
  }
  if (source.kind === 'branch') return `Branch ${source.baseRef}…${source.headRef}`;
  if (source.kind === 'commit') return `Commit ${source.hash.slice(0, 12)}`;
  return `PR #${source.number}`;
}
