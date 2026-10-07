// SPDX-License-Identifier: Apache-2.0
/** Native update state section (read-only).
 * Why: the census classifies the eight update_state entries as worker-generated state;
 * the settings GUI shows the recorded update check's essentials from the native surface
 * instead of repeating a private web request from the renderer.
 * Invariant: nothing here edits anything — only the update worker and its install path
 * write the store; the panel offers reading again only.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { getRuntimeKey, onRuntimeEndpointChanged } from '../../../lib/runtime-switch.ts';
import { getApiBaseUrl } from '../../../lib/runtime-url.ts';
import { useAuthSessionStore } from '../../../lib/runtime-auth-expiry.ts';
import { readNativeUpdateState, readNativeUpdateStateCatalog, updateStateMessages }
  from '../../../lib/nnd/update-state.ts';
import type { NativeUpdateStateView, NativeUpdateStateCatalog } from '../../../lib/nnd/update-state.ts';
import { authorityState, subscribeAuthority } from '../../../sync/authority-sync.ts';
import { SettingsSection } from '../primitives.tsx';

const messageFor = (error: unknown) => {
  const code = error instanceof Error ? error.message : 'nnd_update_state_unavailable';
  return updateStateMessages[code] ?? code;
};

export function NativeUpdateState() {
  const auth = useAuthSessionStore((state) => state.status);
  const authority = useSyncExternalStore(subscribeAuthority, authorityState);
  const [view, setView] = useState<NativeUpdateStateView | null>(null);
  const [catalog, setCatalog] = useState<NativeUpdateStateCatalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const active = useRef<AbortController | null>(null);
  useEffect(() => {
    let current = true;
    const stop = onRuntimeEndpointChanged(() => { if (authority === 'ready') refresh(); });
    void work(() => current).catch(() => undefined);
    return () => { current = false; stop();
      if (active.current) { active.current.abort(); active.current = null; } };
  }, [authority]);
  const work = async (current: () => boolean) => {
    if (active.current || auth !== 'ok' || authority !== 'ready') return;
    active.current = new AbortController();
    setBusy(true);
    try {
      const runtime = getRuntimeKey(); const origin = getApiBaseUrl();
      const [next, fields] = await Promise.all([
        readNativeUpdateState(active.current.signal), readNativeUpdateStateCatalog(active.current.signal)]);
      if (current() && runtime === getRuntimeKey() && origin === getApiBaseUrl() && !active.current.signal.aborted) {
        setView(next); setCatalog(fields); setError(null);
      }
    } catch (failure) {
      if (current() && !active.current?.signal.aborted) setError(messageFor(failure));
    } finally {
      active.current = null; setBusy(false);
    }
  };
  const refresh = () => { void work(() => true); };
  if (auth !== 'ok' || authority !== 'ready') {
    return <SettingsSection item="native-update-state.observations" title="Updates (native service)">
      <p role="alert">{auth !== 'ok' ? 'Sign in to read the native update state.'
        : 'Native authority is resynchronizing; reading is paused.'}</p>
    </SettingsSection>;
  }
  const disabled = busy || auth !== 'ok' || authority !== 'ready';
  return (
    <SettingsSection item="native-update-state.observations" title="Updates (native service)">
      <p className="text-xs">This is the update worker's last recorded check against the release channel, read from
        the native service on the worker's schedule. Installing happens through the NNA updater, and this panel never
        repeats the request or writes anything.</p>
      {error ? <p role="alert" data-testid="native-update-state-error" className="text-error">{error}</p> : null}
      {view ? view.state === 'absent'
        ? <p data-testid="native-update-state-absent">No update check has been recorded yet.</p>
        : <ul data-testid="native-update-state-table">
          <li>Status: <span data-testid="native-update-state-status">{view.status}</span></li>
          <li>Checked at: <span data-testid="native-update-state-checked">{view.checked_at}</span></li>
          <li>Latest version: <span data-testid="native-update-state-latest">{view.latest_version ?? 'unknown'}</span></li>
          <li>Release ref: <span data-testid="native-update-state-ref">{view.latest_ref ?? 'unknown'}</span></li>
          <li>Release tag: <span data-testid="native-update-state-tag">{view.latest_tag ?? 'unknown'}</span></li>
          <li>Release digest: <span data-testid="native-update-state-sha">{view.latest_sha ?? 'unknown'}</span></li>
          {view.error_code ? <li>Last error: <span data-testid="native-update-state-error-code">{view.error_code}</span></li> : null}
        </ul>
        : <p>{busy ? 'Reading…' : 'The update state has not been read yet.'}</p>}
      <button type="button" className="btn-secondary" data-testid="native-update-state-refresh" disabled={disabled}
        onClick={() => { refresh(); }}>Refresh</button>
    </SettingsSection>
  );
}
