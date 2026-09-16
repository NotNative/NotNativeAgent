// SPDX-License-Identifier: Apache-2.0
/**
 * P3b gates: model-catalog layers/filter/groups/favorites-effort cycle,
 * §H.5 starter insert semantics + persistence, §B.2 effort labels,
 * and the picker current-row rule.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { buildCatalogLayers, cycleVariant, displayLabel, filterEntries, groupEntries, loadFavorites, toggleFavorite } from '../model-catalog.ts';
import type { Provider } from '../../lib/nnd/types.ts';
import { effortLabel } from '../model-picker.ts';
import { startersFor, starterInsertText, addStarter, removeStarter, type Starter } from '../starters.ts';

// node-environment shim: the persistence layer guards on localStorage presence;
// these suites exercise it with an in-memory map.
const backing = new Map<string, string>();
const shim = {
  getItem: (key: string): string | null => backing.get(key) ?? null,
  setItem: (key: string, value: string): void => { backing.set(key, value); },
  removeItem: (key: string): void => { backing.delete(key); },
  clear: (): void => { backing.clear(); },
  key: (): string | null => null,
  get length(): number { return backing.size; },
};
if (typeof (globalThis as Record<string, unknown>)['localStorage'] === 'undefined') {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: shim, writable: true });
}
const clearBacking = (): void => { backing.clear(); };

const PROVIDERS: Provider[] = [
  {
    id: 'nnd',
    name: 'NotNative',
    models: {
      smart: { id: 'smart', providerID: 'nnd', name: 'Smart', variants: { deep: {}, tall: {} } as never },
      quick: { id: 'quick', providerID: 'nnd', name: 'Quick' },
    },
  },
  { id: 'other', name: 'OtherCorp', models: { smart: { id: 'smart', providerID: 'other', name: 'Smart' } } },
];

describe('model catalog layers (HARNESS PORT 1)', () => {
  beforeEach(() => { clearBacking(); });
  it('builds provider → model → variant layers', () => {
    const layers = buildCatalogLayers(PROVIDERS);
    expect(layers.providers.map((provider) => provider.id)).toEqual(['nnd', 'other']);
    expect(layers.entries.find((entry) => entry.providerID === 'nnd' && entry.modelID === 'smart')!.variants).toEqual(['deep', 'tall']);
  });

  it('filters case-insensitively across name/provider/id', () => {
    const entries = buildCatalogLayers(PROVIDERS).entries;
    expect(filterEntries(entries, 'quick').map((entry) => entry.modelID)).toEqual(['quick']);
    expect(filterEntries(entries, 'othercorp')).toHaveLength(1);
  });

  it('collisions disambiguate with provider prefix in the display label', () => {
    const entries = buildCatalogLayers(PROVIDERS).entries;
    const other = entries.find((entry) => entry.providerID === 'other')!;
    expect(displayLabel(other, entries)).toBe('OtherCorp / Smart');
    const ours = entries.find((entry) => entry.providerID === 'nnd' && entry.modelID === 'quick')!;
    expect(displayLabel(ours, entries)).toBe('Quick');
  });

  it('cycles effort Default → variants and wraps both directions', () => {
    expect(cycleVariant(['deep', 'tall'], null, 'next')).toBe('deep');
    expect(cycleVariant(['deep', 'tall'], 'deep', 'prev')).toBe('default');
    expect(cycleVariant(['deep'], 'deep', 'next')).toBe('default');
    expect(effortLabel('deep')).toBe('deep');
    expect(effortLabel(null)).toBe('Default');
  });

  it('favorites persist per runtime and group FIRST with provider groups after', () => {
    clearBacking();
    toggleFavorite('other', 'smart');
    const favorites = loadFavorites();
    expect(favorites.has('other:smart')).toBe(true);
    const entries = buildCatalogLayers(PROVIDERS).entries;
    const groups = groupEntries(entries, favorites);
    expect(groups[0]!.label).toBe('Favorites');
    expect(groups.slice(1).map((group) => group.label)).toEqual(['NotNative']);
    expect(groups[0]!.entries[0]!.modelID).toBe('smart');
  });
});

describe('draft starters (§H.5)', () => {
  beforeEach(() => {
    if (typeof localStorage !== 'undefined') localStorage.clear();
  });

  it('click insert rule: commands take inline args, skills take a newline form', () => {
    const command: Starter = { id: 's1', group: 'global', kind: 'builtin', label: 'Plan', visible: 'Plan a feature:' };
    const skill: Starter = { id: 's2', group: 'project', kind: 'skill', label: 'Skillish', visible: '/skillish' };
    expect(starterInsertText(command, 'craigslist')).toBe('Plan a feature: craigslist');
    expect(starterInsertText(skill, 'craigslist')).toBe('/skillish\ncraigslist');
    expect(starterInsertText(command, '')).toBe('Plan a feature: ');
  });

  it('add/remove persists into the project group', () => {
    const custom: Starter = { id: 'custom', group: 'project', kind: 'command', label: 'Custom', visible: 'Do a thing:' };
    addStarter(custom, 'D:/w');
    const afterAdd = startersFor('D:/w');
    expect(afterAdd.some((starter) => starter.id === 'custom')).toBe(true);
    removeStarter('custom', 'D:/w');
    expect(startersFor('D:/w').some((starter) => starter.id === 'custom')).toBe(false);
  });

  it('global starters always join project starters', () => {
    const list = startersFor('D:/w');
    expect(list.some((starter) => starter.group === 'global')).toBe(true);
  });
});
