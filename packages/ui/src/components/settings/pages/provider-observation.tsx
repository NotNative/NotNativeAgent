// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { readNativeProviderObservation, providerObservationMessages,
  type NativeProviderObservationView } from '../../../lib/nnd/provider-observation.ts';
import { getRuntimeKey, onRuntimeEndpointChanged } from '../../../lib/runtime-switch.ts';
import { getApiBaseUrl } from '../../../lib/runtime-url.ts';
import { useAuthSessionStore } from '../../../lib/runtime-auth-expiry.ts';
import { authorityState, subscribeAuthority } from '../../../sync/authority-sync.ts';
import { SettingsGroupTitle, SettingsSection } from '../primitives.tsx';

const messageFor = (code: string) => providerObservationMessages[code] ?? code;
const isNativeFailure = (value: unknown): value is { code: string } =>
  value instanceof Object && 'code' in value && typeof (value as { code?: unknown }).code === 'string';

const CAPABILITY_LABELS: [keyof NativeProviderObservationView['providers'][number]['capabilities'], string][] = [
  ['streaming', 'streaming'], ['tools', 'tools'], ['images', 'images'],
  ['structured_output', 'structured output'], ['usage', 'usage'], ['cancellation', 'cancellation']];

function useProviderView() {
  const [view, setView] = useState<NativeProviderObservationView | null>(null);
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
    try {
      const result = await readNativeProviderObservation(controller.signal);
      if (current()) setView(result);
    } catch (failure) {
      if (current()) {
        setError(messageFor(isNativeFailure(failure) ? failure.code : 'nnd_provider_observation_unavailable'));
      }
    } finally { if (current()) { pending.current = null; setLoading(false); } }
  }, []);
  useEffect(() => {
    const reset = () => {
      pending.current?.abort(); pending.current = null; setView(null); setLoading(false); setError(null);
    };
    reset(); void load();
    const unsubscribe = onRuntimeEndpointChanged(() => { reset(); void load(); });
    return () => { unsubscribe(); pending.current?.abort(); pending.current = null; };
  }, [load]);
  return { view, loading, error, load };
}

export function ProviderObservationPanel(): ReactNode {
  const auth = useAuthSessionStore(state => state.status);
  const subscribe = useCallback((listener: () => void) => subscribeAuthority(listener), []);
  const authority = useSyncExternalStore(subscribe, authorityState);
  const { view, loading, error, load } = useProviderView();
  return <SettingsSection item="native-provider-observation.bindings">
    <div className="flex items-center justify-between gap-3">
      <SettingsGroupTitle>Provider credential bindings</SettingsGroupTitle>
      <button type="button" disabled={loading || authority !== 'ready' || auth !== 'ok'}
        onClick={() => { void load(); }}>Refresh</button>
    </div>
    <p className="text-xs text-muted-foreground">Which credential each configured provider is bound to,
      read from the manifest the service resolves. Names and identifiers only: secret values stay in the
      vault, and nothing here writes them.</p>
    {auth !== 'ok' ? <p role="status">Sign in to read provider bindings.</p> : null}
    {loading ? <p role="status">Reading provider bindings…</p> : null}
    {error ? <p role="alert">{messageFor(error)}</p> : null}
    {view && view.source_state === 'absent'
      ? <p role="status" data-testid="provider-manifest-absent">No provider manifest is stored, so no
        provider is bound to a credential.</p> : null}
    {view && view.source_state === 'present'
      ? <ul className="grid gap-3 text-xs" data-testid="provider-bindings">
        {view.providers.map(provider => <li className="grid gap-1" key={provider.id}>
          <p className="font-medium">{provider.id}</p>
          <p>model {provider.model}</p>
          <p>endpoint {provider.endpoint}</p>
          <p>trust zone {provider.trust_zone}</p>
          <p>{provider.credential === null
            ? 'no credential binding'
            : provider.credential.source === 'environment'
              ? `environment variable ${provider.credential.name}`
              : `secret ${provider.credential.secret_id} field ${provider.credential.field}`}</p>
          <p>credential_env {provider.credential_env ?? 'unset'}</p>
          <p>{CAPABILITY_LABELS.map(([name, label]) => `${label} ${provider.capabilities[name] ? 'yes' : 'no'}`)
            .join(', ')}</p>
        </li>)}
      </ul> : null}
  </SettingsSection>;
}
