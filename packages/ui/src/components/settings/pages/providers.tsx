// SPDX-License-Identifier: Apache-2.0
/** NNA-owned provider route inventory. Configuration writes remain in NNA. */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { NativeSetupPanel } from './native-setup.tsx';
import { harnessClient } from '../../../lib/nnd/client.ts';
import { waitForNativeModelReady } from '../../../lib/nnd/setup-readiness.ts';
import { useI18n } from '../../I18nProvider.tsx';
import { SettingsGroupTitle, SettingsSection } from '../primitives.tsx';
import { ProviderDiagnostics } from './provider-diagnostics.tsx';
import { ProviderRouteAction } from './provider-route-action.tsx';
import { ProviderRouteActivation } from './provider-route-activation.tsx';
import { ProviderProfileEditor } from './provider-profile-editor.tsx';
import type { I18nKey } from '../../../lib/i18n/messages/en.ts';

interface ProviderProfile {
  profile_id: string;
  display_name?: string;
  endpoint: string;
  model: string;
  active: boolean;
}

interface RuntimeRoute { providerID: string; modelID: string }

type Feedback = { kind: 'key'; key: I18nKey } | { kind: 'raw'; message: string } | null;

const MAX_TEXT_LENGTH = 4096;
async function refreshAfterNativeActivation(signal: AbortSignal): Promise<void> {
  await waitForNativeModelReady(signal);
  if (!signal.aborted) window.location.reload();
}

function boundedText(value: unknown, maxLength: number): value is string {
  if (typeof value !== 'string' || value.length > maxLength) return false;
  return value.trim().length > 0;
}

function runtimeRoute(value: unknown): RuntimeRoute | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const route = value as Record<string, unknown>;
  return boundedText(route.providerID, MAX_TEXT_LENGTH) && boundedText(route.modelID, MAX_TEXT_LENGTH)
    ? { providerID: route.providerID, modelID: route.modelID } : null;
}

function RuntimeRouteStatus({ configured, route, pending, onApplied }: {
  configured: RuntimeRoute | null; route: RuntimeRoute | null; pending: boolean | null; onApplied: () => void;
}): ReactNode {
  const { t } = useI18n();
  const primaryDiffers = Boolean(configured && route
    && (configured.providerID !== route.providerID || configured.modelID !== route.modelID));
  if (pending !== true && !primaryDiffers) return !configured || !route
    ? <p className="text-xs text-muted-foreground">{t('settings.providers.inventory.routeMissing')}</p> : null;
  return <div role="status" className="rounded border border-amber-500/40 p-2 text-xs text-amber-500">
    {primaryDiffers ? t('settings.providers.inventory.routeDiff', { route: `${route?.providerID ?? ''}/${route?.modelID ?? ''}` }) + ' ' : ''}
    {t('settings.providers.inventory.routingPending')}
    <ProviderRouteActivation onApplied={onApplied} />
  </div>;
}

function providerProfile(value: unknown): value is ProviderProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (!boundedText(item.profile_id, MAX_TEXT_LENGTH) || item.active !== true) return false;
  if (item.display_name !== undefined && (typeof item.display_name !== 'string'
    || item.display_name.length > MAX_TEXT_LENGTH)) return false;
  return boundedText(item.endpoint, MAX_TEXT_LENGTH) && boundedText(item.model, MAX_TEXT_LENGTH)
    && endpointIsValid(item.endpoint);
}

function providerProfiles(value: unknown): ProviderProfile[] | null {
  if (!Array.isArray(value) || !value.every(providerProfile)
    || new Set(value.map((profile) => (profile as ProviderProfile).profile_id)).size !== value.length) return null;
  return value as ProviderProfile[];
}

function endpointIsValid(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    return ['http:', 'https:'].includes(url.protocol);
  } catch {
    return false;
  }
}

function endpointDisplay(endpoint: string): { key: I18nKey; origin?: string } {
  return endpointIsValid(endpoint)
    ? { key: 'settings.providers.inventory.endpointUnavailable', origin: new URL(endpoint).origin }
    : { key: 'settings.providers.inventory.endpointUnavailable' };
}

