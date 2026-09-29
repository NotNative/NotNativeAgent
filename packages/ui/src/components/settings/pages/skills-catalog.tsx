// SPDX-License-Identifier: Apache-2.0
/** Configured skill source browsing backed by the P10-37 catalog store. */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useSkillsCatalogStore } from '../../../stores/useSkillsCatalogStore.ts';
import { useSessionViewStore } from '../../../sync/view-store.ts';
import { SettingsGroupTitle, SettingsSection } from '../primitives.tsx';

export function SkillsCatalogPage(): ReactNode {
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
  const [catalogRevision, setCatalogRevision] = useState(0);
  const sources = useSkillsCatalogStore((state) => state.sources);
  const itemsBySource = useSkillsCatalogStore((state) => state.itemsBySource);
  const loadingSourceIds = useSkillsCatalogStore((state) => state.loadingSourceIds);
  const lastCatalogError = useSkillsCatalogStore((state) => state.lastCatalogError);
  const lastScanError = useSkillsCatalogStore((state) => state.lastScanError);
  const loadCatalog = useSkillsCatalogStore((state) => state.loadCatalog);
  const loadSource = useSkillsCatalogStore((state) => state.loadSource);
  const activeDirectory = useSessionViewStore((state) => state.activeDirectory);
  const sourceIds = sources?.map((source) => source.id).join('\n') ?? null;
  const selectedSource = sources?.find((source) => source.id === selectedSourceId) ?? null;
  const items = selectedSourceId === null ? undefined : itemsBySource[`${selectedSourceId}|${activeDirectory ?? ''}`];
  const loading = selectedSourceId !== null && loadingSourceIds.includes(selectedSourceId);

  useEffect(() => { void loadCatalog(); }, [loadCatalog, catalogRevision]);

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
              <div className="mt-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                {item.installed.isInstalled ? `Installed${item.installed.scope ? ` · ${item.installed.scope}` : ''}` : 'Not installed'}
              </div>
            </div>
          ))}
      </div>
    </SettingsSection>
  );
}
