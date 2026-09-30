// SPDX-License-Identifier: Apache-2.0
/** Deterministic walkthrough preview and explicit generation transport. */
type JSONRecord = Record<string, unknown>;
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
  oldPath?: string;
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
  title: string;
  focus: string;
  chapters: { id: string; title: string; icon: 'bug' | 'wrench' | 'path' | 'flask' | 'doc' | 'gear'; blurb: string;
    stops: { id: string; title: string; importance: 'critical' | 'normal' | 'context'; prose: string;
      hunks: { id: string; scope: 'staged' | 'working'; path: string; oldPath?: string; oldStart: number; newStart: number }[] }[] }[];
  omittedSensitiveHunks: number;
  providerID: string;
  modelID: string;
}
export interface WalkthroughModelOption {
  providerID: string;
  modelID: string;
  label: string;
  hasLogin: boolean;
  structuredOutput: boolean | null;
  inputCharBudget: number | null;
  contextTokens: number | null;
  contextKnown: boolean;
  outputTokens: number | null;
}
export interface WalkthroughReadiness {
  ready: boolean;
  reason: 'no-model' | 'empty-diff' | 'only-generated' | 'no-provider-login' | 'provider-unsupported' | 'structured-output-unsupported' | 'context-too-small' | null;
  requiredChars: number;
  availableChars: number | null;
}
export interface WalkthroughReadinessResponse {
  model: WalkthroughModelOption | null;
  options: WalkthroughModelOption[];
  readiness: WalkthroughReadiness;
}

function jsonError(payload: unknown, fallback: string, status: number): Error {
  const shaped = payload as { error?: unknown } | null;
  return new Error(typeof shaped?.error === 'string' ? shaped.error : `${fallback} (${status}).`);
}

function walkthroughIsValid(payload: GeneratedWalkthrough | unknown, snapshotStops?: WalkthroughStopPreview[]):
  payload is GeneratedWalkthrough {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const value = payload as GeneratedWalkthrough;
  const known = snapshotStops === undefined ? undefined : new Map(snapshotStops.map((stop) => [stop.id, stop]));
  const seen = new Set<string>();
  let stopCount = 0;
  return typeof value.revision === 'string' && typeof value.providerID === 'string'
    && value.providerID.length > 0 && value.providerID.length <= 256
    && typeof value.modelID === 'string' && value.modelID.length > 0 && value.modelID.length <= 256
    && typeof value.title === 'string' && value.title.trim() !== '' && value.title.length <= 80
    && typeof value.focus === 'string' && value.focus.trim() !== '' && value.focus.length <= 500
    && Number.isSafeInteger(value.omittedSensitiveHunks)
    && value.omittedSensitiveHunks >= 0 && Array.isArray(value.chapters)
    && value.chapters.length > 0 && value.chapters.length <= 6 && value.chapters.every((chapter) =>
      chapter !== null && typeof chapter === 'object' && !Array.isArray(chapter)
      && typeof chapter.id === 'string' && chapter.id.length > 0 && chapter.id.length <= 128
      && !seen.has(`chapter:${chapter.id}`)
      && typeof chapter.title === 'string' && chapter.title.trim() !== '' && chapter.title.length <= 24
      && ['bug', 'wrench', 'path', 'flask', 'doc', 'gear'].includes(chapter.icon)
      && typeof chapter.blurb === 'string' && chapter.blurb.length <= 600
      && Array.isArray(chapter.stops) && chapter.stops.length > 0 && chapter.stops.length <= 16
      && chapter.stops.every((stop) => {
        if (stop === null || typeof stop !== 'object' || Array.isArray(stop)
          || typeof stop.id !== 'string' || stop.id.length === 0 || stop.id.length > 128 || seen.has(stop.id)
          || typeof stop.title !== 'string' || stop.title.trim() === '' || stop.title.length > 100
          || !['critical', 'normal', 'context'].includes(stop.importance)
          || typeof stop.prose !== 'string' || stop.prose.trim() === '' || stop.prose.length > 1_000
          || !Array.isArray(stop.hunks) || stop.hunks.length === 0 || stop.hunks.length > 14) return false;
        if (++stopCount > 16 || seen.has(`stop:${stop.id}`)) return false;
        seen.add(`chapter:${chapter.id}`);
        seen.add(`stop:${stop.id}`);
        seen.add(stop.id);
        return stop.hunks.every((hunk) => {
          if (hunk === null || typeof hunk !== 'object' || typeof hunk.id !== 'string' || hunk.id.length === 0
            || (hunk.scope !== 'staged' && hunk.scope !== 'working') || typeof hunk.path !== 'string'
            || hunk.path.length === 0 || hunk.path.length > 4_096 || !Number.isSafeInteger(hunk.oldStart) || hunk.oldStart < 0
            || !Number.isSafeInteger(hunk.newStart) || hunk.newStart < 0
            || hunk.oldPath !== undefined && (typeof hunk.oldPath !== 'string' || hunk.oldPath.length === 0 || hunk.oldPath.length > 4_096)) return false;
          if (seen.has(`hunk:${hunk.id}`)) return false;
          seen.add(`hunk:${hunk.id}`);
          if (known === undefined) return true;
          const actual = known.get(hunk.id);
          return actual !== undefined && hunk.scope === actual.scope && hunk.path === actual.path && hunk.oldPath === actual.oldPath
            && hunk.oldStart === actual.oldStart && hunk.newStart === actual.newStart;
        });
      })) && seen.size > 0;
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
  source: WalkthroughSource | WalkthroughScope = 'all', language = 'en',
  snapshotStops?: WalkthroughStopPreview[],
  model: string | null = null,
  signal?: AbortSignal): Promise<GeneratedWalkthrough> {
  const response = await runtimeFetch('/api/git/walkthrough-generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ directory, sessionId, revision, source: requestSource(source), language,
      ...(model === null || model === '' ? {} : { model }) }),
    signal,
  });
  const payload = await response.json().catch(() => null) as GeneratedWalkthrough | { error?: string } | null;
  if (!response.ok) throw jsonError(payload, 'Walkthrough generation failed', response.status);
  if (!payload || !('revision' in payload) || payload.revision !== revision
    || !walkthroughIsValid(payload, snapshotStops)) {
    throw new Error('Invalid generated walkthrough response.');
  }
  return payload;
}

