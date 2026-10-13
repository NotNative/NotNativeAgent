// SPDX-License-Identifier: Apache-2.0
/** Fetch-path regression: both native clients must target the /api bridge —
 * a request without the /api prefix misses the server proxy and lands on the
 * SPA fallback (20261010-20 audit finding). */
import { afterEach, describe, expect, it, vi } from 'vitest';

const fetchCalls: { url: string; init: RequestInit }[] = [];
// The stub payload is intentionally not a full projection; these tests pin
// the URL only and swallow the resulting parse failure.
vi.mock('../../runtime-fetch.ts', () => ({
  runtimeFetch: (url: string, init: RequestInit) => {
    fetchCalls.push({ url, init });
    return Promise.resolve(new Response('{}', { status: 200 }));
  },
}));
vi.mock('../../sync/authority-sync.ts', () => ({ authorityState: () => 'ready' }));

import { readNativeEnvironmentCatalog } from '../environment.ts';
import { readNativeUpdateState } from '../update-state.ts';

describe('native client fetch paths', () => {
  afterEach(() => { fetchCalls.length = 0; vi.restoreAllMocks(); });

  it('sends the environment catalog read through the /api bridge', async () => {
    await readNativeEnvironmentCatalog(new AbortController().signal).catch(() => undefined);
    expect(fetchCalls[0]?.url).toBe('/api/v1/nnd/configuration/environment/catalog');
  });

  it('sends the update-state read through the /api bridge', async () => {
    await readNativeUpdateState(new AbortController().signal).catch(() => undefined);
    expect(fetchCalls[0]?.url).toBe('/api/v1/nnd/configuration/update-state');
  });
});
