// SPDX-License-Identifier: Apache-2.0
/** Configured skill source browsing backed by the P10-37 catalog store. */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { onRuntimeEndpointChanged } from '../../../lib/runtime-switch.ts';
import type { SkillConflict, SkillTargetSource } from '../../../lib/skills-api.ts';
import { useSkillsCatalogStore } from '../../../stores/useSkillsCatalogStore.ts';
import { useSessionViewStore } from '../../../sync/view-store.ts';
import { SettingsChipGroup, SettingsGroupTitle, SettingsSection } from '../primitives.tsx';

export function SkillsCatalogPage(): ReactNode {
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
  const [catalogRevision, setCatalogRevision] = useState(0);
  const [installScope, setInstallScope] = useState<'user' | 'project'>('user');
  const [targetSource, setTargetSource] = useState<SkillTargetSource>('opencode');
  const [installStatus, setInstallStatus] = useState<{
    sourceId: string; directory?: string; scope: 'user' | 'project';
    target: SkillTargetSource; message: string;
  } | null>(null);
  const [conflictState, setConflictState] = useState<{
    sourceId: string; directory?: string; scope: 'user' | 'project';
    target: SkillTargetSource; skillName: string; path: string;
  } | null>(null);
  const [runtimeRevision, setRuntimeRevision] = useState(0);
  const runtimeRevisionRef = useRef(runtimeRevision);
  const activeInstallRef = useRef(new Set<string>());
  const sources = useSkillsCatalogStore((state) => state.sources);
  const itemsBySource = useSkillsCatalogStore((state) => state.itemsBySource);
  const loadingSourceIds = useSkillsCatalogStore((state) => state.loadingSourceIds);
  const lastCatalogError = useSkillsCatalogStore((state) => state.lastCatalogError);
  const lastScanError = useSkillsCatalogStore((state) => state.lastScanError);
  const loadCatalog = useSkillsCatalogStore((state) => state.loadCatalog);
  const loadSource = useSkillsCatalogStore((state) => state.loadSource);
  const installSource = useSkillsCatalogStore((state) => state.installSource);
  const activeDirectory = useSessionViewStore((state) => state.activeDirectory);
  const installingSourceIds = useSkillsCatalogStore((state) => state.installingSourceIds);
  const sourceIds = sources?.map((source) => source.id).join('\n') ?? null;
  const selectedSource = sources?.find((source) => source.id === selectedSourceId) ?? null;
  const items = selectedSourceId === null ? undefined : itemsBySource[`${selectedSourceId}|${activeDirectory ?? ''}`];
  const loading = selectedSourceId !== null && loadingSourceIds.includes(selectedSourceId);
  const installStatusVisible = installStatus !== null
    && installStatus.sourceId === selectedSourceId
    && installStatus.directory === (activeDirectory || undefined)
    && installStatus.scope === installScope
    && installStatus.target === targetSource;
  const conflictStateVisible = conflictState !== null
    && conflictState.sourceId === selectedSourceId
    && conflictState.directory === (activeDirectory || undefined)
    && conflictState.scope === installScope
    && conflictState.target === targetSource;
  const conflictPending = selectedSourceId !== null && installingSourceIds.includes(selectedSourceId);

  useEffect(() => { void loadCatalog(); }, [loadCatalog, catalogRevision, runtimeRevision]);

  useEffect(() => {
    const off = onRuntimeEndpointChanged(() => {
      runtimeRevisionRef.current += 1;
      setRuntimeRevision(runtimeRevisionRef.current);
      setSelectedSourceId(null);
      setInstallStatus(null);
      setConflictState(null);
    });
    return () => { off(); };
  }, []);

  useEffect(() => {
    if (sources === null || sources.length === 0) return;
    setSelectedSourceId((current) => current !== null && sources.some((source) => source.id === current)
      ? current
      : sources[0]!.id);
  }, [sourceIds, sources]);

  useEffect(() => {
    if (selectedSourceId === null) return;
    void loadSource(selectedSourceId, { directory: activeDirectory || undefined });
  }, [selectedSourceId, activeDirectory, loadSource, catalogRevision]);

  type InstallRequest = {
    sourceId: string; skillName: string; directory?: string;
    scope: 'user' | 'project'; target: SkillTargetSource;
  };
  const sendInstallRequest = useCallback(async (request: InstallRequest, override: {
    conflictPolicy?: 'skipAll' | 'overwriteAll';
    conflictDecision?: 'skip' | 'overwrite';
  } = {}): Promise<void> => {
    const requestKey = `${request.sourceId}|${request.skillName}`;
    if (installingSourceIds.includes(request.sourceId) || activeInstallRef.current.has(requestKey)) return;
    const requestRuntimeRevision = runtimeRevisionRef.current;
    activeInstallRef.current.add(requestKey);
    setInstallStatus(null);
    try {
      const outcome = await installSource(request.sourceId, {
        directory: request.directory,
        scope: request.scope,
        targetSource: request.target,
        selections: [request.skillName],
        conflictPolicy: override.conflictPolicy,
        conflictDecisions: override.conflictDecision === undefined
          ? undefined
          : { [request.skillName]: override.conflictDecision },
      });
      if (runtimeRevisionRef.current !== requestRuntimeRevision) return;
      if (outcome.kind === 'success') {
        setConflictState(null);
        setInstallStatus({
          sourceId: request.sourceId, directory: request.directory,
          scope: request.scope, target: request.target, message: outcome.message,
        });
        void loadSource(request.sourceId, { directory: request.directory, refresh: true });
        return;
      }
      const relevantConflict = outcome.conflicts?.find((conflict) =>
        typeof conflict.skillName === 'string' && conflict.skillName === request.skillName
        && typeof conflict.path === 'string' && conflict.path !== ''
        && (conflict.scope === 'user' || conflict.scope === 'project') && conflict.scope === request.scope
        && typeof conflict.source === 'string' && conflict.source === request.target);
      setConflictState(relevantConflict === undefined ? null : {
        sourceId: request.sourceId, directory: request.directory,
        scope: request.scope, target: request.target,
        skillName: request.skillName, path: relevantConflict.path,
      });
      setInstallStatus({
        sourceId: request.sourceId, directory: request.directory,
        scope: request.scope, target: request.target, message: outcome.message,
      });
    } finally {
      activeInstallRef.current.delete(requestKey);
    }
  }, [installingSourceIds, installSource, loadSource]);

  const installSkill = useCallback((name: string): void => {
    if (selectedSourceId === null) return;
    void sendInstallRequest({
      sourceId: selectedSourceId, skillName: name, directory: activeDirectory || undefined,
      scope: installScope, target: targetSource,
    });
  }, [selectedSourceId, activeDirectory, installScope, targetSource, sendInstallRequest]);

  const resolveConflict = useCallback((action: 'skip' | 'overwrite' | 'skipAll' | 'overwriteAll'): void => {
    if (conflictState === null) return;
    void sendInstallRequest({
      sourceId: conflictState.sourceId, skillName: conflictState.skillName,
      directory: conflictState.directory, scope: conflictState.scope, target: conflictState.target,
    }, action === 'skip' || action === 'overwrite'
      ? { conflictDecision: action }
      : { conflictPolicy: action });
  }, [conflictState, sendInstallRequest]);

  const refresh = useCallback(() => {
    setCatalogRevision((current) => current + 1);
    if (selectedSourceId !== null) {
      void loadSource(selectedSourceId, { directory: activeDirectory || undefined, refresh: true });
    }
  }, [selectedSourceId, activeDirectory, loadSource]);

  return (
    <SettingsSection item="skills.catalog">
      <div className="flex items-center justify-between gap-3">
        <SettingsGroupTitle>Skills catalog</SettingsGroupTitle>
        <button type="button" className="rounded border border-border/60 px-2 py-1 text-xs text-foreground disabled:opacity-50" data-testid="skills-catalog-refresh" onClick={refresh}>Refresh</button>
      </div>
      {lastCatalogError ? <p role="alert" className="text-xs text-destructive">{lastCatalogError}</p> : null}
      {sources?.length === 0 ? <p className="text-xs text-muted-foreground">No skill catalog sources are configured.</p>
        : sources === null && !lastCatalogError ? <p role="status" className="text-xs text-muted-foreground">Loading catalog sources…</p>
        : (
          <div className="flex flex-wrap items-center gap-2" data-testid="skill-catalog-source-picker">
            {sources?.map((source) => (
              <button key={source.id} type="button" aria-pressed={source.id === selectedSourceId}
                data-testid="skill-catalog-source"
                onClick={() => setSelectedSourceId(source.id)}
                className={`rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
                  source.id === selectedSourceId
                    ? 'border-primary/60 bg-primary/15 text-primary'
                    : 'border-border/60 text-muted-foreground hover:bg-interactive-hover'
                }`}
              >
                {source.label}
              </button>
            ))}
          </div>
        )}
      {activeDirectory ? <p className="mt-2 text-xs text-muted-foreground">Workspace: {activeDirectory}</p> : null}
      {lastScanError ? <p role="alert" className="mt-2 text-xs text-destructive">{lastScanError}</p> : null}
      {installStatusVisible ? <p role="status" className="mt-2 text-xs text-muted-foreground">{installStatus.message}</p> : null}
      {conflictStateVisible && conflictState !== null ? (
        <div className="mt-2 rounded-md border border-border/60 p-3" data-testid="skill-catalog-conflict">
          <div className="text-xs font-medium text-foreground">Skill already exists</div>
          <div className="mt-1 text-xs text-muted-foreground">{conflictState.skillName} · {conflictState.path}</div>
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" className="rounded border border-border/60 px-2 py-1 text-xs text-foreground hover:bg-interactive-hover disabled:opacity-50" data-testid="skill-catalog-conflict-skip" disabled={conflictPending} onClick={() => resolveConflict('skip')}>Skip</button>
            <button type="button" className="rounded border border-border/60 px-2 py-1 text-xs text-foreground hover:bg-interactive-hover disabled:opacity-50" data-testid="skill-catalog-conflict-overwrite" disabled={conflictPending} onClick={() => resolveConflict('overwrite')}>Overwrite</button>
            <button type="button" className="rounded border border-border/60 px-2 py-1 text-xs text-foreground hover:bg-interactive-hover disabled:opacity-50" data-testid="skill-catalog-conflict-skip-all" disabled={conflictPending} onClick={() => resolveConflict('skipAll')}>Skip all</button>
            <button type="button" className="rounded border border-border/60 px-2 py-1 text-xs text-foreground hover:bg-interactive-hover disabled:opacity-50" data-testid="skill-catalog-conflict-overwrite-all" disabled={conflictPending} onClick={() => resolveConflict('overwriteAll')}>Overwrite all</button>
          </div>
        </div>
      ) : null}
      <div className="mt-2 flex flex-col gap-2 lg:flex-row">
        <SettingsChipGroup item="skills.catalog.scope" value={installScope} onChange={(value) => setInstallScope(value === 'project' ? 'project' : 'user')}
          options={[
            { value: 'user', label: 'User' },
            { value: 'project', label: activeDirectory ? 'Project' : 'Project (no workspace)' },
          ]}
        />
        <SettingsChipGroup item="skills.catalog.target" value={targetSource} onChange={(value) => setTargetSource(value === 'agents' ? 'agents' : 'opencode')}
          options={[
            { value: 'opencode', label: 'OpenCode' },
            { value: 'agents', label: 'Agents' },
          ]}
        />
      </div>
      {selectedSource === null ? null : (
        <div className="mt-3" data-testid="skill-catalog-source-details">
          <div className="text-xs font-medium text-foreground">{selectedSource.label}</div>
          <div className="text-xs text-muted-foreground">{selectedSource.source}{selectedSource.subpath ? ` · ${selectedSource.subpath}` : ''}</div>
        </div>
      )}
      <div className="mt-3 space-y-2">
        {loading && items === undefined ? <p role="status" className="text-xs text-muted-foreground">Scanning source…</p>
          : items === undefined && !lastScanError ? <p className="text-xs text-muted-foreground">Select a source to browse its skills.</p>
          : items !== undefined && items.length === 0 ? <p className="text-xs text-muted-foreground">No skills were discovered in this source.</p>
          : items?.map((item) => (
            <div key={item.skillDir} className="rounded-md border border-border/40 p-3 text-xs" data-testid="skill-catalog-item">
              <div className="font-medium text-foreground">{item.skillName}</div>
              <div className="mt-1 text-muted-foreground">{item.description}</div>
                              <div className="mt-2 flex items-center justify-between gap-2 text-[10px] uppercase tracking-wide text-muted-foreground">
                  <span>{item.installed.isInstalled ? `Installed${item.installed.scope ? ` · ${item.installed.scope}` : ''}` : 'Not installed'}</span>
                  {!item.installed.isInstalled ? (
                    <button type="button"
                      className="rounded border border-border/60 px-2 py-1 text-xs normal-case text-foreground hover:bg-interactive-hover disabled:opacity-50"
                      data-testid={`install-skill-${item.skillName}`}
                      disabled={!item.installable || (installScope === 'project' && !activeDirectory)
                        || installingSourceIds.includes(selectedSourceId || '') || activeInstallRef.current.has(`${selectedSourceId}|${item.skillName}`)}
                      onClick={() => { void installSkill(item.skillName); }}
                    >
                      Install
                    </button>
                  ) : null}
                </div>
            </div>
          ))}
      </div>
    </SettingsSection>
  );
}
