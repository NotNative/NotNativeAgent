// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../runtime-fetch.ts', () => ({ runtimeFetch: vi.fn() }));
import { runtimeFetch } from '../../runtime-fetch.ts';
import { generateWalkthroughPreview, loadWalkthroughPreview } from '../walkthrough-preview.ts';

const request = runtimeFetch as ReturnType<typeof vi.fn>;
const snapshot = { signature: 'server-revision', fileCount: 1, binaryFiles: 0, stops: [
  { id: 'working:a.ts:abcd1234', scope: 'working', path: 'a.ts', header: '@@ -1 +1 @@',
    oldStart: 1, newStart: 1, body: '-old\n+new' },
] };
beforeEach(() => request.mockReset());

describe('deterministic walkthrough client', () => {
  it('uses one server-owned snapshot and preserves its hunk ID and signature', async () => {
    request.mockResolvedValue(new Response(JSON.stringify(snapshot), { status: 200 }));
    const result = await loadWalkthroughPreview('/repo');
    expect(request).toHaveBeenCalledOnce();
    expect(String(request.mock.calls[0]?.[0])).toContain('/api/git/walkthrough-snapshot?directory=%2Frepo&scope=all');
    expect(result.signature).toBe('server-revision');
    expect(result.stops[0]?.id).toBe('working:a.ts:abcd1234');
    expect(result.stops[0]?.body).toBe('-old\n+new');
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
    request.mockResolvedValue(new Response(JSON.stringify({ revision: 'rev1', chapters: [], omittedSensitiveHunks: 0 }), { status: 200 }));
    await generateWalkthroughPreview('/repo', 'ses_test', 'rev1');
    expect(request.mock.calls[0]?.[0]).toBe('/api/git/walkthrough-generate');
    const init = request.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ directory: '/repo', sessionId: 'ses_test', revision: 'rev1', scope: 'all' });
  });
});
