// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { getRuntimeKey, onRuntimeEndpointChanged } from '../../../lib/runtime-switch.ts';
import { getApiBaseUrl } from '../../../lib/runtime-url.ts';
import { useAuthSessionStore } from '../../../lib/runtime-auth-expiry.ts';
import { readServiceStatus, requestServiceAction, NativeServiceLifecycleFailure,
  serviceLifecycleErrorText, type ServiceStatusView,
  type StartReceipt, type StopReceipt, type WiringReceipt } from '../../../lib/nnd/lifecycle.ts';
import { authorityState, subscribeAuthority } from '../../../sync/authority-sync.ts';
import { SettingsGroupTitle, SettingsSection } from '../primitives.tsx';

const BUTTON = 'rounded border border-border px-2 py-1 text-xs disabled:opacity-50';
const safeError = (error: unknown) => error instanceof NativeServiceLifecycleFailure ? error.code : 'nnd_service_unavailable';

/** A runtime switch or login change resets the section; connected endpoints
 * trigger a fresh observation, and any unmount aborts in-flight work. */
function mountEndpointWatch(reset: () => void, load: () => void): () => void {
  reset(); load();
  const off = onRuntimeEndpointChanged(() => { reset(); load(); });
  return () => { off(); reset(); };
}

/** While native authority resynchronizes, in-flight work pauses honestly; once
 * ready, a missing observation triggers one fresh read. */
function syncAuthority(authority: string, auth: string, hasView: boolean,
  active: React.RefObject<AbortController | null>, setBusy: (busy: boolean) => void,
  load: () => void): void {
  if (authority !== 'ready') { active.current?.abort(); active.current = null; setBusy(false); }
  else if (!hasView && auth === 'ok') load();
}

/** One in-flight session at a time; every callback guards runtime, origin,
 * login, and native authority so late results from a switched context drop. */
function enqueue(auth: string, active: React.RefObject<AbortController | null>,
  setBusy: (busy: boolean) => void, setError: (message: string | null) => void,
  work: (signal: AbortSignal, current: () => boolean) => Promise<void>): void {
  if (active.current || auth !== 'ok' || authorityState() !== 'ready') return;
  const controller = new AbortController(); active.current = controller;
  const runtime = getRuntimeKey(), origin = getApiBaseUrl();
  const current = () => active.current === controller && !controller.signal.aborted
    && runtime === getRuntimeKey() && origin === getApiBaseUrl() && authorityState() === 'ready';
  setBusy(true); setError(null);
  void work(controller.signal, current).catch(failure => { if (current()) setError(safeError(failure)); })
    .finally(() => { if (current()) setBusy(false); if (active.current === controller) active.current = null; });
}

export function ServiceLifecycleControls(): ReactNode {
  const auth = useAuthSessionStore(state => state.status);
  const authority = useSyncExternalStore(subscribeAuthority, authorityState);
  const [status, setStatus] = useState<ServiceStatusView | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const active = useRef<AbortController | null>(null);
  const run = (work: (signal: AbortSignal, current: () => boolean) => Promise<void>) =>
    enqueue(auth, active, setBusy, setError, work);
  const load = useCallback(() => { run(async (signal, current) => {
    const next = (await readServiceStatus(signal)).status;
    if (!current()) return;
    setStatus(next); setError(null);
  }); }, [auth]);
  const act = useCallback((action: 'start' | 'stop' | 'enable' | 'disable') => { run(async (signal, current) => {
    // Inputs never ride lifecycle actions: the wire accepts only empty bodies, so
    // stray state can never sneak into a process kill or a wiring change.
    const next = await requestServiceAction(action, signal);
    if (!current()) return;
    setReceipt(`${summarize(next)} (operation ${next.operation_id.slice(0, 8)}, ${next.application})`);
    const observed = (await readServiceStatus(signal)).status;
    if (!current()) return;
    setStatus(observed); setError(null);
  }); }, [auth]);
  const resetWire = useCallback(() => { active.current?.abort(); active.current = null;
    setStatus(null); setReceipt(null); setError(null); setBusy(false); }, []);
  const mountWire = useCallback(() => mountEndpointWatch(resetWire, load), [load, resetWire]);
  useEffect(() => mountWire(), [mountWire]);
  useEffect(() => syncAuthority(authority, auth, status !== null, active, setBusy, load),
    [authority, auth, status, load]);
  const disabled = busy || auth !== 'ok' || authority !== 'ready';
  return <SettingsSection item="native-service-lifecycle.settings">
    <div className="flex items-center justify-between gap-3">
      <SettingsGroupTitle>NNA compatibility service actions</SettingsGroupTitle>
      <div className="flex gap-2">
        <button type="button" className={BUTTON} onClick={() => act('start')} disabled={disabled}>Start</button>
        <button type="button" className={BUTTON} onClick={() => act('stop')} disabled={disabled}>Stop</button>
        <button type="button" className={BUTTON} onClick={() => act('enable')} disabled={disabled}>Enable login auto-start</button>
        <button type="button" className={BUTTON} onClick={() => act('disable')} disabled={disabled}>Disable login auto-start</button>
        <button type="button" className={BUTTON} onClick={load} disabled={disabled}>Refresh</button>
      </div>
    </div>
    <p className="text-xs">These verbs run the native OpenCode lifecycle service verbatim: start spawns the
      detached managed runtime from the persisted wiring, stop stops a verified runtime (it refuses an
      unverified one), enable/disable install or remove the Windows login Startup script and flip the
      persisted flag — that wiring takes effect at the next service start. Values applied this moment are
      receipts only; the generic managed foreground runtime (run) is driven by the detached start and the
      login script, so it has no operator button here. Actions need nnd.service.manage; inspecting needs
      nnd.configuration.read.</p>
    {auth !== 'ok' ? <p role="alert">Sign in to operate the compatibility service.</p> : null}
    {authority !== 'ready' ? <p role="alert">Native authority is resynchronizing. Service actions are paused.</p> : null}
    {busy ? <p role="status">Working…</p> : null}
    {error ? <p role="alert">{serviceLifecycleErrorText(error)} ({error})</p> : null}
    {receipt ? <p role="status" data-testid="lifecycle-receipt">{receipt}</p> : null}
    {status ? <StatusPanel status={status} /> : null}
  </SettingsSection>;
}

