// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { createDesktopSshNativeBridge } from '../../../lib/desktopSshNativeBridge.ts';
import { createDesktopSshStore } from '../../../lib/desktopSshStore.ts';
import { useI18n } from '../../I18nProvider.tsx';
import { switchRuntimeEndpoint } from '../../../lib/runtime-switch.ts';
import type { I18nKey } from '../../../lib/i18n/messages/en.ts';

type ActionFeedback = { kind: 'key'; key: I18nKey } | { kind: 'raw'; message: string } | null;

function switchApiEndpointIsValid(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    return ['http:', 'https:'].includes(url.protocol);
  } catch {
    return false;
  }
}

function expectedRuntimeKey(hostId: string): string {
  return hostId === 'local' ? 'local' : `ssh:${hostId}`;
}

function requestHeadersAreSafe(value: unknown): value is Record<string, string> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.values(value).every((item) => typeof item === 'string');
}

function bootOutcomeIsValid(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && typeof (value as { status?: unknown }).status === 'string';
}

export function DesktopSshCatalog(): ReactNode {
  const [store] = useState(() => createDesktopSshStore(createDesktopSshNativeBridge()));
  const [, redraw] = useState(0);
  const [sshCommand, setSshCommand] = useState('');
  const [nickname, setNickname] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionFeedback, setActionFeedback] = useState<ActionFeedback>(null);
  const busyRef = useRef(false);
  const bridgeAvailable = store.getBridge() !== null;
  const { t } = useI18n();

  useEffect(() => {
    const unsubscribe = store.subscribe(() => redraw((value) => value + 1));
    void (async () => {
      await store.loadConfig();
      await store.refreshStatuses();
    })();
    return unsubscribe;
  }, [store]);

  const add = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setActionFeedback(null);
    try {
      const id = await store.createFromCommand(sshCommand, nickname || undefined);
      if (id) { setSshCommand(''); setNickname(''); }
    } finally { busyRef.current = false; setBusy(false); }
  };

  const importAliases = async (): Promise<void> => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setActionFeedback(null);
    try { await store.refreshImportCandidates(); }
    finally { busyRef.current = false; setBusy(false); }
  };

  const addAlias = async (command: string, alias: string): Promise<void> => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setActionFeedback(null);
    try { await store.createFromCommand(command, alias); }
    finally { busyRef.current = false; setBusy(false); }
  };

  const activateRuntime = async (hostId: string): Promise<boolean> => {
    const bridge = store.getBridge();
    if (!bridge) return false;
    const result = await bridge.invoke('desktop_host_switch', { hostId }) as {
      activeHostId?: unknown; runtime?: unknown; bootOutcome?: unknown;
    } | null;
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      setActionFeedback({ kind: 'key', key: 'settings.desktopSsh.action.switchFailed' });
      return false;
    }
    const activeHostId = typeof result.activeHostId === 'string' ? result.activeHostId : null;
    const runtime = result.runtime as {
      apiBaseUrl?: unknown; clientToken?: unknown; requestHeaders?: unknown; runtimeKey?: unknown;
    } | undefined;
    if (activeHostId === null
      || !bootOutcomeIsValid(result.bootOutcome)
      || typeof runtime?.apiBaseUrl !== 'string'
      || !switchApiEndpointIsValid(runtime.apiBaseUrl)
      || runtime.runtimeKey !== expectedRuntimeKey(hostId)
      || (runtime.clientToken !== null && (typeof runtime.clientToken !== 'string' || runtime.clientToken === ''))
      || !requestHeadersAreSafe(runtime.requestHeaders)) {
      setActionFeedback({ kind: 'key', key: 'settings.desktopSsh.action.invalidRuntime' });
      return false;
    }
    await switchRuntimeEndpoint({
      apiBaseUrl: runtime.apiBaseUrl,
      runtimeKey: runtime.runtimeKey,
      clientToken: runtime.clientToken as string | null,
      requestHeaders: runtime.requestHeaders as Record<string, string>,
    });
    if (typeof result.bootOutcome === 'object' && result.bootOutcome !== null) {
      window.__NOTNATIVE_DESKTOP_BOOT_OUTCOME__ = result.bootOutcome as Record<string, unknown>;
    }
    const active = activeHostId === hostId;
    setActionFeedback(active
      ? hostId === 'local' ? { kind: 'key', key: 'settings.desktopSsh.action.localActive' }
        : (result.bootOutcome as { status: string }).status === 'auth'
          ? { kind: 'key', key: 'settings.desktopSsh.action.signIn' }
          : { kind: 'key', key: 'settings.desktopSsh.action.sshActive' }
      : { kind: 'key', key: 'settings.desktopSsh.action.switchInactive' });
    return active;
  };

  const selectRuntime = async (hostId: string): Promise<void> => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try { await activateRuntime(hostId); }
    catch (error) { setActionFeedback(error instanceof Error ? { kind: 'raw', message: error.message } : { kind: 'key', key: 'settings.desktopSsh.action.switchFailed' }); }
    finally { busyRef.current = false; setBusy(false); }
  };

  const remove = async (id: string): Promise<void> => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      if (window.__NOTNATIVE_RUNTIME_KEY__ === `ssh:${id}` && !(await activateRuntime('local'))) return;
      await store.remove(id);
    } catch (error) {
      setActionFeedback(error instanceof Error ? { kind: 'raw', message: error.message } : { kind: 'key', key: 'settings.desktopSsh.action.removeFailed' });
    } finally { busyRef.current = false; setBusy(false); }
  };

  const transportAction = async (id: string, action: 'connect' | 'disconnect' | 'cancel'): Promise<void> => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      if (action === 'connect') await store.connect(id);
      else if (action === 'disconnect') {
        if (window.__NOTNATIVE_RUNTIME_KEY__ === `ssh:${id}` && !(await activateRuntime('local'))) return;
        await store.disconnect(id);
      }
      else await store.cancelConnecting(id);
    } catch (error) {
      setActionFeedback(error instanceof Error ? { kind: 'raw', message: error.message } : { kind: 'key', key: 'settings.desktopSsh.action.updateFailed' });
    } finally { busyRef.current = false; setBusy(false); }
  };

  const configureManaged = async (instance: (typeof store.instances)[number], enabled: boolean): Promise<void> => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await store.upsert({ ...instance, remoteOpenchamber: {
        ...instance.remoteOpenchamber,
        mode: enabled ? 'managed' : 'external',
        uploadBundleOverSsh: enabled,
      } });
    } finally { busyRef.current = false; setBusy(false); }
  };

  const configureKeepRunning = async (instance: (typeof store.instances)[number], keepRunning: boolean): Promise<void> => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try { await store.upsert({ ...instance, remoteOpenchamber: { ...instance.remoteOpenchamber, keepRunning } }); }
    finally { busyRef.current = false; setBusy(false); }
  };

  const activeRuntimeKey = window.__NOTNATIVE_RUNTIME_KEY__ ?? '';
  const activeSshHostId = activeRuntimeKey.startsWith('ssh:') ? activeRuntimeKey.slice(4) : '';
  const activeSshPhase = activeSshHostId ? store.statuses[activeSshHostId]?.phase ?? '' : '';
  useEffect(() => {
    // A tunnel can fail while another catalog action is in flight. Retry the
    // fallback when that action releases the UI lock, or the SSH runtime can
    // remain pointed at a dead forwarded port indefinitely.
    if (!busy && (activeSshPhase === 'error' || activeSshPhase === 'idle')) void selectRuntime('local');
  }, [activeRuntimeKey, activeSshPhase, busy]);

  return (
    <section className="mt-5 border-t border-border/50 pt-4" aria-labelledby="desktop-ssh-catalog-title">
      <h3 id="desktop-ssh-catalog-title" className="text-sm font-medium text-foreground">{t('settings.desktopSsh.title')}</h3>
      <p className="mb-3 mt-1 text-xs text-muted-foreground">{t('settings.desktopSsh.description')}</p>
      {!bridgeAvailable ? <p className="text-xs text-muted-foreground">{t('settings.desktopSsh.desktopOnly')}</p> : (
        <>
          <form className="flex flex-col gap-2" onSubmit={(event) => { void add(event); }}>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              {t('settings.desktopSsh.command')}
              <input value={sshCommand} onChange={(event) => setSshCommand(event.currentTarget.value)} placeholder="ssh user@host" maxLength={4096}
                className="rounded border border-border bg-background px-2 py-1.5 text-sm text-foreground" />
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              {t('settings.desktopSsh.name')}
              <input value={nickname} onChange={(event) => setNickname(event.currentTarget.value)} maxLength={256}
                className="rounded border border-border bg-background px-2 py-1.5 text-sm text-foreground" />
            </label>
            <div className="flex gap-2">
    <button type="submit" data-testid="desktop-ssh-add" disabled={busy || sshCommand.trim() === ''} className="rounded border border-border px-3 py-1.5 text-xs hover:bg-interactive-hover/40 disabled:opacity-50">{t('settings.desktopSsh.add')}</button>
    <button type="button" data-testid="desktop-ssh-import" disabled={busy} onClick={() => { void importAliases(); }} className="rounded border border-border px-3 py-1.5 text-xs hover:bg-interactive-hover/40 disabled:opacity-50">{t('settings.desktopSsh.import')}</button>
            </div>
          </form>
          {store.lastError ? <p role="alert" className="mt-2 text-xs text-destructive">{store.lastError}</p> : null}
          {store.importCandidates.filter((candidate) => !candidate.pattern).map((candidate) => (
            <div key={`${candidate.source}:${candidate.host}`} className="mt-2 flex items-center justify-between gap-2 rounded border border-border/50 px-3 py-2">
              <span className="truncate text-xs text-foreground">{candidate.host}</span>
    <button type="button" data-testid="desktop-ssh-add-alias" disabled={busy} onClick={() => { void addAlias(candidate.sshCommand, candidate.host); }} className="shrink-0 rounded border border-border px-2 py-1 text-xs hover:bg-interactive-hover/40 disabled:opacity-50">{t('settings.desktopSsh.alias')}</button>
            </div>
          ))}
          {store.instances.map((instance) => {
            const status = store.statuses[instance.id];
            const connecting = ['config_resolved', 'auth_check', 'remote_installing', 'master_connecting', 'remote_probe', 'installing', 'updating', 'server_detecting', 'server_starting', 'forwarding'].includes(status?.phase ?? '');
            return <div key={instance.id} className="mt-2 flex items-center justify-between gap-3 rounded border border-border/50 px-3 py-2">
              <div className="min-w-0">
                <div className="truncate text-sm text-foreground">{instance.nickname || instance.sshParsed.destination}</div>
                <div className="truncate text-xs text-muted-foreground">{instance.sshCommand}</div>
                <label className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                  <input type="checkbox" checked={instance.remoteOpenchamber.mode === 'managed' && instance.remoteOpenchamber.uploadBundleOverSsh}
                    disabled={busy || connecting || activeSshHostId === instance.id}
                    onChange={(event) => { void configureManaged(instance, event.currentTarget.checked); }} />
                  {t('settings.desktopSsh.managedInstall')}
                </label>
                {instance.remoteOpenchamber.mode === 'managed' ? (
                  <label className="flex items-center gap-1 text-xs text-muted-foreground">
                    <input type="checkbox" checked={instance.remoteOpenchamber.keepRunning}
                      disabled={busy || connecting || activeSshHostId === instance.id}
                      onChange={(event) => { void configureKeepRunning(instance, event.currentTarget.checked); }} />
                  {t('settings.desktopSsh.keepRunning')}
                  </label>
                ) : null}
                {status ? (
                  <div role="status" className="mt-1 truncate text-xs text-muted-foreground">
                    {status.phase === 'ready'
                      ? t('settings.desktopSsh.statusReady', { url: status.localUrl ?? 'local endpoint' })
                      : status.phase.replaceAll('_', ' ')}
                  </div>
                ) : null}
              </div>
              <div className="flex shrink-0 gap-1">
                {status?.phase === 'ready' ? (
                  <>
                    <button type="button" data-testid="desktop-ssh-use" disabled={busy || window.__NOTNATIVE_RUNTIME_KEY__ === `ssh:${instance.id}`} onClick={() => { void selectRuntime(instance.id); }} className="rounded border border-border px-2 py-1 text-xs hover:bg-interactive-hover/40 disabled:opacity-50">{window.__NOTNATIVE_RUNTIME_KEY__ === `ssh:${instance.id}` ? t('settings.desktopSsh.current') : t('settings.desktopSsh.use')}</button>
                    <button type="button" data-testid="desktop-ssh-disconnect" disabled={busy} onClick={() => { void transportAction(instance.id, 'disconnect'); }} className="rounded border border-border px-2 py-1 text-xs hover:bg-interactive-hover/40 disabled:opacity-50">{t('settings.desktopSsh.disconnect')}</button>
                  </>
                ) : connecting ? (
                  <button type="button" data-testid="desktop-ssh-cancel" disabled={busy} onClick={() => { void transportAction(instance.id, 'cancel'); }} className="rounded border border-border px-2 py-1 text-xs hover:bg-interactive-hover/40 disabled:opacity-50">{t('settings.desktopSsh.cancel')}</button>
                ) : (
                  <button type="button" data-testid="desktop-ssh-connect" disabled={busy} onClick={() => { void transportAction(instance.id, 'connect'); }} className="rounded border border-border px-2 py-1 text-xs hover:bg-interactive-hover/40 disabled:opacity-50">{instance.remoteOpenchamber.mode === 'managed' ? t('settings.desktopSsh.installConnect') : t('settings.desktopSsh.connect')}</button>
                )}
              <button type="button" data-testid="desktop-ssh-remove" disabled={busy} onClick={() => { void remove(instance.id); }} className="rounded border border-border px-2 py-1 text-xs hover:bg-interactive-hover/40 disabled:opacity-50">{t('settings.desktopSsh.remove')}</button>
              </div>
            </div>;
          })}
          {actionFeedback ? <p role="status" className="mt-2 text-xs text-muted-foreground">{actionFeedback.kind === 'raw' ? actionFeedback.message : t(actionFeedback.key)}</p> : null}
          {store.loaded && store.instances.length === 0 ? <p className="mt-2 text-xs text-muted-foreground">{t('settings.desktopSsh.empty')}</p> : null}
        </>
      )}
    </section>
  );
}
