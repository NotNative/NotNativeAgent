// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { getRuntimeKey, onRuntimeEndpointChanged } from '../../../lib/runtime-switch.ts';
import { getApiBaseUrl } from '../../../lib/runtime-url.ts';
import { readHooks, hooksErrorText, NativeHooksFailure, type HooksList,
  type HookBundle } from '../../../lib/nnd/hooks.ts';
import { authorityState, subscribeAuthority } from '../../../sync/authority-sync.ts';
import { useAuthSessionStore } from '../../../lib/runtime-auth-expiry.ts';
import { SettingsGroupTitle, SettingsSection } from '../primitives.tsx';

const safeError = (error: unknown) => error instanceof NativeHooksFailure ? error.code : 'nnd_hooks_unavailable';
const CAPTION = 'These are the native hook bundles the NNA reads from its configured hooks directory — one manifest per bundle with the nine census fields (bundles carry name, version, subscriptions; subscriptions carry event, phase, command, blocking, priority, timeout_ms, max_concurrent). The view applies or activates nothing: runtime execution stays with the hook runner, and authoring a manifest belongs to the hook-store mutation story, so every field is refused for editing natively. Malformed bundles surface here as their own skipped diagnostics and over-cap stores report the omitted count.';

export function HooksBundleSettings(): ReactNode {
  const auth = useAuthSessionStore(state => state.status);
  const authority = useSyncExternalStore(subscribeAuthority, authorityState);
  const [hooks, setHooks] = useState<HooksList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const active = useRef<AbortController | null>(null);
  const load = useCallback(() => observe(auth, active, setBusy, setError, setHooks), [auth]);
  const reset = useCallback(() => { active.current?.abort(); active.current = null;
    setHooks(null); setError(null); setBusy(false); }, []);
  useEffect(() => mountObservation(reset, load), [reset, load]);
  useEffect(() => syncWatch(authority, auth, hooks !== null, active, setBusy, load),
    [authority, auth, hooks, load]);
  return <SettingsSection item="native-hooks-bundles.settings">
    <div className="flex items-center justify-between gap-3">
      <SettingsGroupTitle>NNA hook bundles</SettingsGroupTitle>
      <button type="button" className="rounded border border-border px-2 py-1 text-xs"
        onClick={load} disabled={busy || auth !== 'ok' || authority !== 'ready'}>Refresh</button>
    </div>
    <p className="text-xs">{CAPTION}</p>
    {auth !== 'ok' ? <p role="alert">Sign in to view the native hook bundles.</p> : null}
    {authority !== 'ready' ? <p role="alert">Native authority is resynchronizing. Hook bundle observations are paused.</p> : null}
    {busy ? <p role="status">Refreshing…</p> : null}
    {error ? <p role="alert">{hooksErrorText(error)} ({error})</p> : null}
    {hooks ? <Catalog hooks={hooks} /> : null}
  </SettingsSection>;
}

/** One observation at a time, dropped when the runtime, origin, login, or
 * native authority drifts away from the mounted view. */
function observe(auth: string, active: React.RefObject<AbortController | null>,
  setBusy: (busy: boolean) => void, setError: (message: string | null) => void,
  setHooks: (hooks: HooksList | null) => void): void {
  if (active.current || auth !== 'ok' || authorityState() !== 'ready') return;
  const controller = new AbortController(); active.current = controller;
  const runtime = getRuntimeKey(), origin = getApiBaseUrl();
  const current = () => active.current === controller && !controller.signal.aborted
    && runtime === getRuntimeKey() && origin === getApiBaseUrl() && authorityState() === 'ready';
  setBusy(true); setError(null);
  void readHooks(controller.signal).then(next => { if (current()) { setHooks(next); setError(null); } })
    .catch(failure => { if (current()) setError(safeError(failure)); })
    .finally(() => { if (current()) setBusy(false); if (active.current === controller) active.current = null; });
}

/** Runtime switches and unmount reset the section; each connected endpoint
 * triggers one fresh observation. */
function mountObservation(reset: () => void, load: () => void): () => void {
  reset(); load();
  const off = onRuntimeEndpointChanged(() => { reset(); load(); });
  return () => { off(); reset(); };
}

/** While native authority resynchronizes in-flight work pauses honestly; once
 * ready a missing observation triggers one fresh read. */
function syncWatch(authority: string, auth: string, hasView: boolean,
  active: React.RefObject<AbortController | null>, setBusy: (busy: boolean) => void,
  load: () => void): void {
  if (authority !== 'ready') { active.current?.abort(); active.current = null; setBusy(false); }
  else if (!hasView && auth === 'ok') load();
}

function Catalog({ hooks }: { hooks: HooksList }): ReactNode {
  if (hooks.source_state === 'absent') {
    return <p className="text-xs" role="status">The native hooks directory does not exist yet, so no bundles are loaded.</p>;
  }
  if (hooks.count === 0) {
    return <p className="text-xs" role="status">The hooks directory exists but every candidate bundle failed discovery.</p>;
  }
  return <ul className="text-xs" data-testid="hooks-roster">
    {hooks.diagnostics.map((entry, index) => <li key={index} data-testid="hook-diagnostic">
      {entry.status === 'limit_reached'
        ? `discovery cap reached: ${entry.omitted} candidate bundles beyond the first 32 were omitted`
        : `bundle ${entry.bundle} was skipped natively (${entry.code})`}</li>)}
    {hooks.hooks.map(bundle => <Hook key={bundle.name} bundle={bundle} />)}
  </ul>;
}

function Hook({ bundle }: { bundle: HookBundle }): ReactNode {
  return <li><span data-testid="hook-name">{bundle.name}</span> v{bundle.version || 'unversioned'}
    {' '}· {bundle.directory_name}
    <ul className="ml-3">
      {bundle.subscriptions.map((subscription, index) => <li key={index}
        data-testid="hook-subscription">
        <code>{subscription.event}:{subscription.phase}</code>
        {' '}{subscription.command} — blocking {String(subscription.blocking)}, priority {subscription.priority},
        timeout {subscription.timeout_ms} ms, max {subscription.max_concurrent} concurrent</li>)}
      {bundle.subscriptions.length === 0 ? <li>(no subscriptions)</li> : null}
    </ul>
  </li>;
}
