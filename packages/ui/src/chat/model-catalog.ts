// SPDX-License-Identifier: Apache-2.0
/**
 * Model catalog (doc 05 §B.2 HARNESS PORT 1): the picker's three layers —
 * provider → models → variants (thinking effort). Favorites persist
 * (nnd.model-favorites.v1, per runtime) and drive the Favorites group.
 */
import { getRuntimeKey } from '../lib/runtime-switch.ts';
import type { Provider } from '../lib/nnd/types.ts';

const FAVORITES_KEY = 'nnd.model-favorites.v1';

export interface ModelEntry {
  providerID: string;
  providerName: string;
  modelID: string;
  name: string;
  variants: string[];
}

export interface CatalogLayers {
  providers: { id: string; name: string; models: ModelEntry[] }[];
  entries: ModelEntry[];
}

export function buildCatalogLayers(providers: Provider[]): CatalogLayers {
  const layers: CatalogLayers['providers'] = [];
  const entries: ModelEntry[] = [];
  for (const provider of providers ?? []) {
    if (!provider || !provider.id || !provider.models) continue;
    const models: ModelEntry[] = [];
    for (const model of Object.values(provider.models)) {
      const variants = Object.keys(model?.variants ?? {});
      const entry: ModelEntry = {
        providerID: provider.id,
        providerName: provider.name,
        modelID: model.id,
        name: model.name || model.id,
        variants,
      };
      models.push(entry);
      entries.push(entry);
    }
    layers.push({ id: provider.id, name: provider.name, models });
  }
  return { providers: layers, entries };
}

/** Fuzzy-lite filter: case-insensitive contains over name/provider/model id. */
export function filterEntries(entries: ModelEntry[], query: string): ModelEntry[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return entries;
  return entries.filter((entry) => (
    entry.name.toLowerCase().includes(needle)
    || entry.providerName.toLowerCase().includes(needle)
    || entry.modelID.toLowerCase().includes(needle)
  ));
}

interface FavoritesEnvelope {
  version: 1;
  runtimes: Record<string, string[]>; // `${providerID}:${modelID}` ids
}

function readFavorites(): Record<string, string[]> {
  try {
    const parsed = JSON.parse(localStorage.getItem(FAVORITES_KEY) ?? '') as FavoritesEnvelope;
    return parsed?.version === 1 && typeof parsed.runtimes === 'object' ? parsed.runtimes : {};
  } catch {
    return {};
  }
}

export function loadFavorites(): Set<string> {
  return new Set(readFavorites()[getRuntimeKey()] ?? []);
}

export function toggleFavorite(providerID: string, modelID: string): void {
  const all = readFavorites();
  const runtime = getRuntimeKey();
  const id = `${providerID}:${modelID}`;
  const list = new Set(all[runtime] ?? []);
  if (list.has(id)) list.delete(id);
  else list.add(id);
  all[runtime] = [...list];
  try {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify({ version: 1, runtimes: all }));
  } catch {
    /* best-effort */
  }
}

/** Group order for the picker: Favorites, then provider groups A→Z. */
export function groupEntries(entries: ModelEntry[], favorites: Set<string>): { label: string; entries: ModelEntry[] }[] {
  const favoriteEntries = entries.filter((entry) => favorites.has(`${entry.providerID}:${entry.modelID}`));
  const byProvider = new Map<string, ModelEntry[]>();
  for (const entry of entries) {
    if (favorites.has(`${entry.providerID}:${entry.modelID}`)) continue;
    const list = byProvider.get(entry.providerName) ?? [];
    list.push(entry);
    byProvider.set(entry.providerName, list);
  }
  const groups: { label: string; entries: ModelEntry[] }[] = [];
  if (favoriteEntries.length > 0) groups.push({ label: 'Favorites', entries: favoriteEntries });
  for (const label of [...byProvider.keys()].sort((a, b) => a.localeCompare(b))) {
    groups.push({ label, entries: byProvider.get(label)! });
  }
  return groups;
}

/** Effort cycle order (§B.2): Default first, then variants as stored. */
export function cycleVariant(variants: string[], current: string | null, direction: 'next' | 'prev'): string | null {
  const options: string[] = ['default', ...variants];
  const index = options.indexOf(current ?? 'default');
  if (index < 0) return options[0]!;
  const buffer = direction === 'next' ? 1 : -1;
  return options[(options.length + index + buffer) % options.length] ?? null;
}

/** Model display label: name, or `provider/name` when names collide. */
export function displayLabel(entry: ModelEntry, entries: ModelEntry[]): string {
  const clones = entries.filter((other) => other.name === entry.name && other !== entry);
  return clones.length > 0 ? `${entry.providerName} / ${entry.name}` : entry.name;
}
