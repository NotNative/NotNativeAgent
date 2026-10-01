// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '../../I18nProvider.tsx';
import { LaunchAtLoginControl } from '../pages/launch-at-login-control.tsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('LaunchAtLoginControl', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    delete window.__NOTNATIVE_DESKTOP_INVOKE__;
  });

  it('preserves a retryable selection when updating fails', async () => {
    type DesktopInvoke = NonNullable<typeof window.__NOTNATIVE_DESKTOP_INVOKE__>;
    const invoke = vi.fn<DesktopInvoke>(async (command, payload) => {
      if (command === 'desktop_get_launch_at_login') return { ok: true, result: { supported: true, enabled: false } };
      const enabled = typeof payload === 'object' && payload !== null && 'enabled' in payload
        ? (payload as { enabled?: unknown }).enabled
        : undefined;
      if (command === 'desktop_set_launch_at_login' && enabled === false) return { ok: false, error: 'denied' };
      return { ok: true, result: { supported: true, enabled } };
    });
    window.__NOTNATIVE_DESKTOP_INVOKE__ = invoke;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => { root!.render(<I18nProvider><LaunchAtLoginControl /></I18nProvider>); });
    const checkbox = () => container!.querySelector('[data-settings-item="general.startup.launch-at-login"] input') as HTMLInputElement;
    expect(checkbox().checked).toBe(false);
    expect(checkbox().disabled).toBe(false);

    await act(async () => { checkbox().click(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(checkbox().checked).toBe(true);
    expect(checkbox().disabled).toBe(false);

    await act(async () => { checkbox().click(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(checkbox().disabled).toBe(false);
    expect(container.textContent).toContain('Could not update the launch-at-login setting.');

    await act(async () => { checkbox().click(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(checkbox().checked).toBe(true);
  });
});

