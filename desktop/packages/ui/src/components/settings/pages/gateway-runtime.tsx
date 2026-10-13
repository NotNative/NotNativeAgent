// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { readNativeGatewayStatus, readNativeGatewayTest, actionTriageMessages,
  refusalSentence, type GatewayRuntimeReceipt, type GatewayTestOkReceipt,
  type TriageRefusalReceipt } from '../../../lib/nnd/action-triage.ts';
import { getRuntimeKey, onRuntimeEndpointChanged } from '../../../lib/runtime-switch.ts';
import { getApiBaseUrl } from '../../../lib/runtime-url.ts';
import { useAuthSessionStore } from '../../../lib/runtime-auth-expiry.ts';
import { authorityState, subscribeAuthority } from '../../../sync/authority-sync.ts';
import { SettingsGroupTitle, SettingsSection } from '../primitives.tsx';

const messageFor = (code: string) => actionTriageMessages[code] ?? code;
const isNativeFailure = (value: unknown): value is { code: string } =>
  value instanceof Object && 'code' in value && typeof (value as { code?: unknown }).code === 'string';
const toSentenceGateway = (value: unknown) => (isNativeFailure(value)
  ? messageFor(value.code) : messageFor('nnd_configuration_unavailable'));
const runtimeSentence = (runtime: GatewayRuntimeReceipt['runtime']) => !runtime.running
  ? 'The gateway is not running.'
  : runtime.verified === true
    ? `The gateway is running (pid ${runtime.pid}, identity verified).`
    : runtime.stale === true
      ? `The gateway pid ${runtime.pid} is stale: ${runtime.reason ?? 'the process could not be verified'}.`
      : `The gateway is running (pid ${runtime.pid}).`;

/** Live native gateway runtime panel: the merged config + runtime view and
 * the read-only Telegram probe verdict; the run/start/stop verbs are
 * CLI-only and the panel says so honestly. */
export function GatewayRuntimePanel(): ReactNode {
  const auth = useAuthSessionStore(state => state.status);
  const subscribe = useCallback((listener: () => void) => subscribeAuthority(listener), []);
  const authority = useSyncExternalStore(subscribe, authorityState);
  const [status, setStatus] = useState<GatewayRuntimeReceipt | null>(null);
  const [test, setTest] = useState<GatewayTestOkReceipt | TriageRefusalReceipt | null>(null);
  const [busy1, setBusy1] = useState(false);
  const [busy2, setBusy2] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const pending1 = useRef<AbortController | null>(null);
  const pending2 = useRef<AbortController | null>(null);
  const ready = auth === 'ok' && authority === 'ready';
  const runStatus = useCallback(async () => {
    if (pending1.current || authorityState() !== 'ready'
      || useAuthSessionStore.getState().status !== 'ok') return;
    const controller = new AbortController();
    pending1.current = controller;
    const runtime = getRuntimeKey(), origin = getApiBaseUrl();
    const current = () => !controller.signal.aborted && pending1.current === controller
      && runtime === getRuntimeKey() && origin === getApiBaseUrl();
    setBusy1(true); setError(null);
    try {
      const next = await readNativeGatewayStatus(controller.signal);
      if (current()) setStatus(next);
    } catch (failure) {
      if (current()) setError(toSentenceGateway(failure));
    } finally {
      if (current()) { pending1.current = null; setBusy1(false); }
    }
  }, []);
  const runTest = useCallback(async () => {
    if (pending2.current || authorityState() !== 'ready'
      || useAuthSessionStore.getState().status !== 'ok') return;
    const controller = new AbortController();
    pending2.current = controller;
    const runtime = getRuntimeKey(), origin = getApiBaseUrl();
    const current = () => !controller.signal.aborted && pending2.current === controller
      && runtime === getRuntimeKey() && origin === getApiBaseUrl();
    setBusy2(true); setTestError(null);
    try {
      const next = await readNativeGatewayTest(controller.signal);
      if (current()) setTest(next);
    } catch (failure) {
      if (current()) setTestError(toSentenceGateway(failure));
    } finally {
      if (current()) { pending2.current = null; setBusy2(false); }
    }
  }, []);
  const started = useRef(false);
  useEffect(() => {
    const reset = () => { pending1.current?.abort(); pending1.current = null; pending2.current?.abort();
      pending2.current = null; setStatus(null); setTest(null); setBusy1(false); setBusy2(false);
      setError(null); setTestError(null); };
    reset();
    const unsubscribe = onRuntimeEndpointChanged(() => { started.current = false; reset(); });
    if (ready && !started.current) { started.current = true; void runStatus(); }
    if (!ready) started.current = false;
    return () => { unsubscribe(); pending1.current?.abort(); pending1.current = null;
      pending2.current?.abort(); pending2.current = null; };
  }, [ready, runStatus]);
  const disabled = !ready;
  return <SettingsSection item="native-gateway-runtime.observation">
    <div className="flex items-center justify-between gap-3">
      <SettingsGroupTitle>Gateway runtime</SettingsGroupTitle>
      <button type="button" className="btn-secondary" data-testid="gateway-runtime-refresh"
        disabled={disabled || busy1} onClick={() => { void runStatus(); }}>Refresh</button>
    </div>
    <p className="text-xs text-muted-foreground">Live gateway view: the Telegram link state plus
      the running process check. The native surface never starts or stops the gateway — run/start/
      stop stay terminal commands (the CLI is their authority).</p>
    {!ready ? <p role="status">{auth !== 'ok'
      ? 'Sign in to read the gateway runtime.'
      : 'Native authority is resynchronizing; reading is paused.'}</p> : null}
    {error ? <p role="alert" data-testid="gateway-runtime-error">{error}</p> : null}
    {status ? <dl className="grid grid-cols-[auto_1fr] gap-x-3 text-xs"
      data-testid="gateway-runtime-receipt">
      <dt>Enabled</dt><dd>{status.config.enabled ? 'yes' : 'no'}</dd>
      <dt>Token</dt><dd>{status.config.configured
        ? `configured (${status.config.token_source})` : 'not configured'}</dd>
      <dt>Workspace</dt><dd>{status.config.workspace_root ?? 'unassigned'}</dd>
      <dt>Polling timeout</dt><dd>{status.config.polling_timeout_seconds}s</dd>
      <dt>Runtime</dt><dd>{runtimeSentence(status.runtime)}</dd>
    </dl> : <p>{busy1 ? 'Reading…' : 'The runtime view has not been read yet.'}</p>}
    <div className="flex items-center justify-between gap-3">
      <SettingsGroupTitle>Verify Telegram link</SettingsGroupTitle>
      <button type="button" className="btn-secondary" data-testid="gateway-test-probe"
        disabled={disabled || busy2} onClick={() => { void runTest(); }}>Probe</button>
    </div>
    <p className="text-xs text-muted-foreground">A read-only Telegram getMe probe over the
      configured token. This changes nothing; it confirms the bot identity the gateway would use.</p>
    {testError ? <p role="alert" data-testid="gateway-test-error">{testError}</p> : null}
    {test ? ('refused' in test
      ? <p data-testid="gateway-test-receipt" role="status">{refusalSentence(test)}</p>
      : <dl className="grid grid-cols-[auto_1fr] gap-x-3 text-xs" data-testid="gateway-test-receipt">
        <dt>Bot</dt><dd>@{test.bot.username ?? 'unnamed'} (id {test.bot.id})</dd>
      </dl>)
      : <p>{busy2 ? 'Probing…' : 'The probe has not been run yet.'}</p>}
  </SettingsSection>;
}
