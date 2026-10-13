// SPDX-License-Identifier: Apache-2.0
/** Explicit, revision-bound model explanation with attachable generation jobs. */
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Hono } from 'hono';
import { readJsonBodyBounded } from '../lib/http/read-bounded.ts';
import { ENV } from '../env.ts';
import { WalkthroughCache } from '../lib/walkthrough/cache.ts';
import { walkthroughCacheKey, sessionIdentity, identityFromString } from '../lib/walkthrough/identity.ts';
import { walkthroughModelSelection, walkthroughReadiness } from '../lib/walkthrough/model-readiness.ts';
import { walkthroughPrompt } from '../lib/walkthrough/prompt.ts';
import { WALKTHROUGH_RESPONSE_SCHEMA } from '../lib/walkthrough/response-schema.ts';
import { credentialEvidence, providerList, readConfig, type SmallModelPorts } from '../lib/small-model/provider-ports.ts';
import { generateSmallModel } from './small-model.ts';
import { readMergedSettings } from '../lib/settings-store.ts';
import { callHarness, harnessRequest } from '../queue/queue-adapter-calls.ts';
import { getWalkthroughSnapshot, SnapshotError, sourceRoot } from './git-walkthrough-snapshot.ts';
import { parseWalkthroughSource, sourceKey } from './git-walkthrough-sources.ts';

const SESSION_ID = /^[A-Za-z0-9_-]{4,128}$/u;
const REVISION = /^[a-f0-9]{40}$|^[a-f0-9]{64}$/u;
const MAX_DIGEST_BYTES = 64_000;
const MAX_TEXT = 65_536;
type Snapshot = ReturnType<typeof getWalkthroughSnapshot>;
type ModelStop = { aliases: string[]; title: string; importance: 'critical' | 'normal' | 'context'; prose: string };
type ModelChapter = { title: string; icon: 'bug' | 'wrench' | 'path' | 'flask' | 'doc' | 'gear'; blurb: string; stops: ModelStop[] };
type ModelWalkthrough = { title: string; focus: string; chapters: ModelChapter[] };
export type WalkthroughStopMetadata = { id: string; scope: 'staged' | 'working'; path: string;
  oldPath?: string; oldStart: number; newStart: number };
export type WalkthroughStop = { id: string; title: string; importance: ModelStop['importance']; prose: string; hunks: WalkthroughStopMetadata[] };
export type WalkthroughChapter = { id: string; title: string; icon: ModelChapter['icon']; blurb: string; stops: WalkthroughStop[] };
export type GeneratedWalkthrough = { title: string; focus: string; chapters: WalkthroughChapter[] };
export type WalkthroughStage = 'collecting' | 'asking' | 'assembling';

export class WalkthroughGenerateError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) { super(message); }
}

export type WalkthroughJob = {
  stage: WalkthroughStage;
  state: 'running' | 'settled';
  expected: string;
  controller: AbortController;
  promise: Promise<unknown>;
  error: unknown;
};

const jobs = new Map<string, WalkthroughJob>();
const defaultCachedWalkthrough = new WalkthroughCache(ENV.dataDir ? `${ENV.dataDir.replace(/[\\/]+$/u, '')}/walkthrough-cache.json` : 'walkthrough-cache.json');
const READINESS_PROMPT_OVERHEAD_CHARS = 8_192;
const stageOrder: Record<WalkthroughStage, number> = { collecting: 0, asking: 1, assembling: 2 };

function signalWithDeadline(job: WalkthroughJob, timeoutMs: number): AbortSignal | undefined {
  const Aborts = globalThis as typeof globalThis & { AbortSignal?: { any?: (...signals: AbortSignal[]) => AbortSignal; timeout?: (timeout: number) => AbortSignal } };
  const deadline = Aborts.AbortSignal?.timeout?.(timeoutMs);
  if (!deadline) return undefined;
  return Aborts.AbortSignal?.any?.([deadline, job.controller.signal]) ?? deadline;
}

