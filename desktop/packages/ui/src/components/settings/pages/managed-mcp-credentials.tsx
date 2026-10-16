// SPDX-License-Identifier: Apache-2.0
import { useSettingsEdit, useSettingsLeave } from '../edit-boundary.tsx';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { getRuntimeKey, onRuntimeEndpointChanged } from '../../../lib/runtime-switch.ts';
import { getApiBaseUrl } from '../../../lib/runtime-url.ts';
import { useAuthSessionStore } from '../../../lib/runtime-auth-expiry.ts';
import { newNativeOperationId } from '../../../lib/nnd/configuration-mutation.ts';
import { isValidManagedServerIdDraft, isValidManagedTokenDraft,
  readNativeMcpCredentialCatalog, readNativeMcpCredentialList, saveNativeMcpCredential,
  deleteNativeMcpCredential, NativeMcpCredentialsFailure, type NativeMcpCredentialList,
  type NativeMcpCredentialReceipt } from '../../../lib/nnd/mcp-credentials.ts';
import { clearNativeMcpCredentialOperation, pendingNativeMcpCredentialOperation,
  reserveNativeMcpCredentialOperation, type PendingNativeMcpCredentialOperation }
  from '../../../lib/nnd/mcp-credentials-pending.ts';
import { authorityState, subscribeAuthority } from '../../../sync/authority-sync.ts';
import { SettingsGroupTitle, SettingsSection } from '../primitives.tsx';

const INPUT = 'w-64 rounded border border-border bg-background px-2 py-1 text-xs';
const BUTTON = 'rounded border border-border px-2 py-1 text-xs disabled:opacity-50';
const safeError = (error: unknown) => error instanceof NativeMcpCredentialsFailure ? error.code : 'nnd_mcp_credentials_unavailable';
const safePrecommit = new Set(['nnd_mcp_credentials_request_invalid', 'mcp_token_invalid',
  'mcp_credentials_invalid', 'mcp_credentials_busy', 'mcp_credentials_full',
  'integration_permission_denied', 'nnd_configuration_unavailable']);
type StagedSave = { server_id: string; token: string };
type StagedDelete = { reference: string };

