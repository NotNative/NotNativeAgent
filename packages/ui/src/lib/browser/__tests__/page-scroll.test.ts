// SPDX-License-Identifier: Apache-2.0
/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pageScrollScript, parsePageScroll, performPageScroll } from '../page-scroll.ts';

afterEach(() => { vi.unstubAllGlobals(); });

describe('exact-page viewport scroll', () => {
  it('refuses a stale URL without scrolling', async () => {
    const scroll = vi.fn(); vi.stubGlobal('scrollTo', scroll);
    expect(await performPageScroll('down', 'https://other.example/')).toMatchObject({ error: expect.stringContaining('page changed') });
    expect(scroll).not.toHaveBeenCalled();
  });

  it('reports bounded readback after an instant scroll in the guest realm', async () => {
    vi.stubGlobal('innerHeight', 500);
    vi.stubGlobal('scrollY', 0);
    vi.stubGlobal('scrollTo', vi.fn(({ top }: { top: number }) => { vi.stubGlobal('scrollY', top); }));
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1; });
    Object.defineProperty(document.documentElement, 'scrollHeight', { configurable: true, value: 1500 });
    const execute = new Function(`return ${pageScrollScript('down', location.href)}`) as () => Promise<unknown>;
    const result = await execute();
    expect(result).toMatchObject({ direction: 'down', scrollY: 400, maxScrollY: 1000, settled: true });
    expect(parsePageScroll(result, 'down', location.href)).toEqual(result);
    expect(parsePageScroll({ ...result as object, scrollY: Infinity }, 'down', location.href)).toBeNull();
  });
});