function sameDirectory(left: string, right: string): boolean {
  const normalize = (path: string): string => process.platform === 'win32' ? path.toLowerCase() : path;
  try { return normalize(realpathSync(left)) === normalize(realpathSync(right)); }
  catch { return normalize(resolve(left)) === normalize(resolve(right)); }
}

function sensitivePath(path: string): boolean {
  const name = path.replaceAll('\\', '/').split('/').at(-1)?.toLowerCase() ?? '';
  if (name === '.env' || name.startsWith('.env.') || /\.(?:pem|key|p12|pfx|kdbx)$/u.test(name)) return true;
  return name.startsWith('id_') && !name.endsWith('.pub');
}

export function digestFor(snapshot: Snapshot): { digest: unknown[]; aliases: Map<string, Snapshot['stops'][number]>; omitted: number } {
  const digest: unknown[] = [];
  const aliases = new Map<string, Snapshot['stops'][number]>();
  let omitted = 0;
  for (const stop of snapshot.stops) {
    if (sensitivePath(stop.path) || (stop.oldPath && sensitivePath(stop.oldPath))) { omitted += 1; continue; }
    const alias = `h${digest.length + 1}`;
    digest.push({ alias, scope: stop.scope, path: stop.path, ...(stop.oldPath ? { oldPath: stop.oldPath } : {}),
      header: stop.header, patch: stop.body });
    aliases.set(alias, stop);
  }
  if (Buffer.byteLength(JSON.stringify(digest), 'utf8') > MAX_DIGEST_BYTES) {
    throw new WalkthroughGenerateError('Diff digest is too large for this model request; no text was sent.', 413, 'context-too-small');
  }
  return { digest, aliases, omitted };
}

function parsedObject(text: string): Record<string, unknown> {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '');
  let value: unknown;
  try { value = JSON.parse(cleaned); } catch { throw new WalkthroughGenerateError('Model returned invalid walkthrough JSON.', 502, 'invalid-walkthrough'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new WalkthroughGenerateError('Model returned invalid walkthrough JSON.', 502, 'invalid-walkthrough');
  }
  return value as Record<string, unknown>;
}