export function ManagedMcpCredentialsSettings(): ReactNode {
  const leave = useSettingsLeave();
  const auth = useAuthSessionStore(state => state.status);
  const authority = useSyncExternalStore(subscribeAuthority, authorityState);
  const [view, setView] = useState<NativeMcpCredentialList | null>(null);
  const [draft, setDraft] = useState<StagedSave | null>(null);
  const [deleteDraft, setDeleteDraft] = useState<StagedDelete | null>(null);
  const [receipt, setReceipt] = useState<NativeMcpCredentialReceipt | null>(null);
  const [pending, setPending] = useState<PendingNativeMcpCredentialOperation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [inputDirty, setInputDirty] = useState(false);
  useSettingsEdit('MCP credential editor', inputDirty || Boolean(draft || deleteDraft), Boolean(pending));
  const active = useRef<AbortController | null>(null);
  const pendingRef = useRef<PendingNativeMcpCredentialOperation | null>(null);
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
  const reload = async (signal: AbortSignal, current: () => boolean) => {
    const [next] = await Promise.all([readNativeMcpCredentialList(signal), readNativeMcpCredentialCatalog(signal)]);
    if (!current()) return null;
    setView(next); setDraft(null); setDeleteDraft(null); setReceipt(null); setInputDirty(false);
    if (mcpServerText.current) mcpServerText.current.value = '';
    if (mcpTokenText.current) mcpTokenText.current.value = '';
    pendingRef.current = pendingNativeMcpCredentialOperation(next);
    if (pendingRef.current !== null && pendingRef.current.reference !== undefined
      && !next.credentials.some(item => item.reference === pendingRef.current?.reference)) {
      // A delete that may not have settled is done when the roster no longer lists it.
      clearNativeMcpCredentialOperation(pendingRef.current); pendingRef.current = null;
    }
    setPending(pendingRef.current);
    return next;
  };
  const load = useCallback(() => { run(async (signal, current) => {
    await reload(signal, current);
  }); }, [auth]);
  useEffect(() => {
    const reset = () => { active.current?.abort(); active.current = null; pendingRef.current = null;
      setView(null); setDraft(null); setDeleteDraft(null); setReceipt(null); setPending(null); setError(null); setBusy(false); };
    reset(); load();
    const off = onRuntimeEndpointChanged(() => { reset(); load(); });
    return () => { off(); active.current?.abort(); active.current = null; };
  }, [load]);
  useEffect(() => {
    if (authority !== 'ready') { active.current?.abort(); active.current = null; setBusy(false); }
    else if (!view && auth === 'ok') load();
  }, [authority]);
  const stageSave = () => { if (!view) return;
    setDraft({ server_id: mcpServerText.current?.value ?? '', token: mcpTokenText.current?.value ?? '' });
    if (mcpTokenText.current) mcpTokenText.current.value = ''; };
  const save = () => { if (!view || !draft || pendingRef.current || active.current) return;
    let operationId: string;
    try { operationId = newNativeOperationId(); } catch (failure) { setError(safeError(failure)); return; }
    const entry = reserveNativeMcpCredentialOperation(view, operationId);
    if (!entry) { setError('nnd_mcp_credentials_unavailable'); return; }
    pendingRef.current = entry; setPending(entry);
    const staged = draft; setDraft(null);
    run(async (signal, current) => { try {
      const result = await saveNativeMcpCredential({ list: view, server_id: staged.server_id,
        token: staged.token, operation_id: operationId }, signal);
      if (!current()) return;
      if (result.persistence === 'saved') { clearNativeMcpCredentialOperation(entry); pendingRef.current = null; }
      setPending(pendingRef.current);
      const next = await reload(signal, current);
      if (current() && next !== null) setReceipt(result);
    } catch (failure) {
      if (current() && safePrecommit.has(safeError(failure))) {
        clearNativeMcpCredentialOperation(entry); pendingRef.current = null; setPending(null);
      }
      throw failure;
    } }); };
  const remove = (reference: string) => { if (!view || pendingRef.current || active.current) return;
    setDeleteDraft({ reference });
  };
  const confirmRemove = () => { if (!view || !deleteDraft || pendingRef.current || active.current) return;
    let operationId: string;
    try { operationId = newNativeOperationId(); } catch (failure) { setError(safeError(failure)); return; }
    const entry = reserveNativeMcpCredentialOperation(view, operationId, deleteDraft.reference);
    if (!entry) { setError('nnd_mcp_credentials_unavailable'); return; }
    pendingRef.current = entry; setPending(entry);
    const staged = deleteDraft; setDeleteDraft(null);
    run(async (signal, current) => { try {
      const result = await deleteNativeMcpCredential({ list: view, reference: staged.reference,
        operation_id: operationId }, signal);
      if (!current()) return;
      if (result.persistence !== 'absent') { clearNativeMcpCredentialOperation(entry); pendingRef.current = null; }
      setPending(pendingRef.current);
      const next = await reload(signal, current);
      if (current() && next !== null) setReceipt(result);
    } catch (failure) {
      if (current() && safePrecommit.has(safeError(failure))) {
        clearNativeMcpCredentialOperation(entry); pendingRef.current = null; setPending(null);
      }
      throw failure;
    } }); };
  const discardHandle = () => { const entry = pendingRef.current; if (!entry || active.current) return;
    clearNativeMcpCredentialOperation(entry); pendingRef.current = null; setPending(null); setError(null); };
  const disabled = busy || pending !== null || auth !== 'ok' || authority !== 'ready';
  // The staged values live in uncontrolled inputs and only move into state on stage:
  // a token never round-trips through a render cycle more than once.
  const mcpServerText = useRef<HTMLInputElement | null>(null);
  const mcpTokenText = useRef<HTMLInputElement | null>(null);
  return <SettingsSection item="native-mcp-credentials.settings">
    <div className="flex items-center justify-between gap-3">
      <SettingsGroupTitle>NNA managed MCP credentials</SettingsGroupTitle>
      <button type="button" className={BUTTON} onClick={() => leave(load)} disabled={busy || auth !== 'ok' || authority !== 'ready'}>Refresh</button>
    </div>
    <p className="text-xs">NNA stores MCP server tokens as NNA_MCP_MANAGED_…_TOKEN references and feeds them to the
      engine host's server environments. Values never render here: the list shows references and whether each one is
      already applied. Saving derives the reference from the server id (an idempotent upsert); deleting the same
      reference again is safe even when nothing was stored. Inspecting needs nnd.configuration.read; changes need
      nnd.configuration.manage.</p>
    {auth !== 'ok' ? <p role="alert">Sign in to inspect managed MCP credentials.</p> : null}
    {authority !== 'ready' ? <p role="alert">Native authority is resynchronizing. Editing is paused.</p> : null}
    {busy ? <p role="status">Working…</p> : null}
    {error ? <p role="alert">{errorText(error)} ({error})</p> : null}
    {view ? <>
      <p className="text-xs" data-testid="mcp-status">Selected installation: {view.installation_id} · data:
        {' '}{view.data_id} · store: {view.source_state} · references: {view.count}</p>
      <ul className="text-xs" data-testid="mcp-list">
        {view.credentials.map(item => <li key={item.reference}>
          {item.reference} · {item.applied ? 'applied' : 'stored, not yet applied'} {' '}
          <button type="button" className={BUTTON} onClick={() => remove(item.reference)} disabled={disabled}>Delete</button>
        </li>)}
      </ul>
      <fieldset disabled={disabled} className="space-y-2">
        <div className="text-xs space-y-1">
          <label>Server id <input className={INPUT} data-testid="mcp-server"
            ref={element => { mcpServerText.current = element; }}
            placeholder="filesystem-mcp" onChange={event => { setDraft(null); setInputDirty(Boolean(event.target.value || mcpTokenText.current?.value)); }} /></label>
          {' '}
          <label>Token <input className={INPUT} data-testid="mcp-token" type="password" autoComplete="off"
            ref={element => { mcpTokenText.current = element; }}
            onChange={event => { setDraft(null); setInputDirty(Boolean(event.target.value || mcpServerText.current?.value)); }} /> (at most 16,384 characters, no line breaks)</label>
        </div>
        <button type="button" className={BUTTON} data-testid="mcp-stage-save" onClick={stageSave}
          disabled={disabled}>Stage the credential</button>
      </fieldset>
      {draft ? <div role="status" className="rounded border border-border p-2 text-xs">
        <p data-testid="mcp-stage-content">Stage a credential for server id {draft.server_id}: NNA will upsert a
          reference derived from it. The token stays in this tab until the save posts; it is never shown again.</p>
        <button type="button" className={BUTTON} data-testid="mcp-save" onClick={save} disabled={disabled}>Save credential</button>
        <button type="button" className={BUTTON} onClick={() => { setDraft(null); setInputDirty(false); if (mcpServerText.current) mcpServerText.current.value = ''; }} disabled={disabled}>Discard stage</button>
      </div> : null}
      {deleteDraft ? <div role="status" className="rounded border border-border p-2 text-xs">
        <p data-testid="mcp-stage-delete">Stage the delete of {deleteDraft.reference}. NNA reports 'absent' when
          nothing was stored; a repeat of the same delete stays safe.</p>
        <button type="button" className={BUTTON} data-testid="mcp-delete" onClick={confirmRemove} disabled={disabled}>Delete credential</button>
        <button type="button" className={BUTTON} onClick={() => setDeleteDraft(null)} disabled={disabled}>Discard delete</button>
      </div> : null}
    </> : null}
    {pending ? <div role="status" className="rounded border border-border p-2 text-xs">
      <p>Operation {pending.operation_id} may have an uncertain outcome. The upsert and the delete are idempotent:
        repeating the same action is safe. You can clear this local handle; NNA keeps no ledger for this family.</p>
      <button type="button" className={BUTTON} onClick={discardHandle} disabled={busy || auth !== 'ok' || authority !== 'ready'}>Clear local handle</button>
    </div> : null}
    {receipt ? <p role="status" className="text-xs">Operation {receipt.operation_id}: {receipt.persistence}
      {receipt.persistence === 'saved' ? '; the reference is ' + receipt.reference : ''}. The engine host applies
      saved references at the next server spawn.</p> : null}
  </SettingsSection>;
}

function errorText(code: string): string {
  if (code === 'nnd_mcp_credentials_request_invalid') return 'The composed change is outside the bounded grammar: server ids stay printable, within 128 characters, tokens 1–16,384, and an operation id is required.';
  if (code === 'nnd_mcp_credentials_view_invalid') return 'NNA served a managed-credential shape this build refuses. Update NNA and this NND together before retrying.';
  if (code === 'nnd_mcp_credentials_unsupported') return 'This NNA does not expose native managed MCP credentials.';
  if (code === 'mcp_token_invalid') return 'The token value is invalid (1–16,384 characters, no line breaks or NUL).';
  if (code === 'mcp_credentials_invalid') return 'The managed credentials store needs native repair before it can be changed here.';
  if (code === 'mcp_credentials_busy') return 'NNA is already writing the credentials store. Wait a moment and retry.';
  if (code === 'mcp_credentials_full') return 'NNA reached its 256-reference limit. Delete a credential before saving another.';
  if (code === 'integration_permission_denied') return 'Native permission denied.';
  return 'Managed MCP credentials could not be read or changed.';
}
