// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../runtime-fetch.ts', () => ({ runtimeFetch: vi.fn() }));

import { runtimeFetch } from '../../runtime-fetch.ts';
import { useGitStore } from '../store.ts';

const fetchMock = vi.mocked(runtimeFetch);

beforeEach(() => {
  fetchMock.mockReset();
  useGitStore.getState().__resetForTests();
});

describe('Git status invalidation', () => {
  it('discards an in-flight pre-mutation snapshot after branch checkout invalidates it', async () => {
    let releaseOld: ((response: Response) => void) | null = null;
    fetchMock.mockImplementationOnce(async () => new Promise<Response>((resolve) => { releaseOld = resolve; }));
    fetchMock.mockImplementationOnce(async () => ({
      ok: true,
      json: async () => ({ isGitRepository: true, branch: 'feature', trackingAhead: 0, trackingBehind: 0, files: [] }),
    } as Response));

    const store = useGitStore.getState();
    const oldRequest = store.ensureStatus('/repo', 'light');
    expect(releaseOld).not.toBeNull();
    store.invalidateStatus('/repo');
    const fresh = await store.ensureStatus('/repo', 'full');
    expect(fresh?.branch).toBe('feature');
    releaseOld!({ ok: true, json: async () => ({
      isGitRepository: true, branch: 'main', trackingAhead: 0, trackingBehind: 0, files: [],
    }) } as Response);
    expect(await oldRequest).toBeNull();
    expect(useGitStore.getState().bucketOf('/repo').status?.status.branch).toBe('feature');
  });
});
