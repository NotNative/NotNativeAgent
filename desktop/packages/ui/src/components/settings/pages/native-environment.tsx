// SPDX-License-Identifier: Apache-2.0
/** Native environment observation section (read-only).
 * Why: the census classifies seven environment rows as direct native observation; the
 * settings GUI shows what the served NNA process actually sees, with credential values
 * withheld by the surface itself.
 * Invariant: nothing here edits anything — the environment is changed in the Windows
 * shell and reaches the service at its restart; the panel offers reading again only.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { getRuntimeKey, onRuntimeEndpointChanged } from '../../../lib/runtime-switch.ts';
import { getApiBaseUrl } from '../../../lib/runtime-url.ts';
import { useAuthSessionStore } from '../../../lib/runtime-auth-expiry.ts';
import { readNativeEnvironment, readNativeEnvironmentCatalog, environmentMessages,
  environmentEntryIsSecret } from '../../../lib/nnd/environment.ts';
import type { NativeEnvironmentView, NativeEnvironmentCatalog } from '../../../lib/nnd/environment.ts';
import { authorityState, subscribeAuthority } from '../../../sync/authority-sync.ts';
import { SettingsGroupTitle, SettingsSection } from '../primitives.tsx';

const safeError = (error: unknown) => error instanceof Error ? error.message : 'nnd_environment_unavailable';
const messageFor = (code: string) => environmentMessages[code] ?? `${code}`;

function EnvironmentRow({ name, present, secret, value }: {
  name: string; present: boolean; secret: boolean; value: string | null }) {
  return (
    <li>
      <span className="mono">{name}</span>{' '}
      <span data-testid={`native-environment-${name.toLowerCase()}`}>{present
        ? secret ? 'set · value withheld' : value ? value : '(empty value)'
        : 'not set in the service process'}</span>
    </li>
  );
}

export function NativeEnvironment() {
  const auth = useAuthSessionStore((state) => state.status);
  const authority = useSyncExternalStore(subscribeAuthority, authorityState);
  const [view, setView] = useState<NativeEnvironmentView | null>(null);
  const [catalog, setCatalog] = useState<NativeEnvironmentCatalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const active = useRef<AbortController | null>(null);
  useEffect(() => {
    let current = true;
    void work(() => current).catch(() => undefined);
    return () => { current = false;
      if (active.current) { active.current.abort(); active.current = null; } };
  }, []);
  const work = async (current: () => boolean) => {
    if (active.current || auth !== 'ok' || authority !== 'ready') return;
    active.current = new AbortController();
    setBusy(true);
    try {
      const runtime = getRuntimeKey(); const origin = getApiBaseUrl();
      const [next, fields] = await Promise.all([
        readNativeEnvironment(active.current.signal), readNativeEnvironmentCatalog(active.current.signal)]);
      if (current() && runtime === getRuntimeKey() && origin === getApiBaseUrl() && !active.current.signal.aborted) {
        setView(next); setCatalog(fields); setError(null);
      }
    } catch (failure) {
      if (current() && !active.current?.signal.aborted) setError(messageFor(safeError(failure)));
    } finally {
      active.current = null; setBusy(false);
    }
  };
  const refresh = () => { void work(() => true); };
  useEffect(() => onRuntimeEndpointChanged(() => {
    if (authority === 'ready') refresh();
  }), [authority]);
  if (auth !== 'ok' || authority !== 'ready') {
    return <SettingsSection title="Environment (native service process)">
      <p role="alert">{auth !== 'ok' ? 'Sign in to read the native environment observation.'
        : 'Native authority is resynchronizing; reading is paused.'}</p>
    </SettingsSection>;
  }
  const disabled = busy || auth !== 'ok' || authority !== 'ready';
  return (
    <SettingsSection item="native-environment.observations" title="Environment (native service process)">
      <p className="text-xs">These determinations are read from the environment of the served NNA process itself
        (scope: service process). Shell and login environments can differ; changes are made in Windows and honored
        after the service restarts. Credential entries never reveal a value here{catalog ? ''
          : ' (catalog pending)'}. {view ? `Observation digest ${view.observation_digest.slice(0, 12)}…` : ''}</p>
      {error ? <p role="alert" data-testid="native-environment-error" className="text-error">{error}</p> : null}
      {view ? (
        <ul data-testid="native-environment-table">
          {view.observed.map((entry) => <EnvironmentRow key={entry.name} {...entry}
            secret={entry.secret || environmentEntryIsSecret(entry.name)} />)}</ul>
      ) : <p>{busy ? 'Reading…' : 'The observation has not been read yet.'}</p>}
      <button type="button" className="btn-secondary" data-testid="native-environment-refresh" disabled={disabled}
        onClick={() => { refresh(); }}>Refresh</button>
    </SettingsSection>
  );
}