export function ProvidersPage({ onOpenConfiguration }: { onOpenConfiguration?: () => void } = {}): ReactNode {
  const { t } = useI18n();
  const [profiles, setProfiles] = useState<ProviderProfile[] | null>(null);
  const [configuredRoute, setConfiguredRoute] = useState<RuntimeRoute | null>(null);
  const [route, setRoute] = useState<RuntimeRoute | null>(null);
  const [routingPending, setRoutingPending] = useState<boolean | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    let current = true;
    setLoading(true);
    void harnessClient.listProviderProfiles().then((result) => {
      if (!current) return;
      const list = providerProfiles(result.data?.profiles);
      if (result.error || list === null) {
        setProfiles(null);
        setConfiguredRoute(null);
        setRoute(null);
        setRoutingPending(null);
        setFeedback(result.error
          ? { kind: 'raw', message: result.error }
          : { kind: 'key', key: 'settings.providers.inventory.invalid' });
      } else {
        setProfiles(list);
        setConfiguredRoute(runtimeRoute(result.data?.configured_primary_route));
        setRoute(runtimeRoute(result.data?.runtime_route));
        setRoutingPending(typeof result.data?.provider_routing_pending === 'boolean' ? result.data.provider_routing_pending : null);
        setFeedback(null);
      }
    }).catch(() => {
      if (current) { setProfiles(null); setConfiguredRoute(null); setRoute(null); setRoutingPending(null);
        setFeedback({ kind: 'key', key: 'settings.providers.inventory.unavailable' }); }
    }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [revision]);

  return (
    <SettingsSection item="providers.inventory">
      <NativeSetupPanel onOpenConfiguration={onOpenConfiguration} onActivated={refreshAfterNativeActivation} />
      <div className="flex items-center justify-between gap-3">
        <SettingsGroupTitle>{t('settings.providers.inventory.title')}</SettingsGroupTitle>
        <button type="button" data-testid="providers-refresh" className="rounded border border-border/60 px-2 py-1 text-xs text-foreground disabled:opacity-50" onClick={refresh} disabled={loading}>{t('settings.providers.inventory.refresh')}</button>
      </div>
      <p className="text-xs text-muted-foreground">{t('settings.providers.inventory.description')}</p>
      <ProviderProfileEditor onSaved={refresh} />
      {loading ? <p role="status" className="text-xs text-muted-foreground">{t('settings.providers.inventory.loading')}</p> : null}
      {!loading && feedback ? <p role="alert" className="text-xs text-destructive">{feedback.kind === 'raw' ? feedback.message : t(feedback.key)}</p> : null}
      {!loading && profiles?.length === 0 ? <p className="text-xs text-muted-foreground">{t('settings.providers.inventory.empty')}</p> : null}
      {!loading && profiles ? <RuntimeRouteStatus configured={configuredRoute} route={route} pending={routingPending} onApplied={refresh} /> : null}
      {!loading && profiles?.map((profile) => (
        <div key={`${profile.profile_id}:${revision}`} className="rounded-md border border-border/40 p-3 text-xs" data-testid="provider-profile">
          <div className="flex items-center gap-2 font-medium text-foreground">
            <span>{profile.display_name || profile.profile_id}</span>
            {configuredRoute?.providerID === profile.profile_id ? <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] text-primary">{t('settings.providers.inventory.configuredPrimary')}</span> : null}
            {route?.providerID === profile.profile_id ? <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] text-primary">{t('settings.providers.inventory.runningRoute')}</span> : null}
          </div>
          <div className="mt-1 text-muted-foreground">{profile.model}</div>
          {configuredRoute?.providerID === profile.profile_id && configuredRoute.modelID !== profile.model ? <div className="mt-1 text-muted-foreground">{t('settings.providers.inventory.configuredModel', { model: configuredRoute.modelID })}</div> : null}
          {route?.providerID === profile.profile_id && route.modelID !== profile.model ? <div className="mt-1 text-muted-foreground">{t('settings.providers.inventory.runningModel', { model: route.modelID })}</div> : null}
          <div className="break-all text-muted-foreground">{(() => {
            const displayed = endpointDisplay(profile.endpoint);
            return displayed.origin ?? t(displayed.key);
          })()}</div>
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
