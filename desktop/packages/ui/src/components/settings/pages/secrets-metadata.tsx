// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { getRuntimeKey, onRuntimeEndpointChanged } from '../../../lib/runtime-switch.ts';
import { getApiBaseUrl } from '../../../lib/runtime-url.ts';
import { useAuthSessionStore } from '../../../lib/runtime-auth-expiry.ts';
import { readNativeSecretsList, readNativeSecretsCatalog, NativeSecretsFailure,
  secretsErrorText, type NativeSecretsList } from '../../../lib/nnd/secrets.ts';
import { authorityState, subscribeAuthority } from '../../../sync/authority-sync.ts';
import { SettingsGroupTitle, SettingsSection } from '../primitives.tsx';

const BUTTON = 'rounded border border-border px-2 py-1 text-xs disabled:opacity-50';
const safeError = (error: unknown) => error instanceof NativeSecretsFailure ? error.code : 'nnd_secrets_unavailable';

export function SecretsMetadataSettings(): ReactNode {
  const auth = useAuthSessionStore(state => state.status);
  const authority = useSyncExternalStore(subscribeAuthority, authorityState);
  const [view, setView] = useState<NativeSecretsList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const active = useRef<AbortController | null>(null);
  const run = (work: (signal: AbortSignal, current: () => boolean) => Promise<void>) => {
    if (active.current || auth !== 'ok' || authorityState() !== 'ready') return;
    const controller = new AbortController(); active.current = controller;
    const runtime = getRuntimeKey(), origin = getApiBaseUrl();
    const current = () => active.current === controller && !controller.signal.aborted
      && runtime === getRuntimeKey() && origin === getApiBaseUrl() && authorityState() === 'ready';
    setBusy(true); setError(null);
    void work(controller.signal, current).catch(failure => { if (current()) setError(safeError(failure)); })
      .finally(() => { if (current()) setBusy(false); if (active.current === controller) active.current = null; });
  };
  const load = useCallback(() => { run(async (signal, current) => {
    const [list] = await Promise.all([readNativeSecretsList(signal), readNativeSecretsCatalog(signal)]);
    if (!current()) return;
    setView(list); setError(null);
  }); }, [auth]);
  useEffect(() => {
    const reset = () => { active.current?.abort(); active.current = null;
      setView(null); setError(null); setBusy(false); };
    reset(); load();
    const off = onRuntimeEndpointChanged(() => { reset(); load(); });
    return () => { off(); active.current?.abort(); active.current = null; };
  }, [load]);
  useEffect(() => {
    if (authority !== 'ready') { active.current?.abort(); active.current = null; setBusy(false); }
    else if (!view && auth === 'ok') load();
  }, [authority]);
  const disabled = busy || auth !== 'ok' || authority !== 'ready';
  return <SettingsSection item="native-secrets.settings">
    <div className="flex items-center justify-between gap-3">
      <SettingsGroupTitle>NNA secrets metadata</SettingsGroupTitle>
      <button type="button" className={BUTTON} onClick={load} disabled={disabled}>Refresh</button>
    </div>
    <p className="text-xs">NNA stores secret values encrypted in its vault; this roster shows only the redaction-safe
      metadata each record carries — label, kind, ownership scope, the NAMES of its public
      metadata, FIELD NAMES, and enabled state.
      Values and encrypted material never render here. This diagnostic view is read-only. Manage records in the Secrets tab;
      provider bindings stay in Providers and models. Inspecting needs nnd.configuration.read.</p>
    {auth !== 'ok' ? <p role="alert">Sign in to inspect secrets metadata.</p> : null}
    {authority !== 'ready' ? <p role="alert">Native authority is resynchronizing. Inspection is paused.</p> : null}
    {busy ? <p role="status">Working…</p> : null}
    {error ? <p role="alert">{secretsErrorText(error)} ({error})</p> : null}
    {view ? <>
      <p className="text-xs" data-testid="secrets-status">Selected installation: {view.installation_id} · data:
        {' '}{view.data_id} · vault: {view.source_state} · records: {view.count}</p>
      <ul className="text-xs" data-testid="secrets-list">
        {view.secrets.map(item => <li key={item.id}>{[
          item.label, item.kind, item.enabled ? 'enabled' : 'disabled',
          `fields ${item.fields.join(', ') || 'none'}`,
          `metadata ${Object.keys(item.metadata).sort().join(', ') || 'none'}`,
          item.scope ? `scope ${item.scope.kind}:${item.scope.id}` : 'unscoped',
          `updated ${item.updated_at}`].join(' · ')}</li>)}
      </ul>
    </> : null}
  </SettingsSection>;
}
