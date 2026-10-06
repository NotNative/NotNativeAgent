// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { getRuntimeKey, onRuntimeEndpointChanged } from '../../../lib/runtime-switch.ts';
import { getApiBaseUrl } from '../../../lib/runtime-url.ts';
import { useAuthSessionStore } from '../../../lib/runtime-auth-expiry.ts';
import { newNativeOperationId } from '../../../lib/nnd/configuration-mutation.ts';
import { clearNativeCompatibilityOperation, pendingNativeCompatibilityOperation,
  reserveNativeCompatibilityOperation, type PendingNativeCompatibilityOperation }
  from '../../../lib/nnd/compatibility-pending.ts';
import { inspectNativeCompatibilityOperation, isValidCompatibilityHostnameDraft,
  isValidCompatibilityPasswordDraft, isValidCompatibilityPortDraft,
  isValidCompatibilityUsernameDraft, nativeCompatibilityRequest, previewNativeCompatibility,
  readNativeCompatibility, readNativeCompatibilityCatalog, saveNativeCompatibility,
  NativeCompatibilityFailure, type NativeCompatibilityReceipt, type NativeCompatibilityView,
  type CompatibilityPasswordAction } from '../../../lib/nnd/compatibility.ts';
import { authorityState, subscribeAuthority } from '../../../sync/authority-sync.ts';
import { SettingsGroupTitle, SettingsSection } from '../primitives.tsx';

const INPUT = 'w-64 rounded border border-border bg-background px-2 py-1 text-xs';
const BUTTON = 'rounded border border-border px-2 py-1 text-xs disabled:opacity-50';
const safeError = (error: unknown) => error instanceof NativeCompatibilityFailure ? error.code : 'nnd_compatibility_unavailable';
const safePrecommit = new Set(['nnd_compatibility_request_invalid', 'manifest_revision_conflict',
  'integration_permission_denied', 'nnd_compatibility_source_invalid', 'opencode_hostname_invalid',
  'opencode_bind_port_invalid', 'opencode_username_invalid', 'opencode_password_invalid',
  'opencode_bind_exposed_requires_password', 'opencode_config_version_unsupported',
  'opencode_config_invalid', 'opencode_config_too_large']);
interface PendingPreview { request: ReturnType<typeof nativeCompatibilityRequest>; view: NativeCompatibilityView }
type CompatibilityDraft = { enabled: boolean; hostname: string; port: string; username: string;
  password_action: CompatibilityPasswordAction; password_value: string };

