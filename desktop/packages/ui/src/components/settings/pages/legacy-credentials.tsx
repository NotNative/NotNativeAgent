// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { readNativeLegacyProviderCredentials, legacyCredentialsMessages,
  type NativeLegacyProviderCredentialsReceipt } from '../../../lib/nnd/legacy-credentials.ts';
import { getRuntimeKey, onRuntimeEndpointChanged } from '../../../lib/runtime-switch.ts';
import { getApiBaseUrl } from '../../../lib/runtime-url.ts';
import { useAuthSessionStore } from '../../../lib/runtime-auth-expiry.ts';
import { authorityState, subscribeAuthority } from '../../../sync/authority-sync.ts';
import { SettingsGroupTitle, SettingsSection } from '../primitives.tsx';

const messageFor = (code: string) => legacyCredentialsMessages[code] ?? code;
const isNativeFailure = (value: unknown): value is { code: string } =>
  value instanceof Object && 'code' in value && typeof (value as { code?: unknown }).code === 'string';
const toSentence = (value: unknown) => (isNativeFailure(value) ? messageFor(value.code)
  : messageFor('nnd_legacy_credentials_unavailable'));

const reasonSentence = (reason: string | null) => reason === null
  ? null
  : reason === 'provider_bootstrap_file_too_large'
    ? 'The legacy credential store exceeds its size bound; the alias was not loaded.'
    : 'The legacy credential store has an unsupported shape; the alias was not loaded.';

/** Native legacy provider-credential alias observation: the served process's
 * startup alias loader read without ever revealing the value
 * (sensitivity: secret — presence and verdict only). */
export function LegacyCredentialsPanel(): ReactNode {
  const auth = useAuthSessionStore(state => state.status);
  const subscribe = useCallback((listener: () => void) => subscribeAuthority(listener), []);
  const authority = useSyncExternalStore(subscribe, authorityState);
  const [receipt, setReceipt] = useState<NativeLegacyProviderCredentialsReceipt | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<AbortController | null>(null);
  const ready = auth === 'ok' && authority === 'ready';
  const run = useCallback(async () => {
    if (pending.current || authorityState() !== 'ready'
      || useAuthSessionStore.getState().status !== 'ok') return;
    const controller = new AbortController();
    pending.current = controller;
    const runtime = getRuntimeKey(), origin = getApiBaseUrl();
    const current = () => !controller.signal.aborted && pending.current === controller
      && runtime === getRuntimeKey() && origin === getApiBaseUrl();
    setBusy(true); setError(null);
    try {
      const next = await readNativeLegacyProviderCredentials(controller.signal);
      if (current()) setReceipt(next);
    } catch (failure) {
      if (current()) setError(toSentence(failure));
    } finally {
      if (current()) { pending.current = null; setBusy(false); }
    }
  }, []);
  const started = useRef(false);
  useEffect(() => {
    const reset = () => { pending.current?.abort(); pending.current = null; setReceipt(null); setBusy(false); setError(null); };
    reset();
    const unsubscribe = onRuntimeEndpointChanged(() => { started.current = false; reset(); });
    if (ready && !started.current) { started.current = true; void run(); }
    if (!ready) started.current = false;
    return () => { unsubscribe(); pending.current?.abort(); pending.current = null; };
  }, [ready, run]);
  const disabled = busy || !ready;
  return <SettingsSection item="native-legacy-credentials.observation">
    <div className="flex items-center justify-between gap-3">
      <SettingsGroupTitle>Legacy provider credential alias</SettingsGroupTitle>
      <button type="button" className="btn-secondary" data-testid="legacy-credentials-refresh"
        disabled={disabled} onClick={() => { void run(); }}>Refresh</button>
    </div>
    <p className="text-xs text-muted-foreground">Whether the served process loaded the legacy
      NNA_PROVIDER_INITIAL_KEY alias from config/provider-credentials.json. The value is never
      displayed — only the load verdict; the alias itself is read at startup and unused entries are
      never injected.</p>
    {!ready ? <p role="status">{auth !== 'ok'
      ? 'Sign in to read the legacy credential observation.'
      : 'Native authority is resynchronizing; reading is paused.'}</p> : null}
    {error ? <p role="alert" data-testid="legacy-credentials-error">{error}</p> : null}
    {receipt ? <dl className="grid grid-cols-[auto_1fr] gap-x-3 text-xs"
      data-testid="legacy-credentials-receipt">
      <dt>Loaded</dt><dd>{receipt.loaded ? 'yes' : 'no'}</dd>
      <dt>Alias count</dt><dd>{receipt.count}</dd>
      <dt>Verdict</dt><dd>{reasonSentence(receipt.reason) ?? 'The store loaded; the alias is active at startup.'}</dd>
    </dl> : <p>{busy ? 'Reading…' : 'The verdict has not been read yet.'}</p>}
  </SettingsSection>;
}
