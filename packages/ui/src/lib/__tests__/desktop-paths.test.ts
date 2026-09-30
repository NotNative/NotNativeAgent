import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDesktopPathApi, isDesktopLocalOriginActive } from '../desktop-paths';

function desktopWindow(href = 'notnative-ui://app/index.html', origin = 'http://127.0.0.1:57123') {
  const invoke = vi.fn(async (): Promise<{ ok: boolean; error?: string }> => ({ ok: true }));
  const value = {
    __NOTNATIVE_ELECTRON__: { runtime: 'electron', arch: 'x64', trayEnabled: true },
    __NOTNATIVE_LOCAL_ORIGIN__: origin,
    __NOTNATIVE_DESKTOP_INVOKE__: invoke,
    location: new URL(href),
  };
  return { value: value as unknown as Window, invoke };
}

afterEach(() => vi.restoreAllMocks());

describe('desktop local path API', () => {
  it('opens and reveals only through the desktop bridge on an active local origin', async () => {
    const { value, invoke } = desktopWindow();
    const api = createDesktopPathApi(value);
    expect(isDesktopLocalOriginActive(value)).toBe(true);
    expect(await api.open('C:\\work\\notes.md', 'Editor')).toBe(true);
    expect(await api.reveal('C:\\work\\notes.md')).toBe(true);
    expect(invoke.mock.calls).toEqual([
      ['desktop_open_path', { path: 'C:\\work\\notes.md', app: 'Editor' }],
      ['desktop_reveal_path', { path: 'C:\\work\\notes.md' }],
    ]);
  });

  it('accepts matching loopback origins but rejects remote or mismatched pages', () => {
    expect(isDesktopLocalOriginActive(desktopWindow('http://localhost:57123/', 'http://127.0.0.1:57123').value)).toBe(true);
    expect(isDesktopLocalOriginActive(desktopWindow('https://remote.example/', 'http://127.0.0.1:57123').value)).toBe(false);
    expect(isDesktopLocalOriginActive(desktopWindow('http://127.0.0.1:57124/', 'http://127.0.0.1:57123').value)).toBe(false);
  });

  it('returns null when unavailable and false when IPC rejects the operation', async () => {
    const unavailable = desktopWindow();
    unavailable.value.__NOTNATIVE_DESKTOP_INVOKE__ = undefined;
    expect(await createDesktopPathApi(unavailable.value).open('x')).toBe(null);
    const broken = desktopWindow();
    broken.invoke.mockResolvedValue({ ok: false, error: 'denied' });
    expect(await createDesktopPathApi(broken.value).reveal('x')).toBe(false);
  });
});
