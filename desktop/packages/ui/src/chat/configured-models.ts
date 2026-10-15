// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from 'react';
import { harnessClient } from '../lib/nnd/client.ts';

export type ConfiguredProfile = { profile_id: string; display_name?: string; model: string };
export function useConfiguredModels(open: boolean) {
  const [profiles, setProfiles] = useState<ConfiguredProfile[]>([]);
  const [models, setModels] = useState<Record<string, string[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let live = true;
    if (!open) return;
    setLoading(true); setError(null);
    const load = async () => {
      const response = await harnessClient.listProviderProfiles();
      if (response.error || !Array.isArray(response.data?.profiles)) throw new Error('Configured providers are unavailable.');
      const rows = response.data.profiles.filter((value): value is ConfiguredProfile => { const row = value as ConfiguredProfile | null; return !!row && typeof row.profile_id === 'string' && typeof row.model === 'string'; }).slice(0, 128);
      if (!live) return;
      setProfiles(rows);
      let index = 0;
      const worker = async () => {
        while (live && index < rows.length) {
          const profile = rows[index++]!;
          try {
            const names = await discover(profile.profile_id);
            if (live) setModels(previous => ({ ...previous, [profile.profile_id]: [...new Set([profile.model, ...names])] }));
          } catch { if (live) setError('Some providers could not be reached. Saved models are still available.'); }
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, rows.length) }, worker));
    };
    void load().catch(() => { if (live) setError('Configured providers are unavailable.'); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [open, revision]);
  return { profiles, models, error, loading, retry: () => setRevision(value => value + 1) };
}
async function discover(profile: string): Promise<string[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([harnessClient.discoverProviderModels(profile), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Model discovery timed out')), 15_000);
    })]);
    if (response.error) throw new Error('Model discovery failed');
    return (response.data?.models ?? []).map(value => typeof value === 'string' ? value : (value as { id?: string })?.id)
      .filter((value): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256).slice(0, 256);
  } finally { clearTimeout(timer); }
}
