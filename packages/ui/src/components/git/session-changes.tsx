// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { StoreApi } from 'zustand/vanilla';
import type { DirectoryStore } from '../../sync/types.ts';
import type { GitStatus } from '../../lib/git/api.ts';
import { isNnaActivitySource, refreshActivitySnapshot } from '../../sync/activity-snapshot.ts';
import { latestTurnRequestID } from '../../sync/activity-log.ts';
import { sessionChangedFiles } from './session-change-evidence.ts';
import { useI18n } from '../../lib/i18n/context.tsx';

export function SessionChanges({ store, directory, sessionID, status, stale, visible, onOpen }: {
  store: StoreApi<DirectoryStore>; directory: string; sessionID: string | null; status: GitStatus;
  stale: boolean; visible: boolean; onOpen: (path: string, staged: boolean) => void;
}): ReactNode {
  const { t } = useI18n();
  // Config can arrive after this pane mounts. Subscribe to the whole directory
  // snapshot so becoming an NNA source also starts saved-activity recovery.
  const snapshot = useSyncExternalStore(store.subscribe, store.getState);
  const nnaSource = isNnaActivitySource(store);
  const historyKey = `${directory}\u0000${sessionID ?? ''}`;
  const [history, setHistory] = useState<{ key: string; status: 'loading' | 'ready' | 'unavailable' } | null>(null);
  const [refreshRevision, setRefreshRevision] = useState(0);
  const [scope, setScope] = useState<'session' | 'turn'>('session');
  const historyStatus = !sessionID || !nnaSource ? 'ready' : history?.key === historyKey ? history.status : 'loading';
  useEffect(() => {
    if (!visible || !sessionID || !nnaSource) return;
    let current = true;
    setHistory({ key: historyKey, status: 'loading' });
    void refreshActivitySnapshot(store, directory, sessionID, () => current)
      .then((available) => { if (current) setHistory({ key: historyKey, status: available ? 'ready' : 'unavailable' }); });
    return () => { current = false; };
  }, [historyKey, directory, sessionID, store, visible, nnaSource, refreshRevision]);
  if (!sessionID) return null;
  const turnRequestID = latestTurnRequestID(snapshot.activity, sessionID);
  const turnScoped = scope === 'turn' && turnRequestID !== null;
  const files = sessionChangedFiles(snapshot.activity, sessionID, directory, status,
    turnScoped ? turnRequestID : undefined);
  return <section className="rounded-lg border border-sky-500/20 bg-sky-500/5 p-2" data-testid="git-session-changes">
    <div className="flex items-center justify-between gap-2 px-1">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-sky-300">{turnScoped ? t('gitUi.lastTurnTouched') : t('gitUi.sessionTouched')} · {files.length}</h3>
      <div role="group" aria-label={t('gitUi.evidenceScope')} className="flex gap-1 text-[10px]">
        <button type="button" aria-pressed={!turnScoped} className={!turnScoped ? 'text-sky-300' : 'text-muted-foreground'} onClick={() => setScope('session')}>{t('gitUi.sessionScope')}</button>
        <button type="button" disabled={!turnRequestID} aria-pressed={turnScoped} className={turnScoped ? 'text-sky-300' : 'text-muted-foreground disabled:opacity-40'}
          title={!turnRequestID ? t('gitUi.noTurnIdentity') : undefined} onClick={() => setScope('turn')}>{t('gitUi.lastTurnScope')}</button>
      </div>
    </div>
    <p className="px-1 py-1 text-[10px] text-muted-foreground">{t('gitUi.evidenceNote')}</p>
    {nnaSource && historyStatus === 'unavailable' ? <p role="status" className="px-1 py-1 text-[10px] text-amber-300">
      {t('gitUi.activityUnavailable')} <button type="button" className="underline" onClick={() => setRefreshRevision((value) => value + 1)}>{t('gitUi.retry')}</button>
    </p> : null}
    {stale ? <p className="px-1 text-[10px] text-amber-300">{t('gitUi.staleEvidence')}</p> : null}
    {files.length === 0 ? <p className="px-1 py-1 text-[11px] text-muted-foreground">{historyStatus === 'loading'
      ? t('gitUi.loadingEvidence') : turnScoped ? t('gitUi.noLastTurnFiles') : t('gitUi.noSessionFiles')}</p> : files.map((file) =>
      <div key={file.path} className="flex items-center gap-2 px-1 py-0.5 text-xs">
        <button type="button" disabled={stale} className="min-w-0 flex-1 truncate text-left text-foreground hover:text-primary disabled:opacity-40"
          title={file.path} aria-label={t('gitUi.viewSessionDiff', { path: file.path })}
          onClick={() => onOpen(file.path, file.working ? false : file.staged)}>{file.path}</button>
        <span className="shrink-0 text-[10px] text-muted-foreground">{file.working && file.staged ? t('gitUi.workingAndStaged') : file.working ? t('gitUi.working') : t('gitUi.staged')}</span>
      </div>)}
  </section>;
}
