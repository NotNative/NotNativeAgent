// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { readNativeInstallation, installationMessages, NativeInstallationFailure,
  type NativeInstallationView } from '../../../lib/nnd/installation.ts';
import { getRuntimeKey, onRuntimeEndpointChanged } from '../../../lib/runtime-switch.ts';
import { getApiBaseUrl } from '../../../lib/runtime-url.ts';
import { useAuthSessionStore } from '../../../lib/runtime-auth-expiry.ts';
import { authorityState, subscribeAuthority } from '../../../sync/authority-sync.ts';
import { SettingsGroupTitle, SettingsSection } from '../primitives.tsx';

const messageFor = (code: string) => installationMessages[code] ?? code;
const isNativeFailure = (value: unknown): value is { code: string } =>
  value instanceof Object && 'code' in value && typeof (value as { code?: unknown }).code === 'string';

function useInstallationView() {
  const [view, setView] = useState<NativeInstallationView | null>(null);
  const [loading, setLoading] = useState(false), [error, setError] = useState<string | null>(null);
  const pending = useRef<AbortController | null>(null);
  const load = useCallback(async () => {
    if (pending.current || authorityState() !== 'ready'
      || useAuthSessionStore.getState().status !== 'ok') return;
    const controller = new AbortController(); pending.current = controller;
    const runtime = getRuntimeKey(), origin = getApiBaseUrl();
    const current = () => !controller.signal.aborted && pending.current === controller
      && runtime === getRuntimeKey() && origin === getApiBaseUrl();
    setLoading(true); setError(null); setView(null);
    try { const result = await readNativeInstallation(controller.signal); if (current()) setView(result); }
    catch (failure) {
      if (current()) setError(messageFor(isNativeFailure(failure) ? failure.code : 'nnd_installation_unavailable'));
    }
    finally { if (current()) { pending.current = null; setLoading(false); } }
  }, []);
  useEffect(() => {
    const reset = () => { pending.current?.abort(); pending.current = null; setView(null); setLoading(false); setError(null); };
    reset(); void load();
    const unsubscribe = onRuntimeEndpointChanged(() => { reset(); void load(); });
    return () => { unsubscribe(); pending.current?.abort(); pending.current = null; };
  }, [load]);
  return { view, loading, error, load };
}
void NativeInstallationFailure;

export function InstallationObservationPanel(): ReactNode {
  const auth = useAuthSessionStore(state => state.status);
  const subscribe = useCallback((listener: () => void) => subscribeAuthority(listener), []);
  const authority = useSyncExternalStore(subscribe, authorityState);
  const { view, loading, error, load } = useInstallationView();
  void auth;
  return <SettingsSection item="native-installation.observation">
    <div className="flex items-center justify-between gap-3">
      <SettingsGroupTitle>Installation</SettingsGroupTitle>
      <button type="button" disabled={loading || authority !== 'ready' || auth !== 'ok'} onClick={() => { void load(); }}>
        Refresh</button>
    </div>
    <p className="text-xs text-muted-foreground">The verified install.json descriptor the service was
      admitted with, re-verified on every read; the installer owns this state.</p>
    {auth !== 'ok' ? <p role="status">Sign in to read the installation descriptor.</p> : null}
    {loading ? <p role="status">Reading the installation descriptor…</p> : null}
    {error ? <p role="alert">{messageFor(error)}</p> : null}
    {view ? <dl className="grid grid-cols-[auto_1fr] gap-x-3 text-xs" data-testid="installation-view">
      <dt>Product</dt><dd>{view.product}</dd>
      <dt>Version</dt><dd>{view.version}</dd>
      <dt>Install root</dt><dd>{view.install_root}</dd>
      <dt>Data root</dt><dd>{view.data_root}</dd>
      <dt>Node runtime</dt><dd>{view.node} ({view.node_major})</dd>
    </dl> : null}
  </SettingsSection>;
}
