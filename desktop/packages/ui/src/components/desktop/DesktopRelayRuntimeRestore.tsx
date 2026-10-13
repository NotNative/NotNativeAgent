// SPDX-License-Identifier: Apache-2.0
import { useEffect } from 'react';
import { probeDesktopRelayHost } from '../../lib/desktop-relay-host.ts';
import { switchRuntimeEndpoint } from '../../lib/runtime-switch.ts';
import { adoptRelayTunnel } from '../../lib/runtime-tunnel.ts';

let restoreStarted = false;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type DesktopInvoke = NonNullable<typeof window.__NOTNATIVE_DESKTOP_INVOKE__>;
interface PendingRelay {
  outcome: Record<string, unknown>;
  host: Record<string, unknown>;
  descriptor: { relayUrl: string; serverId: string; hostEncPubJwk: { kty: string; crv: string; x: string; y: string } };
  clientToken: string | null;
  requestHeaders: Record<string, string>;
}

function publishOutcome(outcome: Record<string, unknown>): void {
  window.__NOTNATIVE_DESKTOP_BOOT_OUTCOME__ = outcome;
  window.dispatchEvent(new CustomEvent('notnative:desktop-boot-outcome-changed', { detail: outcome }));
}

async function pendingRelay(invoke: DesktopInvoke): Promise<PendingRelay | null> {
  const boot = await invoke('desktop_boot_config_get').catch(() => null);
  if (!boot?.ok || !isRecord(boot.result) || !isRecord(boot.result.bootOutcome)) return null;
  const outcome = boot.result.bootOutcome;
  if (outcome.status !== 'relay-pending' || typeof outcome.hostId !== 'string') return null;
  const catalog = await invoke('desktop_hosts_get').catch(() => null);
  const hosts = catalog?.ok && isRecord(catalog.result) && Array.isArray(catalog.result.hosts) ? catalog.result.hosts : [];
  const host = hosts.find((entry: unknown) => isRecord(entry) && entry.id === outcome.hostId) as Record<string, unknown> | undefined;
  const relay = host && isRecord(host.relay) ? host.relay : null;
  const jwk = relay && isRecord(relay.hostEncPubJwk) ? relay.hostEncPubJwk : null;
  if (!host || !relay || !jwk || typeof relay.relayUrl !== 'string' || typeof relay.serverId !== 'string'
    || typeof jwk.kty !== 'string' || typeof jwk.crv !== 'string' || typeof jwk.x !== 'string' || typeof jwk.y !== 'string') return null;
  const requestHeaders = isRecord(host.requestHeaders) ? Object.fromEntries(Object.entries(host.requestHeaders)
    .filter(([key, value]) => /^[A-Za-z0-9-]{1,64}$/u.test(key) && typeof value === 'string'
      && !/^(authorization|cookie|set-cookie)$/iu.test(key))) as Record<string, string> : {};
  return {
    outcome, host,
    descriptor: { relayUrl: relay.relayUrl, serverId: relay.serverId,
      hostEncPubJwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y } },
    clientToken: typeof host.clientToken === 'string' ? host.clientToken : null,
    requestHeaders,
  };
}

export async function persistAfterProbe(
  invoke: DesktopInvoke,
  relay: PendingRelay,
  sleep: (delayMs: number) => Promise<void> = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
): Promise<Awaited<ReturnType<DesktopInvoke>> | null> {
  for (let attempt = 0; attempt < 7; attempt += 1) {
    const result = await invoke('desktop_host_set_relay_default', {
      hostId: relay.host.id,
      restoringDefault: true,
      expectedHost: { ...relay.descriptor, clientToken: relay.clientToken, requestHeaders: relay.requestHeaders },
    }).catch(() => null);
    if (result?.error !== 'desktop-hosts-busy' || attempt === 6) return result;
    await sleep(Math.min(500 * (2 ** attempt), 7_000));
  }
  return null;
}

async function restoreRelayRuntime(invoke: DesktopInvoke): Promise<void> {
  const relay = await pendingRelay(invoke);
  if (!relay) return;
  const probe = await probeDesktopRelayHost(relay.descriptor, {
    clientToken: relay.clientToken, requestHeaders: relay.requestHeaders, keepTunnel: true,
  });
  if (probe.status !== 'ok' || !probe.client) {
    publishOutcome({ ...relay.outcome, status: probe.status, localAvailable: true });
    return;
  }
  const selected = await persistAfterProbe(invoke, relay);
  if (selected?.error === 'desktop-host-default-changed') {
    probe.client.close();
    return;
  }
  if (!selected?.ok || !isRecord(selected.result) || !isRecord(selected.result.runtime)) {
    probe.client.close();
    publishOutcome({ ...relay.outcome, status: 'unreachable', localAvailable: true });
    return;
  }
  const runtime = selected.result.runtime;
  if (typeof runtime.apiBaseUrl !== 'string' || typeof runtime.runtimeKey !== 'string'
    || (runtime.clientToken !== null && typeof runtime.clientToken !== 'string') || !isRecord(runtime.requestHeaders)) {
    probe.client.close();
    return;
  }
  adoptRelayTunnel(relay.descriptor, probe.client);
  try {
    await switchRuntimeEndpoint({
      apiBaseUrl: runtime.apiBaseUrl, clientToken: runtime.clientToken as string | null,
      runtimeKey: runtime.runtimeKey, requestHeaders: runtime.requestHeaders as Record<string, string>,
      relay: relay.descriptor,
    });
  } catch {
    probe.client.close();
    publishOutcome({ ...relay.outcome, status: 'unreachable', localAvailable: true });
    return;
  }
  publishOutcome((selected.result.bootOutcome ?? { ...relay.outcome, status: 'ok' }) as Record<string, unknown>);
}

/** Restores saved relay defaults only after the renderer has the trusted E2EE
 * client runtime. Main-process boot stays local until this succeeds. */
export function DesktopRelayRuntimeRestore(): null {
  useEffect(() => {
    if (restoreStarted) return;
    restoreStarted = true;
    const invoke = window.__NOTNATIVE_DESKTOP_INVOKE__;
    if (!invoke) return;
    void restoreRelayRuntime(invoke).catch(() => undefined);
  }, []);
  return null;
}
