// SPDX-License-Identifier: Apache-2.0
import { useSettingsEdit } from '../edit-boundary.tsx';
/** Saved specialist routing is configuration; activation affects future sessions only. */
import { useEffect, useState, type ReactNode } from 'react';
import type { HarnessResult } from '../../../lib/nnd/client.ts';
import { harnessClient } from '../../../lib/nnd/client.ts';
import { useI18n } from '../../I18nProvider.tsx';
import { ProviderRouteActivation } from './provider-route-activation.tsx';

interface Route { providerID: string; modelID: string }
interface Profile { profile_id: string; model: string }
interface ProviderProfilePayload { profiles?: unknown[]; provider_routing_pending?: boolean | null }
interface RouteLoad { configured: Route | null; profiles: Profile[] | null; pending: boolean | null; error: string | null }

function routeOf(value: unknown): Route | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const route = value as Record<string, unknown>;
  return typeof route.providerID === 'string' && route.providerID.length > 0
    && typeof route.modelID === 'string' && route.modelID.length > 0
    ? { providerID: route.providerID, modelID: route.modelID } : null;
}

function profileOf(value: unknown): value is Profile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const profile = value as Profile;
  return typeof profile.profile_id === 'string' && profile.profile_id.length > 0
    && typeof profile.model === 'string';
}

function profilesOf(value: unknown): Profile[] | null {
  if (!Array.isArray(value) || !value.every(profileOf)
    || new Set(value.map((profile) => (profile as Profile).profile_id)).size !== value.length) return null;
  return value as Profile[];
}

function subagentRouteLoad(routeResult: HarnessResult<{ configured_route?: unknown }>,
  profileResult: HarnessResult<ProviderProfilePayload>, invalid: string, unavailable: string): RouteLoad {
  const configured = routeOf(routeResult.data?.configured_route);
  const profiles = profilesOf(profileResult.data?.profiles);
  if (routeResult.error || profileResult.error || configured === null || profiles === null) {
    return { configured: null, profiles: null, pending: null,
      error: routeResult.error ?? profileResult.error ?? invalid };
  }
  return { configured, profiles,
    pending: typeof profileResult.data?.provider_routing_pending === 'boolean'
      ? profileResult.data.provider_routing_pending : null, error: null };
}
function RouteControls({ profiles, providerId, model, busy, changed, onProviderChange, onModelChange, onSave }: {
  profiles: Profile[]; providerId: string; model: string; busy: boolean; changed: boolean;
  onProviderChange: (id: string) => void; onModelChange: (model: string) => void; onSave: () => void;
}): ReactNode {
  const { t } = useI18n();
  return <div className="mt-2 flex flex-wrap items-end gap-2">
    <label className="flex flex-col gap-1 text-muted-foreground">{t('settings.agents.route.providerLabel')}
      <select data-testid="subagent-provider" value={providerId} disabled={busy} onChange={(event) => onProviderChange(event.target.value)}
        className="rounded border border-border/60 bg-background px-2 py-1 text-foreground">
        {!profiles.some((profile) => profile.profile_id === providerId) ? <option value={providerId}>{providerId}</option> : null}
        {profiles.map((profile) => <option key={profile.profile_id} value={profile.profile_id}>{profile.profile_id}</option>)}
      </select>
    </label>
    <label className="flex flex-col gap-1 text-muted-foreground">{t('settings.agents.route.modelLabel')}
      <input data-testid="subagent-model" value={model} maxLength={4096} disabled={busy}
        onChange={(event) => onModelChange(event.target.value)}
        className="w-48 rounded border border-border/60 bg-background px-2 py-1 text-foreground" />
    </label>
    <button type="button" data-testid="subagent-save" disabled={busy || !changed || !providerId || !model.trim()} onClick={onSave}
      className="rounded border border-border/60 px-2 py-1 text-foreground disabled:opacity-50">
      {busy ? t('settings.agents.route.saving') : t('settings.agents.route.save')}
    </button>
  </div>;
}

