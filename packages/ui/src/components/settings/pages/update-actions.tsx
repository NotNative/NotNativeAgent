// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { getRuntimeKey, onRuntimeEndpointChanged } from '../../../lib/runtime-switch.ts';
import { getApiBaseUrl } from '../../../lib/runtime-url.ts';
import { runUpdateCheck, attemptInstallForReceipt, NativeUpdateActionFailure,
  updateActionErrorText, type UpdateCheckReceipt } from '../../../lib/nnd/update-actions.ts';
import { authorityState, subscribeAuthority } from '../../../sync/authority-sync.ts';
import { useAuthSessionStore } from '../../../lib/runtime-auth-expiry.ts';
import { SettingsGroupTitle, SettingsSection } from '../primitives.tsx';

const FIELD = 'rounded border border-border px-2 py-1 text-xs';
const BUTTON = 'rounded border border-border px-2 py-1 text-xs disabled:opacity-50';
const safeError = (failure: unknown) => failure instanceof NativeUpdateActionFailure
  ? failure.code : 'nnd_update_action_unavailable';
const BOUND_NOTE = 'The runtime reuses the update CLI\'s authority: check forces a live'
  + ' repository probe and records the verdict exactly as the CLI does; the install line'
  + ' is wired to the surface so the refusal is learned and reported verbatim — the'
  + ' installer inherits the owning console and replaces the running implementation,'
  + ' which an HTTP handler cannot host.';

export function UpdateActionsPanel(): ReactNode {
  const auth = useAuthSessionStore(state => state.status);
  const authority = useSyncExternalStore(subscribeAuthority, authorityState);
  const [check, setCheck] = useState<UpdateCheckReceipt | null>(null);
  const [installNote, setInstallNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const active = useRef<AbortController | null>(null);
  const resetView = useCallback(() => { active.current?.abort(); active.current = null;
    setCheck(null); setInstallNote(null); setError(null); setBusy(false); }, []);
  const load = useCallback(() => runOnce(auth, active, setBusy, setError, async (signal) => {
    setCheck(await runUpdateCheck(signal)); setError(null);
  }), [auth]);
  const install = useCallback(() => runOnce(auth, active, setBusy, setError, async (signal) => {
    await attemptInstallForReceipt(signal);
    setInstallNote('nnd_update_install_unsupported'); setError(null);
  }), [auth]);
  useEffect(() => mountPanel(resetView, load), [resetView, load]);
  useEffect(() => syncWatch(authority, auth, check !== null, active, setBusy, load),
    [authority, auth, check, load]);
  return <SettingsSection item="native-update-actions.settings">
    <div className="flex items-center justify-between gap-3">
      <SettingsGroupTitle>NNA update actions</SettingsGroupTitle>
      <button type="button" className={BUTTON} onClick={load}
        disabled={busy || auth !== 'ok' || authority !== 'ready'}>Check now</button>
    </div>
    <p className="text-xs">Complements the cached update-state view with the forced check
      action; the receipt is the CLI's own verdict. {BOUND_NOTE}</p>
    {auth !== 'ok' ? <p role="alert">Sign in to operate the native update actions.</p> : null}
    {authority !== 'ready' ? <p role="alert">Native authority is resynchronizing.</p> : null}
    {busy ? <p role="status">Working…</p> : null}
    {error ? <p role="alert">{updateActionErrorText(error)} ({error})</p> : null}
    {installNote ? <p role="status" data-testid="update-install-note">
      {updateActionErrorText(installNote)} (nnd_update_install_unsupported)</p> : null}
    <CheckView check={check} install={install} disabled={busy} />
  </SettingsSection>;
}

function CheckView({ check, install, disabled }: {
  check: UpdateCheckReceipt | null; install: () => void; disabled: boolean }): ReactNode {
  if (!check) return <ul className="text-xs" data-testid="update-check-view">
    <li>waiting for the forced check receipt…</li></ul>;
  const availability = check.availability;
  return <ul className="text-xs" data-testid="update-check-view">
    <li>status {availability.status} · current {availability.currentVersion}
      {availability.available ? ` · update available ${availability.latestVersion}` : ''}
      {availability.errorCode ? ` · ${availability.errorCode}` : ''}</li>
    <li>checked {availability.checkedAt} · recorded receipt {check.operationId.slice(0, 13)}…</li>
    <li><button type="button" className={BUTTON} disabled={disabled} data-testid="update-install"
      onClick={install}>Install available update…</button>
      <span className="pl-2">the runtime refuses this honestly and the refusal is the receipt</span></li>
  </ul>;
}

async function runOnce(auth: string, active: React.RefObject<AbortController | null>,
  setBusy: (busy: boolean) => void, setError: (message: string | null) => void,
  work: (signal: AbortSignal) => Promise<void>): Promise<void> {
  if (active.current || auth !== 'ok' || authorityState() !== 'ready') return;
  const controller = new AbortController(); active.current = controller;
  const runtime = getRuntimeKey(), origin = getApiBaseUrl();
  const current = () => active.current === controller && !controller.signal.aborted
    && runtime === getRuntimeKey() && origin === getApiBaseUrl() && authorityState() === 'ready';
  setBusy(true); setError(null);
  try { await work(controller.signal); if (!current()) return; setError(null); }
  catch (failure) { if (current()) setError(safeError(failure)); }
  finally { if (current()) setBusy(false); if (active.current === controller) active.current = null; }
}

/** Runtime switches and unmount reset the panel; each connected endpoint
 * triggers one fresh check. */
function mountPanel(reset: () => void, load: () => void): () => void {
  reset(); load();
  const off = onRuntimeEndpointChanged(() => { reset(); load(); });
  return () => { off(); reset(); };
}

/** While native authority resynchronizes, in-flight work pauses honestly; once
 * ready, a missing receipt triggers one fresh read. */
function syncWatch(authority: string, auth: string, hasView: boolean,
  active: React.RefObject<AbortController | null>, setBusy: (busy: boolean) => void,
  load: () => void): void {
  if (authority !== 'ready') { active.current?.abort(); active.current = null; setBusy(false); }
  else if (!hasView && auth === 'ok') load();
}
