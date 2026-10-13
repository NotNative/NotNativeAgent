// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { requestNativeConfiguration, type NativeConfigurationView } from '../../../lib/nnd/configuration.ts';
import { onRuntimeEndpointChanged, getRuntimeKey } from '../../../lib/runtime-switch.ts';
import { getApiBaseUrl } from '../../../lib/runtime-url.ts';
import { useAuthSessionStore } from '../../../lib/runtime-auth-expiry.ts';
import { useI18n } from '../../I18nProvider.tsx';
import { SettingsGroupTitle, SettingsSection } from '../primitives.tsx';
import { NativeConfigurationControls } from './native-configuration-controls.tsx';

function useNativeTuiView(auth: string) {
  const [view, setView] = useState<NativeConfigurationView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
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

export function NativeTuiPreferencesPage(): ReactNode {
  const { t } = useI18n(), auth = useAuthSessionStore(state => state.status);
  const { view, loading, error, load } = useNativeTuiView(auth);
  return <SettingsSection item="native-tui.preferences">
    <div className="flex items-center justify-between gap-3">
      <SettingsGroupTitle>{t('settings.page.nativeTui.title')}</SettingsGroupTitle>
      <button type="button" disabled={loading || auth !== 'ok'} onClick={() => { void load(); }}>
        {t('settings.nativeConfiguration.refresh')}</button>
    </div>
    <p className="text-xs text-muted-foreground">{t('settings.nativeTui.description')}</p>
    {auth !== 'ok' ? <p role="status">{t('settings.nativeConfiguration.auth')}</p> : null}
    {loading ? <p role="status">{t('settings.nativeConfiguration.loading')}</p> : null}
    {error ? <p role="alert">{t('settings.nativeConfiguration.error')}</p> : null}
    {view ? <>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 text-xs">
        <dt>{t('settings.nativeConfiguration.installation')}</dt><dd className="break-all">{view.installation_id}</dd>
        <dt>{t('settings.nativeConfiguration.data')}</dt><dd className="break-all">{view.data_id}</dd>
        <dt>{t('settings.nativeConfiguration.sourceRevision')}</dt><dd className="break-all">
          {view.source_revision ?? t('settings.nativeConfiguration.absent')}</dd>
      </dl>
      <NativeConfigurationControls key={`${view.installation_id}:${view.data_id}:${view.source_revision}:${view.resolution_revision}`}
        view={view} onReload={() => { void load(); }} family="tui" />
    </> : null}
  </SettingsSection>;
}
