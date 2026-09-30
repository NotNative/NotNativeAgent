// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cancelWalkthrough, digestFor, generateWalkthrough, normalizeWalkthrough, walkthroughProgress,
  walkthroughProgressState,
  type WalkthroughJob } from '../routes/git-walkthrough-generate.ts';
import { getWalkthroughSnapshot } from '../routes/git-walkthrough-snapshot.ts';
import { sourceKey } from '../routes/git-walkthrough-sources.ts';
import { WalkthroughCache } from '../lib/walkthrough/cache.ts';

const revision = 'a'.repeat(64);
const tempCacheDir = (): string => {
  const parent = mkdtempSync(join(tmpdir(), 'nnd-walkthrough-cache-'));
  rmSync(parent, { recursive: true, force: true });
  return parent;
};
const stop = (path: string, id = 'working:a.ts:12345678', oldPath?: string) => ({ id, scope: 'working' as const, path,
  ...(oldPath ? { oldPath } : {}),
  header: '@@ -1 +1 @@', oldStart: 1, newStart: 1, body: '-old\n+new' });
const snapshot = (stops = [stop('a.ts')], signature = revision): ReturnType<typeof getWalkthroughSnapshot> =>
  ({ signature, stops, fileCount: stops.length, binaryFiles: 0 });
const narrative = JSON.stringify({ chapters: [{ title: 'Behavior', stops: [
  { alias: 'h1', explanation: 'The value changes.' }, { alias: 'fake', explanation: 'Invented.' },
] }] });

describe('walkthrough generation lifecycle', () => {
  it('never returns generated content after an explicit cancel lands', async () => {
    const store = new Map<string, WalkthroughJob>();
    let release: (error: Error) => void = () => undefined;
    const ports = { root: () => '/job-root', snapshot: () => snapshot(), call: async (request: Request) => {
      if (new URL(request.url).pathname.endsWith('/session/ses_test')) return json({ directory: '/repo' });
      await new Promise((_resolve, reject) => { release = reject; });
      return json({ revision, text: narrative, providerID: 'local', modelID: 'small' });
    } };
    const pending = generateWalkthrough('/repo', 'ses_test', revision, ports, 'all', { jobs: store, rawSource: 'all' });
    await new Promise((resolve) => setTimeout(resolve));
    expect(cancelWalkthrough('/repo', { kind: 'working-tree', scope: 'all' }, '/job-root', store)).toBe(true);
    release(new Error('aborted transport'));
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('reports progress failures as structured source answers, not raw 500 text', async () => {
    const { Hono } = await import('hono');
    const { registerGitWalkthroughGenerateRoute } = await import('../routes/git-walkthrough-generate.ts');
    const app = new Hono();
    registerGitWalkthroughGenerateRoute(app);
    const target = 'definitely-missing-repo';
    const response = await app.request('/api/git/walkthrough-progress?source=all&directory=' + encodeURIComponent(target));
    const body = await response.json() as { error?: string; code?: string };
    expect(body.code).toBe('git-failed');
  });

  it('returns malformed readiness source as a request error', async () => {
    const { Hono } = await import('hono');
    const { registerGitWalkthroughGenerateRoute } = await import('../routes/git-walkthrough-generate.ts');
    const app = new Hono();
    registerGitWalkthroughGenerateRoute(app);
    const response = await app.request('/api/git/walkthrough-readiness?directory=missing&source=not-json');
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'invalid-source' });
  });
});
const json = (value: unknown, status = 200): Response => Response.json(value, { status });

