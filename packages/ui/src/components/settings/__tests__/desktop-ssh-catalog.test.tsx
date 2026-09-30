// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DesktopSshCatalog } from '../pages/desktop-ssh-catalog.tsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('DesktopSshCatalog', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;
  let invoke: ReturnType<typeof vi.fn>;
  let instances: Array<Record<string, unknown>>;

  beforeEach(() => {
    instances = [];
    invoke = vi.fn(async (command: string, payload?: unknown) => {
      if (command === 'desktopSshConfig') return { ok: true, result: { instances } };
      if (command === 'desktopSshReadConfig') return { ok: true, result: 'Host atlas\n  HostName atlas.example\n' };
      if (command === 'desktopSshCreateFromCommand') {
        const data = payload as { sshCommand: string; nickname?: string };
        const id = `ssh-${instances.length + 1}`;
        instances = [...instances, { id, sshCommand: data.sshCommand, nickname: data.nickname }];
        return { ok: true, result: { id } };
      }
      if (command === 'desktopSshRemoveInstance') {
        const { id } = payload as { id: string };
        instances = instances.filter((entry) => entry.id !== id);
        return { ok: true, result: { instances } };
      }
      return { ok: false, error: 'unexpected-command' };
    });
    window.__NOTNATIVE_DESKTOP_INVOKE__ = invoke;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    delete window.__NOTNATIVE_DESKTOP_INVOKE__;
    delete window.__NOTNATIVE_DESKTOP_EVENTS__;
    vi.clearAllMocks();
  });

  it('loads SSH aliases, saves a command, and removes the persisted row through the bridge', async () => {
    await act(async () => { root!.render(<DesktopSshCatalog />); await Promise.resolve(); });
    expect(invoke).toHaveBeenCalledWith('desktopSshConfig', undefined);
    await act(async () => {
      [...container!.querySelectorAll('button')].find((button) => button.textContent === 'Load SSH config aliases')!.click();
      await Promise.resolve(); await Promise.resolve();
    });
    expect(container?.textContent).toContain('atlas');
    await act(async () => {
      [...container!.querySelectorAll('button')].find((button) => button.textContent === 'Add alias')!.click();
      await Promise.resolve(); await Promise.resolve();
    });
    expect(invoke).toHaveBeenCalledWith('desktopSshCreateFromCommand', { sshCommand: 'ssh atlas', nickname: 'atlas' });
    expect(container?.textContent).toContain('ssh atlas');
    await act(async () => {
      [...container!.querySelectorAll('button')].find((button) => button.textContent === 'Remove')!.click();
      await Promise.resolve();
    });
    expect(invoke).toHaveBeenCalledWith('desktopSshRemoveInstance', { id: 'ssh-1' });
    expect(container?.textContent).toContain('No SSH instances saved.');
  });

  it('locks alias creation while the native write is pending', async () => {
    let finishCreate!: (reply: { ok: true; result: { id: string } }) => void;
    invoke.mockImplementation(async (command: string, payload?: unknown) => {
      if (command === 'desktopSshConfig') return { ok: true, result: { instances } };
      if (command === 'desktopSshReadConfig') return { ok: true, result: 'Host atlas\n' };
      if (command === 'desktopSshCreateFromCommand') {
        return await new Promise((resolve) => { finishCreate = resolve; });
      }
      return { ok: false, error: 'unexpected-command' };
    });
    await act(async () => { root!.render(<DesktopSshCatalog />); await Promise.resolve(); });
    await act(async () => {
      [...container!.querySelectorAll('button')].find((button) => button.textContent === 'Load SSH config aliases')!.click();
      await Promise.resolve(); await Promise.resolve();
    });
    const aliasButton = [...container!.querySelectorAll('button')].find((button) => button.textContent === 'Add alias')!;
    act(() => aliasButton.click());
    expect(aliasButton.disabled).toBe(true);
    expect(invoke.mock.calls.filter(([command]) => command === 'desktopSshCreateFromCommand')).toHaveLength(1);
    await act(async () => { finishCreate({ ok: true, result: { id: 'ssh-1' } }); await Promise.resolve(); await Promise.resolve(); });
  });
});
