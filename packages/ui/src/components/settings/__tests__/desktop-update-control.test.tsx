// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '../../I18nProvider.tsx';
import { DesktopUpdateControl } from '../pages/desktop-update-control.tsx';
import { useI18nStore } from '../../../lib/i18n/store.ts';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('DesktopUpdateControl', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    delete window.__NOTNATIVE_DESKTOP_UPDATER__;
  });

  it('checks, downloads, receives progress, and offers install only when ready', async () => {
    let progress: ((detail: { event: string; data?: { downloaded?: number; total?: number | null } }) => void) | undefined;
    type UpdaterBridge = NonNullable<typeof window.__NOTNATIVE_DESKTOP_UPDATER__>;
    const updater = {
      check: vi.fn(async () => ({ ok: true, result: { available: true, version: '20260930-69', body: 'Release notes' } })),
      download: vi.fn(async () => ({ ok: true, result: null })),
      install: vi.fn(async () => ({ ok: true, result: null })),
      onProgress: vi.fn<UpdaterBridge['onProgress']>((handler) => { progress = handler; return () => { progress = undefined; }; }),
    };
    window.__NOTNATIVE_DESKTOP_UPDATER__ = updater;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => { root!.render(<I18nProvider><DesktopUpdateControl /></I18nProvider>); });
    const button = (): HTMLButtonElement => container!.querySelector('button')!;
    await act(async () => { button().click(); await Promise.resolve(); });
    expect(updater.check).toHaveBeenCalledOnce();
    expect(container.textContent).toContain('Version 20260930-69 is available.');
    expect(container.textContent).toContain('Release notes');
    await act(async () => { button().click(); await Promise.resolve(); });
    expect(updater.download).toHaveBeenCalledOnce();
    await act(async () => { progress?.({ event: 'Progress', data: { downloaded: 25, total: 100 } }); });
    expect(container.textContent).toContain('Downloading update: 25%');
    await act(async () => { progress?.({ event: 'Finished' }); });
    expect(container.textContent).toContain('Update downloaded.');
    await act(async () => { button().click(); await Promise.resolve(); });
    expect(updater.install).toHaveBeenCalledOnce();
  });

  it('clears a failed download state so the user can retry', async () => {
    type UpdaterBridge = NonNullable<typeof window.__NOTNATIVE_DESKTOP_UPDATER__>;
    let progress: Parameters<UpdaterBridge['onProgress']>[0] | undefined;
    let attempts = 0;
    window.__NOTNATIVE_DESKTOP_UPDATER__ = {
      check: async () => ({ ok: true, result: { available: true, version: '20260930-69' } }),
      download: async () => {
        attempts += 1;
        progress?.({ event: 'Started' });
        return attempts === 1 ? { ok: false, error: 'network interrupted' } : { ok: true, result: null };
      },
      install: async () => ({ ok: true, result: null }),
      onProgress: (handler) => { progress = handler; return () => { progress = undefined; }; },
    };
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => { root!.render(<I18nProvider><DesktopUpdateControl /></I18nProvider>); });
    const click = async (): Promise<void> => act(async () => { container!.querySelector('button')!.click(); await Promise.resolve(); });
    await click();
    await click();
    expect(container.textContent).toContain('Desktop update operation failed.');
    expect(container.querySelector('button')?.textContent).toBe('Download update');
    await click();
    expect(attempts).toBe(2);
  });
});
