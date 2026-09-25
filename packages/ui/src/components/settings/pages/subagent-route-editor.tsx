// SPDX-License-Identifier: Apache-2.0
/** Saved specialist routing is configuration; activation affects future sessions only. */
import { useEffect, useState, type ReactNode } from 'react';
import { harnessClient } from '../../../lib/nnd/client.ts';
import { ProviderRouteActivation } from './provider-route-activation.tsx';

interface Route { providerID: string; modelID: string }
interface Profile { profile_id: string; model: string }

function routeOf(value: unknown): Route | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const route = value as Record<string, unknown>;
  return typeof route.providerID === 'string' && typeof route.modelID === 'string'
    ? { providerID: route.providerID, modelID: route.modelID } : null;
}

function profileOf(value: unknown): value is Profile {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && typeof (value as Profile).profile_id === 'string' && typeof (value as Profile).model === 'string');
}

export function SubagentRouteEditor({ runningRoute, onApplied }: {
  runningRoute: Route; onApplied: () => void;
}): ReactNode {
  const [configured, setConfigured] = useState<Route | null>(null);
  const [profiles, setProfiles] = useState<Profile[] | null>(null);
  const [pending, setPending] = useState<boolean | null>(null);
  const [providerId, setProviderId] = useState('');
  const [model, setModel] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const refresh = (): void => setRevision((value) => value + 1);

  useEffect(() => {
    let current = true;
    setLoading(true);
    void Promise.all([harnessClient.getSubagentProviderRoute(), harnessClient.listProviderProfiles()])
      .then(([routeResult, profilesResult]) => {
        if (!current) return;
        const route = routeOf(routeResult.data?.configured_route);
        const list = profilesResult.data?.profiles;
        if (routeResult.error || profilesResult.error || !route || !Array.isArray(list) || !list.every(profileOf)) {
          setConfigured(null); setProfiles(null);
          setError(routeResult.error ?? profilesResult.error ?? 'NNA returned invalid specialist routing.');
          return;
        }
        setConfigured(route); setProfiles(list);
        setPending(typeof profilesResult.data?.provider_routing_pending === 'boolean'
          ? profilesResult.data.provider_routing_pending : null);
        setProviderId(route.providerID); setModel(route.modelID); setError(null);
      }).catch(() => { if (current) { setConfigured(null); setProfiles(null); setError('NNA specialist routing is unavailable.'); } })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [revision]);

  const save = async (): Promise<void> => {
    if (!providerId || !model.trim()) return;
    setBusy(true); setError(null);
    try {
      const result = await harnessClient.setSubagentProviderRoute(providerId, model.trim());
      if (result.error || !routeOf(result.data?.configured_route)) setError(result.error ?? 'NNA did not confirm the specialist route.');
      else refresh();
    } catch { setError('NNA specialist route update is unavailable.'); }
    finally { setBusy(false); }
  };
  const changed = configured?.providerID !== providerId || configured?.modelID !== model.trim();
  const drift = configured && (configured.providerID !== runningRoute.providerID || configured.modelID !== runningRoute.modelID);
  return <div className="mt-3 rounded-md border border-border/40 p-3 text-xs">
    <div className="font-medium text-foreground">Subagent model route</div>
    <p className="mt-1 text-muted-foreground">Running: {runningRoute.providerID}/{runningRoute.modelID}. Selecting a model does not grant any agent permission.</p>
    {loading ? <p role="status">Loading specialist route…</p> : null}
    {error ? <p role="alert" className="text-destructive">{error}</p> : null}
    {!loading && configured && profiles ? <>
      <p className="mt-1 text-muted-foreground">Saved: {configured.providerID}/{configured.modelID}</p>
      <div className="mt-2 flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-muted-foreground">Provider profile
          <select value={providerId} disabled={busy} onChange={(event) => {
            const id = event.target.value;
            setProviderId(id);
            setModel(profiles.find((profile) => profile.profile_id === id)?.model ?? '');
          }} className="rounded border border-border/60 bg-background px-2 py-1 text-foreground">
            {!profiles.some((profile) => profile.profile_id === providerId) ? <option value={providerId}>{providerId}</option> : null}
            {profiles.map((profile) => <option key={profile.profile_id} value={profile.profile_id}>{profile.profile_id}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-muted-foreground">Model
          <input value={model} maxLength={4096} disabled={busy} onChange={(event) => setModel(event.target.value)}
            className="w-48 rounded border border-border/60 bg-background px-2 py-1 text-foreground" />
        </label>
        <button type="button" disabled={busy || !changed || !providerId || !model.trim()} onClick={() => { void save(); }}
          className="rounded border border-border/60 px-2 py-1 text-foreground disabled:opacity-50">
          {busy ? 'Saving subagent route…' : 'Save subagent route'}
        </button>
      </div>
      {pending === true || drift ? <div role="status" className="mt-2 text-amber-500">
        Saved provider routing differs from what new NNA sessions currently use. Existing sessions retain their routing.
        <ProviderRouteActivation onApplied={() => { refresh(); onApplied(); }} />
      </div> : null}
    </> : null}
  </div>;
}