export function normalizeWalkthrough(text: string, aliases: Map<string, Snapshot['stops'][number]>): ModelWalkthrough {
  const rawResult = parsedObject(text);
  const title = typeof rawResult.title === 'string' ? rawResult.title.replace(/\s+/gu, ' ').trim().slice(0, 80) : '';
  const focus = typeof rawResult.focus === 'string' ? rawResult.focus.replace(/\s+/gu, ' ').trim().slice(0, 500) : '';
  const raw = rawResult.chapters;
  if (!title || !focus || !Array.isArray(raw) || raw.length > 6) throw new WalkthroughGenerateError('Model returned invalid chapters.', 502, 'invalid-walkthrough');
  const used = new Set<string>();
  const chapters: ModelChapter[] = [];
  let totalStops = 0;
  for (const chapter of raw) {
    if (!chapter || typeof chapter !== 'object' || Array.isArray(chapter)) continue;
    const shaped = chapter as { title?: unknown; icon?: unknown; blurb?: unknown; stops?: unknown };
    if (typeof shaped.title !== 'string' || !shaped.title.trim() || !Array.isArray(shaped.stops)) continue;
    const icon = ['bug', 'wrench', 'path', 'flask', 'doc', 'gear'].includes(String(shaped.icon)) ? shaped.icon as ModelChapter['icon'] : 'doc';
    const blurb = typeof shaped.blurb === 'string' && shaped.blurb.trim()
      ? shaped.blurb.replace(/\s+/gu, ' ').trim().slice(0, 600) : 'Related changes.';
    const stops: ModelStop[] = [];
    for (const item of shaped.stops.slice(0, 16 - totalStops)) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const stop = item as { title?: unknown; hunks?: unknown; importance?: unknown; prose?: unknown };
      if (!Array.isArray(stop.hunks) || typeof stop.prose !== 'string' || !stop.prose.trim()) continue;
      const hunkAliases = stop.hunks.slice(0, 14).filter((alias): alias is string => typeof alias === 'string'
        && aliases.has(alias) && !used.has(alias));
      if (!hunkAliases.length) continue;
      hunkAliases.forEach((alias) => used.add(alias));
      const importance = ['critical', 'normal', 'context'].includes(String(stop.importance)) ? stop.importance as ModelStop['importance'] : 'normal';
      stops.push({ aliases: hunkAliases, title: (typeof stop.title === 'string' ? stop.title.replace(/\s+/gu, ' ').trim() : '').slice(0, 100) || `Step ${totalStops + stops.length + 1}`,
        importance, prose: stop.prose.replace(/\s+/gu, ' ').trim().slice(0, 1_000) });
    }
    if (stops.length) { totalStops += stops.length; chapters.push({ title: shaped.title.replace(/\s+/gu, ' ').trim().slice(0, 24), icon, blurb, stops }); }
  }
  if (!chapters.length) throw new WalkthroughGenerateError('Model did not explain any current hunk.', 502, 'invalid-walkthrough');
  return { title, focus, chapters };
}
function cancelledIfAborted(job: WalkthroughJob): void {
  if (job.controller.signal.aborted) throw new WalkthroughGenerateError('Walkthrough generation cancelled.', 499, 'cancelled');
}
function cacheIdentity(sourceKey: string, root: string, identity: { providerID: string; modelID: string },
  language: string, snapshot: Snapshot) {
  return walkthroughCacheKey('walkthrough-cache-v3', root, sourceKey, identity, language, snapshot);
}
function cacheModelIdentity(requested: string | null, owner: unknown): { providerID: string; modelID: string } | null {
  return requested === null ? sessionIdentity(owner) : identityFromString(requested);
}

export function generationJobKey(root: string, source: string, requestedModel: string | null): string {
  return requestedModel === null
    ? `${root.toLowerCase()}\0${source}`
    : `${root.toLowerCase()}\0${source}\0${requestedModel}`;
}

async function modelSelection(directory: string, requestModel: string | undefined,
  modelPorts: SmallModelPorts = {}) {
  const providers = await providerList(modelPorts, directory);
  if (providers === null) throw new WalkthroughGenerateError('Model provider inventory is unavailable.', 502, 'provider-list-failed');
  const credentials = await credentialEvidence(directory, providers, modelPorts);
  const config = await readConfig(modelPorts, directory);
  const settings = readMergedSettings('web');
  return walkthroughModelSelection({
    providers, credentials, requestModel,
    settingsOverride: settings.walkthroughModelOverride, smallModelSettings: settings, config,
  });
}

async function ownedSession(ports: Partial<Record<'call' | 'root', any>>, sessionId: string,
  directory: string, job: WalkthroughJob): Promise<Response> {
  return ports.call?.(harnessRequest(`/session/${encodeURIComponent(sessionId)}`, directory, {
    method: 'GET', signal: signalWithDeadline(job, 5_000),
  })) ?? Promise.reject(new WalkthroughGenerateError('Walkthrough generation failed.', 500, 'generation-failed'));
}

type WalkthroughModelResponse = { revision: unknown; text: unknown; providerID: unknown; modelID: unknown; error?: { message?: string } };
type AcceptedModelResponse = { revision: string; text: string; providerID: string; modelID: string; error?: { message?: string } };

function requestedModel(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > 512) {
    throw new WalkthroughGenerateError('Invalid walkthrough request.', 400, 'invalid-request');
  }
  const separator = value.indexOf('/');
  if (separator <= 0 || separator >= value.length - 1) {
    throw new WalkthroughGenerateError('Model must be providerID/modelID.', 400, 'invalid-model');
  }
  return value;
}