export function CompatibilityServiceSettings(): ReactNode {
  const auth = useAuthSessionStore(state => state.status);
  const authority = useSyncExternalStore(subscribeAuthority, authorityState);
  const [view, setView] = useState<NativeCompatibilityView | null>(null);
  const [draft, setDraft] = useState<CompatibilityDraft | null>(null);
  const [preview, setPreview] = useState<PendingPreview | null>(null);
  const [receipt, setReceipt] = useState<NativeCompatibilityReceipt | null>(null);
  const [pending, setPending] = useState<PendingNativeCompatibilityOperation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const active = useRef<AbortController | null>(null);
  const pendingRef = useRef<PendingNativeCompatibilityOperation | null>(null);
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
    const [next] = await Promise.all([readNativeCompatibility(signal), readNativeCompatibilityCatalog(signal)]);
    if (!current()) return null;
    setView(next); setDraft({ enabled: next.enabled, hostname: next.hostname, port: String(next.port),
      username: next.username, password_action: 'keep', password_value: '' });
    setPreview(null); setReceipt(null); pendingRef.current = pendingNativeCompatibilityOperation(next);
    setPending(pendingRef.current);
    return next;
  };
  const load = useCallback(() => { run(async (signal, current) => {
    const next = await reload(signal, current);
    if (!current() || next === null) return;
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
  const patchDraft = (part: Partial<CompatibilityDraft>) => { setDraft(previous => previous ? { ...previous, ...part } : previous);
    setPreview(null); setReceipt(null); };
  const doPreview = () => { if (!view || !draft || pendingRef.current) return;
    let request: PendingPreview['request'];
    try {
      const port = Number(draft.port);
      if (!/^\d{1,5}$/u.test(draft.port.trim()) || Number.isNaN(port)) { setError('opencode_bind_port_invalid'); return; }
      request = nativeCompatibilityRequest(view, { enabled: draft.enabled, hostname: draft.hostname.trim(),
        port, username: draft.username.trim(), password: draft.password_action === 'replace'
          ? { action: 'replace', replace: draft.password_value } : { action: draft.password_action } });
    } catch (failure) { setError(safeError(failure)); return; }
    run(async (signal, current) => {
      const result = await previewNativeCompatibility(request, view, signal);
      if (current()) setPreview({ request, view: result });
    }); };
  const save = () => { if (!view || !preview || pendingRef.current || active.current || auth !== 'ok' || authority !== 'ready') return;
    let operationId: string;
    try { operationId = newNativeOperationId(); } catch (failure) { setError(safeError(failure)); return; }
    const entry = reserveNativeCompatibilityOperation(view, operationId, preview.request.expected_revision);
    if (!entry) { setError('nnd_compatibility_unavailable'); return; }
    pendingRef.current = entry; setPending(entry);
    run(async (signal, current) => { try {
      const result = await saveNativeCompatibility(preview.request, operationId, signal);
      if (!current()) return;
      if (result.persistence === 'saved' || result.persistence === 'unpublished') {
        clearNativeCompatibilityOperation(entry); pendingRef.current = null;
      }
      setPending(pendingRef.current);
      await reload(signal, current);
      // The refreshed view replaces the staged draft; the receipt stays for the audit trail.
      if (current()) setReceipt(result);
    } catch (failure) {
      if (current()) setPreview(null);
      if (current() && safePrecommit.has(safeError(failure))) {
        clearNativeCompatibilityOperation(entry); pendingRef.current = null; setPending(null);
      }
      throw failure;
    } }); };
  const inspect = () => { const entry = pendingRef.current; if (!entry) return;
    run(async (signal, current) => {
      const result = await inspectNativeCompatibilityOperation(entry, entry.operation_id, signal);
      if (!current()) return;
      if (result && result.before_revision !== entry.expected_revision) throw new NativeCompatibilityFailure('nnd_compatibility_view_invalid');
      if (result?.persistence === 'saved' || result?.persistence === 'unpublished') {
        clearNativeCompatibilityOperation(entry); pendingRef.current = null; setPending(null); setView(null); setDraft(null);
      }
      if (result) setReceipt(result); else setError('operation_not_found');
    }); };
  const discardExpiredHandle = () => {
    const entry = pendingRef.current;
    if (!entry || error !== 'operation_not_found' || active.current) return;
    clearNativeCompatibilityOperation(entry); pendingRef.current = null; setPending(null);
    setView(null); setDraft(null); setPreview(null); setReceipt(null); setError(null);
  };
  const disabled = busy || pending !== null || auth !== 'ok' || authority !== 'ready';
  const portValid = view && draft ? /^\d{1,5}$/u.test(draft.port.trim()) && isValidCompatibilityPortDraft(Number(draft.port)) : false;
  const replaceNeeded = draft?.password_action === 'replace';
  return <SettingsSection item="native-compatibility.settings">
    <div className="flex items-center justify-between gap-3">
      <SettingsGroupTitle>NNA compatibility service settings</SettingsGroupTitle>
      <button type="button" className={BUTTON} onClick={load} disabled={busy || auth !== 'ok' || authority !== 'ready'}>Refresh</button>
    </div>
    <p className="text-xs">The compatibility service is the native OpenCode wiring surface: login auto-start plus the
      fixed wire identity and its Basic auth credentials. It reads this configuration at its next start, so a saved
      change takes effect on the next service start. Secret values are never shown — a read reports where the password
      comes from, and an environment override (OPENCODE_SERVER_PASSWORD) can keep supplying it after a clear.</p>
    {auth !== 'ok' ? <p role="alert">Sign in to inspect compatibility service settings.</p> : null}
    {authority !== 'ready' ? <p role="alert">Native authority is resynchronizing. Editing is paused.</p> : null}
    {busy ? <p role="status">Working…</p> : null}
    {error ? <p role="alert">{errorText(error)} ({error})</p> : null}
    {view && draft ? <>
      <p className="text-xs">Selected installation: {view.installation_id} · data: {view.data_id} · source:
        {' '}{view.source_state} · revision: {view.source_revision.slice(0, 12)}</p>
      <p className="text-xs" data-testid="compat-status">Login auto-start: {view.enabled ? 'on' : 'off'} · bind:
        {' '}http://{view.hostname}:{view.port} · user: {view.username} · password:
        {' '}{view.password.configured ? `present (${view.password.source})` : 'not configured'}</p>
      <fieldset disabled={disabled} className="space-y-2">
        <div className="text-xs">
          <label><input type="checkbox" data-testid="compat-enabled" checked={draft.enabled}
            onChange={event => patchDraft({ enabled: event.target.checked })} /> Start with login</label>
          <label>Hostname <input className={INPUT} data-testid="compat-hostname" value={draft.hostname}
            placeholder="127.0.0.1" onChange={event => patchDraft({ hostname: event.target.value })} /></label>
          <label>Port <input className={`${INPUT} w-24`} data-testid="compat-port" value={draft.port}
            placeholder="4095" onChange={event => patchDraft({ port: event.target.value })} /></label>
          <label>Username <input className={INPUT} data-testid="compat-username" value={draft.username}
            placeholder="opencode" onChange={event => patchDraft({ username: event.target.value })} /></label>
        </div>
        <div className="text-xs space-y-1" data-testid="compat-password-staging">
          <label><input type="radio" name="compat-password" checked={draft.password_action === 'keep'}
            onChange={() => patchDraft({ password_action: 'keep' })} /> Keep current password</label>
          <label><input type="radio" name="compat-password" data-testid="compat-password-replace"
            checked={draft.password_action === 'replace'}
            onChange={() => patchDraft({ password_action: 'replace' })} /> Replace with a new value</label>
          {replaceNeeded ? <label>New password <input className={INPUT} data-testid="compat-password-value" type="password"
            value={draft.password_value}
            onChange={event => patchDraft({ password_value: event.target.value })} /> (20–512 characters)</label> : null}
          <label><input type="radio" name="compat-password" data-testid="compat-password-clear"
            checked={draft.password_action === 'clear'}
            onChange={() => patchDraft({ password_action: 'clear' })} /> Clear the stored password</label>
        </div>
      </fieldset>
      <button type="button" className={BUTTON} onClick={doPreview} disabled={disabled || !portValid
        || !isValidCompatibilityHostnameDraft(draft.hostname) || !isValidCompatibilityUsernameDraft(draft.username)
        || replaceNeeded && !isValidCompatibilityPasswordDraft(draft.password_value)}>Preview native change</button>
    </> : null}
    {preview ? <div role="status" className="rounded border border-border p-2 text-xs">
      <p data-testid="compat-preview">NNA preview: login auto-start would be {preview.view.enabled ? 'on' : 'off'},
        bind http://{preview.view.hostname}:{preview.view.port} with user {preview.view.username}; password
        {' '}{preview.view.password.configured ? `present (${preview.view.password.source})` : 'not configured'}.
        The change applies at the next service start; nothing is saved or applied yet.</p>
      <button type="button" className={BUTTON} data-testid="compat-save" onClick={save}
        disabled={disabled}>Save with native revision check</button>
    </div> : null}
    {pending ? <div role="status" className="rounded border border-border p-2 text-xs">
      <p>Operation {pending.operation_id} may have an uncertain outcome. Inspect the native receipt before another change.</p>
      <button type="button" className={BUTTON} onClick={inspect} disabled={busy || auth !== 'ok' || authority !== 'ready'}>Inspect operation</button>
      {error === 'operation_not_found' ? <button type="button" className={BUTTON} onClick={discardExpiredHandle}
        disabled={busy || auth !== 'ok' || authority !== 'ready'}>Clear expired local handle</button> : null}
    </div> : null}
    {receipt ? <p role="status" className="text-xs">Operation {receipt.operation_id}: {receipt.persistence}.
      {receipt.persistence === 'saved' ? ' Saved in NNA; it applies at the next compatibility service start.'
        : receipt.persistence === 'unpublished' ? ' The write was not published. Refresh before trying again.'
          : ' The write is not confirmed. Inspect this operation before retrying.'}</p> : null}
  </SettingsSection>;
}

function errorText(code: string): string {
  if (code === 'manifest_revision_conflict') return 'Compatibility settings changed. Refresh and preview again.';
  if (code === 'integration_permission_denied') return 'Native permission denied.';
  if (code === 'operation_not_found') return 'No retained receipt was found. Clear the expired local handle, refresh native settings, and preview before another save.';
  if (code === 'nnd_compatibility_request_invalid') return 'A composed change is outside the bounded settings grammar. Hostnames stay within 253 characters, ports run 1–65535, usernames 1–64, and the replace value 20–512 characters.';
  if (code === 'nnd_compatibility_source_invalid') return 'Compatibility settings need native repair before they can be changed here.';
  if (code === 'nnd_compatibility_projection_invalid') return 'NNA served a compatibility shape this build refuses. Update NNA and this NND together before retrying.';
  if (code === 'nnd_compatibility_unsupported') return 'This NNA does not expose native compatibility service settings.';
  if (code === 'opencode_hostname_invalid') return 'Hostnames must be an IP address or DNS name without scheme, port, or brackets in the middle.';
  if (code === 'opencode_bind_port_invalid') return 'The bind port must be an integer from 1 through 65535.';
  if (code === 'opencode_username_invalid') return 'The Basic auth username is invalid (1–64 characters, no colons or control characters).';
  if (code === 'opencode_password_invalid') return 'The password value is invalid (20–512 characters, no line breaks).';
  if (code === 'opencode_bind_exposed_requires_password') return 'A bind beyond loopback needs Basic auth credentials; set a password in the same preview or keep the loopback host.';
  if (code === 'opencode_config_version_unsupported' || code === 'opencode_config_invalid' || code === 'opencode_config_too_large') return 'The stored configuration is not readable by this NNA build.';
  return 'Compatibility service settings could not be read or changed.';
}
