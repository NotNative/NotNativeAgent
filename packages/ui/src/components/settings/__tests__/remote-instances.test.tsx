// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../../../lib/runtime-switch.ts', () => ({ switchRuntimeEndpoint: vi.fn(async () => undefined) }));

import { switchRuntimeEndpoint } from '../../../lib/runtime-switch.ts';
import { RemoteInstancesPage } from '../pages/remote-instances.tsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('RemoteInstancesPage', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;
  let invoke: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    invoke = vi.fn(async (command: string) => {
      if (command === 'desktop_hosts_get') return { ok: true, result: {
        defaultHostId: 'local',
        hosts: [{ id: 'studio', label: 'Studio', url: 'https://studio.example/nnd', clientToken: 'secret' }],
      } };
      if (command === 'desktop_boot_config_get') return { ok: true, result: {
        apiBaseUrl: 'http://127.0.0.1:57123', clientToken: 'local-secret', requestHeaders: {}, runtimeKey: 'local',
        bootOutcome: { target: 'remote', status: 'unreachable', hostId: 'studio' },
      } };
      if (command === 'desktop_host_switch') return { ok: true, result: {
        activeHostId: 'studio',
        runtime: {
          apiBaseUrl: 'https://studio.example/nnd', clientToken: 'secret',
          requestHeaders: {}, runtimeKey: 'host:studio',
        },
        bootOutcome: { target: 'remote', status: 'ok', hostId: 'studio' },
      } };
      return { ok: false, error: 'unexpected-command' };
    });
    window.__NOTNATIVE_DESKTOP_INVOKE__ = invoke;
  });

  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    delete window.__NOTNATIVE_DESKTOP_INVOKE__;
    vi.clearAllMocks();
  });

  it('loads the saved catalog and switches the active runtime through native IPC', async () => {
    await act(async () => { root!.render(<RemoteInstancesPage />); await Promise.resolve(); });
    expect(container?.textContent).toContain('Studio');
    const button = [...container!.querySelectorAll('button')].find((item) => item.textContent === 'Use this instance');
    expect(button).toBeDefined();
    await act(async () => { button!.click(); await Promise.resolve(); await Promise.resolve(); });
    expect(invoke).toHaveBeenCalledWith('desktop_host_switch', { hostId: 'studio' });
    expect(switchRuntimeEndpoint).toHaveBeenCalledWith({
      apiBaseUrl: 'https://studio.example/nnd', clientToken: 'secret',
      requestHeaders: {}, runtimeKey: 'host:studio',
    });
    expect(container?.textContent).toContain('Switched to Studio.');
  });

  it('keeps an unreachable saved default retryable while the local runtime stays active', async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === 'desktop_hosts_get') return { ok: true, result: {
        defaultHostId: 'studio', hosts: [{ id: 'studio', label: 'Studio', url: 'https://studio.example/nnd' }],
      } };
      if (command === 'desktop_boot_config_get') return { ok: true, result: {
        apiBaseUrl: 'http://127.0.0.1:57123', clientToken: 'local-secret', requestHeaders: {}, runtimeKey: 'local',
        bootOutcome: { target: 'remote', status: 'unreachable', hostId: 'studio' },
      } };
      if (command === 'desktop_host_switch') return { ok: true, result: {
        activeHostId: 'local', runtime: {
          apiBaseUrl: 'http://127.0.0.1:57123', clientToken: 'local-secret', requestHeaders: {}, runtimeKey: 'local',
        }, bootOutcome: { target: 'remote', status: 'unreachable', hostId: 'studio' },
      } };
      return { ok: false, error: 'unexpected-command' };
    });
    await act(async () => { root!.render(<RemoteInstancesPage />); await Promise.resolve(); });
    const button = [...container!.querySelectorAll('button')].find((item) => item.textContent === 'Use this instance');
    expect(button?.disabled).toBe(false);
    await act(async () => { button!.click(); await Promise.resolve(); await Promise.resolve(); });
    expect(container?.textContent).toContain('The local instance remains active (unreachable).');
    const retry = [...container!.querySelectorAll('button')].find((item) => item.textContent === 'Use this instance');
    expect(retry?.disabled).toBe(false);
  });

  it('does not offer a relay-only record as an HTTP host', async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === 'desktop_hosts_get') return { ok: true, result: {
        defaultHostId: 'local', hosts: [
          { id: 'relay', label: 'Relay', url: 'relay://server-id' },
          { id: 'hybrid', label: 'Hybrid', url: 'relay://hybrid-id', apiUrl: 'https://hybrid.example' },
        ],
      } };
      if (command === 'desktop_boot_config_get') return { ok: true, result: {
        apiBaseUrl: 'http://127.0.0.1:57123', clientToken: 'local-secret', requestHeaders: {}, runtimeKey: 'local',
        bootOutcome: { target: 'local', status: 'ok' },
      } };
      return { ok: false, error: 'unexpected-command' };
    });
    await act(async () => { root!.render(<RemoteInstancesPage />); await Promise.resolve(); });
    expect(container?.textContent).toContain('Relay-only connections are not available in this build.');
    const relayButton = [...container!.querySelectorAll('button')].find((item) => item.textContent === 'Relay support pending');
    expect(relayButton?.disabled).toBe(true);
    expect(invoke).not.toHaveBeenCalledWith('desktop_host_switch', { hostId: 'relay' });
    expect(container?.textContent).toContain('https://hybrid.example');
    const hybridButton = [...container!.querySelectorAll('button')].find((item) => {
      const row = item.parentElement;
      return row?.textContent?.includes('Hybrid') && item.textContent === 'Use this instance';
    });
    expect(hybridButton?.disabled).toBe(false);
    await act(async () => { hybridButton!.click(); await Promise.resolve(); });
    expect(invoke).toHaveBeenCalledWith('desktop_host_switch', { hostId: 'hybrid' });
  });
});
