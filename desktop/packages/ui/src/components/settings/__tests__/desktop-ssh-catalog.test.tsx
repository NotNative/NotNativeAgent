// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { switchRuntimeEndpoint } from '../../../lib/runtime-switch.ts';
import { I18nProvider } from '../../../lib/i18n/context.tsx';
import { useI18nStore } from '../../../lib/i18n/store.ts';
import { DesktopSshCatalog } from '../pages/desktop-ssh-catalog.tsx';

vi.mock('../../../lib/runtime-switch.ts', () => ({
  switchRuntimeEndpoint: vi.fn(async (runtime: { runtimeKey?: string }) => {
    window.__NOTNATIVE_RUNTIME_KEY__ = runtime.runtimeKey;
  }),
}));

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
      if (command === 'desktopSshRefreshStatuses') return { ok: true, result: [] };
      if (command === 'desktopSshUpsertInstance') {
        const { instance } = payload as { instance: Record<string, unknown> };
        instances = instances.map((entry) => entry.id === instance.id ? instance : entry);
        return { ok: true, result: { instances } };
      }
      if (command === 'desktop_host_switch') {
        const { hostId } = payload as { hostId: string };
        const needsLogin = hostId === 'ssh-1';
        return { ok: true, result: {
          activeHostId: hostId,
          runtime: { apiBaseUrl: 'http://127.0.0.1:57123', clientToken: null, requestHeaders: {}, runtimeKey: hostId === 'local' ? 'local' : `ssh:${hostId}` },
          bootOutcome: { target: hostId === 'local' ? 'local' : 'remote', status: needsLogin ? 'auth' : 'ok' },
        } };
      }
      if (command === 'desktopSshConnect') return { ok: true, result: { id: 'ssh-1', phase: 'ready', startedByUs: true, retryAttempt: 0, requiresUserAction: false, updatedAtMs: Date.now() } };
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
    useI18nStore.getState().setLocale('en');
    if (root) act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    delete window.__NOTNATIVE_DESKTOP_INVOKE__;
    delete window.__NOTNATIVE_DESKTOP_EVENTS__;
    delete window.__NOTNATIVE_RUNTIME_KEY__;
    vi.clearAllMocks();
  });

  it('loads SSH aliases, saves a command, and removes the persisted row through the bridge', async () => {
    await act(async () => { root!.render(<I18nProvider><DesktopSshCatalog /></I18nProvider>); await Promise.resolve(); });
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

  it('requires explicit opt-in before configuring managed SSH installation', async () => {
    instances = [{ id: 'ssh-1', sshCommand: 'ssh dev@atlas.example', nickname: 'Atlas' }];
    await act(async () => { root!.render(<I18nProvider><DesktopSshCatalog /></I18nProvider>); await Promise.resolve(); await Promise.resolve(); });
    const installToggle = [...container!.querySelectorAll('label')]
      .find((label) => label.textContent?.includes('Install this desktop build over SSH'))
      ?.querySelector('input');
    expect(installToggle?.checked).toBe(false);
    await act(async () => {
      installToggle!.click();
      await Promise.resolve(); await Promise.resolve();
    });
    const saved = invoke.mock.calls.find(([command]) => command === 'desktopSshUpsertInstance')?.[1] as { instance: { remoteOpenchamber: Record<string, unknown> } };
    expect(saved.instance.remoteOpenchamber).toMatchObject({ mode: 'managed', uploadBundleOverSsh: true });
    expect(container?.textContent).toContain('Keep the remote server running after disconnect');
    expect(container?.textContent).toContain('Install & connect');
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
    await act(async () => { root!.render(<I18nProvider><DesktopSshCatalog /></I18nProvider>); await Promise.resolve(); });
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

  it('starts a saved SSH tunnel through the native store bridge', async () => {
    instances = [{ id: 'ssh-1', sshCommand: 'ssh dev@atlas.example', nickname: 'Atlas' }];
    await act(async () => { root!.render(<I18nProvider><DesktopSshCatalog /></I18nProvider>); await Promise.resolve(); await Promise.resolve(); });
    const connect = [...container!.querySelectorAll('button')].find((button) => button.textContent === 'Connect tunnel');
    expect(connect).toBeDefined();
    await act(async () => { connect!.click(); await Promise.resolve(); await Promise.resolve(); });
    expect(invoke).toHaveBeenCalledWith('desktopSshConnect', { id: 'ssh-1' });
  });

  it('adopts an authenticated SSH tunnel and directs the user to the session gate', async () => {
    instances = [{ id: 'ssh-1', sshCommand: 'ssh dev@atlas.example', nickname: 'Atlas' }];
    window.__NOTNATIVE_DESKTOP_EVENTS__ = {
      onOpenSession: () => () => {},
      onRelayPairingRequest: () => () => {},
      onSshStatus: (handler) => {
        queueMicrotask(() => handler({ id: 'ssh-1', phase: 'ready', localUrl: 'http://127.0.0.1:48123', startedByUs: true, retryAttempt: 0, requiresUserAction: false, updatedAtMs: Date.now() }));
        return () => {};
      },
    };
    await act(async () => { root!.render(<I18nProvider><DesktopSshCatalog /></I18nProvider>); await Promise.resolve(); await Promise.resolve(); });
    await act(async () => {
      [...container!.querySelectorAll('button')].find((button) => button.textContent === 'Use instance')!.click();
      await Promise.resolve(); await Promise.resolve();
    });
    expect(switchRuntimeEndpoint).toHaveBeenCalledWith(expect.objectContaining({ runtimeKey: 'ssh:ssh-1' }));
    expect(container?.textContent).toContain('Sign in to use this SSH instance.');
  });

  it('renders tunnel readiness after a locale switch', async () => {
    instances = [{ id: 'ssh-1', sshCommand: 'ssh dev@atlas.example', nickname: 'Atlas' }];
    window.__NOTNATIVE_DESKTOP_EVENTS__ = {
      onOpenSession: () => () => {},
      onRelayPairingRequest: () => () => {},
      onSshStatus: (handler) => {
        queueMicrotask(() => handler({ id: 'ssh-1', phase: 'ready', localUrl: 'http://127.0.0.1:48123', startedByUs: true, retryAttempt: 0, requiresUserAction: false, updatedAtMs: Date.now() }));
        return () => {};
      },
    };
    await act(async () => { root!.render(<I18nProvider><DesktopSshCatalog /></I18nProvider>); await Promise.resolve(); await Promise.resolve(); });
    expect(container?.textContent).toContain('Tunnel ready at http://127.0.0.1:48123');
    await act(async () => {
      useI18nStore.getState().setLocale('es');
      await new Promise((resolve) => { setTimeout(resolve, 0); });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container?.textContent).toContain('Túnel listo en http://127.0.0.1:48123');
  });

  it('rejects an active host id whose runtime key does not match the SSH instance', async () => {
    instances = [{ id: 'ssh-1', sshCommand: 'ssh dev@atlas.example', nickname: 'Atlas' }];
    window.__NOTNATIVE_RUNTIME_KEY__ = 'local';
    window.__NOTNATIVE_DESKTOP_EVENTS__ = {
      onOpenSession: () => () => {},
      onRelayPairingRequest: () => () => {},
      onSshStatus: (handler) => {
        queueMicrotask(() => handler({ id: 'ssh-1', phase: 'ready', localUrl: 'http://127.0.0.1:48123', startedByUs: true, retryAttempt: 0, requiresUserAction: false, updatedAtMs: Date.now() }));
        return () => {};
      },
    };
    let finishSwitch!: (reply: { ok: true; result: Record<string, unknown> }) => void;
    invoke.mockImplementation(async (command: string, payload?: unknown) => {
      if (command === 'desktopSshConfig') return { ok: true, result: { instances } };
      if (command === 'desktopSshRefreshStatuses') return { ok: true, result: [] };
      if (command === 'desktop_host_switch') {
        const { hostId } = payload as { hostId: string };
        return await new Promise((resolve) => { finishSwitch = resolve; });
      }
      return { ok: false, error: 'unexpected-command' };
    });
    await act(async () => { root!.render(<I18nProvider><DesktopSshCatalog /></I18nProvider>); await Promise.resolve(); await Promise.resolve(); });
    const use = container!.querySelector<HTMLButtonElement>('button[data-testid="desktop-ssh-use"]')!;
    await act(async () => { use.click(); await Promise.resolve(); });
    expect(switchRuntimeEndpoint).not.toHaveBeenCalled();
    await act(async () => {
      useI18nStore.getState().setLocale('es');
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      finishSwitch({ ok: true, result: {
        activeHostId: 'ssh-1',
        runtime: { apiBaseUrl: 'http://127.0.0.1:57123', clientToken: null, requestHeaders: {}, runtimeKey: 'local' },
        bootOutcome: { target: 'remote', status: 'ok' },
      } });
      await Promise.resolve(); await Promise.resolve();
    });
    expect(switchRuntimeEndpoint).not.toHaveBeenCalled();
    expect(window.__NOTNATIVE_RUNTIME_KEY__).toBe('local');
    expect(container?.querySelector('[role="status"]')?.textContent).not.toBe('');
    await act(async () => {
      useI18nStore.getState().setLocale('en');
      await new Promise((resolve) => { setTimeout(resolve, 0); });
      await Promise.resolve();
      await Promise.resolve();
    });
  });

  it('rejects unsafe request headers in the HTTP 200 runtime envelope', async () => {
    instances = [{ id: 'ssh-1', sshCommand: 'ssh dev@atlas.example', nickname: 'Atlas' }];
    window.__NOTNATIVE_RUNTIME_KEY__ = 'local';
    window.__NOTNATIVE_DESKTOP_EVENTS__ = {
      onOpenSession: () => () => {},
      onRelayPairingRequest: () => () => {},
      onSshStatus: (handler) => {
        queueMicrotask(() => handler({ id: 'ssh-1', phase: 'ready', localUrl: 'http://127.0.0.1:48123', startedByUs: true, retryAttempt: 0, requiresUserAction: false, updatedAtMs: Date.now() }));
        return () => {};
      },
    };
    invoke.mockImplementation(async (command: string) => {
      if (command === 'desktopSshConfig') return { ok: true, result: { instances } };
      if (command === 'desktopSshRefreshStatuses') return { ok: true, result: [] };
      if (command === 'desktop_host_switch') return { ok: true, result: {
        activeHostId: 'ssh-1',
        runtime: { apiBaseUrl: 'http://127.0.0.1:57123', clientToken: null, requestHeaders: { authorization: 7 }, runtimeKey: 'ssh:ssh-1' },
        bootOutcome: { target: 'remote', status: 'auth' },
      } };
      return { ok: false, error: 'unexpected-command' };
    });
    await act(async () => { root!.render(<I18nProvider><DesktopSshCatalog /></I18nProvider>); await Promise.resolve(); await Promise.resolve(); });
    await act(async () => {
      container!.querySelector<HTMLButtonElement>('button[data-testid="desktop-ssh-use"]')!.click();
      await Promise.resolve(); await Promise.resolve();
    });
    expect(switchRuntimeEndpoint).not.toHaveBeenCalled();
    expect(window.__NOTNATIVE_RUNTIME_KEY__).toBe('local');
    expect(container?.querySelector('[role="status"]')?.textContent).not.toBe('');
  });

  it('switches an active SSH runtime to local before removing its instance', async () => {
    instances = [{ id: 'ssh-1', sshCommand: 'ssh dev@atlas.example', nickname: 'Atlas' }];
    window.__NOTNATIVE_RUNTIME_KEY__ = 'ssh:ssh-1';
    await act(async () => { root!.render(<I18nProvider><DesktopSshCatalog /></I18nProvider>); await Promise.resolve(); await Promise.resolve(); });
    await act(async () => {
      [...container!.querySelectorAll('button')].find((button) => button.textContent === 'Remove')!.click();
      await Promise.resolve(); await Promise.resolve();
    });
    const fallbackCall = invoke.mock.calls.findIndex(([command]) => command === 'desktop_host_switch');
    const removeCall = invoke.mock.calls.findIndex(([command]) => command === 'desktopSshRemoveInstance');
    expect(invoke).toHaveBeenNthCalledWith(fallbackCall + 1, 'desktop_host_switch', { hostId: 'local' });
    expect(fallbackCall).toBeGreaterThanOrEqual(0);
    expect(removeCall).toBeGreaterThan(fallbackCall);
    expect(switchRuntimeEndpoint).toHaveBeenCalledWith(expect.objectContaining({ runtimeKey: 'local' }));
    expect(window.__NOTNATIVE_RUNTIME_KEY__).toBe('local');
  });

  it('retries local fallback when the active tunnel fails during another catalog action', async () => {
    instances = [
      { id: 'ssh-1', sshCommand: 'ssh dev@atlas.example', nickname: 'Atlas' },
      { id: 'ssh-2', sshCommand: 'ssh dev@other.example', nickname: 'Other' },
    ];
    window.__NOTNATIVE_RUNTIME_KEY__ = 'ssh:ssh-1';
    let publishStatus!: (status: Record<string, unknown>) => void;
    window.__NOTNATIVE_DESKTOP_EVENTS__ = {
      onOpenSession: () => () => {},
      onRelayPairingRequest: () => () => {},
      onSshStatus: (handler) => {
        publishStatus = handler as (status: Record<string, unknown>) => void;
        return () => {};
      },
    };
    let finishRemove!: (reply: { ok: true; result: { instances: unknown[] } }) => void;
    invoke.mockImplementation(async (command: string, payload?: unknown) => {
      if (command === 'desktopSshConfig') return { ok: true, result: { instances } };
      if (command === 'desktopSshRefreshStatuses') return { ok: true, result: [] };
      if (command === 'desktopSshRemoveInstance') {
        return await new Promise((resolve) => { finishRemove = resolve; });
      }
      if (command === 'desktop_host_switch') {
        const { hostId } = payload as { hostId: string };
        return { ok: true, result: {
          activeHostId: hostId,
          runtime: { apiBaseUrl: 'http://127.0.0.1:57123', clientToken: null, requestHeaders: {}, runtimeKey: 'local' },
          bootOutcome: { target: 'local', status: 'ok' },
        } };
      }
      return { ok: false, error: 'unexpected-command' };
    });
    await act(async () => { root!.render(<I18nProvider><DesktopSshCatalog /></I18nProvider>); await Promise.resolve(); await Promise.resolve(); });
    const removeButtons = [...container!.querySelectorAll('button')].filter((button) => button.textContent === 'Remove');
    act(() => removeButtons[1]!.click());
    expect(invoke).toHaveBeenCalledWith('desktopSshRemoveInstance', { id: 'ssh-2' });
    await act(async () => {
      publishStatus({ id: 'ssh-1', phase: 'error', startedByUs: true, retryAttempt: 0, requiresUserAction: false, updatedAtMs: Date.now() });
      await Promise.resolve();
    });
    expect(invoke.mock.calls.filter(([command]) => command === 'desktop_host_switch')).toHaveLength(0);
    await act(async () => {
      finishRemove({ ok: true, result: { instances: [instances[0]!] } });
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    });
    expect(invoke).toHaveBeenCalledWith('desktop_host_switch', { hostId: 'local' });
    expect(window.__NOTNATIVE_RUNTIME_KEY__).toBe('local');
  });
});
