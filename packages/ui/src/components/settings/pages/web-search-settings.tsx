// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { getRuntimeKey, onRuntimeEndpointChanged } from '../../../lib/runtime-switch.ts';
import { getApiBaseUrl } from '../../../lib/runtime-url.ts';
import { useAuthSessionStore } from '../../../lib/runtime-auth-expiry.ts';
import { newNativeOperationId } from '../../../lib/nnd/configuration-mutation.ts';
import { clearNativeWebSearchOperation, pendingNativeWebSearchOperation, reserveNativeWebSearchOperation,
  type PendingNativeWebSearchOperation } from '../../../lib/nnd/web-search-pending.ts';
import { canonicalWebSearchEndpoint, inspectNativeWebSearchOperation, isValidWebSearchEndpointDraft,
  isValidWebSearchNameDraft, nativeWebSearchOperations, nativeWebSearchRequest, previewNativeWebSearch,
  readNativeWebSearch, readNativeWebSearchCatalog, saveNativeWebSearch, NativeWebSearchFailure,
  type NativeWebSearchOperation, type NativeWebSearchReceipt, type NativeWebSearchView } from '../../../lib/nnd/web-search.ts';
import { authorityState, subscribeAuthority } from '../../../sync/authority-sync.ts';
import { SettingsGroupTitle, SettingsSection } from '../primitives.tsx';

const INPUT = 'w-64 rounded border border-border bg-background px-2 py-1 text-xs';
const BUTTON = 'rounded border border-border px-2 py-1 text-xs disabled:opacity-50';
const safeError = (error: unknown) => error instanceof NativeWebSearchFailure ? error.code : 'nnd_web_search_unavailable';
const safePrecommit = new Set(['nnd_web_search_request_invalid', 'manifest_revision_conflict',
  'integration_permission_denied', 'nnd_web_search_source_invalid', 'web_search_endpoint_required',
  'web_search_endpoint_duplicate', 'web_search_endpoint_invalid', 'web_search_profile_missing',
  'web_search_profiles_too_many', 'web_search_profile_id_exhausted', 'web_search_profile_name_invalid',
  'web_search_profile_id_invalid']);
const MAX_OPERATIONS = 16;
// The managed flag marks a profile NNA deployed or adopted itself (the CLI's
// deploy stamps managed:true and derives the "Local SearXNG" name); the field
// rides the read view and is never an operator input, so it renders as a
// pointer to the deployment observation rather than as a control. The Managed
// SearXNG deployment section renders on the same composed settings page.
const MANAGED_NOTE = ' · managed deploy (observed in the Managed SearXNG deployment section)';
type PendingPreview = { request: ReturnType<typeof nativeWebSearchRequest>; view: NativeWebSearchView };
type WebSearchDraft = { enabled: boolean; add_name: string; add_endpoint: string;
  added: readonly { display_name: string; endpoint: string }[]; removed: readonly string[]; primary: string | null };

function composeOperations(view: NativeWebSearchView, draft: WebSearchDraft): NativeWebSearchOperation[] {
  const operations: NativeWebSearchOperation[] = [];
  const removed = new Set(draft.removed);
  // Adds go first: the domain refuses an enable with zero profiles, so the enable
  // must see the appended profile (the add itself re-enables by domain parity). An
  // enable-only batch still reaches the server, which refuses with the honest
  // endpoint-required code when no profile exists.
  for (const staged of draft.added) {
    if (!view.profiles.some(profile => profile.endpoint === staged.endpoint)) {
      operations.push({ op: 'add_profile', display_name: staged.display_name, endpoint: staged.endpoint });
    }
  }
  if (draft.enabled !== view.enabled) {
    operations.push({ op: 'set_enabled', enabled: draft.enabled });
  }
  if (draft.primary && draft.primary !== view.profiles[0]?.id && !removed.has(draft.primary)) {
    operations.push({ op: 'promote_profile', id: draft.primary });
  }
  for (const id of draft.removed) operations.push({ op: 'remove_profile', id });
  return operations;
}

