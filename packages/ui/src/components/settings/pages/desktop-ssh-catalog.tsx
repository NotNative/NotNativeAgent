// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { createDesktopSshNativeBridge } from '../../../lib/desktopSshNativeBridge.ts';
import { createDesktopSshStore } from '../../../lib/desktopSshStore.ts';

export function DesktopSshCatalog(): ReactNode {
  const [store] = useState(() => createDesktopSshStore(createDesktopSshNativeBridge()));
  const [, redraw] = useState(0);
  const [sshCommand, setSshCommand] = useState('');
  const [nickname, setNickname] = useState('');
  const [busy, setBusy] = useState(false);
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

  const remove = async (id: string): Promise<void> => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try { await store.remove(id); }
    finally { busyRef.current = false; setBusy(false); }
  };

  const transportAction = async (id: string, action: 'connect' | 'disconnect' | 'cancel'): Promise<void> => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      if (action === 'connect') await store.connect(id);
      else if (action === 'disconnect') await store.disconnect(id);
      else await store.cancelConnecting(id);
    } finally { busyRef.current = false; setBusy(false); }
  };

  return (
    <section className="mt-5 border-t border-border/50 pt-4" aria-labelledby="desktop-ssh-catalog-title">
      <h3 id="desktop-ssh-catalog-title" className="text-sm font-medium text-foreground">SSH instances</h3>
      <p className="mb-3 mt-1 text-xs text-muted-foreground">Connect to an existing OpenChamber server through an SSH key or agent. The tunnel targets remote port 57123; password prompts and remote installation are not supported yet.</p>
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
            const connecting = ['config_resolved', 'auth_check', 'master_connecting', 'remote_probe', 'installing', 'updating', 'server_detecting', 'server_starting', 'forwarding'].includes(status?.phase ?? '');
            return <div key={instance.id} className="mt-2 flex items-center justify-between gap-3 rounded border border-border/50 px-3 py-2">
              <div className="min-w-0">
                <div className="truncate text-sm text-foreground">{instance.nickname || instance.sshParsed.destination}</div>
                <div className="truncate text-xs text-muted-foreground">{instance.sshCommand}</div>
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
                  <button type="button" disabled={busy} onClick={() => { void transportAction(instance.id, 'disconnect'); }} className="rounded border border-border px-2 py-1 text-xs hover:bg-interactive-hover/40 disabled:opacity-50">Disconnect</button>
                ) : connecting ? (
                  <button type="button" disabled={busy} onClick={() => { void transportAction(instance.id, 'cancel'); }} className="rounded border border-border px-2 py-1 text-xs hover:bg-interactive-hover/40 disabled:opacity-50">Cancel</button>
                ) : (
                  <button type="button" disabled={busy} onClick={() => { void transportAction(instance.id, 'connect'); }} className="rounded border border-border px-2 py-1 text-xs hover:bg-interactive-hover/40 disabled:opacity-50">Connect tunnel</button>
                )}
              <button type="button" disabled={busy} onClick={() => { void remove(instance.id); }} className="rounded border border-border px-2 py-1 text-xs hover:bg-interactive-hover/40 disabled:opacity-50">Remove</button>
              </div>
            </div>;
          })}
          {store.loaded && store.instances.length === 0 ? <p className="mt-2 text-xs text-muted-foreground">No SSH instances saved.</p> : null}
        </>
      )}
    </section>
  );
}
