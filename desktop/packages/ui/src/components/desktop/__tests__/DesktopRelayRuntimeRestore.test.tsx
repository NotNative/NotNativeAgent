// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const relayClient = { close: vi.fn() };
const probe = vi.fn(async () => ({ status: 'ok' as const, latencyMs: 9, client: relayClient }));
const adopt = vi.fn();
const switchRuntime = vi.fn(async () => undefined);
vi.mock('../../../lib/desktop-relay-host.ts', () => ({ probeDesktopRelayHost: (..._args: unknown[]) => probe() }));
vi.mock('../../../lib/runtime-tunnel.ts', () => ({ adoptRelayTunnel: (..._args: unknown[]) => adopt() }));
vi.mock('../../../lib/runtime-switch.ts', () => ({ switchRuntimeEndpoint: (..._args: unknown[]) => switchRuntime() }));

import { DesktopRelayRuntimeRestore } from '../DesktopRelayRuntimeRestore.tsx';
import { persistAfterProbe } from '../DesktopRelayRuntimeRestore.tsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('DesktopRelayRuntimeRestore', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    delete window.__NOTNATIVE_DESKTOP_INVOKE__;
    delete window.__NOTNATIVE_DESKTOP_BOOT_OUTCOME__;
    vi.clearAllMocks();
  });

  it('restores an E2EE relay default after the catalog lock clears', async () => {
    let selections = 0;
    window.__NOTNATIVE_DESKTOP_INVOKE__ = vi.fn(async (command: string) => {
      if (command === 'desktop_boot_config_get') return { ok: true, result: { bootOutcome: { target: 'remote', status: 'relay-pending', hostId: 'relay-1', via: 'relay' } } };
      if (command === 'desktop_hosts_get') return { ok: true, result: { hosts: [{
        id: 'relay-1', clientToken: 'paired-token', relay: {
          relayUrl: 'wss://relay.example/ws', serverId: 'server-1',
          hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
        },
      }] } };
      if (command === 'desktop_host_set_relay_default') {
        selections += 1;
        return { ok: true, result: {
          runtime: { apiBaseUrl: 'http://tunnel.invalid', clientToken: 'paired-token', requestHeaders: {}, runtimeKey: 'host:relay-1' },
          bootOutcome: { target: 'remote', status: 'ok', hostId: 'relay-1', via: 'relay' },
        } };
      }
      return { ok: false, error: 'unexpected-command' };
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root!.render(<DesktopRelayRuntimeRestore />); await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(selections).toBe(1);
    expect(probe).toHaveBeenCalledOnce();
    expect(adopt).toHaveBeenCalledOnce();
    expect(switchRuntime).toHaveBeenCalledOnce();
    expect(window.__NOTNATIVE_DESKTOP_BOOT_OUTCOME__?.status).toBe('ok');
  });

  it('retries only catalog-busy replies with capped exponential backoff', async () => {
    let selections = 0;
    const invoke = vi.fn(async () => {
      selections += 1;
      return selections < 3 ? { ok: false, error: 'desktop-hosts-busy' } : { ok: true, result: {} };
    });
    const relay = {
      outcome: {}, host: { id: 'relay-1' }, descriptor: {
        relayUrl: 'wss://relay.example/ws', serverId: 'server-1',
        hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
      }, clientToken: 'token', requestHeaders: {},
    } as Parameters<typeof persistAfterProbe>[1];
    const waits: number[] = [];
    const result = await persistAfterProbe(invoke as Parameters<typeof persistAfterProbe>[0], relay, async (delay) => { waits.push(delay); });
    expect(result?.ok).toBe(true);
    expect(selections).toBe(3);
    expect(waits).toEqual([500, 1_000]);
  });
});
