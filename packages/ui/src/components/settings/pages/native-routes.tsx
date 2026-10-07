// SPDX-License-Identifier: Apache-2.0
import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { requestNativeConfiguration, type NativeConfigurationView, type NativeValue } from '../../../lib/nnd/configuration.ts';
import { onRuntimeEndpointChanged, getRuntimeKey } from '../../../lib/runtime-switch.ts';
import { getApiBaseUrl } from '../../../lib/runtime-url.ts';
import { useAuthSessionStore } from '../../../lib/runtime-auth-expiry.ts';
import { useI18n } from '../../I18nProvider.tsx';
import { SettingsGroupTitle, SettingsSection } from '../primitives.tsx';
import { NativeConfigurationControls } from './native-configuration-controls.tsx';

function useNativeRouteView(auth: string) {
  const [view, setView] = useState<NativeConfigurationView | null>(null);
  const [loading, setLoading] = useState(false), [error, setError] = useState(false);
  const pending = useRef<AbortController | null>(null);
  const load = useCallback(async () => {
    if (pending.current || auth !== 'ok') return;
    const controller = new AbortController(); pending.current = controller;
    const runtime = getRuntimeKey(), origin = getApiBaseUrl();
    const current = () => !controller.signal.aborted && pending.current === controller
      && runtime === getRuntimeKey() && origin === getApiBaseUrl();
    setLoading(true); setError(false); setView(null);
    try { const result = await requestNativeConfiguration(controller.signal); if (current()) setView(result); }
    catch { if (current()) setError(true); }
    finally { if (current()) { pending.current = null; setLoading(false); } }
  }, [auth]);
  useEffect(() => {
    const reset = () => { pending.current?.abort(); pending.current = null; setView(null); setLoading(false); setError(false); };
    reset(); void load();
    const unsubscribe = onRuntimeEndpointChanged(() => { reset(); void load(); });
    return () => { unsubscribe(); pending.current?.abort(); pending.current = null; };
  }, [load]);
  return { view, loading, error, load };
}

function routeValue(value: NativeValue | undefined): string {
  if (!value?.present) return '—';
  return 'value' in value ? String(value.value) : '—';
}

function memberText(value: NativeValue | undefined, t: ReturnType<typeof useI18n>['t']): string {
  if (!value?.present) return t('settings.nativeConfiguration.absent');
  if ('redacted' in value) return t('settings.nativeConfiguration.redacted');
  if ('value_unavailable' in value) return t('settings.nativeConfiguration.unavailableValue');
  return JSON.stringify(value.value);
}

// NNA serves eleven members for every route role (test/nnd-configuration-view.test.js: "the
// route family serves inherited bindings, canonical zeros, and its own availability gate"),
// so the role card renders the whole family, not only the binding pair: the closed route
// container is on screen when this card shows everything its role holds.
const ROUTE_MEMBERS = ['provider_id', 'model', 'context_limit_bytes', 'required_capabilities', 'temperature',
  'max_output_tokens', 'budget', 'fallbacks', 'deadline_ms', 'reasoning_effort', 'enable_thinking'] as const;

// NNA's own role list (src/contracts.js:12) and the subset it lets the desktop rebind
// (NND_ROUTE_BINDING_ROLES, src/nnd-configuration-intents.js:7). Primary and subagent are
// bound through the provider route authority instead, so their cards must not imply that
// the editor below can change them.
const ROUTE_ROLES = ['primary', 'reviewer', 'subagent', 'vision'] as const;
const ROUTE_BINDING_ROLES: readonly string[] = ['reviewer', 'vision'];
type RouteRole = typeof ROUTE_ROLES[number];

function RoleBinding({ view, role }: { view: NativeConfigurationView; role: RouteRole }): ReactNode {
  const { t } = useI18n();
  const provider = view.fields.find(field => field.path === `routes.${role}.provider_id`);
  const model = view.fields.find(field => field.path === `routes.${role}.model`);
  return <div className="rounded border border-border/60 p-2 text-xs" data-testid={`route-binding-${role}`}>
    <h3 className="font-semibold">{role}</h3>
    <dl className="grid grid-cols-[auto_1fr] gap-x-3">
      <dt>{t('settings.nativeRoutes.provider')}</dt><dd>{routeValue(provider?.effective)}</dd>
      <dt>{t('settings.nativeRoutes.model')}</dt><dd>{routeValue(model?.effective)}</dd>
    </dl>
    <p className="text-muted-foreground">{ROUTE_BINDING_ROLES.includes(role)
      ? t('settings.nativeRoutes.bindingReadOnly')
      : t('settings.nativeRoutes.bindingProviderRoute')}</p>
    <dl aria-label={t('settings.nativeRoutes.members')} className="mt-1 grid grid-cols-[auto_1fr] gap-x-3">
      {ROUTE_MEMBERS.map(key => {
        const field = view.fields.find(item => item.path === `routes.${role}.${key}`);
        return <Fragment key={key}>
          <dt className="font-mono">{`routes.${role}.${key}`}</dt>
          <dd>{memberText(field?.explicit, t)}</dd>
          <dd className="break-all">{memberText(field?.effective, t)}
            <span className="text-muted-foreground">
              {field?.effective.source ?? t('settings.nativeConfiguration.originUnknown')}</span></dd>
        </Fragment>;
      })}
    </dl>
  </div>;
}

export function NativeRoutesPage(): ReactNode {
  const { t } = useI18n(), auth = useAuthSessionStore(state => state.status);
  const { view, loading, error, load } = useNativeRouteView(auth);
  return <SettingsSection item="native-routes.tuning">
    <div className="flex items-center justify-between gap-3">
      <SettingsGroupTitle>{t('settings.page.nativeRoutes.title')}</SettingsGroupTitle>
      <button type="button" disabled={loading || auth !== 'ok'} onClick={() => { void load(); }}>
        {t('settings.nativeConfiguration.refresh')}</button>
    </div>
    <p className="text-xs text-muted-foreground">{t('settings.nativeRoutes.description')}</p>
    {auth !== 'ok' ? <p role="status">{t('settings.nativeConfiguration.auth')}</p> : null}
    {loading ? <p role="status">{t('settings.nativeConfiguration.loading')}</p> : null}
    {error ? <p role="alert">{t('settings.nativeConfiguration.error')}</p> : null}
    {view ? <>
      <p className="text-xs text-muted-foreground">{t('settings.nativeConfiguration.installation')}: {view.installation_id};
        {' '}{t('settings.nativeConfiguration.data')}: {view.data_id}</p>
      {ROUTE_ROLES.map(role => <RoleBinding key={role} view={view} role={role} />)}
      <p role="status" className="text-xs text-amber-500">{t('settings.nativeConfiguration.notApplied')}</p>
      <NativeConfigurationControls key={`${view.installation_id}:${view.data_id}:${view.source_revision}:${view.resolution_revision}`}
        view={view} onReload={() => { void load(); }} family="routes" />
    </> : null}
  </SettingsSection>;
}