export function WebSearchSettings(): ReactNode {
  const auth = useAuthSessionStore(state => state.status);
  const authority = useSyncExternalStore(subscribeAuthority, authorityState);
  const [view, setView] = useState<NativeWebSearchView | null>(null);
  const [draft, setDraft] = useState<WebSearchDraft | null>(null);
  const [preview, setPreview] = useState<PendingPreview | null>(null);
  const [receipt, setReceipt] = useState<NativeWebSearchReceipt | null>(null);
  const [pending, setPending] = useState<PendingNativeWebSearchOperation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const active = useRef<AbortController | null>(null);
  const pendingRef = useRef<PendingNativeWebSearchOperation | null>(null);
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
    const [next] = await Promise.all([readNativeWebSearch(signal), readNativeWebSearchCatalog(signal)]);
    if (!current()) return;
    setView(next); setDraft({ enabled: next.enabled, add_name: '', add_endpoint: '', added: [],
      removed: [], primary: null });
    setPreview(null); setReceipt(null);
    pendingRef.current = pendingNativeWebSearchOperation(next); setPending(pendingRef.current);
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
  const patchDraft = (part: Partial<WebSearchDraft>) => { setDraft(previous => previous ? { ...previous, ...part } : previous);
    setPreview(null); setReceipt(null); };
  const doPreview = () => { if (!view || !draft || pendingRef.current) return;
    let request: PendingPreview['request'];
    try {
      const composed = composeOperations(view, draft);
      if (composed.length < 1) { setError('nothing_to_save'); return; }
      if (composed.length > MAX_OPERATIONS) { setError('nnd_web_search_request_invalid'); return; }
      const operations = nativeWebSearchOperations(composed);
      request = nativeWebSearchRequest(view, operations);
    } catch (failure) { setError(safeError(failure)); return; }
    run(async (signal, current) => {
      const result = await previewNativeWebSearch(request, view, signal);
      if (current()) setPreview({ request, view: result });
    }); };
  const save = () => { if (!view || !preview || pendingRef.current || active.current || auth !== 'ok' || authority !== 'ready') return;
    let operationId: string;
    try { operationId = newNativeOperationId(); } catch (failure) { setError(safeError(failure)); return; }
    const entry = reserveNativeWebSearchOperation(view, operationId, preview.request.expected_revision);
    if (!entry) { setError('nnd_web_search_unavailable'); return; }
    pendingRef.current = entry; setPending(entry);
    run(async (signal, current) => { try {
      const result = await saveNativeWebSearch(preview.request, operationId, signal);
      if (!current()) return;
      if (result.persistence === 'saved' || result.persistence === 'unpublished') {
        clearNativeWebSearchOperation(entry); pendingRef.current = null; setPending(null);
      }
      setReceipt(result); setPreview(null); setView(null); setDraft(null);
    } catch (failure) {
      if (current()) setPreview(null);
      if (current() && safePrecommit.has(safeError(failure))) {
        clearNativeWebSearchOperation(entry); pendingRef.current = null; setPending(null);
      }
      throw failure;
    } }); };
  const inspect = () => { const entry = pendingRef.current; if (!entry) return;
    run(async (signal, current) => {
      const result = await inspectNativeWebSearchOperation(entry, entry.operation_id, signal);
      if (!current()) return;
      if (result && result.before_revision !== entry.expected_revision) throw new NativeWebSearchFailure('nnd_web_search_view_invalid');
      if (result?.persistence === 'saved' || result?.persistence === 'unpublished') {
        clearNativeWebSearchOperation(entry); pendingRef.current = null; setPending(null); setView(null); setDraft(null);
      }
      if (result) setReceipt(result); else setError('operation_not_found');
    }); };
  const discardExpiredHandle = () => {
    const entry = pendingRef.current;
    if (!entry || error !== 'operation_not_found' || active.current) return;
    clearNativeWebSearchOperation(entry); pendingRef.current = null; setPending(null);
    setView(null); setDraft(null); setPreview(null); setReceipt(null); setError(null);
  };
  const disabled = busy || pending !== null || auth !== 'ok' || authority !== 'ready';
  const draftProfiles = view && draft ? view.profiles.filter(profile => !draft.removed.includes(profile.id)) : [];
  return <SettingsSection item="native-web-search.settings">
    <div className="flex items-center justify-between gap-3">
      <SettingsGroupTitle>NNA web search settings</SettingsGroupTitle>
      <button type="button" className={BUTTON} onClick={load} disabled={busy || auth !== 'ok' || authority !== 'ready'}>Refresh</button>
    </div>
    <p className="text-xs">WebSearch runs over your SearXNG instances. Choose whether it is enabled and which endpoints it
      may query; the search tool reloads this configuration on every search, so a saved change is honored by the next web
      search. Reading shows one sticky default state until the first profile save creates the store; an added profile
      enables WebSearch by domain parity (disable it with the toggle in the same batch to keep it off).</p>
    {auth !== 'ok' ? <p role="alert">Sign in to inspect WebSearch settings.</p> : null}
    {authority !== 'ready' ? <p role="alert">Native authority is resynchronizing. Editing is paused.</p> : null}
    {busy ? <p role="status">Working…</p> : null}
    {error ? <p role="alert">{errorText(error)} ({error})</p> : null}
    {view && draft ? <>
      <p className="text-xs">Selected installation: {view.installation_id} · data: {view.data_id} · source:
        {' '}{view.source_state} · revision: {view.source_revision.slice(0, 12)}</p>
      <p className="text-xs" data-testid="websearch-profiles-summary">WebSearch is {view.enabled ? 'enabled' : 'disabled'} · profiles:
        {' '}{view.profiles.map(profile => `${profile.id} (${profile.endpoint})${profile.managed ? ' · managed' : ''}`).join(', ') || 'none'}</p>
      <fieldset disabled={disabled} className="space-y-2">
        <div className="text-xs">
          <label><input type="checkbox" data-testid="websearch-enabled" checked={draft.enabled}
            onChange={event => patchDraft({ enabled: event.target.checked })} /> Enabled</label>
          <ul className="ml-3 list-disc">{draftProfiles.map(profile => <li key={profile.id}>
            {profile.id}: {profile.display_name} → {profile.endpoint}
            {view.profiles[0]?.id === profile.id ? ' (primary)' : ''}
            {profile.managed ? <span data-testid="websearch-profile-managed">{MANAGED_NOTE}</span> : null}
            <button type="button" className={BUTTON} disabled={disabled || view.profiles[0]?.id === profile.id}
              onClick={() => patchDraft({ primary: profile.id })}>Make primary</button>
            <button type="button" className={BUTTON} disabled={disabled}
              onClick={() => patchDraft({ removed: [...draft.removed, profile.id],
                primary: draft.primary === profile.id ? null : draft.primary })}>Remove</button>
          </li>)}</ul>
          {draft.added.length > 0 ? <ul className="ml-3 list-disc">{draft.added.map((staged, index) => <li
            key={`${staged.display_name}|${staged.endpoint}`}
            data-testid={`websearch-staged-${staged.endpoint}`}>{staged.display_name} → {staged.endpoint}
            <button type="button" className={BUTTON} disabled={disabled} onClick={() => patchDraft({
              added: draft.added.filter((_, at) => at !== index) })}>Drop staged profile</button></li>)}</ul> : null}
          <label>Add profile name <input className={INPUT} data-testid="websearch-name-add" value={draft.add_name}
            placeholder="Docs search" onChange={event => patchDraft({ add_name: event.target.value })} /></label>
          <label>Endpoint <input className={INPUT} data-testid="websearch-endpoint-add" value={draft.add_endpoint}
            placeholder="https://searx.docs.example" onChange={event => patchDraft({ add_endpoint: event.target.value })} /></label>
          <button type="button" className={BUTTON} disabled={disabled || !draft.add_endpoint.trim()
            || !isValidWebSearchNameDraft(draft.add_name)
            || !isValidWebSearchEndpointDraft(draft.add_endpoint.trim())
            || [...view.profiles, ...draft.added].some(item => item.endpoint === canonicalWebSearchEndpoint(draft.add_endpoint.trim()))}
            data-testid="websearch-add" onClick={() => patchDraft({ added: [...draft.added, {
              display_name: draft.add_name.trim(), endpoint: canonicalWebSearchEndpoint(draft.add_endpoint.trim()) }],
              add_name: '', add_endpoint: '' })}>Add profile</button>
        </div>
      </fieldset>
      <button type="button" className={BUTTON} onClick={doPreview} disabled={disabled}>Preview native change</button>
    </> : null}
    {preview ? <div role="status" className="rounded border border-border p-2 text-xs">
      <p>NNA preview: WebSearch would be {preview.view.enabled ? 'enabled' : 'disabled'} with profiles
        {' '}{preview.view.profiles.map(profile => `${profile.id} (${profile.endpoint})${profile.managed ? ' · managed' : ''}`).join(', ') || 'none'}.
        No change has been saved or applied.</p>
      <button type="button" className={BUTTON} onClick={save} disabled={disabled}>Save with native revision check</button>
    </div> : null}
    {pending ? <div role="status" className="rounded border border-border p-2 text-xs">
      <p>Operation {pending.operation_id} may have an uncertain outcome. Inspect the native receipt before another change.</p>
      <button type="button" className={BUTTON} onClick={inspect} disabled={busy || auth !== 'ok' || authority !== 'ready'}>Inspect operation</button>
      {error === 'operation_not_found' ? <button type="button" className={BUTTON} onClick={discardExpiredHandle}
        disabled={busy || auth !== 'ok' || authority !== 'ready'}>Clear expired local handle</button> : null}
    </div> : null}
    {receipt ? <p role="status" className="text-xs">Operation {receipt.operation_id}: {receipt.persistence}.
      {receipt.persistence === 'saved' ? ' Saved in NNA; the next web search will honor it.'
        : receipt.persistence === 'unpublished' ? ' The write was not published. Refresh before trying again.'
          : ' The write is not confirmed. Inspect this operation before retrying.'}</p> : null}
  </SettingsSection>;
}

