// SPDX-License-Identifier: Apache-2.0
import { useSettingsEdit, useSettingsLeave } from '../edit-boundary.tsx';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { getRuntimeKey, onRuntimeEndpointChanged } from '../../../lib/runtime-switch.ts';
import { getApiBaseUrl } from '../../../lib/runtime-url.ts';
import { useAuthSessionStore } from '../../../lib/runtime-auth-expiry.ts';
import { newNativeOperationId } from '../../../lib/nnd/configuration-mutation.ts';
import { clearNativeGatewayOperation, pendingNativeGatewayOperation, reserveNativeGatewayOperation,
  type PendingNativeGatewayOperation } from '../../../lib/nnd/native-gateway-pending.ts';
import { inspectNativeGatewayOperation, nativeGatewayOperations, nativeGatewayRequest, previewNativeGateway,
  readNativeGateway, readNativeGatewayCatalog, saveNativeGateway, NativeGatewayFailure, type NativeGatewayOperation,
  type NativeGatewayReceipt, type NativeGatewayView } from '../../../lib/nnd/native-gateway.ts';
import { authorityState, subscribeAuthority } from '../../../sync/authority-sync.ts';
import { SettingsGroupTitle, SettingsSection } from '../primitives.tsx';

const INPUT = 'w-24 rounded border border-border bg-background px-2 py-1 text-xs';
const WIDE_INPUT = 'w-64 rounded border border-border bg-background px-2 py-1 text-xs';
const BUTTON = 'rounded border border-border px-2 py-1 text-xs disabled:opacity-50';
const safeError = (error: unknown) => error instanceof NativeGatewayFailure ? error.code : 'nnd_gateway_timeout_unavailable';
const safePrecommit = new Set(['nnd_gateway_timeout_request_invalid', 'manifest_revision_conflict',
  'integration_permission_denied', 'nnd_gateway_timeout_source_missing', 'nnd_gateway_timeout_source_invalid']);
const validTimeoutDraft = (value: string) => /^(?:[5-9]|[1-4][0-9]|50)$/u.test(value);
const validUserDraft = (value: string) => /^[1-9][0-9]{0,19}$/u.test(value);
const MAX_OPERATIONS = 16;
type PendingPreview = { request: ReturnType<typeof nativeGatewayRequest>; view: NativeGatewayView };
type GatewayDraft = { enabled: boolean; token_env: string; workspace_root: string; polling_timeout_seconds: string;
  clear_token: boolean; token_value: string; user_add: string; user_ids: string[] };

function composeOperations(view: NativeGatewayView, draft: GatewayDraft): NativeGatewayOperation[] {
  const operations: NativeGatewayOperation[] = [];
  if (draft.enabled !== view.enabled) operations.push({ op: 'set', field: 'enabled', value: draft.enabled });
  if (draft.token_env === '') {
    if (view.token_env !== 'NNA_TELEGRAM_BOT_TOKEN') operations.push({ op: 'reset', field: 'token_env' });
  } else if (draft.token_env !== view.token_env) operations.push({ op: 'set', field: 'token_env', value: draft.token_env });
  if (draft.workspace_root === '') {
    if (view.workspace_root !== null) operations.push({ op: 'reset', field: 'workspace_root' });
  } else if (draft.workspace_root !== view.workspace_root) operations.push({ op: 'set', field: 'workspace_root', value: draft.workspace_root });
  if (validTimeoutDraft(draft.polling_timeout_seconds)
    && Number(draft.polling_timeout_seconds) !== view.polling_timeout_seconds) {
    operations.push({ op: 'set', field: 'polling_timeout_seconds', value: Number(draft.polling_timeout_seconds) });
  }
  if (draft.token_value !== '') operations.push({ op: 'set_token', token: draft.token_value });
  else if (draft.clear_token && view.token_present) operations.push({ op: 'clear_token' });
  const removed = view.authorized_user_ids.filter(id => !draft.user_ids.includes(id));
  const added = draft.user_ids.filter(id => !view.authorized_user_ids.includes(id));
  for (const user_id of added) operations.push({ op: 'authorize', user_id });
  for (const user_id of removed) operations.push({ op: 'revoke', user_id });
  return operations;
}

