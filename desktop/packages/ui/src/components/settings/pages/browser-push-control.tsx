// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { browserPushAvailable, browserPushSubscribed, enableBrowserPush, disableBrowserPush } from '../../../lib/browser-push.ts';
import { getRuntimeKey, onRuntimeEndpointChanged } from '../../../lib/runtime-switch.ts';
import { useI18n } from '../../I18nProvider.tsx';

export function BrowserPushControl() {
  const runtime = useSyncExternalStore(onRuntimeEndpointChanged, getRuntimeKey);
  return <SubscriptionControl key={runtime} runtime={runtime} />;
}

function SubscriptionControl({ runtime }: { runtime: string }) {
  const { t } = useI18n();
  const available = browserPushAvailable();
  const [state, setState] = useState<'checking' | 'off' | 'existing' | 'registered' | 'unknown'>('checking');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const token = useRef(0);
  const pending = useRef(false);
  const current = (value: number) => value === token.current && runtime === getRuntimeKey();
  const refresh = async () => {
    if (!available || pending.current) return;
    const request = ++token.current;
    setState('checking');
    setFailed(false);
    try {
      const exists = await browserPushSubscribed();
      if (current(request)) setState(exists ? 'existing' : 'off');
    } catch { if (current(request)) { setState('unknown'); setFailed(true); } }
  };
  useEffect(() => { void refresh(); return () => { token.current += 1; }; }, [runtime]);
  const change = async (enable: boolean) => {
    if (pending.current || !available) return;
    const request = ++token.current;
    pending.current = true;
    setBusy(true);
    setFailed(false);
    try {
      await (enable ? enableBrowserPush() : disableBrowserPush());
      if (current(request)) setState(enable ? 'registered' : 'off');
    } catch { if (current(request)) { setState('unknown'); setFailed(true); } }
    finally { if (current(request)) { pending.current = false; setBusy(false); } }
  };
  return <section className="rounded border border-white/10 p-3" data-testid="browser-push-control">
    <h3 className="text-sm">{t('push.heading')}</h3>
    <p className="mt-1 text-xs text-neutral-400">{t(available ? 'push.hint' : 'push.unavailable')}</p>
    {available ? <>
      <p role="status" className="mt-2 text-xs">{t(busy ? 'push.saving' : `push.${state}`)}</p>
      {failed ? <p role="alert" className="text-xs text-red-300">{t('push.failed')}</p> : null}
      <div className="mt-2 flex gap-3 text-xs">
        <button type="button" disabled={busy} onClick={() => { void change(true); }}>{t('push.enable')}</button>
        <button type="button" disabled={busy || (!failed && state === 'off')} onClick={() => { void change(false); }}>{t('push.disable')}</button>
        <button type="button" disabled={busy} onClick={() => { void refresh(); }}>{t('push.refresh')}</button>
      </div>
    </> : null}
  </section>;
}