function errorText(code: string): string {
  if (code === 'manifest_revision_conflict') return 'WebSearch settings changed. Refresh and preview again.';
  if (code === 'integration_permission_denied') return 'Native permission denied.';
  if (code === 'operation_not_found') return 'No retained receipt was found. Clear the expired local handle, refresh native settings, and preview before another save.';
  if (code === 'nothing_to_save') return 'No enabled toggle, profile, or primary choice differs from the saved settings.';
  if (code === 'nnd_web_search_request_invalid') return 'A composed change is outside the bounded settings grammar. Profile names stay within 128 characters, endpoints are credential-free HTTP(S) base URLs, and one batch stays at most 16 operations.';
  if (code === 'nnd_web_search_source_invalid') return 'WebSearch settings need native repair before they can be changed here.';
  if (code === 'nnd_web_search_unsupported') return 'This NNA does not expose native WebSearch settings.';
  if (code === 'web_search_endpoint_required') return 'WebSearch cannot be enabled while no profile exists. Add a profile in the same batch first.';
  if (code === 'web_search_endpoint_duplicate') return 'That SearXNG endpoint already has a profile.';
  if (code === 'web_search_endpoint_invalid') return 'Endpoints must be credential-free HTTP(S) base URLs.';
  if (code === 'web_search_profile_missing') return 'That profile is not listed anymore. Refresh and preview again.';
  if (code === 'web_search_profiles_too_many') return 'WebSearch supports at most 8 profiles.';
  if (code === 'web_search_profile_id_exhausted') return 'No unique identifier could be derived from that profile name.';
  if (code === 'web_search_profile_name_invalid') return 'Profile names must contain 1–128 characters.';
  if (code === 'web_search_profile_id_invalid') return 'Profile identifiers use 1–64 lowercase letters, numbers, or hyphens.';
  return 'WebSearch settings could not be read or changed.';
}
