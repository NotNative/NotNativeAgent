// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from 'react';
import { harnessClient } from '../lib/nnd/client.ts';
import { catalogModels, catalogOwner, rememberCatalog, rememberedModels, useModelCatalog } from './configured-model-catalog.ts';
import { useSettingsStore } from '../lib/settings/store.ts';
import { onRuntimeEndpointChanged } from '../lib/runtime-switch.ts';

export type ConfiguredProfile = { profile_id: string; display_name?: string; model: string };
function configuredProfiles(value: unknown): ConfiguredProfile[] {
  if (!Array.isArray(value) || value.length > 128 || !value.every(row => row && typeof row === 'object'
    && typeof row.profile_id === 'string' && /^[A-Za-z0-9_-]{1,64}$/u.test(row.profile_id)
    && typeof row.model === 'string' && row.model.trim().length > 0 && row.model.length <= 256
    && (row.display_name === undefined || (typeof row.display_name === 'string' && row.display_name.length <= 4096)))
    || new Set(value.map(row => row.profile_id)).size !== value.length) throw new Error('Configured providers are invalid.');
  return value as ConfiguredProfile[];
}
export function useConfiguredModels(open: boolean, discoverOnOpen = true) {
  const [profiles, setProfiles] = useState<ConfiguredProfile[]>([]);
  const catalog = useModelCatalog(state => state.models);
  const doc = useSettingsStore(state => state.doc);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  useEffect(() => onRuntimeEndpointChanged(() => { setProfiles([]); setRevision(value => value + 1); }), []);
  useEffect(() => {
    let live = true;
    const owner = catalogOwner();
    const current = () => live && owner === catalogOwner();
    if (!open) return;
    setLoading(true); setError(null);
    const load = async () => {
      const response = await harnessClient.listProviderProfiles();
      if (response.error || !Array.isArray(response.data?.profiles)) throw new Error('Configured providers are unavailable.');
      const rows = configuredProfiles(response.data.profiles);
      if (!current()) return;
      setProfiles(rows);
      if (!discoverOnOpen) return;
      let index = 0;
      const worker = async () => {
        while (current() && index < rows.length) {
          const profile = rows[index++]!;
          try {
            const names = await discover(profile.profile_id);
            if (current()) rememberCatalog(profile.profile_id, names, owner);
          } catch { if (current()) setError('Some providers could not be reached. Saved models are still available.'); }
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, rows.length) }, worker));
    };
    void load().catch(() => { if (current()) { setProfiles([]); setError('Configured providers are unavailable.'); } }).finally(() => { if (current()) setLoading(false); });
    return () => { live = false; };
  }, [open, revision, discoverOnOpen]);
  const models = Object.fromEntries(profiles.map(profile => [profile.profile_id, rememberedModels(profile.profile_id, profile.model,
    catalog[profile.profile_id] ?? [], (doc.favoriteModels as string[] | undefined) ?? [], (doc.hiddenModels as string[] | undefined) ?? [])]));
  return { profiles, models, error, loading, retry: () => setRevision(value => value + 1) };
}
async function discover(profile: string): Promise<string[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([harnessClient.discoverProviderModels(profile), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Model discovery timed out')), 15_000);
    })]);
    if (response.error) throw new Error('Model discovery failed');
    return catalogModels(response.data, profile);
  } finally { clearTimeout(timer); }
}
