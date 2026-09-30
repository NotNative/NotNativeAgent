// SPDX-License-Identifier: Apache-2.0
/** Explicit, revision-bound model explanation with attachable generation jobs. */
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Hono } from 'hono';
import { readJsonBodyBounded } from '../lib/http/read-bounded.ts';
import { callHarness, harnessRequest } from '../queue/queue-adapter-calls.ts';
import { getWalkthroughSnapshot, SnapshotError, sourceRoot } from './git-walkthrough-snapshot.ts';
import { parseWalkthroughSource, sourceKey } from './git-walkthrough-sources.ts';

const SESSION_ID = /^[A-Za-z0-9_-]{4,128}$/u;
const REVISION = /^[a-f0-9]{40}$|^[a-f0-9]{64}$/u;
const MAX_DIGEST_BYTES = 64_000;
const MAX_TEXT = 65_536;
type Snapshot = ReturnType<typeof getWalkthroughSnapshot>;
type ModelStop = { alias: string; explanation: string };
type ModelChapter = { title: string; stops: ModelStop[] };
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
    digest.push({ alias, scope: stop.scope, path: stop.path, header: stop.header, patch: stop.body });
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

export function normalizeWalkthrough(text: string, aliases: Map<string, Snapshot['stops'][number]>): ModelChapter[] {
  const raw = parsedObject(text).chapters;
  if (!Array.isArray(raw) || raw.length > 12) throw new WalkthroughGenerateError('Model returned invalid chapters.', 502, 'invalid-walkthrough');
  const used = new Set<string>();
  const chapters: ModelChapter[] = [];
  for (const chapter of raw) {
    if (!chapter || typeof chapter !== 'object' || Array.isArray(chapter)) continue;
    const shaped = chapter as { title?: unknown; stops?: unknown };
    if (typeof shaped.title !== 'string' || !shaped.title.trim() || shaped.title.length > 120 || !Array.isArray(shaped.stops)) continue;
    const stops: ModelStop[] = [];
    for (const item of shaped.stops.slice(0, 200)) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const stop = item as { alias?: unknown; explanation?: unknown };
      if (typeof stop.alias !== 'string' || !aliases.has(stop.alias) || used.has(stop.alias)
        || typeof stop.explanation !== 'string' || !stop.explanation.trim() || stop.explanation.length > 1_000) continue;
      used.add(stop.alias);
      stops.push({ alias: stop.alias, explanation: stop.explanation.trim() });
    }
    if (stops.length) chapters.push({ title: shaped.title.trim(), stops });
  }
  if (!chapters.length) throw new WalkthroughGenerateError('Model did not explain any current hunk.', 502, 'invalid-walkthrough');
  return chapters;
}

function cancelledIfAborted(job: WalkthroughJob): void {
  if (job.controller.signal.aborted) throw new WalkthroughGenerateError('Walkthrough generation cancelled.', 499, 'cancelled');
}

function parseInputs(sessionId: unknown, expected: unknown, directory: unknown, rawSource: unknown): {
  sessionId: string; expected: string; directory: string;
} {
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId) || typeof expected !== 'string' || !REVISION.test(expected)
    || typeof directory !== 'string' || !directory || directory.length > 4096) {
    throw new WalkthroughGenerateError('Invalid walkthrough request.', 400, 'invalid-request');
  }
  try { parseWalkthroughSource(rawSource); } catch {
    throw new WalkthroughGenerateError('Invalid walkthrough request.', 400, 'invalid-request');
  }
  return { sessionId, expected, directory };
}

async function runGeneration(input: {
  sessionId: string; expected: string; directory: string;
  ports: Partial<Record<'snapshot' | 'call' | 'root', any>>;
  rawSource: unknown;
  job: WalkthroughJob;
}): Promise<unknown> {
  const { sessionId, expected, directory, ports } = input;
  const rawSource = input.rawSource;
  const job = input.job;
  const source = parseWalkthroughSource(rawSource);
  setStage(job, 'collecting');
  const snapshot = ports.snapshot(directory, undefined, source);
  if (snapshot.signature !== expected) throw new WalkthroughGenerateError('Diff changed; refresh before generating.', 409, 'snapshot-stale');
  const { digest, aliases, omitted } = digestFor(snapshot);
  if (!digest.length) throw new WalkthroughGenerateError('No reviewable non-sensitive text hunks.', 409, 'empty-diff');
  setStage(job, 'asking');
  const session = await ports.call(harnessRequest(`/session/${encodeURIComponent(sessionId)}`, directory, {
    method: 'GET', signal: signalWithDeadline(job, 5_000),
  }));
  const owner = await session.json().catch(() => null) as { directory?: unknown } | null;
  if (!session.ok || typeof owner?.directory !== 'string' || !sameDirectory(owner.directory, directory)) {
    throw new WalkthroughGenerateError('Session does not belong to this workspace.', 403, 'session-scope');
  }
  const response = await ports.call(harnessRequest(`/v1/nnd/sessions/${encodeURIComponent(sessionId)}/walkthrough`, directory, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ revision: snapshot.signature, digest }), signal: signalWithDeadline(job, 50_000),
  }));
  const result = await response.json().catch(() => null) as { text?: unknown; revision?: unknown; providerID?: unknown; modelID?: unknown; error?: { message?: string } } | null;
  if (!response.ok) throw new WalkthroughGenerateError(result?.error?.message ?? 'Walkthrough model is unavailable.', response.status, 'model-unavailable');
  if (!result || result.revision !== snapshot.signature || typeof result.text !== 'string' || result.text.length > MAX_TEXT
    || typeof result.providerID !== 'string' || !result.providerID || result.providerID.length > 256
    || typeof result.modelID !== 'string' || !result.modelID || result.modelID.length > 256) {
    throw new WalkthroughGenerateError('Model response does not match this diff revision.', 502, 'invalid-walkthrough');
  }
  setStage(input.job, 'assembling');
  const chapters = normalizeWalkthrough(result.text, aliases);
  const current = ports.snapshot(directory, undefined, source);
  if (current.signature !== snapshot.signature) {
    throw new WalkthroughGenerateError('Diff changed during generation; refresh and retry.', 409, 'snapshot-stale');
  }
  cancelledIfAborted(input.job);
  return { revision: snapshot.signature, chapters: chapters.map((chapter) => ({ title: chapter.title,
    stops: chapter.stops.map((item) => ({ id: aliases.get(item.alias)!.id, explanation: item.explanation })) })),
    omittedSensitiveHunks: omitted, providerID: result.providerID, modelID: result.modelID };
}

