// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useRef, useState } from 'react';
import { requestNativeSetup, type NativeSetupStatus } from '../../../lib/nnd/setup.ts';
import { SetupWizard } from '../../setup/setup-wizard.tsx';
import { onRuntimeEndpointChanged, getRuntimeKey } from '../../../lib/runtime-switch.ts';
import { getApiBaseUrl } from '../../../lib/runtime-url.ts';
import { useAuthSessionStore } from '../../../lib/runtime-auth-expiry.ts';
import { useI18n } from '../../I18nProvider.tsx';
import { SettingsGroupTitle } from '../primitives.tsx';

export function NativeSetupPanel({ onOpenConfiguration, onActivated, guided = false }: {
  onOpenConfiguration?: () => void; onActivated?: (signal: AbortSignal) => Promise<void> | void; guided?: boolean;
} = {}) {
  const { t } = useI18n();
  const [status, setStatus] = useState<NativeSetupStatus | null>(null);
  const [busy, setBusy] = useState<'read' | 'activate' | null>(null);
  const [error, setError] = useState(false);
  const pending = useRef<AbortController | null>(null);
  const auth = useAuthSessionStore((state) => state.status);
  const load = useCallback(async (activate: boolean) => {
    if (pending.current || auth !== 'ok') return;
    const controller = new AbortController(); pending.current = controller;
    const runtime = getRuntimeKey(), origin = getApiBaseUrl();
    setBusy(activate ? 'activate' : 'read'); setError(false); setStatus(null);
    const current = () => !controller.signal.aborted && pending.current === controller
      && runtime === getRuntimeKey() && origin === getApiBaseUrl();
    try {
      const result = await requestNativeSetup(activate, controller.signal);
      if (current()) {
        setStatus(result.status); setError(result.error);
        if (activate && !result.error && result.status?.execution_state === 'ready') {
          try { await onActivated?.(controller.signal); }
          catch { if (current()) setError(true); }
        }
      }
    } catch { if (current()) { setStatus(null); setError(true); } }
    finally { if (current()) { pending.current = null; setBusy(null); } }
  }, [auth, onActivated]);
  useEffect(() => {
    const reset = () => { pending.current?.abort(); pending.current = null; setStatus(null); setBusy(null); setError(false); };
    reset(); void load(false);
    const unsubscribe = onRuntimeEndpointChanged(() => { reset(); void load(false); });
    return () => { unsubscribe(); pending.current?.abort(); pending.current = null; };
  }, [load]);
  const blocked = busy !== null || auth !== 'ok';
  const restart = status && ['nnd_setup_activation_timeout','nnd_setup_cleanup_failed'].includes(status.failure_code ?? '');
  const canActivate = status && !['starting','stopping','stopped','ready'].includes(status.service_state)
    && !['nnd_setup_activation_timeout','nnd_setup_cleanup_failed'].includes(status.failure_code ?? '');
  return <section className="mb-4 space-y-2 rounded border border-border/60 p-3" aria-label={t('settings.nativeSetup.title')}>
    <SettingsGroupTitle>{t('settings.nativeSetup.title')}</SettingsGroupTitle>
    {guided ? <SetupWizard /> : null}
    <p className="text-xs text-muted-foreground">{t('settings.nativeSetup.description')}</p>
    <div className="flex gap-2">
      <button type="button" disabled={blocked} onClick={() => { void load(false); }}>{t('settings.nativeSetup.refresh')}</button>
      <button type="button" disabled={blocked || !canActivate} onClick={() => { void load(true); }}>{t('settings.nativeSetup.activate')}</button>
    </div>
    {busy ? <p role="status">{t(busy === 'activate' ? 'settings.nativeSetup.activating' : 'settings.nativeSetup.loading')}</p> : null}
    {error ? <p role="alert">{t('settings.nativeSetup.error')}</p> : null}
    {restart ? <p role="status">{t('settings.nativeSetup.restart')}</p> : null}
    {status ? <dl className="text-xs">{(['service','configuration','execution'] as const).map((name) => <div key={name}>
      <dt>{t(`settings.nativeSetup.${name}`)}</dt><dd>{t(`settings.nativeSetup.state.${status[`${name}_state`]}`)}</dd>
    </div>)}</dl> : null}
    <p className="text-xs text-muted-foreground">{t('settings.nativeSetup.provider')}</p>
    <p className="text-xs text-muted-foreground">{t('settings.nativeSetup.guidance')}</p>
    {onOpenConfiguration ? <button type="button" onClick={onOpenConfiguration}>
      {t('settings.nativeSetup.configurationLink')}
    </button> : null}
  </section>;
}
