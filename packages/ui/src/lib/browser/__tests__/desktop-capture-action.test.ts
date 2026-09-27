// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
import { executeDesktopCapture } from '../desktop-capture-action.ts';

const observationId = '00000000-0000-4000-8000-000000000007';
function fixture(overrides: Record<string, unknown> = {}) {
  let revision = 7;
  let id: string | null = observationId;
  const image = { getSize: () => ({ width: 2400, height: 1200 }),
    resize: vi.fn(() => ({ toJPEG: () => Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]) })),
    toJPEG: () => Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]) };
  const guest = { capturePage: vi.fn(async () => image),
    getBoundingClientRect: () => ({ width: 800, height: 600 }) } as unknown as HTMLElement;
  const state = { guest, currentGuest: () => guest, currentUrl: () => 'https://example.org/',
    revision: () => revision, observationId: () => id, otherPending: () => false,
    pending: { current: null as Promise<unknown> | null }, invalidate: () => { revision += 1; id = null; }, ...overrides };
  return { guest, image, state };
}
const parameters = { expectedUrl: 'https://example.org/', observationRevision: 7, observationId };

describe('bounded desktop guest capture', () => {
  it('resizes and returns a bounded JPEG for the exact observed guest', async () => {
    const { image, state } = fixture();
    const result = await executeDesktopCapture(parameters, state);
    expect(result).toEqual({ url: 'https://example.org/', mime: 'image/jpeg', base64: '/9j/2Q==', width: 1600, height: 800 });
    expect(image.resize).toHaveBeenCalledWith({ width: 1600, height: 800 });
    expect(state.pending.current).toBeNull();
  });
  it('rejects missing observation, pending actions, and post-capture navigation', async () => {
    const { guest, state } = fixture();
    await expect(executeDesktopCapture({ ...parameters, observationId: '00000000-0000-4000-8000-000000000099' }, state)).rejects.toThrow(/page changed/u);
    expect((guest as unknown as { capturePage: ReturnType<typeof vi.fn> }).capturePage).not.toHaveBeenCalled();
    await expect(executeDesktopCapture(parameters, fixture({ otherPending: () => true }).state)).rejects.toThrow(/prior browser action/u);
    let current = 'https://example.org/';
    const changed = fixture({ currentUrl: () => current,
      invalidate: () => { current = 'https://example.net/'; } });
    await expect(executeDesktopCapture(parameters, changed.state)).rejects.toThrow(/uncertain/u);
  });
  it('does not return an oversized or invalid viewport', async () => {
    const huge = fixture();
    (huge.guest as unknown as { capturePage: ReturnType<typeof vi.fn> }).capturePage.mockResolvedValue({
      getSize: () => ({ width: 9000, height: 200 }), toJPEG: () => new Uint8Array(4),
    });
    await expect(executeDesktopCapture(parameters, huge.state)).rejects.toThrow(/dimensions/u);
    const noisy = fixture();
    (noisy.guest as unknown as { capturePage: ReturnType<typeof vi.fn> }).capturePage.mockResolvedValue({
      getSize: () => ({ width: 800, height: 600 }), toJPEG: () => new Uint8Array(150_001),
    });
    await expect(executeDesktopCapture(parameters, noisy.state)).rejects.toThrow(/size limit/u);
  });
});
