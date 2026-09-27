// SPDX-License-Identifier: Apache-2.0
/** Explicit, revision-bound model explanation for a local diff snapshot. */
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Hono } from 'hono';
import { readJsonBodyBounded } from '../lib/http/read-bounded.ts';
import { callHarness, harnessRequest } from '../queue/queue-adapter-calls.ts';
import { getWalkthroughSnapshot, SnapshotError, type WalkthroughScope } from './git-walkthrough-snapshot.ts';

const SESSION_ID = /^[A-Za-z0-9_-]{4,128}$/u;
const REVISION = /^[a-f0-9]{64}$/u;
const MAX_DIGEST_BYTES = 64_000;
const MAX_TEXT = 65_536;
type Snapshot = ReturnType<typeof getWalkthroughSnapshot>;
type ModelStop = { alias: string; explanation: string };
type ModelChapter = { title: string; stops: ModelStop[] };

export class WalkthroughGenerateError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) { super(message); }
}

function sameDirectory(left: string, right: string): boolean {
  const normalize = (path: string): string => process.platform === 'win32' ? path.toLowerCase() : path;
  try { return normalize(realpathSync(left)) === normalize(realpathSync(right)); }
  catch { return normalize(resolve(left)) === normalize(resolve(right)); }
}

function sensitivePath(path: string): boolean {
  const name = path.replaceAll('\\', '/').split('/').at(-1)?.toLowerCase() ?? '';
  return name === '.env' || name.startsWith('.env.') || /\.(?:pem|key|p12|pfx|kdbx)$/u.test(name);
}

export function digestFor(snapshot: Snapshot): { digest: unknown[]; aliases: Map<string, Snapshot['stops'][number]>; omitted: number } {
  const digest: unknown[] = [];
  const aliases = new Map<string, Snapshot['stops'][number]>();
  let omitted = 0;
  for (const stop of snapshot.stops) {
    // A rename can expose the former sensitive file through a harmless new
    // filename; the patch still contains its old contents.
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

export async function generateWalkthrough(directory: string, sessionId: string, expected: string,
  ports: { snapshot: typeof getWalkthroughSnapshot; call: typeof callHarness } = { snapshot: getWalkthroughSnapshot, call: callHarness },
  scope: WalkthroughScope = 'all'): Promise<unknown> {
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId) || typeof expected !== 'string' || !REVISION.test(expected)
    || typeof directory !== 'string' || !directory || directory.length > 4096 || !['all', 'staged', 'working'].includes(scope)) {
    throw new WalkthroughGenerateError('Invalid walkthrough request.', 400, 'invalid-request');
  }
  const snapshot = ports.snapshot(directory, undefined, scope);
  if (snapshot.signature !== expected) throw new WalkthroughGenerateError('Diff changed; refresh before generating.', 409, 'snapshot-stale');
  const { digest, aliases, omitted } = digestFor(snapshot);
  if (!digest.length) throw new WalkthroughGenerateError('No reviewable non-sensitive text hunks.', 409, 'empty-diff');
  const session = await ports.call(harnessRequest(`/session/${encodeURIComponent(sessionId)}`, directory, {
    method: 'GET', signal: AbortSignal.timeout(5_000),
  }));
  const owner = await session.json().catch(() => null) as { directory?: unknown } | null;
  if (!session.ok || typeof owner?.directory !== 'string' || !sameDirectory(owner.directory, directory)) {
    throw new WalkthroughGenerateError('Session does not belong to this workspace.', 403, 'session-scope');
  }
  const response = await ports.call(harnessRequest(`/v1/nnd/sessions/${encodeURIComponent(sessionId)}/walkthrough`, directory, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ revision: snapshot.signature, digest }), signal: AbortSignal.timeout(50_000),
  }));
  const result = await response.json().catch(() => null) as { text?: unknown; revision?: unknown; providerID?: unknown; modelID?: unknown; error?: { message?: string } } | null;
  if (!response.ok) throw new WalkthroughGenerateError(result?.error?.message ?? 'Walkthrough model is unavailable.', response.status, 'model-unavailable');
  if (result?.revision !== snapshot.signature || typeof result.text !== 'string' || result.text.length > MAX_TEXT
    || typeof result.providerID !== 'string' || !result.providerID || result.providerID.length > 256
    || typeof result.modelID !== 'string' || !result.modelID || result.modelID.length > 256) {
    throw new WalkthroughGenerateError('Model response does not match this diff revision.', 502, 'invalid-walkthrough');
  }
  const chapters = normalizeWalkthrough(result.text, aliases);
  const current = ports.snapshot(directory, undefined, scope);
  if (current.signature !== snapshot.signature) throw new WalkthroughGenerateError('Diff changed during generation; refresh and retry.', 409, 'snapshot-stale');
  return { revision: snapshot.signature, chapters: chapters.map((chapter) => ({ title: chapter.title,
    stops: chapter.stops.map((item) => ({ id: aliases.get(item.alias)!.id, explanation: item.explanation })) })),
    omittedSensitiveHunks: omitted, providerID: result.providerID, modelID: result.modelID };
}

export function registerGitWalkthroughGenerateRoute(app: Hono): void {
  app.post('/api/git/walkthrough-generate', async (c) => {
    try {
      const body = await readJsonBodyBounded(c.req.raw, 4_096);
      return c.json(await generateWalkthrough(body?.directory as string, body?.sessionId as string, body?.revision as string,
        undefined, body?.scope as WalkthroughScope));
    } catch (cause) {
      if (cause instanceof WalkthroughGenerateError) return c.json({ error: cause.message, code: cause.code }, cause.status as 400);
      if (cause instanceof SnapshotError) return c.json({ error: cause.message, code: cause.code }, cause.status as 403);
      return c.json({ error: 'Walkthrough generation failed.', code: 'generation-failed' }, 500);
    }
  });
}
