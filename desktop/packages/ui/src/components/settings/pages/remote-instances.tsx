// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { SettingsGroupTitle, SettingsSection } from '../primitives.tsx';
import { switchRuntimeEndpoint } from '../../../lib/runtime-switch.ts';
import { adoptRelayTunnel } from '../../../lib/runtime-tunnel.ts';
import { probeDesktopRelayHost } from '../../../lib/desktop-relay-host.ts';
import { DesktopSshCatalog } from './desktop-ssh-catalog.tsx';
import type { I18nKey } from '../../../lib/i18n/messages/en.ts';
import { useI18n } from '../../I18nProvider.tsx';

interface DesktopHost {
  id: string;
  label: string;
  url: string;
  apiUrl?: string;
  relayOnly: boolean;
  relay?: { relayUrl: string; serverId: string; hostEncPubJwk: { kty: string; crv: string; x: string; y: string } };
  clientToken: string | null;
  requestHeaders: Record<string, string>;
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
    const host = item as { id?: unknown; label?: unknown; url?: unknown; apiUrl?: unknown; relay?: unknown; clientToken?: unknown; requestHeaders?: unknown };
    if (typeof host.id !== 'string' || typeof host.label !== 'string' || typeof host.url !== 'string') return null;
    if (host.apiUrl !== undefined && typeof host.apiUrl !== 'string') return null;
    const apiUrl = typeof host.apiUrl === 'string' && /^https?:\/\//iu.test(host.apiUrl) ? host.apiUrl : undefined;
    let relay: DesktopHost['relay'];
    if (typeof host.relay === 'object' && host.relay !== null) {
      const candidate = host.relay as { relayUrl?: unknown; serverId?: unknown; hostEncPubJwk?: unknown };
      const jwk = candidate.hostEncPubJwk as { kty?: unknown; crv?: unknown; x?: unknown; y?: unknown } | null;
      if (typeof candidate.relayUrl === 'string' && /^wss?:\/\//iu.test(candidate.relayUrl)
        && typeof candidate.serverId === 'string' && jwk?.kty === 'EC' && jwk.crv === 'P-256'
        && typeof jwk.x === 'string' && typeof jwk.y === 'string') {
        relay = { relayUrl: candidate.relayUrl, serverId: candidate.serverId,
          hostEncPubJwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y } };
      }
    }
    const requestHeaders: Record<string, string> = {};
    if (typeof host.requestHeaders === 'object' && host.requestHeaders !== null && !Array.isArray(host.requestHeaders)) {
      for (const [key, value] of Object.entries(host.requestHeaders)) {
        if (/^[A-Za-z0-9-]{1,64}$/u.test(key) && typeof value === 'string' && value.length <= 2_048
          && !/^(authorization|cookie|set-cookie)$/iu.test(key)) requestHeaders[key] = value;
      }
    }
    hosts.push({
      id: host.id, label: host.label, url: host.url, ...(apiUrl ? { apiUrl } : {}),
      relayOnly: host.url.startsWith('relay://') && apiUrl === undefined,
      ...(relay ? { relay } : {}),
      clientToken: typeof host.clientToken === 'string' && host.clientToken.length <= 8_192 ? host.clientToken : null,
      requestHeaders,
    });
  }
  if (input.defaultHostId !== null && typeof input.defaultHostId !== 'string') return null;
  return { hosts, defaultHostId: input.defaultHostId as string | null };
}


const PROBE_STATUS_KEYS: Record<string, I18nKey> = {
  auth: 'settings.remoteInstances.probe.auth',
  incompatible: 'settings.remoteInstances.probe.incompatible',
  'update-recommended': 'settings.remoteInstances.probe.updateRecommended',
  'wrong-service': 'settings.remoteInstances.probe.wrongService',
  unreachable: 'settings.remoteInstances.probe.unreachable',
};

const HOST_SWITCH_ERRORS: Record<string, I18nKey> = {
  'desktop-env-target-active': 'settings.remoteInstances.error.envTargetActive',
  'desktop-host-not-found': 'settings.remoteInstances.error.hostNotFound',
  'desktop-ssh-not-connected': 'settings.remoteInstances.error.sshNotConnected',
  'desktop-hosts-busy': 'settings.remoteInstances.error.hostsBusy',
  'desktop-host-switch-busy': 'settings.remoteInstances.error.switchBusy',
  'desktop-host-changed': 'settings.remoteInstances.error.hostChanged',
};

const BOOT_STATUS_KEYS: Record<string, I18nKey> = {
  ok: 'settings.remoteInstances.bootStatus.ok',
  unreachable: 'settings.remoteInstances.bootStatus.unreachable',
  incompatible: 'settings.remoteInstances.bootStatus.incompatible',
  'wrong-service': 'settings.remoteInstances.bootStatus.wrongService',
  auth: 'settings.remoteInstances.bootStatus.auth',
  'relay-pending': 'settings.remoteInstances.bootStatus.relayPending',
};