function validModelResponse(result: WalkthroughModelResponse | null, snapshot: Snapshot):
  result is { revision: string; text: string; providerID: string; modelID: string; error?: { message?: string } } {
  return result !== null && result.revision === snapshot.signature && typeof result.text === 'string' && result.text.length <= MAX_TEXT
    && typeof result.providerID === 'string' && result.providerID.length > 0 && result.providerID.length <= 256
    && typeof result.modelID === 'string' && result.modelID.length > 0 && result.modelID.length <= 256;
}

function acceptModelResponse(result: WalkthroughModelResponse | null, snapshot: Snapshot,
  identity: { providerID: string; modelID: string } | null,
  requestModel: string | null): AcceptedModelResponse {
  if (!validModelResponse(result, snapshot)) {
    throw new WalkthroughGenerateError('Model response does not match this diff revision.', 502, 'invalid-walkthrough');
  }
  if (identity !== null && (result!.providerID !== identity.providerID || result!.modelID !== identity.modelID)) {
    throw new WalkthroughGenerateError('Model response does not match this walkthrough identity.', 502, 'model-changed');
  }
  if (requestModel !== null && `${result!.providerID}/${result!.modelID}` !== requestModel) {
    throw new WalkthroughGenerateError('Model response does not match the requested walkthrough model.', 502, 'model-changed');
  }
  return result!;
}

function cachedChaptersMatch(snapshot: Snapshot, cached: { revision: string;
  chapters: { stops: { hunks: { id: string; scope: 'staged' | 'working'; path: string; oldPath?: string;
    oldStart: number; newStart: number }[] }[] }[] }): boolean {
  if (cached.revision !== snapshot.signature) return false;
  const byId = new Map(snapshot.stops.map((stop) => [stop.id, stop]));
  return cached.chapters.flatMap((chapter) => chapter.stops).flatMap((stop) => stop.hunks).every((hunk) => {
    const actual = byId.get(hunk.id);
    return actual !== undefined && actual.scope === hunk.scope && actual.path === hunk.path
      && actual.oldPath === hunk.oldPath && actual.oldStart === hunk.oldStart && actual.newStart === hunk.newStart;
  });
}

function walkthroughModelError(response: Response, body: Record<string, unknown> | null): WalkthroughGenerateError {
  const detail = body !== null && body.error !== null && typeof body.error === 'object' && !Array.isArray(body.error)
    ? body.error as Record<string, unknown> : {};
  const code = typeof detail.code === 'string' ? detail.code : 'model-unavailable';
  const status = code === 'context-too-small' ? 409 : code === 'output-exhausted' ? 422
    : code === 'cancelled' ? 499 : response.status >= 400 && response.status <= 499 ? response.status : 502;
  const message = typeof detail.message === 'string' ? detail.message : 'Walkthrough model is unavailable.';
  return new WalkthroughGenerateError(message, status, code);
}

function readCachedAnswer(cache: WalkthroughCache, key: string, snapshot: Snapshot, omitted: number): unknown | null {
  const cached = cache.get(key);
  if (cached === null) return null;
  if (!cachedChaptersMatch(snapshot, cached)) {
    cache.delete(key);
    return null;
  }
  return { revision: snapshot.signature, title: cached.title, focus: cached.focus, chapters: cached.chapters,
    omittedSensitiveHunks: omitted, providerID: cached.providerID, modelID: cached.modelID };
}

function walkthroughAnswer(walkthrough: ModelWalkthrough, snapshot: Snapshot, aliases: Map<string, Snapshot['stops'][number]>, omitted: number, providerID: string, modelID: string) {
  return { revision: snapshot.signature, title: walkthrough.title, focus: walkthrough.focus,
    chapters: walkthrough.chapters.map((chapter, chapterIndex) => ({ id: `chapter-${chapterIndex + 1}`, ...chapter,
      stops: chapter.stops.map((stop, stopIndex) => ({ id: `stop-${chapterIndex + 1}-${stopIndex + 1}`,
        title: stop.title, importance: stop.importance, prose: stop.prose,
        hunks: stop.aliases.map((alias) => {
          const hunk = aliases.get(alias)!;
          return { id: hunk.id, scope: hunk.scope, path: hunk.path,
            ...(hunk.oldPath ? { oldPath: hunk.oldPath } : {}), oldStart: hunk.oldStart, newStart: hunk.newStart };
        }) })) })), omittedSensitiveHunks: omitted, providerID, modelID };
}

