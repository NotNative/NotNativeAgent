// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { digestFor, generateWalkthrough, normalizeWalkthrough } from '../routes/git-walkthrough-generate.ts';
import { getWalkthroughSnapshot } from '../routes/git-walkthrough-snapshot.ts';

const revision = 'a'.repeat(64);
const stop = (path: string, id = 'working:a.ts:12345678', oldPath?: string) => ({ id, scope: 'working' as const, path,
  ...(oldPath ? { oldPath } : {}),
  header: '@@ -1 +1 @@', oldStart: 1, newStart: 1, body: '-old\n+new' });
const snapshot = (stops = [stop('a.ts')], signature = revision): ReturnType<typeof getWalkthroughSnapshot> =>
  ({ signature, stops, fileCount: stops.length, binaryFiles: 0 });
const narrative = JSON.stringify({ chapters: [{ title: 'Behavior', stops: [
  { alias: 'h1', explanation: 'The value changes.' }, { alias: 'fake', explanation: 'Invented.' },
] }] });
const json = (value: unknown, status = 200): Response => Response.json(value, { status });

describe('model-authored walkthrough boundary', () => {
  it('omits known sensitive paths and normalizes only current server-owned hunk IDs', () => {
    const current = snapshot([stop('.env', 'secret'), stop('config.ts', 'renamed-secret', '.env.local'), stop('a.ts')]);
    const digest = digestFor(current);
    expect(digest.omitted).toBe(2);
    expect(digest.digest).toEqual([{ alias: 'h1', scope: 'working', path: 'a.ts', header: '@@ -1 +1 @@', patch: '-old\n+new' }]);
    expect(normalizeWalkthrough(narrative, digest.aliases)).toEqual([{ title: 'Behavior', stops: [
      { alias: 'h1', explanation: 'The value changes.' },
    ] }]);
  });

  it('requires a matching snapshot before calling NNA and again after generation', async () => {
    let reads = 0;
    let calls = 0;
    const ports = { snapshot: () => { reads += 1; return snapshot([], reads === 1 ? revision : 'b'.repeat(64)); },
      call: async (_request: Request) => { calls += 1; return json({}); } };
    await expect(generateWalkthrough('/repo', 'ses_test', 'b'.repeat(64), ports)).rejects.toMatchObject({ code: 'snapshot-stale' });
    expect(calls).toBe(0);
    reads = 0;
    const valid = { snapshot: () => { reads += 1; return snapshot([stop('a.ts')], reads === 1 ? revision : 'b'.repeat(64)); },
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
    const ports = { snapshot: () => snapshot(), call: async () => { calls += 1; return json({ directory: '/other' }); } };
    await expect(generateWalkthrough('/repo', 'ses_test', revision, ports)).rejects.toMatchObject({ code: 'session-scope' });
    expect(calls).toBe(1);
  });

  it('sends only the aliased digest to NNA and returns text attached to server IDs', async () => {
    const seen: Request[] = [];
    const ports = { snapshot: () => snapshot(), call: async (request: Request) => {
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
    const ports = { snapshot: (_directory: string, _after: unknown, scope: unknown) => {
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
    const ports = { snapshot: (_directory: string, _after: unknown, source: unknown) => {
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
