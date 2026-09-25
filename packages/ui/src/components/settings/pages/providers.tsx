// SPDX-License-Identifier: Apache-2.0
/** NNA-owned provider route inventory. Configuration writes remain in NNA. */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { harnessClient } from '../../../lib/nnd/client.ts';
import { SettingsGroupTitle, SettingsSection } from '../primitives.tsx';
import { ProviderDiagnostics } from './provider-diagnostics.tsx';
import { ProviderRouteAction } from './provider-route-action.tsx';
import { ProviderRouteActivation } from './provider-route-activation.tsx';
import { ProviderProfileEditor } from './provider-profile-editor.tsx';

interface ProviderProfile {
  profile_id: string;
  display_name?: string;
  endpoint: string;
  model: string;
  active: boolean;
}

interface RuntimeRoute { providerID: string; modelID: string }

function runtimeRoute(value: unknown): RuntimeRoute | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const route = value as Record<string, unknown>;
  return typeof route.providerID === 'string' && typeof route.modelID === 'string'
    ? { providerID: route.providerID, modelID: route.modelID } : null;
}

function RuntimeRouteStatus({ configured, route, pending, onApplied }: {
  configured: RuntimeRoute | null; route: RuntimeRoute | null; pending: boolean | null; onApplied: () => void;
}): ReactNode {
  const primaryDiffers = Boolean(configured && route
    && (configured.providerID !== route.providerID || configured.modelID !== route.modelID));
  if (pending !== true && !primaryDiffers) return !configured || !route
    ? <p className="text-xs text-muted-foreground">Configured or running NNA route was not reported; the primary routes cannot be compared.</p> : null;
  return <div role="status" className="rounded border border-amber-500/40 p-2 text-xs text-amber-500">
    {primaryDiffers ? `Configuration differs from the running NNA route (${route?.providerID}/${route?.modelID}). ` : ''}
    Saved provider routing or profiles differ from what new NNA sessions currently use. Existing sessions retain their own routing.
    <ProviderRouteActivation onApplied={onApplied} />
  </div>;
}

function providerProfile(value: unknown): value is ProviderProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return typeof item.profile_id === 'string' && typeof item.endpoint === 'string'
    && typeof item.model === 'string' && typeof item.active === 'boolean'
    && (item.display_name === undefined || typeof item.display_name === 'string');
}

function endpointOrigin(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    return ['http:', 'https:'].includes(url.protocol) ? url.origin : 'Endpoint unavailable';
  } catch {
    return 'Endpoint unavailable';
  }
}

export function ProvidersPage(): ReactNode {
  const [profiles, setProfiles] = useState<ProviderProfile[] | null>(null);
  const [configuredRoute, setConfiguredRoute] = useState<RuntimeRoute | null>(null);
  const [route, setRoute] = useState<RuntimeRoute | null>(null);
  const [routingPending, setRoutingPending] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    let current = true;
    setLoading(true);
    void harnessClient.listProviderProfiles().then((result) => {
      if (!current) return;
      const list = result.data?.profiles;
      if (result.error || !Array.isArray(list) || !list.every(providerProfile)) {
        setProfiles(null);
        setConfiguredRoute(null);
        setRoute(null);
        setRoutingPending(null);
        setError(result.error ?? 'NNA returned an invalid provider inventory.');
      } else {
        setProfiles(list);
        setConfiguredRoute(runtimeRoute(result.data?.configured_primary_route));
        setRoute(runtimeRoute(result.data?.runtime_route));
        setRoutingPending(typeof result.data?.provider_routing_pending === 'boolean' ? result.data.provider_routing_pending : null);
        setError(null);
      }
    }).catch(() => {
      if (current) { setProfiles(null); setConfiguredRoute(null); setRoute(null); setRoutingPending(null); setError('NNA provider inventory is unavailable.'); }
    }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [revision]);

  return (
    <SettingsSection item="providers.inventory">
      <div className="flex items-center justify-between gap-3">
        <SettingsGroupTitle>NNA provider profiles</SettingsGroupTitle>
        <button type="button" className="rounded border border-border/60 px-2 py-1 text-xs text-foreground disabled:opacity-50" onClick={refresh} disabled={loading}>Refresh</button>
      </div>
      <p className="text-xs text-muted-foreground">Routes configured in NotNativeAgent. Save a primary route, then explicitly apply saved provider routing to new sessions; existing sessions keep their current engine route. Diagnostics contact the provider only when clicked. Credentials and endpoint paths are not shown here.</p>
      <ProviderProfileEditor onSaved={refresh} />
      {loading ? <p role="status" className="text-xs text-muted-foreground">Loading provider profiles…</p> : null}
      {!loading && error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
      {!loading && profiles?.length === 0 ? <p className="text-xs text-muted-foreground">No provider profiles are configured in NNA.</p> : null}
      {!loading && profiles ? <RuntimeRouteStatus configured={configuredRoute} route={route} pending={routingPending} onApplied={refresh} /> : null}
      {!loading && profiles?.map((profile) => (
        <div key={`${profile.profile_id}:${revision}`} className="rounded-md border border-border/40 p-3 text-xs" data-testid="provider-profile">
          <div className="flex items-center gap-2 font-medium text-foreground">
            <span>{profile.display_name || profile.profile_id}</span>
            {configuredRoute?.providerID === profile.profile_id ? <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] text-primary">Configured primary</span> : null}
            {route?.providerID === profile.profile_id ? <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] text-primary">Running NNA route</span> : null}
          </div>
          <div className="mt-1 text-muted-foreground">{profile.model}</div>
          {configuredRoute?.providerID === profile.profile_id && configuredRoute.modelID !== profile.model ? <div className="mt-1 text-muted-foreground">Configured primary model: {configuredRoute.modelID}</div> : null}
          {route?.providerID === profile.profile_id && route.modelID !== profile.model ? <div className="mt-1 text-muted-foreground">Running NNA model: {route.modelID}</div> : null}
          <div className="break-all text-muted-foreground">{endpointOrigin(profile.endpoint)}</div>
          <ProviderProfileEditor profile={profile} onSaved={refresh} />
          <ProviderRouteAction profileId={profile.profile_id} defaultModel={profile.model}
            configuredModel={configuredRoute?.providerID === profile.profile_id ? configuredRoute.modelID : null}
            onApplied={refresh} />
          <ProviderDiagnostics profileId={profile.profile_id} />
        </div>
      ))}
    </SettingsSection>
  );
}
