// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';

const release = vi.fn();
vi.mock('../../runtime-auth.ts', () => ({
  acquireRuntimeUrlAuthToken: () => release,
  appendAuthTokenToUrl: vi.fn(async () => { throw new Error('url_token_context_changed'); }),
}));
vi.mock('../../runtime-url.ts', () => ({ getRealtimeBaseUrl: () => 'http://localhost' }));

import { subscribeHarnessEvents } from '../events.ts';

describe('harness event token lifetime', () => {
  it('releases the token consumer when URL preparation fails', async () => {
    release.mockClear();
    await expect(subscribeHarnessEvents(vi.fn())).rejects.toThrow('url_token_context_changed');
    expect(release).toHaveBeenCalledOnce();
  });
});
