// SPDX-License-Identifier: Apache-2.0
import { create } from 'zustand';
import { getApiBaseUrlActive, getRuntimeKey, onRuntimeEndpointChanged } from '../lib/runtime-switch.ts';

export const catalogOwner = (): string => JSON.stringify([getRuntimeKey(), getApiBaseUrlActive()]);
type State = { owner: string; models: Record<string, string[]> };
export const useModelCatalog = create<State>(() => ({ owner: catalogOwner(), models: {} }));
onRuntimeEndpointChanged(() => useModelCatalog.setState({ owner: catalogOwner(), models: {} }));

/** Invariant: provider identity remains separate from model names, including names that contain slashes. */
export const modelReference = (provider: string, model: string): string => `${provider}/${model}`;
export function catalogModels(value: unknown, profileId: string): string[] {
  if (!value || typeof value !== 'object') throw new Error('Invalid model catalog');
  const row = value as { profile_id?: unknown; models?: unknown };
  if (row.profile_id !== profileId || !Array.isArray(row.models) || row.models.length > 4096
    || !row.models.every(item => typeof item === 'string' && item.trim().length > 0 && item.length <= 256)) throw new Error('Invalid model catalog');
  return [...new Set(row.models as string[])].slice(0, 256);
}
export function rememberCatalog(provider: string, models: string[], owner: string): void {
  if (owner !== catalogOwner()) return;
  const previous = useModelCatalog.getState();
  const next = previous.owner === owner ? previous.models : {};
  useModelCatalog.setState({ owner, models: { ...next, [provider]: models } });
}
export function rememberedModels(provider: string, saved: string, discovered: string[], favorites: string[], hidden: string[]): string[] {
  const prefix = `${provider}/`;
  return [...new Set([saved, ...discovered, ...favorites.concat(hidden).filter(ref => ref.startsWith(prefix)).map(ref => ref.slice(prefix.length))])];
}
