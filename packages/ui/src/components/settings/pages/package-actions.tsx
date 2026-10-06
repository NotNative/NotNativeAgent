// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { getRuntimeKey, onRuntimeEndpointChanged } from '../../../lib/runtime-switch.ts';
import { getApiBaseUrl } from '../../../lib/runtime-url.ts';
import { readPackageStatus, activatePackageRoot, deactivatePackageRoot,
  NativePackageActionFailure, packageActionErrorText, type PackageActionReceipt } from '../../../lib/nnd/package-actions.ts';
import { authorityState, subscribeAuthority } from '../../../sync/authority-sync.ts';
import { useAuthSessionStore } from '../../../lib/runtime-auth-expiry.ts';
import { SettingsGroupTitle, SettingsSection } from '../primitives.tsx';

const FIELD = 'rounded border border-border px-2 py-1 text-xs';
const BUTTON = 'rounded border border-border px-2 py-1 text-xs disabled:opacity-50';
const safeError = (failure: unknown) => failure instanceof NativePackageActionFailure
  ? failure.code : 'nnd_package_action_unavailable';
const BOUND_NOTE = 'The runtime reuses the package CLI\'s registry authority (validation,'
  + ' the manifest transaction, and the root-mismatch lockstep); the registry carries'
  + ' root, version, and protocol only.';

export function PackageActionsPanel(): ReactNode {
  const auth = useAuthSessionStore(state => state.status);
  const authority = useSyncExternalStore(subscribeAuthority, authorityState);
  const [status, setStatus] = useState<PackageActionReceipt | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [root, setRoot] = useState('');
  const active = useRef<AbortController | null>(null);
  const resetView = useCallback(() => { active.current?.abort(); active.current = null;
    setStatus(null); setReceipt(null); setError(null); setBusy(false); }, []);
  const load = useCallback(() => runOnce(auth, active, setBusy, setError, async (signal) => {
    setStatus(await readPackageStatus(signal)); setError(null);
  }), [auth]);
  const act = useCallback((label: string, work: (signal: AbortSignal) => Promise<void>) =>
    runOnce(auth, active, setBusy, setError, async (signal) => {
      await work(signal); setReceipt(label);
    }), [auth]);
  useEffect(() => mountPanel(resetView, load), [resetView, load]);
  useEffect(() => syncWatch(authority, auth, status !== null, active, setBusy, load),
    [authority, auth, status, load]);
  return <SettingsSection item="native-package-actions.settings">
    <div className="flex items-center justify-between gap-3">
      <SettingsGroupTitle>NND package actions</SettingsGroupTitle>
      <button type="button" className={BUTTON} onClick={load}
        disabled={busy || auth !== 'ok' || authority !== 'ready'}>Refresh</button>
    </div>
    <p className="text-xs">The installed package registry behind this desktop app.
      {BOUND_NOTE}</p>
    {auth !== 'ok' ? <p role="alert">Sign in to operate the native package actions.</p> : null}
    {authority !== 'ready' ? <p role="alert">Native authority is resynchronizing.</p> : null}
    {busy ? <p role="status">Working…</p> : null}
    {error ? <p role="alert">{packageActionErrorText(error)} ({error})</p> : null}
    {receipt ? <p role="status" data-testid="package-receipt">{receipt}</p> : null}
    <StatusView status={status} act={act} load={load} root={root} setRoot={setRoot} disabled={busy} />
  </SettingsSection>;
}

function StatusView({ status, act, load, root, setRoot, disabled }: {
  status: PackageActionReceipt | null; act: (label: string,
    work: (signal: AbortSignal) => Promise<void>) => void; load: () => void;
  root: string; setRoot: (next: string) => void; disabled: boolean }): ReactNode {
  if (!status) return <ul className="text-xs" data-testid="package-view">
    <li>waiting for the registry observation…</li></ul>;
  const record = status.package;
  return <ul className="text-xs" data-testid="package-view">
    <li>{record.registered
      ? `registered root ${record.root} · version ${record.version} · ${record.valid ? 'valid' : `invalid (${record.reason})`}`
      : 'no NND package is registered natively'}</li>
    <li>
      <input className={FIELD} placeholder="absolute package root" value={root}
        onChange={event => setRoot(event.target.value)} />
      <button type="button" className={BUTTON} disabled={disabled || !root.trim()}
        data-testid="package-activate" onClick={() => act(`activated ${root.trim()}`,
          async (signal) => { await activatePackageRoot(root.trim(), signal); load(); })}>
        Activate…</button>
      <button type="button" className={BUTTON} disabled={disabled || !root.trim()}
        data-testid="package-deactivate" onClick={() => act(`deactivated ${root.trim()}`,
          async (signal) => { await deactivatePackageRoot(root.trim(), signal); load(); })}>
        Deactivate…</button>
    </li>
    <li>activation validates the package through the CLI's own validator, so a
      mismatched root is refused and shown verbatim</li>
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
 * triggers one fresh observation. */
function mountPanel(reset: () => void, load: () => void): () => void {
  reset(); load();
  const off = onRuntimeEndpointChanged(() => { reset(); load(); });
  return () => { off(); reset(); };
}

/** While native authority resynchronizes, in-flight work pauses honestly; once
 * ready, a missing view triggers one fresh read. */
function syncWatch(authority: string, auth: string, hasView: boolean,
  active: React.RefObject<AbortController | null>, setBusy: (busy: boolean) => void,
  load: () => void): void {
  if (authority !== 'ready') { active.current?.abort(); active.current = null; setBusy(false); }
  else if (!hasView && auth === 'ok') load();
}
