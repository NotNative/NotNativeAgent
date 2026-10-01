// SPDX-License-Identifier: Apache-2.0
/** Compact, source-backed workspace context for the persistent shell header. */
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { StoreApi } from 'zustand/vanilla';
import type { DirectoryStore } from '../sync/types.ts';
import { useOptionalI18n } from '../lib/i18n/context.tsx';

type WorkspaceSource = {
  childStoreOf: (directory: string) => StoreApi<DirectoryStore> | undefined;
  manager: {
    ensureChild: (directory: string) => StoreApi<DirectoryStore>;
    pin: (directory: string) => () => void;
  };
};
const subscribeNone = (): (() => void) => () => undefined;

export function workspaceName(directory: string, fallback = 'Workspace'): string {
  return directory.replace(/[\\/]+$/u, '').split(/[\\/]/u).filter(Boolean).at(-1) ?? fallback;
}

export function WorkspaceIdentity({ directory, engine, runtimeKey }: { directory: string; engine: WorkspaceSource; runtimeKey: string }): ReactNode {
  const i18n = useOptionalI18n();
  const [binding, setBinding] = useState<{ directory: string; runtimeKey: string; store: StoreApi<DirectoryStore> } | null>(null);
  useEffect(() => {
    if (!directory) { setBinding(null); return; }
    // ensureChild schedules a harness bootstrap; never call it during render.
    const store = engine.childStoreOf(directory) ?? engine.manager.ensureChild(directory);
    // The active header outlives a child-store idle TTL; preserve its source
    // until the directory changes so a stale branch cannot remain displayed.
    const release = engine.manager.pin(directory);
    setBinding({ directory, runtimeKey, store });
    return release;
  }, [directory, engine, runtimeKey]);
  const store = binding?.directory === directory && binding.runtimeKey === runtimeKey ? binding.store : null;
  const vcs = useSyncExternalStore(store?.subscribe ?? subscribeNone, () => store?.getState().vcs ?? null);
  const branch = typeof vcs?.branch === 'string' && vcs.branch.trim() ? vcs.branch : null;
  return <div className="flex min-w-0 max-w-56 items-center gap-1.5 border-l border-white/10 pl-3 text-[11px] text-neutral-500" title={directory} data-testid="workspace-identity">
    <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" className="h-3.5 w-3.5 shrink-0"><path d="M1.5 4.5h4l1.3 1.4h7.7v7.5h-13z"/><path d="M1.5 5V3.4h4.2l1.1 1.1"/></svg>
    <span className="truncate text-neutral-300">{workspaceName(directory, i18n?.t('workspaceUi.workspaceFallback') ?? 'Workspace')}</span>
    {branch ? <span className="flex min-w-0 items-center gap-1 text-neutral-600"><span aria-hidden="true">⑂</span><span className="truncate">{branch}</span></span> : null}
  </div>;
}
