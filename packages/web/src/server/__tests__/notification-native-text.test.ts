// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
import { generateNativeNotification } from '../notifications/native-text.ts';
import { callHarness } from '../queue/queue-adapter-calls.ts';

vi.mock('../queue/queue-adapter-calls.ts', () => ({ callHarness: vi.fn(async () => Response.json({ text: '{}' })),
  harnessRequest: (path: string, directory: string, init: RequestInit) => ({ path, directory, ...init }) }));
const raw = { sessionID: 'session-1', directory: '/workspace', prompt: JSON.stringify({ event: 'completion',
  fallback: { title: 'Finished', body: 'Turn completed.' }, assistantText: 'Checks passed.' }) };
describe('native notification settings', () => {
  it('forwards an explicit Small Model override while default remains native-owned', async () => {
    vi.mocked(callHarness).mockClear();
    await generateNativeNotification(raw, { settings: async () => ({ smallModelUseDefault: false, smallModelOverride: 'configured/small' }) });
    expect(JSON.parse(String(vi.mocked(callHarness).mock.calls[0]![0].body))).toMatchObject({ model: 'configured/small' });
    await generateNativeNotification(raw, { settings: async () => ({ smallModelUseDefault: true, smallModelOverride: 'ignored/model' }) });
    expect(JSON.parse(String(vi.mocked(callHarness).mock.calls[1]![0].body))).not.toHaveProperty('model');
  });
  it('does not silently replace a missing explicit model or dispatch after cancellation', async () => {
    vi.mocked(callHarness).mockClear();
    expect((await generateNativeNotification(raw, { settings: async () => ({ smallModelUseDefault: false }) })).status).toBe(404);
    const controller = new AbortController(); controller.abort();
    await expect(generateNativeNotification(raw, {}, controller.signal)).rejects.toThrow();
    expect(callHarness).not.toHaveBeenCalled();
  });
});