export function NativeGatewayTimeout(): ReactNode {
  const auth = useAuthSessionStore(state => state.status);
  const leave = useSettingsLeave();
  const authority = useSyncExternalStore(subscribeAuthority, authorityState);
  const [view, setView] = useState<NativeGatewayView | null>(null);
  const [draft, setDraft] = useState<GatewayDraft | null>(null);
  const [preview, setPreview] = useState<PendingPreview | null>(null);
  const [receipt, setReceipt] = useState<NativeGatewayReceipt | null>(null);
  const [pending, setPending] = useState<PendingNativeGatewayOperation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const active = useRef<AbortController | null>(null);
  const pendingRef = useRef<PendingNativeGatewayOperation | null>(null);
  useSettingsEdit('Telegram gateway', Boolean(view && draft && receipt?.persistence !== 'saved' &&
    (composeOperations(view, draft).length || draft.user_add || !validTimeoutDraft(draft.polling_timeout_seconds))), Boolean(pending && (!receipt || receipt.persistence === 'unknown')));
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
  const load = useCallback(() => { run(async (signal, current) => {
    const [next] = await Promise.all([readNativeGateway(signal), readNativeGatewayCatalog(signal)]);
    if (!current()) return;
    setView(next); setDraft({ enabled: next.enabled, token_env: next.token_env,
      workspace_root: next.workspace_root ?? '', polling_timeout_seconds: String(next.polling_timeout_seconds),
      clear_token: false, token_value: '', user_add: '', user_ids: [...next.authorized_user_ids] });
    setPreview(null); setReceipt(null);
    pendingRef.current = pendingNativeGatewayOperation(next); setPending(pendingRef.current);
  }); }, [auth]);
  useEffect(() => {
    const reset = () => { active.current?.abort(); active.current = null; pendingRef.current = null;
      setView(null); setDraft(null); setPreview(null); setReceipt(null); setPending(null); setError(null); setBusy(false); };
    reset(); load();
    const off = onRuntimeEndpointChanged(() => { reset(); load(); });
    return () => { off(); active.current?.abort(); active.current = null; };
  }, [load]);
  useEffect(() => {
    if (authority !== 'ready') { active.current?.abort(); active.current = null; setBusy(false); setPreview(null); }
    else if (!view && auth === 'ok') load();
  }, [authority]);
  const patchDraft = (part: Partial<GatewayDraft>) => { setDraft(previous => previous ? { ...previous, ...part } : previous);
    setPreview(null); setReceipt(null); };
  const doPreview = () => { if (!view || !draft || pendingRef.current) return;
    let request: PendingPreview['request'];
    try {
      const operations = nativeGatewayOperations(composeOperations(view, draft));
      if (operations.length < 1) { setError('nothing_to_save'); return; }
      if (operations.length > MAX_OPERATIONS) { setError('nnd_gateway_timeout_request_invalid'); return; }
      request = nativeGatewayRequest(view, operations);
    } catch (failure) { setError(safeError(failure)); return; }
    run(async (signal, current) => {
      const result = await previewNativeGateway(request, view, signal);
      if (current()) setPreview({ request, view: result });
    }); };
  const save = () => { if (!view || !preview || pendingRef.current || active.current || auth !== 'ok' || authority !== 'ready') return;
    let operationId: string;
    try { operationId = newNativeOperationId(); } catch (failure) { setError(safeError(failure)); return; }
    const entry = reserveNativeGatewayOperation(view, operationId, preview.request.expected_revision);
    if (!entry) { setError('nnd_gateway_timeout_unavailable'); return; }
    pendingRef.current = entry; setPending(entry);
    run(async (signal, current) => { try {
      const result = await saveNativeGateway(preview.request, operationId, signal);
      if (!current()) return;
      if (result.persistence === 'saved' || result.persistence === 'unpublished') {
        clearNativeGatewayOperation(entry); pendingRef.current = null; setPending(null);
      }
      setReceipt(result); setPreview(null); setView(null); setDraft(null);
    } catch (failure) {
      if (current()) setPreview(null);
      if (current() && safePrecommit.has(safeError(failure))) {
        clearNativeGatewayOperation(entry); pendingRef.current = null; setPending(null);
      }
      throw failure;
    } }); };
  const inspect = () => { const entry = pendingRef.current; if (!entry) return;
    run(async (signal, current) => {
      const result = await inspectNativeGatewayOperation(entry, entry.operation_id, signal);
      if (!current()) return;
      if (result && result.before_revision !== entry.expected_revision) throw new NativeGatewayFailure('nnd_gateway_timeout_view_invalid');
      if (result?.persistence === 'saved' || result?.persistence === 'unpublished') {
        clearNativeGatewayOperation(entry); pendingRef.current = null; setPending(null); setView(null); setDraft(null);
      }
      if (result) setReceipt(result); else setError('operation_not_found');
    }); };
  const discardExpiredHandle = () => {
    const entry = pendingRef.current;
    if (!entry || error !== 'operation_not_found' || active.current) return;
    clearNativeGatewayOperation(entry); pendingRef.current = null; setPending(null);
    setView(null); setDraft(null); setPreview(null); setReceipt(null); setError(null);
  };
  const disabled = busy || pending !== null || auth !== 'ok' || authority !== 'ready';
  return <SettingsSection item="native-gateway.timeout">
    <div className="flex items-center justify-between gap-3">
      <SettingsGroupTitle>NNA gateway settings</SettingsGroupTitle>
      <button type="button" className={BUTTON} onClick={() => leave(load)} disabled={busy || auth !== 'ok' || authority !== 'ready'}>Refresh</button>
    </div>
    <p className="text-xs">Edit the enabled flag, Telegram token, token environment name, workspace root, polling
      bounds, and the authorized user allowlist of the selected NNA installation in one checked change. Saved
      values require a gateway restart and do not affect a running gateway. The token value is never displayed.</p>
    {auth !== 'ok' ? <p role="alert">Sign in to inspect gateway settings.</p> : null}
    {authority !== 'ready' ? <p role="alert">Native authority is resynchronizing. Editing is paused.</p> : null}
    {busy ? <p role="status">Working…</p> : null}
    {error ? <p role="alert">{errorText(error)} ({error})</p> : null}
    {view && draft ? <>
      <p className="text-xs">Selected installation: {view.installation_id} · data: {view.data_id} · revision: {view.source_revision.slice(0, 12)}</p>
      <p className="text-xs">Gateway is {view.enabled ? 'enabled' : 'disabled'} · token present: {view.token_present ? 'yes' : 'no'} ·
        saved polling timeout: {view.polling_timeout_seconds} seconds · authorized users: {view.authorized_user_ids.join(', ') || 'none'}
        · last saved: {view.updated_at ?? 'not recorded'}</p>
      <fieldset disabled={disabled} className="space-y-2">
        <label className="block text-xs">Enabled <input type="checkbox" checked={draft.enabled}
          onChange={event => patchDraft({ enabled: event.target.checked })} /></label>
        <label className="block text-xs">Replace token (20–512 characters, blank keeps the current token)
          <input className={WIDE_INPUT} type="password" data-testid="gateway-token-value" value={draft.token_value}
            onChange={event => patchDraft({ token_value: event.target.value, clear_token: false })} /></label>
        <label className="block text-xs">Clear token <input type="checkbox" checked={draft.clear_token}
          onChange={event => patchDraft({ clear_token: event.target.checked, token_value: '' })} /></label>
        <label className="block text-xs">Token environment variable (blank resets to NNA_TELEGRAM_BOT_TOKEN)
          <input className={WIDE_INPUT} data-testid="gateway-token-env" value={draft.token_env}
            onChange={event => patchDraft({ token_env: event.target.value })} /></label>
        <label className="block text-xs">Workspace root (blank resets to none)
          <input className={WIDE_INPUT} data-testid="gateway-workspace-root" value={draft.workspace_root}
            onChange={event => patchDraft({ workspace_root: event.target.value })} /></label>
        <label className="block text-xs">Polling timeout (seconds, 5–50) <input className={INPUT} type="number" min="5" max="50" step="1"
          value={draft.polling_timeout_seconds}
          onChange={event => patchDraft({ polling_timeout_seconds: event.target.value })} /></label>
        <div className="text-xs">
          Authorized numeric user ids:
          <ul className="ml-3 list-disc">{draft.user_ids.map(id => <li key={id}>{id}
            <button type="button" className={BUTTON} disabled={disabled}
              onClick={() => patchDraft({ user_ids: draft.user_ids.filter(item => item !== id) })}>Remove</button></li>)}
          </ul>
          <label>Add user id <input className={INPUT} data-testid="gateway-user-add" value={draft.user_add}
            onChange={event => patchDraft({ user_add: event.target.value })} /></label>
          <button type="button" className={BUTTON} disabled={disabled || !validUserDraft(draft.user_add)}
            onClick={() => { patchDraft({ ...draft, user_add: '', user_ids: draft.user_add && !draft.user_ids.includes(draft.user_add)
              ? [...draft.user_ids, draft.user_add] : draft.user_ids }); }}>Add</button>
        </div>
      </fieldset>
      <button type="button" className={BUTTON} onClick={doPreview} disabled={disabled}>Preview native change</button>
    </> : null}
    {preview ? <div role="status" className="rounded border border-border p-2 text-xs">
      <p>NNA preview: the saved settings would become enabled: {String(preview.view.enabled)}, token present:
        {' '}{String(preview.view.token_present)}, token env: {preview.view.token_env}, workspace:
        {' '}{preview.view.workspace_root ?? 'none'}, polling: {preview.view.polling_timeout_seconds} seconds, users:
        {' '}{preview.view.authorized_user_ids.join(', ') || 'none'}. No change has been saved or applied.</p>
      <button type="button" className={BUTTON} onClick={save} disabled={disabled}>Save with native revision check</button>
    </div> : null}
    {pending ? <div role="status" className="rounded border border-border p-2 text-xs">
      <p>Operation {pending.operation_id} may have an uncertain outcome. Inspect the native receipt before another change.</p>
      <button type="button" className={BUTTON} onClick={inspect} disabled={busy || auth !== 'ok' || authority !== 'ready'}>Inspect operation</button>
      {error === 'operation_not_found' ? <button type="button" className={BUTTON} onClick={discardExpiredHandle}
        disabled={busy || auth !== 'ok' || authority !== 'ready'}>Clear expired local handle</button> : null}
    </div> : null}
    {receipt ? <p role="status" className="text-xs">Operation {receipt.operation_id}: {receipt.persistence}.
      {receipt.persistence === 'saved' ? ' Saved in NNA; restart the gateway to apply it.'
        : receipt.persistence === 'unpublished' ? ' The write was not published. Refresh before trying again.'
          : ' The write is not confirmed. Inspect this operation before retrying.'}</p> : null}
  </SettingsSection>;
}

function errorText(code: string): string {
  if (code === 'manifest_revision_conflict') return 'Gateway settings changed. Refresh and preview again.';
  if (code === 'integration_permission_denied') return 'Native permission denied.';
  if (code === 'operation_not_found') return 'No retained receipt was found. Clear the expired local handle, refresh native settings, and preview before another save.';
  if (code === 'nothing_to_save') return 'No settings differ from the saved values.';
  if (code === 'nnd_gateway_timeout_request_invalid') return 'A composed change is outside the bounded settings grammar. Reduce the batch to at most 16 valid operations.';
  if (code === 'nnd_gateway_timeout_source_missing' || code === 'nnd_gateway_timeout_source_invalid') {
    return 'Gateway settings need native setup or repair before the gateway can be configured here.';
  }
  if (code === 'nnd_gateway_timeout_unsupported') return 'This NNA does not expose native gateway settings.';
  return 'Gateway settings could not be read or changed.';
}