function parseInputs(sessionId: unknown, expected: unknown, directory: unknown, rawSource: unknown): {
  sessionId: string; expected: string; directory: string; language: string;
} {
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId) || typeof expected !== 'string' || !REVISION.test(expected)
    || typeof directory !== 'string' || !directory || directory.length > 4096) {
    throw new WalkthroughGenerateError('Invalid walkthrough request.', 400, 'invalid-request');
  }
  try { parseWalkthroughSource(rawSource); } catch {
    throw new WalkthroughGenerateError('Invalid walkthrough request.', 400, 'invalid-request');
  }
    return { sessionId, expected, directory, language: 'en' };
}

async function runGeneration(input: { sessionId: string; expected: string; directory: string;
  ports: Partial<Record<'snapshot' | 'call' | 'root', any>>; modelPorts?: SmallModelPorts; rawSource: unknown;
  language: string; requestModel: string | null; cache?: WalkthroughCache; job: WalkthroughJob }): Promise<unknown> {
  const { sessionId, expected, directory, ports } = input;
  const rawSource = input.rawSource;
  const job = input.job;
  const source = parseWalkthroughSource(rawSource);
  const root = ports.root?.(directory) ?? sourceRoot(directory);
  setStage(job, 'collecting');
  const snapshot = ports.snapshot(directory, undefined, source);
  if (snapshot.signature !== expected) throw new WalkthroughGenerateError('Diff changed; refresh before generating.', 409, 'snapshot-stale');
  const { digest, aliases, omitted } = digestFor(snapshot);
  if (!digest.length) throw new WalkthroughGenerateError('No reviewable non-sensitive text hunks.', 409, 'empty-diff');
  setStage(job, 'asking');
  const session = await ownedSession(ports, sessionId, directory, job);
  const owner = await session.json().catch(() => null) as { directory?: unknown } | null;
  if (!session.ok || typeof owner?.directory !== 'string' || !sameDirectory(owner.directory, directory)) {
    throw new WalkthroughGenerateError('Session does not belong to this workspace.', 403, 'session-scope');
  }
  const selected = input.modelPorts === undefined ? null : await modelSelection(directory, input.requestModel ?? undefined, input.modelPorts);
  const identity = selected === null ? cacheModelIdentity(input.requestModel, owner) : selected.selected;
  if (selected !== null) {
    const requiredChars = Buffer.byteLength(JSON.stringify(digest), 'utf8') + READINESS_PROMPT_OVERHEAD_CHARS;
    const readiness = walkthroughReadiness({ digestCount: digest.length, fileCount: snapshot.fileCount, requiredChars, selection: selected });
    if (!readiness.ready) {
      const reason = readiness.reason ?? 'no-model';
      const status = reason === 'no-provider-login' ? 401 : reason === 'context-too-small' ? 409 : 422;
      throw new WalkthroughGenerateError(`Walkthrough model is not ready: ${reason}.`, status, reason);
    }
  }
  if (identity !== null && input.cache !== undefined) {
    const cacheKey = cacheIdentity(sourceKey(source), root, identity, input.language, snapshot);
    const cached = readCachedAnswer(input.cache, cacheKey, snapshot, omitted);
    if (cached !== null) {
      cancelledIfAborted(input.job);
      return cached;
    }
  }
  const result = await requestWalkthroughModel({ ...input, snapshot, source, root, digest, identity, selected });
  const accepted = acceptModelResponse(result, snapshot, identity, input.requestModel);
  setStage(input.job, 'assembling');
  const walkthrough = normalizeWalkthrough(accepted.text, aliases);
  const current = ports.snapshot(directory, undefined, source);
  if (current.signature !== snapshot.signature) throw new WalkthroughGenerateError('Diff changed during generation; refresh and retry.', 409, 'snapshot-stale');
  cancelledIfAborted(input.job);
  const answer = walkthroughAnswer(walkthrough, snapshot, aliases, omitted, accepted.providerID, accepted.modelID);
  if (identity !== null && input.cache !== undefined) {
    input.cache.set(cacheIdentity(sourceKey(source), root, identity, input.language, snapshot), answer);
  }
  return answer;
}

