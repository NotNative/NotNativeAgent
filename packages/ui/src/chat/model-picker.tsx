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
    <div className="absolute bottom-full left-0 z-20 max-h-80 w-80 overflow-auto rounded-xl border border-white/10 bg-neutral-950 p-2 shadow-2xl" data-testid="model-picker">
      <button type="button" className="mb-1 w-full rounded bg-white/5 px-2 py-1.5 text-left text-[12px] text-amber-300 hover:bg-white/10" onClick={props.onOpenAddProvider}>
        + Add new provider
      </button>
      <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search provider or model…" aria-label="Search provider or model" className="mb-2 w-full rounded-lg border border-white/10 bg-neutral-900 px-2 py-1.5 text-[12px] text-neutral-200 outline-none focus:border-white/25" />
      {groups.length === 0 ? <div className="px-2 py-3 text-[11px] text-neutral-600">No models available</div> : null}
      {groups.map((group) => (
        <fieldset key={group.label} className="mb-2">
          <legend className="px-1 text-[10px] uppercase tracking-wide text-neutral-500">{group.label}</legend>
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
    <div className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-white/5" data-testid="model-row">
      <button type="button" className="min-w-0 flex-1 text-left" onClick={onPick}>
        <span className={`block truncate text-[12px] ${current !== undefined ? 'text-emerald-300' : 'text-neutral-200'}`}>{displayLabel(entry, entries)}</span>
        <span className="block truncate text-[10px] text-neutral-600">{entry.providerName} · {entry.modelID}{currentVariant ? ` · Thinking: ${currentVariant}` : ''}</span>
      </button>
      {entry.variants.length > 0 ? (
        <button type="button" aria-label="Cycle thinking effort" className="rounded px-1 text-[10px] text-indigo-300" onClick={() => onCycleVariant('next')} onKeyDown={(event) => {
          if (event.key === 'ArrowLeft') { event.preventDefault(); onCycleVariant('prev'); }
          if (event.key === 'ArrowRight') { event.preventDefault(); onCycleVariant('next'); }
        }}>brain</button>
      ) : null}
      <button type="button" aria-label={favorite ? 'Unfavorite model' : 'Favorite model'} aria-pressed={favorite} className={`text-[12px] ${favorite ? 'text-amber-300' : 'text-neutral-700'}`} onClick={onFavorite}>{favorite ? '★' : '☆'}</button>
    </div>
  );
}
