// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { getRuntimeKey, onRuntimeEndpointChanged } from '../../../lib/runtime-switch.ts';
import { getApiBaseUrl } from '../../../lib/runtime-url.ts';
import { useAuthSessionStore } from '../../../lib/runtime-auth-expiry.ts';
import { newNativeOperationId } from '../../../lib/nnd/configuration-mutation.ts';
import { clearNativeWebFetchOperation, pendingNativeWebFetchOperation, reserveNativeWebFetchOperation,
  type PendingNativeWebFetchOperation } from '../../../lib/nnd/web-fetch-pending.ts';
import { inspectNativeWebFetchOperation, nativeWebFetchOperations, nativeWebFetchRequest, previewNativeWebFetch,
  readNativeWebFetch, readNativeWebFetchCatalog, saveNativeWebFetch, isValidWebFetchOriginDraft,
  NativeWebFetchFailure, type NativeWebFetchOperation, type NativeWebFetchReceipt,
  type NativeWebFetchView } from '../../../lib/nnd/web-fetch.ts';
import { authorityState, subscribeAuthority } from '../../../sync/authority-sync.ts';
import { SettingsGroupTitle, SettingsSection } from '../primitives.tsx';

const INPUT = 'w-64 rounded border border-border bg-background px-2 py-1 text-xs';
const BUTTON = 'rounded border border-border px-2 py-1 text-xs disabled:opacity-50';
const safeError = (error: unknown) => error instanceof NativeWebFetchFailure ? error.code : 'nnd_web_fetch_unavailable';
const safePrecommit = new Set(['nnd_web_fetch_request_invalid', 'manifest_revision_conflict',
  'integration_permission_denied', 'nnd_web_fetch_source_invalid']);
const MAX_OPERATIONS = 16;
type PendingPreview = { request: ReturnType<typeof nativeWebFetchRequest>; view: NativeWebFetchView };
type WebFetchDraft = { origin_add: string; origins: string[] };

function composeOperations(view: NativeWebFetchView, draft: WebFetchDraft): NativeWebFetchOperation[] {
  const operations: NativeWebFetchOperation[] = [];
  const added = draft.origins.filter(origin => !view.trusted_origins.includes(origin));
  const removed = view.trusted_origins.filter(origin => !draft.origins.includes(origin));
  for (const origin of added) operations.push({ op: 'trust', origin });
  for (const origin of removed) operations.push({ op: 'revoke', origin });
  return operations;
}