describe('model-authored walkthrough boundary', () => {
  it('omits known sensitive paths and normalizes only current server-owned hunk IDs', () => {
    const current = snapshot([stop('.env', 'secret'), stop('config.ts', 'renamed-secret', '.env.local'), stop('id_ed25519', 'ssh-key'), stop('id_rsa.pub', 'public-key'), stop('a.ts')]);
    const digest = digestFor(current);
    expect(digest.omitted).toBe(3);
    expect(digest.digest).toEqual([
      { alias: 'h1', scope: 'working', path: 'id_rsa.pub', header: '@@ -1 +1 @@', patch: '-old\n+new' },
      { alias: 'h2', scope: 'working', path: 'a.ts', header: '@@ -1 +1 @@', patch: '-old\n+new' },
    ]);
    expect(normalizeWalkthrough(narrative, digest.aliases)).toEqual([{ title: 'Behavior', stops: [
      { alias: 'h1', explanation: 'The value changes.' },
    ] }]);
  });

  it('requires a matching snapshot before calling NNA and again after generation', async () => {
    let reads = 0;
    let calls = 0;
    const ports = { root: () => '/test-root', snapshot: () => { reads += 1; return snapshot([], reads === 1 ? revision : 'b'.repeat(64)); },
      call: async (_request: Request) => { calls += 1; return json({}); } };
    await expect(generateWalkthrough('/repo', 'ses_test', 'b'.repeat(64), ports)).rejects.toMatchObject({ code: 'snapshot-stale' });
    expect(calls).toBe(0);
    reads = 0;
    const valid = { root: () => '/test-root', snapshot: () => { reads += 1; return snapshot([stop('a.ts')], reads === 1 ? revision : 'b'.repeat(64)); },
      call: async (request: Request) => {
        calls += 1;
        if (new URL(request.url).pathname.endsWith('/session/ses_test')) return json({ directory: '/repo' });
        return json({ revision, text: narrative, providerID: 'local', modelID: 'small' });
      } };
    await expect(generateWalkthrough('/repo', 'ses_test', revision, valid)).rejects.toMatchObject({ code: 'snapshot-stale' });
    expect(calls).toBe(2);
  });

  it('checks session workspace before sending a diff to the model', async () => {
    let calls = 0;
    const ports = { root: () => '/test-root', snapshot: () => snapshot(), call: async () => { calls += 1; return json({ directory: '/other' }); } };
    await expect(generateWalkthrough('/repo', 'ses_test', revision, ports)).rejects.toMatchObject({ code: 'session-scope' });
    expect(calls).toBe(1);
  });

  it('passes a valid explicit model and refuses a mismatched NNA response', async () => {
    let bodies: unknown[] = [];
    let modelCalls = 0;
    const ports = { root: () => '/test-root', snapshot: () => snapshot(),
      call: async (request: Request) => {
        if (new URL(request.url).pathname.endsWith('/session/ses_test')) return json({ directory: '/repo' });
        modelCalls += 1;
        bodies.push(JSON.parse(await request.clone().text()));
        return json({ revision, text: narrative, providerID: 'audit-local',
          modelID: modelCalls === 1 ? 'small' : 'other' });
      } };
    await expect(generateWalkthrough('/repo', 'ses_test', revision, ports, 'all',
      { model: 'audit-local/small', cache: new WalkthroughCache(join(tempCacheDir(), 'cache.json')) }))
      .resolves.toMatchObject({ providerID: 'audit-local', modelID: 'small' });
    expect(bodies[0]).toMatchObject({ model: 'audit-local/small' });
    bodies = [];
    await expect(generateWalkthrough('/repo', 'ses_test', revision, ports, 'all',
      { model: 'audit-local/small', cache: new WalkthroughCache(join(tempCacheDir(), 'cache.json')) }))
      .rejects.toMatchObject({ code: 'model-changed' });
    await expect(generateWalkthrough('/repo', 'ses_test', revision, ports, 'all', { model: 'invalid' }))
      .rejects.toMatchObject({ code: 'invalid-model' });
    expect(bodies).toHaveLength(1);
  });

  it('sends only the aliased digest to NNA and returns text attached to server IDs', async () => {
    const seen: Request[] = [];
    const ports = { root: () => '/test-root', snapshot: () => snapshot(), call: async (request: Request) => {
      seen.push(request);
      if (new URL(request.url).pathname.endsWith('/session/ses_test')) return json({ directory: '/repo' });
      return json({ revision, text: narrative, providerID: 'local', modelID: 'small' });
    } };
    const result = await generateWalkthrough('/repo', 'ses_test', revision, ports);
    expect(result).toMatchObject({ revision, chapters: [{ title: 'Behavior', stops: [
      { id: 'working:a.ts:12345678', explanation: 'The value changes.' },
    ] }] });
    const sent = await seen[1]!.json() as { revision: string; digest: unknown[] };
    expect(sent.revision).toBe(revision);
    expect(sent.digest).toHaveLength(1);
    expect(JSON.stringify(sent)).not.toContain('fake');
  });

  it('rechecks the selected staged scope and refuses an invalid scope before any NNA call', async () => {
    const scopes: unknown[] = [];
    let calls = 0;
    const ports = { root: () => '/test-root', snapshot: (_directory: string, _after: unknown, scope: unknown) => {
      scopes.push(scope); return snapshot();
    }, call: async (request: Request) => {
      calls += 1;
      if (new URL(request.url).pathname.endsWith('/session/ses_test')) return json({ directory: '/repo' });
      return json({ revision, text: narrative, providerID: 'local', modelID: 'small' });
    } };
    await generateWalkthrough('/repo', 'ses_test', revision, ports, 'staged');
    expect(scopes).toEqual([{ kind: 'working-tree', scope: 'staged' }, { kind: 'working-tree', scope: 'staged' }]);
    await expect(generateWalkthrough('/repo', 'ses_test', revision, ports, 'invalid' as 'all'))
      .rejects.toMatchObject({ code: 'invalid-request' });
    expect(calls).toBe(2);
  });

  it('rechecks a non-working-tree source and accepts the compatible server signature', async () => {
    const sources: unknown[] = [];
    const sourceRevision = 'b'.repeat(40);
    let calls = 0;
    const ports = { root: () => '/test-root', snapshot: (_directory: string, _after: unknown, source: unknown) => {
      sources.push(source);
      return { ...snapshot(), signature: sourceRevision };
    }, call: async (request: Request) => {
      calls += 1;
      if (new URL(request.url).pathname.endsWith('/session/ses_test')) return json({ directory: '/repo' });
      return json({ revision: sourceRevision, text: narrative, providerID: 'local', modelID: 'small' });
    } };
    const result = await generateWalkthrough('/repo', 'ses_test', sourceRevision, ports, { kind: 'commit', hash: 'a'.repeat(40) }) as { revision: string };
    expect(sources).toEqual([{ kind: 'commit', hash: 'a'.repeat(40) }, { kind: 'commit', hash: 'a'.repeat(40) }]);
    expect(result.revision).toBe(sourceRevision);
    expect(calls).toBe(2);
  });
});

  it('attaches a second request to the same running source job', async () => {
    const roots: Array<{ stage: string; state: string; controller: AbortController; promise: Promise<unknown>; error: unknown }> = [];
    let calls = 0;
    const ports = { root: () => '/job-root', snapshot: () => snapshot(), call: async (request: Request) => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (new URL(request.url).pathname.endsWith('/session/ses_test')) return json({ directory: '/repo' });
      return json({ revision, text: narrative, providerID: 'local', modelID: 'small' });
    } };
    const store = new Map<string, WalkthroughJob>();
    const [first, second] = await Promise.all([
      generateWalkthrough('/repo', 'ses_test', revision, ports, 'all', { jobs: store, rawSource: 'all' }),
      generateWalkthrough('/repo', 'ses_test', revision, ports, 'all', { jobs: store, rawSource: 'all' }),
    ]);
    expect(first).toMatchObject({ revision });
    expect(second).toMatchObject({ revision });
    expect(calls).toBe(2);
  });

  it('reports source progress and honors explicit cancellation', async () => {
    const store = new Map<string, WalkthroughJob>();
    const root = '/job-root';
    expect(walkthroughProgress('/repo', { kind: 'working-tree', scope: 'all' }, root, store)).toBeNull();
    expect(cancelWalkthrough('/repo', { kind: 'working-tree', scope: 'all' }, root, store)).toBe(false);
    store.set(root.toLowerCase() + ' working-tree:all', {
      stage: 'asking', state: 'running', expected: revision, controller: new AbortController(), promise: Promise.resolve({}), error: null,
    });
    expect(walkthroughProgress('/repo', 'all', root, store)).toBe('asking');
    expect(walkthroughProgress('/repo', 'all', root, store, 'audit-mobile/small')).toBeNull();
    expect(cancelWalkthrough('/repo', { kind: 'working-tree', scope: 'all' }, root, store)).toBe(true);
    expect(store.get(root.toLowerCase() + ' working-tree:all')!.controller.signal.aborted).toBe(true);
  });

  it('keeps explicit-model progress and cancellation isolated from the default chain', () => {
    const store = new Map<string, WalkthroughJob>();
    const root = '/job-root';
    store.set(`${root.toLowerCase()}\0${sourceKey({ kind: 'working-tree', scope: 'all' })}\0audit-mobile/small`, {
      stage: 'asking', state: 'running', expected: revision, controller: new AbortController(),
      promise: Promise.resolve({}), error: null,
    });
    expect(walkthroughProgress('/repo', 'all', root, store)).toBeNull();
    expect(walkthroughProgress('/repo', 'all', root, store, 'audit-mobile/small')).toBe('asking');
    expect(cancelWalkthrough('/repo', { kind: 'working-tree', scope: 'all' }, root, store, 'other-model')).toBe(false);
    expect(cancelWalkthrough('/repo', { kind: 'working-tree', scope: 'all' }, root, store, 'audit-mobile/small')).toBe(true);
  });

  it('rejects a revision mismatch while the source job is already running', async () => {
    const store = new Map<string, WalkthroughJob>();
    const root = '/job-root';
    store.set(`${root.toLowerCase()}\0working-tree:all`, {
      stage: 'asking', state: 'running', expected: revision, controller: new AbortController(), promise: Promise.resolve({}), error: null,
    });
    expect(cancelWalkthrough('/repo', { kind: 'working-tree', scope: 'all' }, root, store, 'audit-mobile/small')).toBe(false);
    await expect(generateWalkthrough('/repo', 'ses_test', 'b'.repeat(64), {
      root: () => root, snapshot: () => snapshot(), call: async () => { throw new Error('unexpected model call'); },
    }, 'all', { jobs: store, rawSource: 'all' })).rejects.toMatchObject({ code: 'snapshot-stale' });
  });

  it('returns malformed progress source as a request error', () => {
    const store = new Map<string, WalkthroughJob>();
    expect(walkthroughProgressState('not-json', '/job-root', store)).toMatchObject({
      status: 400,
      body: { code: 'invalid-source' },
    });
  });