export async function loadWalkthroughReadiness(directory: string,
  selected: WalkthroughScope | WalkthroughSource = 'all', model: string | null = null,
  signal?: AbortSignal): Promise<WalkthroughReadinessResponse> {
  const modelQuery = model === null || model === '' ? '' : `&model=${encodeURIComponent(model)}`;
  const response = await runtimeFetch(`/api/git/walkthrough-readiness?directory=${encodeURIComponent(directory)}&${encodeSource(selected)}${modelQuery}`, { signal });
  const payload = await response.json().catch(() => null) as {
    model?: WalkthroughModelOption; options?: WalkthroughModelOption[];
    readiness?: WalkthroughReadiness;
  } | null;
  if (!response.ok) throw jsonError(payload, 'Model readiness failed', response.status);
  const selectedModel = payload?.model;
  if (!payload || !payload.readiness || !Array.isArray(payload.options)
    || selectedModel !== null && (selectedModel === undefined || selectedModel === null
      || typeof selectedModel.providerID !== 'string' || typeof selectedModel.modelID !== 'string')) {
    throw new Error('Invalid model readiness response.');
  }
  return { model: selectedModel ?? null, options: payload.options, readiness: payload.readiness };
}

export async function fetchWalkthroughStage(directory: string, source: WalkthroughSource | WalkthroughScope = 'all',
  signal?: AbortSignal, model: string | null = null): Promise<string | null> {
  const modelQuery = model === null || model === '' ? '' : `&model=${encodeURIComponent(model)}`;
  const response = await runtimeFetch(`/api/git/walkthrough-progress?directory=${encodeURIComponent(directory)}&${encodeSource(source)}${modelQuery}`, { signal });
  const payload = await response.json().catch(() => null) as { stage?: unknown } | JSONRecord | null;
  if (!response.ok) return null;
  return typeof payload?.stage === 'string' && payload.stage.length <= 32 ? payload.stage : null;
}

export async function cancelWalkthroughStage(directory: string, source: WalkthroughSource | WalkthroughScope = 'all',
  model: string | null = null): Promise<boolean> {
  const response = await runtimeFetch('/api/git/walkthrough-cancel', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ directory, source: requestSource(source),
      ...(model === null || model === '' ? {} : { model }) }),
  });
  const payload = await response.json().catch(() => null) as { cancelled?: unknown } | JSONRecord | null;
  return response.ok && payload?.cancelled === true;
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