function StatusPanel({ status }: { status: ServiceStatusView }): ReactNode {
  const runtime = status.runtime;
  const runtimeText = !runtime.running
    ? runtime.stale
      ? `not running · stale pid ${runtime.pid ?? 'record'}${runtime.reason ? ` (${runtime.reason})` : ''}`
      : 'not running'
    : runtime.verified ? `running · verified pid ${runtime.pid}${runtime.url ? ` at ${runtime.url}` : ''}`
      : `running · UNVERIFIED pid ${runtime.pid}${runtime.legacy ? ' (legacy record)' : ''} — stop refuses this runtime until identity reconciles`;
  const login = status.login;
  const loginText = !login.supported ? 'login wiring unavailable on this platform'
    : login.error ? `login wiring probe failed (${login.error})`
      : login.installed ? `Startup script installed: ${login.script_path}`
        : 'no login Startup script installed';
  const env = status.environment;
  const envText = !env.supported ? 'OpenChamber environment not owned on this platform'
    : env.error ? `environment probe failed (${env.error})`
      : `OPENCODE_SKIP_START=${env.skip_start ?? 'unset'} · OPENCODE_HOST=${env.host ?? 'unset'} · OPENCODE_SERVER_USERNAME=${env.username ?? 'unset'} · OPENCODE_SERVER_PASSWORD${env.password_present ? ' present' : ' absent'}`;
  return <ul className="text-xs" data-testid="lifecycle-status">
    <li>service {status.service.autostart_enabled ? 'enabled' : 'disabled'} · {status.service.configured
      ? `basic auth configured (password source: ${status.service.password_source})`
      : 'no basic auth credentials'} · user {status.service.username}</li>
    <li>wire {status.service.bind_url} (hostname {status.service.hostname}, port {status.service.port})</li>
    <li data-testid="lifecycle-runtime">{runtimeText}{status.stale_binding
      ? ' · the recorded binding is stale; refresh after reconciliation' : ''}</li>
    <li data-testid="lifecycle-login">{loginText}</li>
    <li data-testid="lifecycle-environment">{envText}</li>
  </ul>;
}

function summarize(next: StartReceipt | StopReceipt | WiringReceipt): string {
  if (next.action === 'start') return next.started ? `runtime started at ${next.url}`
    : next.reason === 'already_starting' ? 'runtime is already starting'
      : 'runtime is already running';
  if (next.action === 'stop') return next.stopped ? `runtime stopped (pid ${next.pid})`
    : 'nothing was running; the receipt records not_running';
  return next.action === 'enable' ? `login auto-start wired: ${next.login.installed ? 'installed' : 'not installed'}; applies at the next service start (runtime ${next.runtime.running ? 'running' : 'not running'})`
    : `login auto-start unwired: ${next.login.installed ? 'still installed' : 'removed'}; applies at the next service start (runtime ${next.runtime.running ? 'running' : 'not running'})`;
}
