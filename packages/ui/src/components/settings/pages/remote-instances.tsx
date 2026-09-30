// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { SettingsGroupTitle, SettingsSection } from '../primitives.tsx';
import { switchRuntimeEndpoint } from '../../../lib/runtime-switch.ts';

interface DesktopHost {
  id: string;
  label: string;
  url: string;
  apiUrl?: string;
  relayOnly: boolean;
}

interface HostCatalog {
  hosts: DesktopHost[];
  defaultHostId: string | null;
}

interface RuntimeSelection {
  apiBaseUrl: string;
  clientToken: string | null;
  requestHeaders: Record<string, string>;
  runtimeKey: string;
}

function parseRuntime(value: unknown): RuntimeSelection | null {
  if (typeof value !== 'object' || value === null) return null;
  const input = value as Partial<RuntimeSelection>;
  if (typeof input.apiBaseUrl !== 'string' || typeof input.runtimeKey !== 'string'
    || (input.clientToken !== null && typeof input.clientToken !== 'string')
    || typeof input.requestHeaders !== 'object' || input.requestHeaders === null || Array.isArray(input.requestHeaders)) return null;
  try {
    const url = new URL(input.apiBaseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
  } catch { return null; }
  const requestHeaders: Record<string, string> = {};
  for (const [key, header] of Object.entries(input.requestHeaders)) {
    if (!/^[A-Za-z0-9-]{1,64}$/u.test(key) || typeof header !== 'string' || header.length > 4_096
      || /^(authorization|cookie|set-cookie)$/iu.test(key)) return null;
    requestHeaders[key] = header;
  }
  return {
    apiBaseUrl: input.apiBaseUrl, clientToken: input.clientToken ?? null,
    requestHeaders, runtimeKey: input.runtimeKey,
  };
}

function parseCatalog(value: unknown): HostCatalog | null {
  if (typeof value !== 'object' || value === null) return null;
  const input = value as { hosts?: unknown; defaultHostId?: unknown };
  if (!Array.isArray(input.hosts)) return null;
  const hosts: DesktopHost[] = [];
  for (const item of input.hosts) {
    if (typeof item !== 'object' || item === null) return null;
    const host = item as { id?: unknown; label?: unknown; url?: unknown; apiUrl?: unknown };
    if (typeof host.id !== 'string' || typeof host.label !== 'string' || typeof host.url !== 'string') return null;
    if (host.apiUrl !== undefined && typeof host.apiUrl !== 'string') return null;
    const apiUrl = typeof host.apiUrl === 'string' && /^https?:\/\//iu.test(host.apiUrl) ? host.apiUrl : undefined;
    hosts.push({
      id: host.id, label: host.label, url: host.url, ...(apiUrl ? { apiUrl } : {}),
      relayOnly: host.url.startsWith('relay://') && apiUrl === undefined,
    });
  }
  if (input.defaultHostId !== null && typeof input.defaultHostId !== 'string') return null;
  return { hosts, defaultHostId: input.defaultHostId as string | null };
}

export function RemoteInstancesPage(): ReactNode {
  const [catalog, setCatalog] = useState<HostCatalog | null>(null);
  const [activeHostId, setActiveHostId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    const invoke = window.__NOTNATIVE_DESKTOP_INVOKE__;
    if (!invoke) { setMessage('Remote instance management is available in the desktop app.'); return; }
    try {
      const reply = await invoke('desktop_hosts_get');
      const parsed = reply.ok ? parseCatalog(reply.result) : null;
      setCatalog(parsed);
      if (!reply.ok || parsed === null) setMessage('Could not read saved remote instances.');
      const boot = await invoke('desktop_boot_config_get');
      if (boot.ok && typeof boot.result === 'object' && boot.result !== null) {
        const runtimeKey = (boot.result as { runtimeKey?: unknown }).runtimeKey;
        const outcome = (boot.result as { bootOutcome?: unknown }).bootOutcome;
        if (runtimeKey === 'local') setActiveHostId('local');
        else if (typeof runtimeKey === 'string' && runtimeKey.startsWith('host:')) setActiveHostId(runtimeKey.slice(5));
        else if (typeof outcome === 'object' && outcome !== null
          && (outcome as { hostId?: unknown }).hostId === '__env') setActiveHostId('__env');
      }
    } catch {
      setMessage('Could not read saved remote instances.');
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const select = async (hostId: string): Promise<void> => {
    const invoke = window.__NOTNATIVE_DESKTOP_INVOKE__;
    if (!invoke) return;
    setBusyId(hostId);
    setMessage('Checking the selected instance…');
    try {
      const reply = await invoke('desktop_host_switch', { hostId });
      if (!reply.ok) {
        const messages: Record<string, string> = {
          'desktop-env-target-active': 'An explicit server URL is active; the saved host cannot be selected in this launch.',
          'desktop-host-not-found': 'That saved instance no longer exists.',
          'desktop-hosts-busy': 'A pairing operation is updating the saved instances. Try again shortly.',
          'desktop-host-switch-busy': 'An instance switch is already in progress.',
        };
        setMessage(messages[reply.error ?? ''] ?? 'Could not switch instances.');
        return;
      }
      const result = reply.result as { activeHostId?: unknown; bootOutcome?: { status?: unknown }; runtime?: unknown } | undefined;
      const runtime = parseRuntime(result?.runtime);
      if (runtime === null) { setMessage('The desktop returned an invalid runtime configuration.'); return; }
      await switchRuntimeEndpoint(runtime);
      window.__NOTNATIVE_API_BASE_URL__ = runtime.apiBaseUrl;
      window.__NOTNATIVE_CLIENT_TOKEN__ = runtime.clientToken ?? '';
      window.__NOTNATIVE_RUNTIME_HEADERS__ = runtime.requestHeaders;
      window.__NOTNATIVE_RUNTIME_KEY__ = runtime.runtimeKey;
      if (typeof result?.bootOutcome === 'object' && result.bootOutcome !== null) {
        window.__NOTNATIVE_DESKTOP_BOOT_OUTCOME__ = result.bootOutcome;
      }
      const active = typeof result?.activeHostId === 'string' ? result.activeHostId : 'local';
      setActiveHostId(active);
      if (active !== hostId) {
        setCatalog((previous) => previous ? { ...previous, defaultHostId: hostId } : previous);
        setMessage(`The saved default is set, but the server could not be reached. The local instance remains active (${String(result?.bootOutcome?.status ?? 'unavailable')}).`);
      } else {
        setCatalog((previous) => previous ? { ...previous, defaultHostId: hostId } : previous);
        setMessage(`Switched to ${hostId === 'local' ? 'the local instance' : catalog?.hosts.find((host) => host.id === hostId)?.label ?? 'the selected instance'}.`);
      }
    } catch {
      setMessage('Could not switch instances.');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <SettingsSection item="remote-instances.default">
        <SettingsGroupTitle>Default instance</SettingsGroupTitle>
        <p className="mb-3 text-xs text-muted-foreground">Choose which saved server the desktop connects to. Each remote is checked for identity, authentication, and API compatibility before switching.</p>
        <div className="flex items-center justify-between gap-3 rounded border border-border/50 px-3 py-2">
          <div className="min-w-0">
            <div className="text-sm text-foreground">This computer</div>
            <div className="truncate text-xs text-muted-foreground">Local desktop server</div>
          </div>
          <button type="button" className="rounded border border-border px-3 py-1.5 text-xs hover:bg-interactive-hover/40" disabled={busyId !== null || catalog === null || activeHostId === 'local'} onClick={() => { void select('local'); }}>
            {busyId === 'local' ? 'Switching…' : activeHostId === 'local' ? 'Current' : 'Use this instance'}
          </button>
        </div>
        {catalog?.hosts.map((host) => (
          <div key={host.id} className="mt-2 flex items-center justify-between gap-3 rounded border border-border/50 px-3 py-2">
            <div className="min-w-0">
              <div className="truncate text-sm text-foreground">{host.label}</div>
              <div className="truncate text-xs text-muted-foreground">{host.apiUrl ?? host.url}</div>
            </div>
            <button type="button" className="shrink-0 rounded border border-border px-3 py-1.5 text-xs hover:bg-interactive-hover/40" disabled={busyId !== null || activeHostId === host.id || host.relayOnly} onClick={() => { void select(host.id); }}>
              {busyId === host.id ? 'Checking…' : activeHostId === host.id ? 'Current' : host.relayOnly ? 'Relay support pending' : 'Use this instance'}
            </button>
            {host.relayOnly ? <div className="basis-full text-xs text-muted-foreground">Relay-only connections are not available in this build.</div> : null}
          </div>
        ))}
        {catalog?.hosts.length === 0 ? <p className="mt-2 text-xs text-muted-foreground">No paired remote instances yet. Open a pairing link to add one.</p> : null}
        {message ? <p role="status" className="mt-3 text-xs text-muted-foreground">{message}</p> : null}
      </SettingsSection>
    </div>
  );
}
