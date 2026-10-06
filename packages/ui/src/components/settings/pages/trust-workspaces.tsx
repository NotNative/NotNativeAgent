// SPDX-License-Identifier: Apache-2.0
/** Trusted workspaces section (authority grants).
 * Why: the census classifies the three trust rows as the canonical workspace grants
 * governing project configuration and skills admission; the settings GUI grants and
 * revokes THROUGH the native trust functions, so canonicalization and admission
 * semantics stay native, and receipts show the canonical root the grant recorded.
 * Invariant: only existing roots can be granted (the native admission check refuses
 * a missing target), a corrupt or unreadable store is surfaced honestly (it never
 * claims which roots are trusted), and a revoke is always receivable (a gone root is
 * an honest no-op).
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { getRuntimeKey, onRuntimeEndpointChanged } from '../../../lib/runtime-switch.ts';
import { getApiBaseUrl } from '../../../lib/runtime-url.ts';
import { useAuthSessionStore } from '../../../lib/runtime-auth-expiry.ts';
import { grantNativeWorkspaceTrust, isValidTrustWorkspaceDraft, readNativeTrustList,
  readNativeTrustCatalog, revokeNativeWorkspaceTrust, trustMessages, NativeTrustFailure,
  type NativeTrustListView, type NativeTrustReceipt } from '../../../lib/nnd/trust.ts';
import { authorityState, subscribeAuthority } from '../../../sync/authority-sync.ts';
import { SettingsSection } from '../primitives.tsx';

const INPUT = 'w-64 rounded border border-border bg-background px-2 py-1 text-xs';
const BUTTON = 'rounded border border-border px-2 py-1 text-xs disabled:opacity-50';
const safeError = (error: unknown) =>
  error instanceof NativeTrustFailure ? error.code : 'nnd_workspace_trust_unavailable';
const messageFor = (code: string) => trustMessages[code] ?? code;

export function TrustWorkspaces(): ReactNode {
  const auth = useAuthSessionStore(state => state.status);
  const authority = useSyncExternalStore(subscribeAuthority, authorityState);
  const [view, setView] = useState<NativeTrustListView | null>(null);
  const [catalog, setCatalog] = useState<true | null>(null);
  const [receipt, setReceipt] = useState<NativeTrustReceipt | null>(null);
  const [draft, setDraft] = useState('');
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
    void work(controller.signal, current).catch(failure => { if (current()) setError(messageFor(safeError(failure))); })
      .finally(() => { if (current()) setBusy(false); if (active.current === controller) active.current = null; });
  };
  const load = useCallback(() => { run(async (signal, current) => {
    const [next, fields] = await Promise.all([readNativeTrustList(signal), readNativeTrustCatalog(signal)]);
    if (!current()) return;
    setView(next); setCatalog(true); setReceipt(null);
  }); }, [auth]);
  useEffect(() => {
    const reset = () => { active.current?.abort(); active.current = null;
      setView(null); setCatalog(null); setReceipt(null); setError(null); setBusy(false); };
    reset(); load();
    const off = onRuntimeEndpointChanged(() => { reset(); load(); });
    return () => { off(); active.current?.abort(); active.current = null; };
  }, [load]);
  useEffect(() => {
    if (authority !== 'ready') { active.current?.abort(); active.current = null; setBusy(false); setView(null); }
    else if (!view && auth === 'ok') load();
  }, [authority]);
  if (auth !== 'ok' || authority !== 'ready') {
    return <SettingsSection item="trust-workspaces.grants" title="Trusted workspaces">
      <p role="alert">{auth !== 'ok' ? 'Sign in to read and change workspace trust.' :
        'Native authority is resynchronizing; trust reads are paused.'}</p>
    </SettingsSection>;
  }
  const doGrant = () => { if (!isValidTrustWorkspaceDraft(draft)) { setError(messageFor('nnd_trust_request_invalid')); return; }
    run(async (signal, current) => {
      const outcome = await grantNativeWorkspaceTrust(draft, signal);
      if (!current()) return;
      setReceipt(outcome); setDraft('');
      const next = await readNativeTrustList(signal);
      if (current()) setView(next);
    }); };
  const doRevoke = (root: string) => { run(async (signal, current) => {
    const outcome = await revokeNativeWorkspaceTrust(root, signal);
    if (!current()) return;
    setReceipt(outcome);
    const next = await readNativeTrustList(signal);
    if (current()) setView(next);
  }); };
  // Reasons for disabling are local (in flight) only: a failed read leaves the error
  // sentence on display and the server still enforces the honest refusal grants.
  const disabled = busy;
  return (
    <SettingsSection item="trust-workspaces.grants" title="Trusted workspaces">
      <p className="text-xs">Workspace roots trusted by the native service: a trusted root's project
        configuration and skills are admitted. Grants and revokes run through the native trust
        functions, so the receipt may name the CANONICAL root rather than the path typed here.</p>
      {error ? <p role="alert" data-testid="trust-error" className="text-error">{error}</p> : null}
      {receipt ? <p data-testid="trust-receipt">{receipt.operation === 'grant' ? 'Granted' : 'Revoked'}
        {' '}<span data-testid="trust-receipt-root">{receipt.root}</span></p> : null}
      <ul data-testid="trust-list">
        {(view?.workspaces ?? []).map((workspace) => (
          <li key={workspace.root} data-testid="trust-row">
            <span data-testid="trust-row-root">{workspace.root}</span>
            <span className="text-xs"> trusted {workspace.trusted_at}</span>
            <button type="button" className={BUTTON} data-testid="trust-revoke" disabled={disabled}
              onClick={() => doRevoke(workspace.root)}>Revoke</button>
          </li>
        ))}
        {view && view.workspaces.length === 0 ? <li data-testid="trust-empty">No trusted workspaces recorded.</li> : null}
      </ul>
      <div className="flex items-center gap-2">
        <input type="text" className={INPUT} data-testid="trust-draft" placeholder="Workspace path to trust"
          value={draft} onChange={(event) => setDraft(event.target.value)} />
        <button type="button" className={BUTTON} data-testid="trust-grant" disabled={disabled}
          onClick={doGrant}>Grant</button>
      </div>
      <p className="text-xs">Only existing workspace roots can be granted; revoking a removed root is an
        honest no-op receipt.</p>
    </SettingsSection>
  );
}