function RouteContent({ runningRoute, configured, profiles, providerId, model, busy, changed, pending, onProviderChange, onModelChange, onSave, onApplied }: {
  runningRoute: Route | null; configured: Route; profiles: Profile[]; providerId: string; model: string;
  busy: boolean; changed: boolean; pending: boolean | null; onProviderChange: (id: string) => void;
  onModelChange: (model: string) => void; onSave: () => void; onApplied: () => void;
}): ReactNode {
  const { t } = useI18n();
  const savedRoute = `${configured.providerID}/${configured.modelID}`;
  const drift = runningRoute && (configured.providerID !== runningRoute.providerID || configured.modelID !== runningRoute.modelID);
  return <>
    <p className="mt-1 text-muted-foreground">{t('settings.agents.route.saved', { route: savedRoute })}</p>
    <RouteControls profiles={profiles} providerId={providerId} model={model} busy={busy} changed={changed}
      onProviderChange={onProviderChange} onModelChange={onModelChange} onSave={onSave} />
    {pending === true || drift ? <div role="status" className="mt-2 text-amber-500">
      {t('settings.agents.route.drift')}
      <ProviderRouteActivation onApplied={() => { onApplied(); }} />
    </div> : null}
  </>;
}

export function SubagentRouteEditor({ runningRoute: suppliedRoute, onApplied }: {
  runningRoute?: Route; onApplied: () => void;
}): ReactNode {
  const { t } = useI18n();
  const [configured, setConfigured] = useState<Route | null>(null);
  const [profiles, setProfiles] = useState<Profile[] | null>(null);
  const [pending, setPending] = useState<boolean | null>(null);
  const [providerId, setProviderId] = useState('');
  const [model, setModel] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [observedRoute, setObservedRoute] = useState<Route | null>(null);
  const runningRoute = suppliedRoute ?? observedRoute;
  const refresh = (): void => setRevision((value) => value + 1);

  useEffect(() => {
    let current = true;
    setLoading(true);
    void Promise.all([harnessClient.getSubagentProviderRoute(), harnessClient.listProviderProfiles()])
      .then(([routeResult, profilesResult]) => {
        if (!current) return;
        setObservedRoute(routeOf(routeResult.data?.runtime_route));
        const load = subagentRouteLoad(routeResult, profilesResult,
          t('settings.agents.route.invalid'), t('settings.agents.route.unavailable'));
        setConfigured(load.configured); setProfiles(load.profiles); setPending(load.pending);
        setProviderId(load.configured?.providerID ?? ''); setModel(load.configured?.modelID ?? '');
        setError(load.error);
      }).catch(() => { if (current) { setConfigured(null); setProfiles(null);
        setError(t('settings.agents.route.unavailable')); } })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [revision]);

  const save = async (): Promise<void> => {
    if (!providerId || !model.trim()) return;
    setBusy(true); setError(null);
    try {
      const result = await harnessClient.setSubagentProviderRoute(providerId, model.trim());
      const confirmed = routeOf(result.data?.configured_route);
      if (result.error || confirmed?.providerID !== providerId || confirmed.modelID !== model.trim()) {
        setError(result.error ?? t('settings.agents.route.notConfirmed'));
      } else refresh();
    } catch { setError(t('settings.agents.route.updateUnavailable')); }
    finally { setBusy(false); }
  };
  const changed = configured?.providerID !== providerId || configured?.modelID !== model.trim();
  useSettingsEdit('Subagent route', Boolean(configured && changed), busy);
  return <div className="mt-3 rounded-md border border-border/40 p-3 text-xs">
    <div className="font-medium text-foreground">{t('settings.agents.route.title')}</div>
    <p className="mt-1 text-muted-foreground">{runningRoute ? t('settings.agents.route.running', { route: `${runningRoute.providerID}/${runningRoute.modelID}` }) : 'Running subagent route was not reported.'}</p>
    <p className="mt-1 text-muted-foreground">{t('settings.agents.route.permission')}</p>
    {loading ? <p role="status">{t('settings.agents.route.loading')}</p> : null}
    {error ? <p role="alert" className="text-destructive">{error}</p> : null}
    {!loading && configured && profiles ? <RouteContent runningRoute={runningRoute} configured={configured} profiles={profiles}
      providerId={providerId} model={model} busy={busy} changed={changed} pending={pending}
      onProviderChange={(id) => { setProviderId(id);
        setModel(profiles.find((profile) => profile.profile_id === id)?.model ?? ''); }}
      onModelChange={setModel} onSave={() => { void save(); }} onApplied={() => { refresh(); onApplied(); }} /> : null}
  </div>;
}
