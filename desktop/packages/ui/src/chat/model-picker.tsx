// SPDX-License-Identifier: Apache-2.0
/**
 * Model picker popover (doc 05 §B.2, v1): search field, Favorites group +
 * provider groups, per-row current marker + favorite star; effort cycles via
 * the variants layer. Tooltip metadata + long-press ride P5 (settings data).
 */
import { useMemo, useState, type ReactNode } from 'react';
import type { Provider } from '../lib/nnd/types.ts';
import { buildCatalogLayers, cycleVariant, displayLabel, filterEntries, groupEntries, loadFavorites, toggleFavorite, type ModelEntry } from './model-catalog.ts';

export type ModelSelection = { providerID: string; modelID: string; variant: string | null };

export function ModelPicker(props: {
  providers: Provider[];
  selection: ModelSelection | null;
  onPick: (selection: ModelSelection) => void;
  onOpenAddProvider: () => void;
}): ReactNode {
  const [query, setQuery] = useState('');
  const [favorites, setFavorites] = useState<Set<string>>(() => loadFavorites());
  const layers = useMemo(() => buildCatalogLayers(props.providers ?? []), [props.providers]);
  const visible = useMemo(() => filterEntries(layers.entries, query), [layers, query]);
  const groups = useMemo(() => groupEntries(visible, favorites), [visible, favorites]);

  return (
    <div className="absolute bottom-full left-0 z-20 max-h-80 w-80 overflow-auto rounded-xl border border-border/10 bg-popover p-2 shadow-2xl" data-testid="model-picker">
      <button type="button" className="mb-1 w-full rounded bg-card/5 px-2 py-1.5 text-left text-[length:var(--type-meta)] text-tone-warning hover:bg-card/10" onClick={props.onOpenAddProvider}>
        + Add new provider
      </button>
      <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search provider or model…" aria-label="Search provider or model" className="mb-2 w-full rounded-lg border border-border/10 bg-background px-2 py-1.5 text-[length:var(--type-meta)] text-foreground outline-none focus:border-border/25" />
      {groups.length === 0 ? <div className="px-2 py-3 text-[length:var(--type-meta)] text-foreground">No models available</div> : null}
      {groups.map((group) => (
        <fieldset key={group.label} className="mb-2">
          <legend className="px-1 text-[length:var(--type-micro)] uppercase tracking-wide text-muted-foreground">{group.label}</legend>
          {group.entries.map((entry) => (
            <ModelRow
              key={`${entry.providerID}:${entry.modelID}`}
              entry={entry}
              entries={layers.entries}
              current={props.selection?.providerID === entry.providerID && props.selection?.modelID === entry.modelID ? '' : undefined}
              currentVariant={props.selection?.modelID === entry.modelID && props.selection?.providerID === entry.providerID ? props.selection.variant : null}
              favorite={favorites.has(`${entry.providerID}:${entry.modelID}`)}
              onFavorite={() => {
                toggleFavorite(entry.providerID, entry.modelID);
                setFavorites(loadFavorites());
              }}
              onPick={() => props.onPick({ providerID: entry.providerID, modelID: entry.modelID, variant: null })}
              onCycleVariant={(direction) => {
                const variant = cycleVariant(entry.variants, props.selection?.variant ?? null, direction);
                props.onPick({ providerID: entry.providerID, modelID: entry.modelID, variant });
              }}
            />
          ))}
        </fieldset>
      ))}
    </div>
  );
}

function ModelRow({ entry, entries, current, currentVariant, favorite, onFavorite, onPick, onCycleVariant }: {
  entry: ModelEntry;
  entries: ModelEntry[];
  current: string | undefined;
  currentVariant: string | null;
  favorite: boolean;
  onFavorite: () => void;
  onPick: () => void;
  onCycleVariant: (direction: 'next' | 'prev') => void;
}): ReactNode {
  return (
    <div className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-card/5" data-testid="model-row">
      <button type="button" className="min-w-0 flex-1 text-left" onClick={onPick}>
        <span className={`block truncate text-[length:var(--type-meta)] ${current !== undefined ? 'text-tone-success' : 'text-foreground'}`}>{displayLabel(entry, entries)}</span>
        <span className="block truncate text-[length:var(--type-micro)] text-foreground">{entry.providerName} · {entry.modelID}{currentVariant ? ` · Thinking: ${currentVariant}` : ''}</span>
      </button>
      {entry.variants.length > 0 ? (
        <button type="button" aria-label="Cycle thinking effort" className="rounded px-1 text-[length:var(--type-micro)] text-primary" onClick={() => onCycleVariant('next')} onKeyDown={(event) => {
          if (event.key === 'ArrowLeft') { event.preventDefault(); onCycleVariant('prev'); }
          if (event.key === 'ArrowRight') { event.preventDefault(); onCycleVariant('next'); }
        }}>brain</button>
      ) : null}
      <button type="button" aria-label={favorite ? 'Unfavorite model' : 'Favorite model'} aria-pressed={favorite} className={`text-[length:var(--type-meta)] ${favorite ? 'text-tone-warning' : 'text-foreground'}`} onClick={onFavorite}>{favorite ? '★' : '☆'}</button>
    </div>
  );
}