async function requestWalkthroughModel(input: {
  sessionId: string; directory: string; ports: Partial<Record<'snapshot' | 'call' | 'root', any>>;
  modelPorts?: SmallModelPorts; requestModel: string | null; language: string; job: WalkthroughJob;
  snapshot: Snapshot; source: ReturnType<typeof parseWalkthroughSource>; root: string; digest: unknown[];
  identity: { providerID: string; modelID: string } | null;
  selected: Awaited<ReturnType<typeof modelSelection>> | null;
}): Promise<WalkthroughModelResponse | null> {
  const { snapshot, identity, selected, modelPorts, directory, language, source, root, digest, job } = input;
  if (modelPorts !== undefined && selected?.model !== null && selected?.model !== undefined && identity !== null) {
    const model = `${selected.model.providerID}/${selected.model.modelID}`;
    const prompt = walkthroughPrompt(digest, source, language);
    const timeoutMs = Math.min(900_000, 120_000 + digest.length * 1_000);
    const response = await generateSmallModel({ directory, model,
      sessionID: `nnd-walkthrough-${cacheIdentity(sourceKey(source), root, identity, language, snapshot)}`,
      system: prompt.system, prompt: prompt.prompt, maxOutputTokens: selected.model.outputTokens ?? 24_000,
      ...(selected.model.structuredOutput === true ? { responseSchema: WALKTHROUGH_RESPONSE_SCHEMA } : {}),
    }, modelPorts, job.controller.signal, timeoutMs);
    const generated = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!response.ok) throw walkthroughModelError(response, generated);
    return generated === null ? null : { revision: snapshot.signature, text: generated.text,
      providerID: generated.providerID, modelID: generated.modelID };
  }
  const response = await input.ports.call(harnessRequest(`/v1/nnd/sessions/${encodeURIComponent(input.sessionId)}/walkthrough`, directory, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input.requestModel === null ? { revision: snapshot.signature, digest }
      : { revision: snapshot.signature, digest, model: input.requestModel }),
    signal: signalWithDeadline(job, 50_000),
  }));
  const result = await response.json().catch(() => null) as WalkthroughModelResponse | null;
  if (!response.ok) throw new WalkthroughGenerateError(result?.error?.message ?? 'Walkthrough model is unavailable.', response.status, 'model-unavailable');
  return result;
}

