// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../runtime-fetch.ts', () => ({ runtimeFetch: vi.fn() }));
import { runtimeFetch } from '../../runtime-fetch.ts';
import { cancelWalkthroughStage, fetchWalkthroughStage, generateWalkthroughPreview, loadWalkthroughPreview, type WalkthroughSource } from '../walkthrough-preview.ts';

const request = runtimeFetch as ReturnType<typeof vi.fn>;
const snapshot = { signature: 'server-revision', fileCount: 1, binaryFiles: 0, stops: [
  { id: 'working:a.ts:abcd1234', scope: 'working', path: 'a.ts', header: '@@ -1 +1 @@',
    oldStart: 1, newStart: 1, body: '-old\n+new' } as const,
] };
beforeEach(() => request.mockReset());

describe('deterministic walkthrough client', () => {
  it('uses one server-owned snapshot and preserves its hunk ID and signature', async () => {
    request.mockResolvedValue(new Response(JSON.stringify(snapshot), { status: 200 }));
    const result = await loadWalkthroughPreview('/repo');
    expect(request).toHaveBeenCalledOnce();
    expect(String(request.mock.calls[0]?.[0])).toContain('/api/git/walkthrough-snapshot?directory=%2Frepo&source=');
    expect(String(request.mock.calls[0]?.[0])).toContain(encodeURIComponent(JSON.stringify({ kind: 'working-tree', scope: 'all' })));
    expect(result.signature).toBe('server-revision');
    expect(result.stops[0]?.id).toBe('working:a.ts:abcd1234');
    expect(result.stops[0]?.body).toBe('-old\n+new');
  });

  it('encodes branch, commit, and PR source descriptors without interpolation', async () => {
    request.mockResolvedValue(new Response(JSON.stringify(snapshot), { status: 200 }));
    const source: WalkthroughSource = { kind: 'pr', number: 12, sourceRepo: { owner: 'owner', repo: 'repo' } };
    await loadWalkthroughPreview('/repo?x=1', source);
    expect(String(request.mock.calls[0]?.[0])).toContain('directory=%2Frepo%3Fx%3D1');
    expect(String(request.mock.calls[0]?.[0])).toContain(encodeURIComponent(JSON.stringify(source)));
  });

  it('reports stale/retry response rather than accepting a partial tour', async () => {
    request.mockResolvedValue(new Response(JSON.stringify({ error: 'Changes moved while capturing the diff. Retry.', code: 'snapshot-stale' }), { status: 409 }));
    await expect(loadWalkthroughPreview('/repo')).rejects.toThrow(/Retry/u);
  });

  it('rejects a malformed successful payload', async () => {
    request.mockResolvedValue(new Response(JSON.stringify({ files: [] }), { status: 200 }));
    await expect(loadWalkthroughPreview('/repo')).rejects.toThrow(/Invalid Git snapshot/u);
  });

  it('sends an explicit revision-bound generation request', async () => {
    request.mockResolvedValue(new Response(JSON.stringify({
      revision: 'rev1', title: 'Walkthrough', focus: 'Follow the change.', chapters: [{ id: 'chapter-1',
        title: 'Behavior', icon: 'gear', blurb: 'A behavior change.', stops: [{ id: 'stop-1',
          title: 'Changed value', importance: 'normal', prose: 'It changes.', hunks: [{ id: snapshot.stops[0]!.id,
            scope: 'working', path: 'a.ts', oldStart: 1, newStart: 1 }] }] }],
      omittedSensitiveHunks: 0, providerID: 'provider', modelID: 'model',
    }), { status: 200 }));
    await generateWalkthroughPreview('/repo', 'ses_test', 'rev1');
    expect(request.mock.calls[0]?.[0]).toBe('/api/git/walkthrough-generate');
    const init = request.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe('POST');
      expect(JSON.parse(String(init.body))).toEqual({
      directory: '/repo', sessionId: 'ses_test', revision: 'rev1',
        language: 'en',
      source: { kind: 'working-tree', scope: 'all' },
    });
  });

  it('rejects a successful narrative whose stop facts reject the live snapshot', async () => {
    request.mockResolvedValue(new Response(JSON.stringify({
      revision: 'rev1', title: 'Walkthrough', focus: 'Follow the change.', chapters: [{ id: 'chapter-1',
        title: 'Behavior', icon: 'gear', blurb: 'A behavior change.', stops: [{ id: 'stop-1',
          title: 'Changed value', importance: 'normal', prose: 'It changes.', hunks: [{
            id: snapshot.stops[0]!.id, scope: snapshot.stops[0]!.scope, path: 'wrong.ts', oldStart: 1, newStart: 1,
          }] }] }], omittedSensitiveHunks: 0, providerID: 'provider', modelID: 'model',
    }), { status: 200 }));
    await expect(generateWalkthroughPreview('/repo', 'ses_test', 'rev1',
      'all', 'en', snapshot.stops)).rejects.toThrow(/Invalid generated walkthrough response/u);
  });

  it('rejects malformed nested chapters without trusting their shape', async () => {
    request.mockResolvedValue(new Response(JSON.stringify({
      revision: 'rev1', chapters: [null], omittedSensitiveHunks: 0, providerID: 'provider', modelID: 'model',
    }), { status: 200 }));
    await expect(generateWalkthroughPreview('/repo', 'ses_test', 'rev1', 'all', 'en', snapshot.stops))
      .rejects.toThrow(/Invalid generated walkthrough response/u);
  });

  it('rejects generated prose outside the bounded schema', async () => {
    request.mockResolvedValue(new Response(JSON.stringify({
      revision: 'rev1', title: 'Walkthrough', focus: 'Follow the change.', chapters: [{ id: 'chapter-1',
        title: 'Behavior', icon: 'gear', blurb: 's'.repeat(601), stops: [{ id: 'stop-1',
          title: 'Changed value', importance: 'normal', prose: 'It changes.', hunks: [{
            id: snapshot.stops[0]!.id, scope: snapshot.stops[0]!.scope, path: snapshot.stops[0]!.path,
            oldStart: 1, newStart: 1,
          }] }] }], omittedSensitiveHunks: 0, providerID: 'provider', modelID: 'model',
    }), { status: 200 }));
    await expect(generateWalkthroughPreview('/repo', 'ses_test', 'rev1', 'all', 'en', snapshot.stops))
      .rejects.toThrow(/Invalid generated walkthrough response/u);
  });

  it('polls and cancels the explicit server-side generation lifecycle', async () => {
    request.mockResolvedValueOnce(new Response(JSON.stringify({ stage: 'asking' }), { status: 200 }));
    expect(await fetchWalkthroughStage('/repo', { kind: 'commit', hash: 'a'.repeat(40) })).toBe('asking');
    expect(String(request.mock.calls[0]?.[0])).toContain('/api/git/walkthrough-progress?directory=%2Frepo&source=');

    request.mockResolvedValueOnce(new Response(JSON.stringify({ cancelled: true }), { status: 200 }));
    expect(await cancelWalkthroughStage('/repo', { kind: 'commit', hash: 'a'.repeat(40) })).toBe(true);
    const cancelInit = request.mock.calls[1]?.[1] as RequestInit;
    expect(cancelInit.method).toBe('POST');
    expect(JSON.parse(String(cancelInit.body))).toEqual({ directory: '/repo', source: { kind: 'commit', hash: 'a'.repeat(40) } });
  });
});
