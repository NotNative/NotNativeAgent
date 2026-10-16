// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState } from 'react';
import { grantNativeWorkspaceTrust, revokeNativeWorkspaceTrust, readNativeTrustList, readNativeTrustCatalog,
  isValidTrustWorkspaceDraft, trustMessages, NativeTrustFailure, type NativeTrustReceipt } from '../../../lib/nnd/trust.ts';
import { useAuthSessionStore } from '../../../lib/runtime-auth-expiry.ts';
import { authorityState } from '../../../sync/authority-sync.ts';
import { useSettingsEdit, useSettingsLeave } from '../edit-boundary.tsx';
import { SettingsSection } from '../primitives.tsx';
import { useNativeObservation, nativeObservationScope } from './use-native-observation.ts';

async function readTrust(signal: AbortSignal) {
  const [view] = await Promise.all([readNativeTrustList(signal), readNativeTrustCatalog(signal)]); return view;
}
export function TrustWorkspaces() {
  const state = useNativeObservation(readTrust), leave = useSettingsLeave(), scope = nativeObservationScope();
  const [draft, setDraft] = useState(''), [query, setQuery] = useState(''), [limit, setLimit] = useState(30);
  const [review, setReview] = useState<{ operation: 'grant' | 'revoke'; root: string } | null>(null);
  const [receipt, setReceipt] = useState<NativeTrustReceipt | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const active = useRef<AbortController | null>(null);
  useSettingsEdit('Workspace trust', Boolean(draft || review), busy);
  useEffect(() => { setDraft(''); setReview(null); setReceipt(null); setError(''); setBusy(false);
    return () => { active.current?.abort(); active.current = null; }; }, [scope, state.ready]);
  const confirm = async () => {
    if (!review || !state.data || !state.ready || busy || active.current) return;
    const controller = new AbortController(); active.current = controller;
    const current = () => active.current === controller && !controller.signal.aborted && scope === nativeObservationScope()
      && useAuthSessionStore.getState().status === 'ok' && authorityState() === 'ready';
    setBusy(true); setError(''); setReceipt(null);
    try {
      const result = await (review.operation === 'grant' ? grantNativeWorkspaceTrust : revokeNativeWorkspaceTrust)(review.root, controller.signal);
      if (!current()) return;
      if (result.installation_id !== state.data.installation_id || result.data_id !== state.data.data_id) throw new Error('identity_mismatch');
      setReceipt(result); setReview(null); setDraft(''); await state.reload();
    } catch (failure) { if (current()) setError(failure instanceof NativeTrustFailure ? trustMessages[failure.code] ?? failure.code
      : 'NNA did not confirm this operation. Refresh and inspect trust before retrying.'); }
    finally { if (current()) { active.current = null; setBusy(false); } }
  };
  const disabled = busy || state.busy || !state.ready || !state.data || Boolean(state.error);
  const searchablePath = (path: string) => path.replaceAll('\\', '/').toLowerCase();
  const rows = state.data?.workspaces.filter(row => searchablePath(row.root).includes(searchablePath(query))) ?? [];
  return <SettingsSection item="trust-workspaces.grants" title="Workspace trust">
    <p>Trusted roots can contribute project configuration and skills. Adding a folder to the sidebar does not trust it.
      Grants admit project configuration and skills; they do not bypass mandatory review. Existing engines may retain initialized configuration.</p>
    <button type="button" disabled={busy || state.busy || !state.ready} onClick={() => { void state.reload(); }}>Refresh trust</button>
    {state.busy || busy ? <p role="status">Waiting for NNA…</p> : null}
    {state.error || error ? <p role="alert" data-testid="trust-error">{error || trustMessages[state.error ?? ''] || state.error}</p> : null}
    {!state.ready ? <p role="alert">Sign in to read and change workspace trust.</p> : null}
    {receipt ? <p role="status" data-testid="trust-receipt">{receipt.operation === 'grant' ? 'Granted' : 'Revoked'} <span data-testid="trust-receipt-root">{receipt.root}</span>. Native acknowledgement received.</p> : null}
    <label className="my-3 block">Filter trusted roots <input aria-label="Filter trusted roots" maxLength={256} value={query} onChange={event => { setQuery(event.target.value); setLimit(30); }} /></label>
    <ul className="space-y-2" data-testid="trust-list">{rows.slice(0, limit).map(row => <li key={row.root} data-testid="trust-row" className="rounded border border-border p-3">
      <span className="break-all" data-testid="trust-row-root">{row.root}</span><p>trusted {row.trusted_at}</p>
      <button type="button" disabled={disabled} data-testid="trust-revoke" onClick={() => leave(() => setReview({ operation: 'revoke', root: row.root }))}>Revoke</button></li>)}</ul>
    {state.data && !rows.length ? <p data-testid="trust-empty">{query ? 'No matching trusted roots.' : 'No trusted workspaces recorded.'}</p> : null}
    {rows.length > limit ? <button type="button" onClick={() => setLimit(value => value + 30)}>Show more roots</button> : null}
    <label className="my-3 block">Workspace path to trust <input aria-label="Workspace path to trust" data-testid="trust-draft" maxLength={32767} value={draft} disabled={busy}
      onChange={event => { setDraft(event.target.value); setReview(null); }} /></label>
    <button type="button" disabled={disabled || !isValidTrustWorkspaceDraft(draft)} data-testid="trust-grant" onClick={() => setReview({ operation: 'grant', root: draft })}>Review grant</button>
    {review ? <fieldset disabled={busy} className="my-3 rounded border border-primary p-3" aria-label="Review workspace trust">
      <p>{review.operation === 'grant' ? 'Admit project configuration and skills from this existing root?' : 'Revoke future project configuration and skill admission from this root?'} <span className="break-all">{review.root}</span></p>
      <p>NNA resolves the canonical directory. Revocation does not undo completed work or terminate existing engines.</p>
      <button type="button" onClick={() => { void confirm(); }}>{review.operation === 'grant' ? 'Confirm grant' : 'Confirm revoke'}</button>
      <button type="button" onClick={() => { setReview(null); setDraft(''); }}>Cancel trust change</button>
    </fieldset> : null}
  </SettingsSection>;
}