export async function generateWalkthrough(directory: string, sessionId: string, expected: string,
  ports: { snapshot: typeof getWalkthroughSnapshot; call: typeof callHarness; root?: typeof sourceRoot } = { snapshot: getWalkthroughSnapshot, call: callHarness },
  rawSource: unknown = 'all',
  context: { jobs?: Map<string, WalkthroughJob>; rawSource?: unknown; language?: unknown;
    model?: unknown; cache?: WalkthroughCache; modelPorts?: SmallModelPorts } = {}): Promise<unknown> {
  const requestModel = requestedModel(context.model);
  parseInputs(sessionId, expected, directory, rawSource);
  const source = parseWalkthroughSource(rawSource);
  const root = ports.root?.(directory) ?? sourceRoot(directory);
  const key = generationJobKey(root, sourceKey(source), requestModel);
  const existing = context.jobs?.get(key);
  if (existing && existing.state === 'running') {
    if (existing.expected !== expected) throw new WalkthroughGenerateError('Diff changed; refresh before generating.', 409, 'snapshot-stale');
    return existing.promise;
  }
  const controller = new AbortController();
  const job: WalkthroughJob = { stage: 'collecting', state: 'running', expected, controller, promise: Promise.resolve<unknown>(null), error: null };
  const rawLanguage = context.language;
  const language = typeof rawLanguage === 'string' && /^[A-Za-z0-9-]{1,32}$/u.test(rawLanguage)
    ? rawLanguage : 'en';
  const generation = { sessionId, expected, directory, rawSource, ports, job,
    language, requestModel, cache: context.cache ?? defaultCachedWalkthrough, modelPorts: context.modelPorts };
  job.promise = runGeneration(generation).catch((error) => {
    job.error = error;
    if (job.controller.signal.aborted) throw new WalkthroughGenerateError('Walkthrough generation cancelled.', 499, 'cancelled');
    throw error;
  }).finally(() => {
    job.state = 'settled';
    if (context.jobs?.get(key) === job) context.jobs.delete(key);
  });
  context.jobs?.set(key, job);
  return job.promise;
}

function setStage(job: WalkthroughJob, next: WalkthroughStage): void {
  if (job.stage === 'collecting' && next === 'assembling') return;
  if (stageOrder[job.stage] < stageOrder[next]) job.stage = next;
}

export function walkthroughProgress(_directory: string, sourceRaw: unknown,
  root: string, store: Map<string, WalkthroughJob>, model: string | null = null): WalkthroughStage | null {
  const source = parseWalkthroughSource(sourceRaw);
  const key = generationJobKey(root, sourceKey(source), model);
  return store.get(key)?.stage ?? null;
}

export function cancelWalkthrough(_directory: string, sourceRaw: unknown,
  root: string, store: Map<string, WalkthroughJob>, model: string | null = null): boolean {
  try {
    const source = parseWalkthroughSource(sourceRaw);
    const key = generationJobKey(root, sourceKey(source), model);
    const job = store.get(key);
    if (!job || job.state !== 'running') return false;
    job.controller.abort();
    return true;
  } catch { return false; }
}

export function __walkthroughJobs(jobsMap: Map<string, WalkthroughJob>): void {
  jobsMap.clear();
}

export function walkthroughProgressState(encodedSource: string, root: string,
  store: Map<string, WalkthroughJob> = jobs, model: string | null = null): { status: number; body: Record<string, unknown> } {
  try {
    return { status: 200, body: { stage: walkthroughProgress("", JSON.parse(encodedSource), root, store, model) } };
  } catch (cause) {
    const failure = cause as { status?: number; code?: string };
    const status = failure.status === 400 || typeof failure.status !== 'number' ? 400 : 500;
    return { status, body: { error: "Invalid walkthrough progress request.", code: status === 400 ? String(failure.code ?? "invalid-source") : "progress-failed" } };
  }
}

