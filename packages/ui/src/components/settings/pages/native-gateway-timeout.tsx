// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { getRuntimeKey, onRuntimeEndpointChanged } from '../../../lib/runtime-switch.ts';
import { getApiBaseUrl } from '../../../lib/runtime-url.ts';
import { useAuthSessionStore } from '../../../lib/runtime-auth-expiry.ts';
import { newNativeOperationId } from '../../../lib/nnd/configuration-mutation.ts';
import { clearNativeGatewayOperation, pendingNativeGatewayOperation, reserveNativeGatewayOperation,
  type PendingNativeGatewayOperation } from '../../../lib/nnd/native-gateway-pending.ts';
import { inspectNativeGatewayOperation, nativeGatewayRequest, previewNativeGateway, readNativeGateway,
  readNativeGatewayCatalog, saveNativeGateway, NativeGatewayFailure, type NativeGatewayRequest,
  type NativeGatewayReceipt, type NativeGatewayView } from '../../../lib/nnd/native-gateway.ts';
import { authorityState, subscribeAuthority } from '../../../sync/authority-sync.ts';
import { SettingsGroupTitle, SettingsSection } from '../primitives.tsx';

const INPUT = 'w-24 rounded border border-border bg-background px-2 py-1 text-xs';
const BUTTON = 'rounded border border-border px-2 py-1 text-xs disabled:opacity-50';
const safeError = (error: unknown) => error instanceof NativeGatewayFailure ? error.code : 'nnd_gateway_timeout_unavailable';
const safePrecommit = new Set(['nnd_gateway_timeout_request_invalid', 'manifest_revision_conflict',
  'integration_permission_denied', 'nnd_gateway_timeout_source_missing', 'nnd_gateway_timeout_source_invalid']);
const validDraft = (value: string) => /^(?:[5-9]|[1-4][0-9]|50)$/u.test(value);
type PendingPreview = { request: NativeGatewayRequest; view: NativeGatewayView };

export function NativeGatewayTimeout(): ReactNode {
  const auth = useAuthSessionStore(state => state.status);
  const authority = useSyncExternalStore(subscribeAuthority, authorityState);
  const [view, setView] = useState<NativeGatewayView | null>(null);
  const [draft, setDraft] = useState('');
  const [preview, setPreview] = useState<PendingPreview | null>(null);
  const [receipt, setReceipt] = useState<NativeGatewayReceipt | null>(null);
  const [pending, setPending] = useState<PendingNativeGatewayOperation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const active = useRef<AbortController | null>(null);
  const pendingRef = useRef<PendingNativeGatewayOperation | null>(null);
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
    setView(next); setDraft(String(next.polling_timeout_seconds)); setPreview(null); setReceipt(null);
    pendingRef.current = pendingNativeGatewayOperation(next); setPending(pendingRef.current);
  }); }, [auth]);
  useEffect(() => {
    const reset = () => { active.current?.abort(); active.current = null; pendingRef.current = null;
      setView(null); setDraft(''); setPreview(null); setReceipt(null); setPending(null); setError(null); setBusy(false); };
    reset(); load();
    const off = onRuntimeEndpointChanged(() => { reset(); load(); });
    return () => { off(); active.current?.abort(); active.current = null; };
  }, [load]);
  useEffect(() => {
    if (authority !== 'ready') { active.current?.abort(); active.current = null; setBusy(false); setPreview(null); }
    else if (!view && auth === 'ok') load();
  }, [authority]);
  const doPreview = () => { if (!view || !validDraft(draft) || pendingRef.current) return;
    run(async (signal, current) => {
      const request = nativeGatewayRequest(view, Number(draft));
      const result = await previewNativeGateway(request, signal);
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
      setReceipt(result); setPreview(null); setView(null);
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
        clearNativeGatewayOperation(entry); pendingRef.current = null; setPending(null); setView(null);
      }
      if (result) setReceipt(result); else setError('operation_not_found');
    }); };
  const discardExpiredHandle = () => {
    const entry = pendingRef.current;
    if (!entry || error !== 'operation_not_found' || active.current) return;
    clearNativeGatewayOperation(entry); pendingRef.current = null; setPending(null);
    setView(null); setPreview(null); setReceipt(null); setError(null);
  };
  const disabled = busy || pending !== null || auth !== 'ok' || authority !== 'ready';
  return <SettingsSection item="native-gateway.timeout">
    <div className="flex items-center justify-between gap-3">
      <SettingsGroupTitle>NNA gateway polling timeout</SettingsGroupTitle>
      <button type="button" className={BUTTON} onClick={load} disabled={busy || auth !== 'ok' || authority !== 'ready'}>Refresh</button>
    </div>
    <p className="text-xs">Edit only the gateway polling timeout in the selected NNA installation. Saved values require a gateway restart and do not affect a running gateway.</p>
    {auth !== 'ok' ? <p role="alert">Sign in to inspect gateway settings.</p> : null}
    {authority !== 'ready' ? <p role="alert">Native authority is resynchronizing. Editing is paused.</p> : null}
    {busy ? <p role="status">Working…</p> : null}
    {error ? <p role="alert">{errorText(error)} ({error})</p> : null}
    {view ? <>
      <p className="text-xs">Selected installation: {view.installation_id} · data: {view.data_id} · revision: {view.source_revision.slice(0, 12)}</p>
      <p className="text-xs">Saved polling timeout: {view.polling_timeout_seconds} seconds</p>
      <fieldset disabled={disabled} className="space-y-2">
        <label className="block text-xs">Polling timeout (seconds, 5–50) <input className={INPUT} type="number" min="5" max="50" step="1"
          value={draft} onChange={event => { setDraft(event.target.value); setPreview(null); setReceipt(null); }} /></label>
        <button type="button" className={BUTTON} onClick={doPreview} disabled={!validDraft(draft)}>Preview native change</button>
      </fieldset>
    </> : null}
    {preview ? <div role="status" className="rounded border border-border p-2 text-xs">
      <p>NNA preview: {view?.polling_timeout_seconds} → {preview.view.polling_timeout_seconds} seconds. No change has been saved or applied.</p>
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
  if (code === 'nnd_gateway_timeout_source_missing' || code === 'nnd_gateway_timeout_source_invalid') {
    return 'Gateway settings need native setup or repair before this timeout can be edited.';
  }
  if (code === 'nnd_gateway_timeout_unsupported') return 'This NNA does not expose gateway timeout editing.';
  return 'Gateway timeout could not be read or changed.';
}
