// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { createDesktopSshNativeBridge } from '../../../lib/desktopSshNativeBridge.ts';
import { createDesktopSshStore } from '../../../lib/desktopSshStore.ts';
import { switchRuntimeEndpoint } from '../../../lib/runtime-switch.ts';

export function DesktopSshCatalog(): ReactNode {
  const [store] = useState(() => createDesktopSshStore(createDesktopSshNativeBridge()));
  const [, redraw] = useState(0);
  const [sshCommand, setSshCommand] = useState('');
  const [nickname, setNickname] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const busyRef = useRef(false);
  const bridgeAvailable = store.getBridge() !== null;

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
    try {
      const id = await store.createFromCommand(sshCommand, nickname || undefined);
      if (id) { setSshCommand(''); setNickname(''); }
    } finally { busyRef.current = false; setBusy(false); }
  };

  const importAliases = async (): Promise<void> => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try { await store.refreshImportCandidates(); }
    finally { busyRef.current = false; setBusy(false); }
  };

  const addAlias = async (command: string, alias: string): Promise<void> => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try { await store.createFromCommand(command, alias); }
    finally { busyRef.current = false; setBusy(false); }
  };

  const activateRuntime = async (hostId: string): Promise<boolean> => {
    const bridge = store.getBridge();
    if (!bridge) return false;
    const result = await bridge.invoke('desktop_host_switch', { hostId }) as {
      activeHostId?: unknown; runtime?: unknown; bootOutcome?: unknown;
    } | null;
    if (!result || typeof result !== 'object') {
      setActionMessage('Could not switch runtime.');
      return false;
    }
    const runtime = result.runtime as {
      apiBaseUrl?: unknown; clientToken?: unknown; requestHeaders?: unknown; runtimeKey?: unknown;
    } | undefined;
    if (typeof runtime?.apiBaseUrl !== 'string' || typeof runtime.runtimeKey !== 'string'
      || (runtime.clientToken !== null && typeof runtime.clientToken !== 'string')
      || typeof runtime.requestHeaders !== 'object' || runtime.requestHeaders === null || Array.isArray(runtime.requestHeaders)) {
      setActionMessage('The desktop returned an invalid runtime configuration.');
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
    const active = result.activeHostId === hostId;
    setActionMessage(active
      ? hostId === 'local' ? 'Using this computer.'
        : result.bootOutcome && typeof result.bootOutcome === 'object'
          && (result.bootOutcome as { status?: unknown }).status === 'auth'
          ? 'Sign in to use this SSH instance.' : 'Using the SSH instance.'
      : 'The SSH server could not be reached or authenticated; this computer remains active.');
    return active;
  };

  const selectRuntime = async (hostId: string): Promise<void> => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try { await activateRuntime(hostId); }
    catch (error) { setActionMessage(error instanceof Error ? error.message : 'Could not switch runtime.'); }
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
      setActionMessage(error instanceof Error ? error.message : 'Could not remove the SSH instance.');
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
      setActionMessage(error instanceof Error ? error.message : 'Could not update the SSH connection.');
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
      <h3 id="desktop-ssh-catalog-title" className="text-sm font-medium text-foreground">SSH instances</h3>
      <p className="mb-3 mt-1 text-xs text-muted-foreground">Connect to an existing server or opt in to upload and install this desktop build over SSH. Managed installation needs a Unix-like remote with Node.js 22.18+ and npm or bun.</p>
      {!bridgeAvailable ? <p className="text-xs text-muted-foreground">SSH instances are available in the desktop app.</p> : (
        <>
          <form className="flex flex-col gap-2" onSubmit={(event) => { void add(event); }}>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              SSH command
              <input value={sshCommand} onChange={(event) => setSshCommand(event.currentTarget.value)} placeholder="ssh user@host" maxLength={4096}
                className="rounded border border-border bg-background px-2 py-1.5 text-sm text-foreground" />
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              Name (optional)
              <input value={nickname} onChange={(event) => setNickname(event.currentTarget.value)} maxLength={256}
                className="rounded border border-border bg-background px-2 py-1.5 text-sm text-foreground" />
            </label>
            <div className="flex gap-2">
              <button type="submit" disabled={busy || sshCommand.trim() === ''} className="rounded border border-border px-3 py-1.5 text-xs hover:bg-interactive-hover/40 disabled:opacity-50">Add SSH instance</button>
              <button type="button" disabled={busy} onClick={() => { void importAliases(); }} className="rounded border border-border px-3 py-1.5 text-xs hover:bg-interactive-hover/40 disabled:opacity-50">Load SSH config aliases</button>
            </div>
          </form>
          {store.lastError ? <p role="alert" className="mt-2 text-xs text-destructive">{store.lastError}</p> : null}
          {store.importCandidates.filter((candidate) => !candidate.pattern).map((candidate) => (
            <div key={`${candidate.source}:${candidate.host}`} className="mt-2 flex items-center justify-between gap-2 rounded border border-border/50 px-3 py-2">
              <span className="truncate text-xs text-foreground">{candidate.host}</span>
              <button type="button" disabled={busy} onClick={() => { void addAlias(candidate.sshCommand, candidate.host); }} className="shrink-0 rounded border border-border px-2 py-1 text-xs hover:bg-interactive-hover/40 disabled:opacity-50">Add alias</button>
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
                  Install this desktop build over SSH
                </label>
                {instance.remoteOpenchamber.mode === 'managed' ? (
                  <label className="flex items-center gap-1 text-xs text-muted-foreground">
                    <input type="checkbox" checked={instance.remoteOpenchamber.keepRunning}
                      disabled={busy || connecting || activeSshHostId === instance.id}
                      onChange={(event) => { void configureKeepRunning(instance, event.currentTarget.checked); }} />
                    Keep the remote server running after disconnect
                  </label>
                ) : null}
                {status ? (
                  <div role="status" className="mt-1 truncate text-xs text-muted-foreground">
                    {status.phase === 'ready'
                      ? `Tunnel ready at ${status.localUrl ?? 'local endpoint'}`
                      : `${status.phase.replaceAll('_', ' ')}${status.detail ? `: ${status.detail}` : ''}`}
                  </div>
                ) : null}
              </div>
              <div className="flex shrink-0 gap-1">
                {status?.phase === 'ready' ? (
                  <>
                    <button type="button" disabled={busy || window.__NOTNATIVE_RUNTIME_KEY__ === `ssh:${instance.id}`} onClick={() => { void selectRuntime(instance.id); }} className="rounded border border-border px-2 py-1 text-xs hover:bg-interactive-hover/40 disabled:opacity-50">{window.__NOTNATIVE_RUNTIME_KEY__ === `ssh:${instance.id}` ? 'Current' : 'Use instance'}</button>
                    <button type="button" disabled={busy} onClick={() => { void transportAction(instance.id, 'disconnect'); }} className="rounded border border-border px-2 py-1 text-xs hover:bg-interactive-hover/40 disabled:opacity-50">Disconnect</button>
                  </>
                ) : connecting ? (
                  <button type="button" disabled={busy} onClick={() => { void transportAction(instance.id, 'cancel'); }} className="rounded border border-border px-2 py-1 text-xs hover:bg-interactive-hover/40 disabled:opacity-50">Cancel</button>
                ) : (
                  <button type="button" disabled={busy} onClick={() => { void transportAction(instance.id, 'connect'); }} className="rounded border border-border px-2 py-1 text-xs hover:bg-interactive-hover/40 disabled:opacity-50">{instance.remoteOpenchamber.mode === 'managed' ? 'Install & connect' : 'Connect tunnel'}</button>
                )}
              <button type="button" disabled={busy} onClick={() => { void remove(instance.id); }} className="rounded border border-border px-2 py-1 text-xs hover:bg-interactive-hover/40 disabled:opacity-50">Remove</button>
              </div>
            </div>;
          })}
          {actionMessage ? <p role="status" className="mt-2 text-xs text-muted-foreground">{actionMessage}</p> : null}
          {store.loaded && store.instances.length === 0 ? <p className="mt-2 text-xs text-muted-foreground">No SSH instances saved.</p> : null}
        </>
      )}
    </section>
  );
}