export function walkthroughCancelState(source: unknown, root: string,
  store: Map<string, WalkthroughJob> = jobs, model: string | null = null): { status: number; body: { cancelled?: boolean; error?: string; code?: string } } {
  try {
    return { status: 200, body: { cancelled: cancelWalkthrough("", source, root, store, model) } };
  } catch (cause) {
    const failure = cause as { status?: number; code?: string };
    const status = failure.status === 400 || typeof failure.status !== 'number' ? 400 : 500;
    return { status, body: { error: "Invalid walkthrough cancel request.", code: status === 400 ? String(failure.code ?? "invalid-source") : "cancel-failed" } };
  }
}
export function registerGitWalkthroughGenerateRoute(app: Hono): void {
  app.post('/api/git/walkthrough-generate', async (c) => {
    try {
      const body = await readJsonBodyBounded(c.req.raw, 4_096);
      return c.json(await generateWalkthrough(body?.directory as string, body?.sessionId as string, body?.revision as string,
        undefined, body?.source ?? body?.scope,
        { jobs, rawSource: body?.source ?? body?.scope, language: body?.language, model: body?.model, modelPorts: {} }));
    } catch (cause) {
      if (cause instanceof WalkthroughGenerateError) return c.json({ error: cause.message, code: cause.code }, cause.status as 400);
      if (cause instanceof SnapshotError) return c.json({ error: cause.message, code: cause.code }, cause.status as 403);
      return c.json({ error: 'Walkthrough generation failed.', code: 'generation-failed' }, 500);
    }
  });
  app.get('/api/git/walkthrough-readiness', async (c) => {
    try {
      const directory = c.req.query('directory');
      if (!directory) return c.json({ error: 'directory parameter is required', code: 'invalid-request' }, 400);
      const rawSource = c.req.query('source') ?? 'all';
      if (rawSource.length > 4_096) throw new WalkthroughGenerateError('Invalid walkthrough source.', 400, 'invalid-source');
      const source = rawSource === 'all' || rawSource === 'staged' || rawSource === 'working'
        ? parseWalkthroughSource(rawSource)
        : parseWalkthroughSource(JSON.parse(rawSource) ?? {});
      const selection = await modelSelection(directory, c.req.query('model'));
      const snapshot = getWalkthroughSnapshot(directory, undefined, source);
      const { digest } = digestFor(snapshot);
      const requiredChars = Buffer.byteLength(JSON.stringify(digest), 'utf8') + READINESS_PROMPT_OVERHEAD_CHARS;
      const readiness = walkthroughReadiness({
        digestCount: digest.length, fileCount: snapshot.fileCount, requiredChars, selection,
      });
      return c.json({ model: selection.model, options: selection.options, readiness });
    } catch (cause) {
      if (cause instanceof WalkthroughGenerateError) return c.json({ error: cause.message, code: cause.code }, cause.status as 502);
      if (cause instanceof Error && (cause as { status?: unknown }).status === 400) {
        return c.json({ error: cause.message,
          code: (cause as { code?: unknown }).code === 'invalid-source' ? 'invalid-source' : 'invalid-request' }, 400);
      }
      if (cause instanceof SnapshotError) return c.json({ error: cause.message, code: cause.code }, cause.status as 403);
      if (cause instanceof SyntaxError) return c.json({ error: 'Invalid walkthrough source.', code: 'invalid-source' }, 400);
      return c.json({ error: 'Walkthrough readiness failed.', code: 'readiness-failed' }, 500);
    }
  });
  app.get('/api/git/walkthrough-progress', (c) => {
    const directory = c.req.query('directory');
    if (!directory) return c.json({ error: 'directory parameter is required', code: 'invalid-request' }, 400);
    try {
      const state = walkthroughProgressState(c.req.query('source') ?? '{}', sourceRoot(directory), jobs,
        typeof c.req.query('model') === 'string' ? c.req.query('model') : null);
      return c.json(state.body, state.status as 200);
    } catch (cause) {
      if (cause instanceof SnapshotError) return c.json({ error: cause.message, code: cause.code }, cause.status as 500);
      throw cause;
    }
  });
  app.post('/api/git/walkthrough-cancel', async (c) => {
    try {
      const body = await readJsonBodyBounded(c.req.raw, 4_096);
      if (!body?.directory) return c.json({ error: 'directory parameter is required', code: 'invalid-request' }, 400);
      const state = walkthroughCancelState(body?.source ?? { kind: 'working-tree', scope: 'all' }, sourceRoot(body.directory as string), jobs,
        typeof body?.model === 'string' ? body.model : null);
      return c.json(state.body, state.status as 200);
    } catch (cause) {
      if (cause instanceof SnapshotError) return c.json({ error: cause.message, code: cause.code }, cause.status as 500);
      throw cause;
    }
  });
}
