// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { requestNativeConfiguration, type NativeConfigurationView, type NativeValue } from '../../../lib/nnd/configuration.ts';
import { onRuntimeEndpointChanged, getRuntimeKey } from '../../../lib/runtime-switch.ts';
import { getApiBaseUrl } from '../../../lib/runtime-url.ts';
import { useAuthSessionStore } from '../../../lib/runtime-auth-expiry.ts';
import { useI18n } from '../../I18nProvider.tsx';
import { SettingsGroupTitle, SettingsSection } from '../primitives.tsx';
import { NativeConfigurationControls } from './native-configuration-controls.tsx';

function showValue(value: NativeValue, t: ReturnType<typeof useI18n>['t']): string {
  if (!value.present) return t('settings.nativeConfiguration.absent');
  if ('redacted' in value) return t('settings.nativeConfiguration.redacted');
  if ('value_unavailable' in value) return t('settings.nativeConfiguration.unavailableValue');
  return JSON.stringify(value.value);
}

export function NativeConfigurationPage(): ReactNode {
  const { t } = useI18n();
  const auth = useAuthSessionStore(state => state.status);
  const [view, setView] = useState<NativeConfigurationView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<'unsupported' | 'unavailable' | null>(null);
  const [filter, setFilter] = useState('');
  const pending = useRef<AbortController | null>(null);
  const load = useCallback(async () => {
    if (pending.current || auth !== 'ok') return;
    const controller = new AbortController(); pending.current = controller;
    const runtime = getRuntimeKey(), origin = getApiBaseUrl();
    const current = () => !controller.signal.aborted && pending.current === controller
      && runtime === getRuntimeKey() && origin === getApiBaseUrl();
    setLoading(true); setError(null); setView(null);
    try {
      const result = await requestNativeConfiguration(controller.signal);
      if (current()) setView(result);
    } catch (failure) { if (current()) setError(failure instanceof Error && failure.message === 'native-configuration-unsupported'
      ? 'unsupported' : 'unavailable'); }
    finally { if (current()) { pending.current = null; setLoading(false); } }
  }, [auth]);
  useEffect(() => {
    const reset = () => { pending.current?.abort(); pending.current = null; setView(null); setLoading(false); setError(null); setFilter(''); };
    reset(); void load();
    const unsubscribe = onRuntimeEndpointChanged(() => { reset(); void load(); });
    return () => { unsubscribe(); pending.current?.abort(); pending.current = null; };
  }, [load]);
  const rows = view?.fields.filter(field => field.path.toLowerCase().includes(filter.trim().toLowerCase())) ?? [];
  return <SettingsSection item="native-configuration.inventory">
    <div className="flex items-center justify-between gap-3">
      <SettingsGroupTitle>{t('settings.nativeConfiguration.title')}</SettingsGroupTitle>
      <button type="button" onClick={() => { void load(); }} disabled={loading || auth !== 'ok'}>
        {t('settings.nativeConfiguration.refresh')}
      </button>
    </div>
    <p className="text-xs text-muted-foreground">{t('settings.nativeConfiguration.description')}</p>
    <div data-settings-item="native-configuration.attachments" className="text-xs">
      <h3 className="font-semibold">{t('settings.nativeAttachments.title')}</h3>
      <p className="text-muted-foreground">{t('settings.nativeAttachments.description')}</p>
    </div>
    <div data-settings-item="native-configuration.memory-limits" className="text-xs">
      <h3 className="font-semibold">{t('settings.nativeMemory.title')}</h3>
      <p className="text-muted-foreground">{t('settings.nativeMemory.description')}</p>
    </div>
    <div data-settings-item="native-configuration.provider-scheduling" className="text-xs">
      <h3 className="font-semibold">{t('settings.nativeScheduling.title')}</h3>
      <p className="text-muted-foreground">{t('settings.nativeScheduling.description')}</p>
    </div>
    <div data-settings-item="native-configuration.dream" className="text-xs">
      <h3 className="font-semibold">{t('settings.nativeDream.title')}</h3>
      <p className="text-muted-foreground">{t('settings.nativeDream.description')}</p>
    </div>
    <div data-settings-item="native-configuration.runtime-timeouts" className="text-xs">
      <h3 className="font-semibold">{t('settings.nativeTimeouts.title')}</h3>
      <p className="text-muted-foreground">{t('settings.nativeTimeouts.description')}</p>
    </div>
    <div data-settings-item="native-configuration.provider-deadline" className="text-xs">
      <h3 className="font-semibold">{t('settings.nativeDeadline.title')}</h3>
      <p className="text-muted-foreground">{t('settings.nativeDeadline.description')}</p>
    </div>
    {loading ? <p role="status">{t('settings.nativeConfiguration.loading')}</p> : null}
    {error ? <p role="alert">{t(error === 'unsupported'
      ? 'settings.nativeConfiguration.unsupported' : 'settings.nativeConfiguration.error')}</p> : null}
    {auth !== 'ok' ? <p role="status">{t('settings.nativeConfiguration.auth')}</p> : null}
    {view ? <>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 text-xs">
        <dt>{t('settings.nativeConfiguration.installation')}</dt><dd className="break-all">{view.installation_id}</dd>
        <dt>{t('settings.nativeConfiguration.data')}</dt><dd className="break-all">{view.data_id}</dd>
        <dt>{t('settings.nativeConfiguration.scope')}</dt><dd>{view.scope}</dd>
        <dt>{t('settings.nativeConfiguration.sourceState')}</dt><dd>{view.source_state}</dd>
        <dt>{t('settings.nativeConfiguration.sourceRevision')}</dt><dd className="break-all">{view.source_revision ?? t('settings.nativeConfiguration.absent')}</dd>
        <dt>{t('settings.nativeConfiguration.resolutionRevision')}</dt><dd className="break-all">{view.resolution_revision ?? t('settings.nativeConfiguration.absent')}</dd>
      </dl>
      <p className="text-xs text-amber-500" role="status">{t('settings.nativeConfiguration.notApplied')}</p>
      <label className="block text-xs">{t('settings.nativeConfiguration.filter')}
        <input value={filter} onChange={event => setFilter(event.target.value)} className="ml-2 rounded border border-border bg-background px-2 py-1 text-foreground" />
      </label>
      <div className="space-y-2" aria-label={t('settings.nativeConfiguration.fields')}>
        {rows.map(field => <div key={field.path} className="rounded border border-border/60 p-2 text-xs">
          <div className="font-mono break-all">{field.path}</div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3">
            <dt>{t('settings.nativeConfiguration.explicit')}</dt><dd className="break-all">{showValue(field.explicit,t)}</dd>
            <dt>{t('settings.nativeConfiguration.effective')}</dt><dd className="break-all">{showValue(field.effective,t)}</dd>
            <dt>{t('settings.nativeConfiguration.origin')}</dt><dd>{field.effective.source ?? t('settings.nativeConfiguration.originUnknown')}</dd>
          </dl>
        </div>)}
      </div>
      <NativeConfigurationControls key={`${view.installation_id}:${view.data_id}:${view.source_revision}:${view.resolution_revision}`}
        view={view} onReload={() => { void load(); }} />
    </> : null}
  </SettingsSection>;
}