export function WebFetchTrust(): ReactNode {
  const auth = useAuthSessionStore(state => state.status);
  const authority = useSyncExternalStore(subscribeAuthority, authorityState);
  const [view, setView] = useState<NativeWebFetchView | null>(null);
  const [draft, setDraft] = useState<WebFetchDraft | null>(null);
  const [preview, setPreview] = useState<PendingPreview | null>(null);
  const [receipt, setReceipt] = useState<NativeWebFetchReceipt | null>(null);
  const [pending, setPending] = useState<PendingNativeWebFetchOperation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const active = useRef<AbortController | null>(null);
  const pendingRef = useRef<PendingNativeWebFetchOperation | null>(null);
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
    const [next] = await Promise.all([readNativeWebFetch(signal), readNativeWebFetchCatalog(signal)]);
    if (!current()) return;
    setView(next); setDraft({ origin_add: '', origins: [...next.trusted_origins] });
    setPreview(null); setReceipt(null);
    pendingRef.current = pendingNativeWebFetchOperation(next); setPending(pendingRef.current);
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
  const patchDraft = (part: Partial<WebFetchDraft>) => { setDraft(previous => previous ? { ...previous, ...part } : previous);
    setPreview(null); setReceipt(null); };
  const doPreview = () => { if (!view || !draft || pendingRef.current) return;
    let request: PendingPreview['request'];
    try {
      const operations = nativeWebFetchOperations(composeOperations(view, draft));
      if (operations.length < 1) { setError('nothing_to_save'); return; }
      if (operations.length > MAX_OPERATIONS) { setError('nnd_web_fetch_request_invalid'); return; }
      request = nativeWebFetchRequest(view, operations);
    } catch (failure) { setError(safeError(failure)); return; }
    run(async (signal, current) => {
      const result = await previewNativeWebFetch(request, view, signal);
      if (current()) setPreview({ request, view: result });
    }); };
  const save = () => { if (!view || !preview || pendingRef.current || active.current || auth !== 'ok' || authority !== 'ready') return;
    let operationId: string;
    try { operationId = newNativeOperationId(); } catch (failure) { setError(safeError(failure)); return; }
    const entry = reserveNativeWebFetchOperation(view, operationId, preview.request.expected_revision);
    if (!entry) { setError('nnd_web_fetch_unavailable'); return; }
    pendingRef.current = entry; setPending(entry);
    run(async (signal, current) => { try {
      const result = await saveNativeWebFetch(preview.request, operationId, signal);
      if (!current()) return;
      if (result.persistence === 'saved' || result.persistence === 'unpublished') {
        clearNativeWebFetchOperation(entry); pendingRef.current = null; setPending(null);
      }
      setReceipt(result); setPreview(null); setView(null); setDraft(null);
    } catch (failure) {
      if (current()) setPreview(null);
      if (current() && safePrecommit.has(safeError(failure))) {
        clearNativeWebFetchOperation(entry); pendingRef.current = null; setPending(null);
      }
      throw failure;
    } }); };
  const inspect = () => { const entry = pendingRef.current; if (!entry) return;
    run(async (signal, current) => {
      const result = await inspectNativeWebFetchOperation(entry, entry.operation_id, signal);
      if (!current()) return;
      if (result && result.before_revision !== entry.expected_revision) throw new NativeWebFetchFailure('nnd_web_fetch_view_invalid');
      if (result?.persistence === 'saved' || result?.persistence === 'unpublished') {
        clearNativeWebFetchOperation(entry); pendingRef.current = null; setPending(null); setView(null); setDraft(null);
      }
      if (result) setReceipt(result); else setError('operation_not_found');
    }); };
  const discardExpiredHandle = () => {
    const entry = pendingRef.current;
    if (!entry || error !== 'operation_not_found' || active.current) return;
    clearNativeWebFetchOperation(entry); pendingRef.current = null; setPending(null);
    setView(null); setDraft(null); setPreview(null); setReceipt(null); setError(null);
  };
  const disabled = busy || pending !== null || auth !== 'ok' || authority !== 'ready';
  return <SettingsSection item="native-web-fetch.trust">
    <div className="flex items-center justify-between gap-3">
      <SettingsGroupTitle>NNA web fetch trust</SettingsGroupTitle>
      <button type="button" className={BUTTON} onClick={load} disabled={busy || auth !== 'ok' || authority !== 'ready'}>Refresh</button>
    </div>
    <p className="text-xs">Trust is an authority grant, not a preference: add exact credential-free HTTP(S) origins whose
      private destinations you accept the WebFetch tool to load. Saved grants are honored by the next web fetch; reading
      shows one sticky default state until the first trust creates the store.</p>
    {auth !== 'ok' ? <p role="alert">Sign in to inspect WebFetch trust.</p> : null}
    {authority !== 'ready' ? <p role="alert">Native authority is resynchronizing. Editing is paused.</p> : null}
    {busy ? <p role="status">Working…</p> : null}
    {error ? <p role="alert">{errorText(error)} ({error})</p> : null}
    {view && draft ? <>
      <p className="text-xs">Selected installation: {view.installation_id} · data: {view.data_id} · source:
        {' '}{view.source_state} · revision: {view.source_revision.slice(0, 12)}</p>
      <p className="text-xs">Trusted origins: {view.trusted_origins.join(', ') || 'none'}</p>
      <fieldset disabled={disabled} className="space-y-2">
        <div className="text-xs">
          Draft trusted origins:
          <ul className="ml-3 list-disc">{draft.origins.map(origin => <li key={origin}>{origin}
            <button type="button" className={BUTTON} disabled={disabled}
              onClick={() => patchDraft({ origins: draft.origins.filter(item => item !== origin) })}>Revoke</button></li>)}
          </ul>
          <label>Add trusted origin <input className={INPUT} data-testid="webfetch-origin-add" value={draft.origin_add}
            placeholder="https://host.example"
            onChange={event => patchDraft({ origin_add: event.target.value })} /></label>
          <button type="button" className={BUTTON} disabled={disabled || !isValidWebFetchOriginDraft(draft.origin_add)}
            onClick={() => { patchDraft({ origin_add: '', origins: draft.origin_add && !draft.origins.includes(draft.origin_add)
              ? [...draft.origins, draft.origin_add] : draft.origins }); }}>Add</button>
        </div>
      </fieldset>
      <button type="button" className={BUTTON} onClick={doPreview} disabled={disabled}>Preview native change</button>
    </> : null}
    {preview ? <div role="status" className="rounded border border-border p-2 text-xs">
      <p>NNA preview: trusted origins would become {' '}
        {preview.view.trusted_origins.join(', ') || 'none'}. No change has been saved or applied.</p>
      <button type="button" className={BUTTON} onClick={save} disabled={disabled}>Save with native revision check</button>
    </div> : null}
    {pending ? <div role="status" className="rounded border border-border p-2 text-xs">
      <p>Operation {pending.operation_id} may have an uncertain outcome. Inspect the native receipt before another change.</p>
      <button type="button" className={BUTTON} onClick={inspect} disabled={busy || auth !== 'ok' || authority !== 'ready'}>Inspect operation</button>
      {error === 'operation_not_found' ? <button type="button" className={BUTTON} onClick={discardExpiredHandle}
        disabled={busy || auth !== 'ok' || authority !== 'ready'}>Clear expired local handle</button> : null}
    </div> : null}
    {receipt ? <p role="status" className="text-xs">Operation {receipt.operation_id}: {receipt.persistence}.
      {receipt.persistence === 'saved' ? ' Saved in NNA; the next web fetch will honor it.'
        : receipt.persistence === 'unpublished' ? ' The write was not published. Refresh before trying again.'
          : ' The write is not confirmed. Inspect this operation before retrying.'}</p> : null}
  </SettingsSection>;
}

function errorText(code: string): string {
  if (code === 'manifest_revision_conflict') return 'WebFetch trust changed. Refresh and preview again.';
  if (code === 'integration_permission_denied') return 'Native permission denied.';
  if (code === 'operation_not_found') return 'No retained receipt was found. Clear the expired local handle, refresh native trust, and preview before another save.';
  if (code === 'nothing_to_save') return 'No origins differ from the saved trust list.';
  if (code === 'nnd_web_fetch_request_invalid') return 'A composed change is outside the bounded trust grammar. Origins must be exact credential-free HTTP(S) origins, and one batch stays at most 16 operations.';
  if (code === 'nnd_web_fetch_source_invalid') return 'WebFetch trust settings need native repair before they can be changed here.';
  if (code === 'nnd_web_fetch_unsupported') return 'This NNA does not expose native WebFetch trust.';
  return 'WebFetch trust could not be read or changed.';
}