export async function generateWalkthrough(directory: string, sessionId: string, expected: string,
  ports: { snapshot: typeof getWalkthroughSnapshot; call: typeof callHarness; root?: typeof sourceRoot } = { snapshot: getWalkthroughSnapshot, call: callHarness },
  rawSource: unknown = 'all',
  context: { jobs?: Map<string, WalkthroughJob>; rawSource?: unknown } = {}): Promise<unknown> {
  parseInputs(sessionId, expected, directory, rawSource);
  const source = parseWalkthroughSource(rawSource);
  const root = ports.root?.(directory) ?? sourceRoot(directory);
  const key = `${root.toLowerCase()}\0${sourceKey(source)}`;
  const existing = context.jobs?.get(key);
  if (existing && existing.state === 'running') {
    if (existing.expected !== expected) throw new WalkthroughGenerateError('Diff changed; refresh before generating.', 409, 'snapshot-stale');
    return existing.promise;
  }
  const controller = new AbortController();
  const job: WalkthroughJob = { stage: 'collecting', state: 'running', expected, controller, promise: Promise.resolve<unknown>(null), error: null };
  const generation = { sessionId, expected, directory, rawSource, ports, job };
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
  root: string, store: Map<string, WalkthroughJob>): WalkthroughStage | null {
  const source = parseWalkthroughSource(sourceRaw);
  const key = `${root.toLowerCase()}\0${sourceKey(source)}`;
  return store.get(key)?.stage ?? null;
}

export function cancelWalkthrough(_directory: string, sourceRaw: unknown,
  root: string, store: Map<string, WalkthroughJob>): boolean {
  try {
    const source = parseWalkthroughSource(sourceRaw);
    const key = `${root.toLowerCase()}\0${sourceKey(source)}`;
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
  store: Map<string, WalkthroughJob> = jobs): { status: number; body: Record<string, unknown> } {
  try {
    return { status: 200, body: { stage: walkthroughProgress("", JSON.parse(encodedSource), root, store) } };
  } catch (cause) {
    const failure = cause as { status?: number; code?: string };
    const status = failure.status === 400 || typeof failure.status !== 'number' ? 400 : 500;
    return { status, body: { error: "Invalid walkthrough progress request.", code: status === 400 ? String(failure.code ?? "invalid-source") : "progress-failed" } };
  }
}

export function walkthroughCancelState(source: unknown, root: string,
  store: Map<string, WalkthroughJob> = jobs): { status: number; body: { cancelled?: boolean; error?: string; code?: string } } {
  try {
    return { status: 200, body: { cancelled: cancelWalkthrough("", source, root, store) } };
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
        undefined, body?.source ?? body?.scope, { jobs, rawSource: body?.source ?? body?.scope }));
    } catch (cause) {
      if (cause instanceof WalkthroughGenerateError) return c.json({ error: cause.message, code: cause.code }, cause.status as 400);
      if (cause instanceof SnapshotError) return c.json({ error: cause.message, code: cause.code }, cause.status as 403);
      return c.json({ error: 'Walkthrough generation failed.', code: 'generation-failed' }, 500);
    }
  });
  app.get('/api/git/walkthrough-progress', (c) => {
    const directory = c.req.query('directory');
    if (!directory) return c.json({ error: 'directory parameter is required', code: 'invalid-request' }, 400);
    try {
      const state = walkthroughProgressState(c.req.query('source') ?? '{}', sourceRoot(directory));
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
      const state = walkthroughCancelState(body?.source ?? { kind: 'working-tree', scope: 'all' }, sourceRoot(body.directory as string));
      return c.json(state.body, state.status as 200);
    } catch (cause) {
      if (cause instanceof SnapshotError) return c.json({ error: cause.message, code: cause.code }, cause.status as 500);
      throw cause;
    }
  });
}