export function RemoteInstancesPage(): ReactNode {
  const { t } = useI18n();
  const [catalog, setCatalog] = useState<HostCatalog | null>(null);
  const [activeHostId, setActiveHostId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<{
    key: I18nKey; reasonKey?: I18nKey; statusKey?: I18nKey; params?: Record<string, unknown>;
  } | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    const invoke = window.__NOTNATIVE_DESKTOP_INVOKE__;
    if (!invoke) { setMessage({ key: 'settings.remoteInstances.desktopOnly' }); return; }
    try {
      const reply = await invoke('desktop_hosts_get');
      const parsed = reply.ok ? parseCatalog(reply.result) : null;
      setCatalog(parsed);
      if (!reply.ok || parsed === null) setMessage({ key: 'settings.remoteInstances.status.readFailed' });
      const boot = await invoke('desktop_boot_config_get');
      const liveRuntimeKey = window.__NOTNATIVE_RUNTIME_KEY__;
      if (liveRuntimeKey === 'local') setActiveHostId('local');
      else if (typeof liveRuntimeKey === 'string' && liveRuntimeKey.startsWith('host:')) setActiveHostId(liveRuntimeKey.slice(5));
      if (boot.ok && typeof boot.result === 'object' && boot.result !== null) {
        const runtimeKey = (boot.result as { runtimeKey?: unknown }).runtimeKey;
        const outcome = (boot.result as { bootOutcome?: unknown }).bootOutcome;
        if (liveRuntimeKey === undefined || liveRuntimeKey === null) {
          if (runtimeKey === 'local') setActiveHostId('local');
          else if (typeof runtimeKey === 'string' && runtimeKey.startsWith('host:')) setActiveHostId(runtimeKey.slice(5));
        }
        else if (typeof outcome === 'object' && outcome !== null
          && (outcome as { hostId?: unknown }).hostId === '__env') setActiveHostId('__env');
      }
    } catch {
      setMessage({ key: 'settings.remoteInstances.status.readFailed' });
    }
  }, []);

  useEffect(() => {
    void reload();
    const onBootOutcome = (event: Event): void => {
      const detail = (event as CustomEvent<unknown>).detail;
      if (!detail || typeof detail !== 'object') return;
      const outcome = detail as { hostId?: unknown; status?: unknown; via?: unknown };
      if (outcome.via !== 'relay') return;
      if (outcome.status === 'ok' && typeof outcome.hostId === 'string') {
        setActiveHostId(outcome.hostId);
        setMessage({ key: 'settings.remoteInstances.status.relayConnected' });
      } else {
        setActiveHostId('local');
        setMessage({ key: 'settings.remoteInstances.status.relayUnreachable' });
      }
    };
    window.addEventListener('notnative:desktop-boot-outcome-changed', onBootOutcome);
    return () => window.removeEventListener('notnative:desktop-boot-outcome-changed', onBootOutcome);
  }, [reload]);

  const select = async (hostId: string): Promise<void> => {
    const invoke = window.__NOTNATIVE_DESKTOP_INVOKE__;
    if (!invoke) return;
    setBusyId(hostId);
    setMessage({ key: 'settings.remoteInstances.status.checking' });
    try {
      const relayHost = catalog?.hosts.find((host) => host.id === hostId && host.relayOnly);
      if (relayHost) {
        if (!relayHost.relay) { setMessage({ key: 'settings.remoteInstances.status.relayInvalid' }); return; }
        const probe = await probeDesktopRelayHost(relayHost.relay, {
          clientToken: relayHost.clientToken, requestHeaders: relayHost.requestHeaders, keepTunnel: true,
        });
        if (probe.status !== 'ok' || !probe.client) {
          setMessage({
            key: 'settings.remoteInstances.status.selectedUnreachable',
            reasonKey: PROBE_STATUS_KEYS[probe.status] ?? 'settings.remoteInstances.probe.unknown',
          });
          return;
        }
        let saved;
        try {
          saved = await invoke('desktop_host_set_relay_default', {
            hostId,
            expectedHost: {
              relayUrl: relayHost.relay.relayUrl, serverId: relayHost.relay.serverId,
              hostEncPubJwk: relayHost.relay.hostEncPubJwk, clientToken: relayHost.clientToken,
              requestHeaders: relayHost.requestHeaders,
            },
          });
        } catch (error) {
          probe.client.close();
          throw error;
        }
        if (!saved.ok) {
          probe.client.close();
          setMessage({
            key: HOST_SWITCH_ERRORS[saved.error ?? ''] ?? 'settings.remoteInstances.error.generic',
          });
          return;
        }
        const selected = saved.result as { runtime?: unknown; bootOutcome?: unknown } | undefined;
        const runtime = parseRuntime(selected?.runtime);
        if (!runtime) { probe.client.close(); setMessage({ key: 'settings.remoteInstances.error.invalidRuntime' }); return; }
        adoptRelayTunnel(relayHost.relay, probe.client);
        await switchRuntimeEndpoint({ ...runtime, relay: relayHost.relay });
        if (typeof selected?.bootOutcome === 'object' && selected.bootOutcome !== null) {
          window.__NOTNATIVE_DESKTOP_BOOT_OUTCOME__ = selected.bootOutcome as Record<string, unknown>;
        }
        setActiveHostId(hostId);
        setCatalog((previous) => previous ? { ...previous, defaultHostId: hostId } : previous);
        setMessage({ key: 'settings.remoteInstances.status.switchedRelay', params: { name: relayHost.label } });
        return;
      }
      const reply = await invoke('desktop_host_switch', { hostId });
      if (!reply.ok) {
        setMessage({
          key: HOST_SWITCH_ERRORS[reply.error ?? ''] ?? 'settings.remoteInstances.error.generic',
        });
        return;
      }
      const result = reply.result as { activeHostId?: unknown; bootOutcome?: { status?: unknown }; runtime?: unknown } | undefined;
      const runtime = parseRuntime(result?.runtime);
      if (runtime === null) { setMessage({ key: 'settings.remoteInstances.error.invalidRuntime' }); return; }
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
        const statusKey = typeof result?.bootOutcome?.status === 'string'
          ? BOOT_STATUS_KEYS[result.bootOutcome.status] ?? 'settings.remoteInstances.bootStatus.unknown'
          : 'settings.remoteInstances.bootStatus.unavailable';
        setMessage({
          key: 'settings.remoteInstances.status.unreachableSavedDefault',
          statusKey,
        });
      } else {
        setCatalog((previous) => previous ? { ...previous, defaultHostId: hostId } : previous);
        setMessage({
          key: 'settings.remoteInstances.status.switched',
          params: { name: hostId === 'local'
            ? t('settings.remoteInstances.localServer')
            : catalog?.hosts.find((host) => host.id === hostId)?.label ?? t('settings.remoteInstances.action.use') },
        });
      }
    } catch {
      setMessage({ key: 'settings.remoteInstances.error.generic' });
    } finally {
      setBusyId(null);
    }
  };

  const messageText = (() => {
    if (!message) return null;
    const messageParams = { ...message.params };
    if (message.reasonKey) messageParams.reason = t(message.reasonKey);
    if (message.statusKey) messageParams.status = t(message.statusKey);
    return t(message.key, messageParams);
  })();

  return (
    <div className="flex flex-col gap-5">
      <SettingsSection item="remote-instances.default">
        <SettingsGroupTitle>{t('settings.remoteInstances.title')}</SettingsGroupTitle>
        <p className="mb-3 text-xs text-muted-foreground">{t('settings.remoteInstances.description')}</p>
        <div className="flex items-center justify-between gap-3 rounded border border-border/50 px-3 py-2">
          <div className="min-w-0">
            <div className="text-sm text-foreground">{t('settings.remoteInstances.thisComputer')}</div>
            <div className="truncate text-xs text-muted-foreground">{t('settings.remoteInstances.localServer')}</div>
          </div>
          <button type="button" className="rounded border border-border px-3 py-1.5 text-xs hover:bg-interactive-hover/40" disabled={busyId !== null || catalog === null || activeHostId === 'local'} onClick={() => { void select('local'); }}>
            {busyId === 'local' ? t('settings.remoteInstances.action.switching') : activeHostId === 'local' ? t('settings.remoteInstances.action.current') : t('settings.remoteInstances.action.use')}
          </button>
        </div>
        {catalog?.hosts.map((host) => (
          <div key={host.id} className="mt-2 flex items-center justify-between gap-3 rounded border border-border/50 px-3 py-2">
            <div className="min-w-0">
              <div className="truncate text-sm text-foreground">{host.label}</div>
              <div className="truncate text-xs text-muted-foreground">{host.apiUrl ?? host.url}</div>
            </div>
            <button type="button" className="shrink-0 rounded border border-border px-3 py-1.5 text-xs hover:bg-interactive-hover/40" disabled={busyId !== null || activeHostId === host.id} onClick={() => { void select(host.id); }}>
            {busyId === host.id ? t('settings.remoteInstances.action.checking') : activeHostId === host.id ? t('settings.remoteInstances.action.current') : t('settings.remoteInstances.action.use')}
            </button>
          </div>
        ))}
        {catalog?.hosts.length === 0 ? <p className="mt-2 text-xs text-muted-foreground">{t('settings.remoteInstances.empty')}</p> : null}
        {messageText ? <p role="status" className="mt-3 text-xs text-muted-foreground">{messageText}</p> : null}
        <DesktopSshCatalog />
      </SettingsSection>
    </div>
  );
}
