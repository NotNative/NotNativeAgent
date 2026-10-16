// SPDX-License-Identifier: Apache-2.0
import { readNativeEnvironment, readNativeEnvironmentCatalog, environmentMessages, environmentEntryIsSecret } from '../../../lib/nnd/environment.ts';
import { SettingsSection } from '../primitives.tsx';
import { useNativeObservation } from './use-native-observation.ts';

async function readEnvironment(signal: AbortSignal) {
  const [view, catalog] = await Promise.all([readNativeEnvironment(signal), readNativeEnvironmentCatalog(signal)]);
  return { view, catalog };
}

export function NativeEnvironment() {
  const state = useNativeObservation(readEnvironment);
  const view = state.data?.view;
  if (!state.ready) return <SettingsSection item="native-environment.observations" title="Environment (native service process)">
    <p role="alert">Sign in to read the native environment observation. Native authority must be ready.</p></SettingsSection>;
  return <SettingsSection item="native-environment.observations" title="Environment (native service process)">
    <p className="text-xs">These values describe the served NNA process. Shell and login environments can differ.
      Change environment settings in the host operating system, then restart NNA. Credential values are withheld.
      {view ? ` Observation digest ${view.observation_digest.slice(0, 12)}…` : ''}</p>
    {state.error ? <p role="alert" data-testid="native-environment-error">{environmentMessages[state.error] ?? state.error}</p> : null}
    {state.busy ? <p role="status">Reading the service environment…</p> : null}
    {view ? <ul data-testid="native-environment-table" className="space-y-2 text-xs">{view.observed.map(entry => <li key={entry.name}>
      <span className="font-mono">{entry.name}</span>{' '}
      <span data-testid={`native-environment-${entry.name.toLowerCase()}`}>{!entry.present ? 'not set in the service process'
        : entry.secret || environmentEntryIsSecret(entry.name) ? 'set · value withheld' : entry.value || '(empty value)'}</span>
    </li>)}</ul> : null}
    <button type="button" data-testid="native-environment-refresh" disabled={state.busy || !state.ready} onClick={() => { void state.reload(); }}>Refresh</button>
  </SettingsSection>;
}
