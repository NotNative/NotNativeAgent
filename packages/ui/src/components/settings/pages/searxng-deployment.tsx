// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { readNativeSearxngStatus, actionTriageMessages,
  type SearxngStatusReceipt } from '../../../lib/nnd/action-triage.ts';
import { getRuntimeKey, onRuntimeEndpointChanged } from '../../../lib/runtime-switch.ts';
import { getApiBaseUrl } from '../../../lib/runtime-url.ts';
import { useAuthSessionStore } from '../../../lib/runtime-auth-expiry.ts';
import { authorityState, subscribeAuthority } from '../../../sync/authority-sync.ts';
import { SettingsGroupTitle, SettingsSection } from '../primitives.tsx';

const messageFor = (code: string) => actionTriageMessages[code] ?? code;
const isNativeFailure = (value: unknown): value is { code: string } =>
  value instanceof Object && 'code' in value && typeof (value as { code?: unknown }).code === 'string';
const toSentence = (value: unknown) => (isNativeFailure(value)
  ? messageFor(value.code) : messageFor('nnd_configuration_unavailable'));

/** Native managed SearXNG deployment observation: the HTTP search probe plus
 * the docker container identity. The deploy/install-local/remove lifecycle
 * verbs are CLI-only and the panel says so honestly. */
export function SearxngDeploymentPanel(): ReactNode {
  const auth = useAuthSessionStore(state => state.status);
  const subscribe = useCallback((listener: () => void) => subscribeAuthority(listener), []);
  const authority = useSyncExternalStore(subscribe, authorityState);
  const [status, setStatus] = useState<SearxngStatusReceipt | null>(null);
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
      const next = await readNativeSearxngStatus(controller.signal);
      if (current()) setStatus(next);
    } catch (failure) {
      if (current()) setError(toSentence(failure));
    } finally {
      if (current()) { pending.current = null; setBusy(false); }
    }
  }, []);
  const started = useRef(false);
  useEffect(() => {
    const reset = () => { pending.current?.abort(); pending.current = null; setStatus(null);
      setBusy(false); setError(null); };
    reset();
    const unsubscribe = onRuntimeEndpointChanged(() => { started.current = false; reset(); });
    if (ready && !started.current) { started.current = true; void run(); }
    if (!ready) started.current = false;
    return () => { unsubscribe(); pending.current?.abort(); pending.current = null; };
  }, [ready, run]);
  const disabled = !ready;
  return <SettingsSection item="native-searxng-deployment.observation">
    <div className="flex items-center justify-between gap-3">
      <SettingsGroupTitle>Managed SearXNG deployment</SettingsGroupTitle>
      <button type="button" className="btn-secondary" data-testid="searxng-deployment-refresh"
        disabled={disabled || busy} onClick={() => { void run(); }}>Refresh</button>
    </div>
    <p className="text-xs text-muted-foreground">Observes the managed SearXNG deployment (HTTP
      search probe plus docker container identity). Deploying, installing, refreshing, or removing
      the deployment changes docker state — those stay terminal commands (the CLI is their
      authority).</p>
    {!ready ? <p role="status">{auth !== 'ok'
      ? 'Sign in to read the managed deployment observation.'
      : 'Native authority is resynchronizing; reading is paused.'}</p> : null}
    {error ? <p role="alert" data-testid="searxng-deployment-error">{error}</p> : null}
    {status ? <dl className="grid grid-cols-[auto_1fr] gap-x-3 text-xs"
      data-testid="searxng-deployment-receipt">
      <dt>Endpoint</dt><dd>{status.status.endpoint}</dd>
      <dt>Container</dt><dd>{status.status.container}</dd>
      {status.status.container_error ? <>
        <dt>Container error</dt><dd>{status.status.container_error}</dd>
      </> : null}
      <dt>Search probe</dt><dd>{status.status.search.ok ? 'reached'
        : `unreachable${status.status.search.error ? ` (${status.status.search.error})` : ''}`}</dd>
    </dl> : <p>{busy ? 'Reading…' : 'The deployment view has not been read yet.'}</p>}
  </SettingsSection>;
}
