// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { getRuntimeKey, onRuntimeEndpointChanged } from '../../../lib/runtime-switch.ts';
import { getApiBaseUrl } from '../../../lib/runtime-url.ts';
import { readBrokerSecrets, readSecretAudit, createSecret, updateSecret, rotateSecret,
  setSecretEnabled, deleteSecret, NativeSecretActionFailure, secretActionErrorText, SECRET_KINDS,
  type PublicSecret, type SecretAuditEvent, type SecretDraftInput, type SecretKindName,
  type SecretScopeName } from '../../../lib/nnd/secret-actions.ts';
import { authorityState, subscribeAuthority } from '../../../sync/authority-sync.ts';
import { useAuthSessionStore } from '../../../lib/runtime-auth-expiry.ts';
import { SettingsGroupTitle, SettingsSection } from '../primitives.tsx';

const safeError = (failure: unknown) => failure instanceof NativeSecretActionFailure
  ? failure.code : 'nnd_secret_action_unavailable';
const FIELD = 'rounded border border-border px-2 py-1 text-xs';
const BUTTON = 'rounded border border-border px-2 py-1 text-xs disabled:opacity-50';
const VALUES_NOTE = 'Field values are typed in, sent once, and never shown again — the roster and the audit render'
  + ' only what the broker itself reports (labels, kinds, scopes, field NAMES, counts, and outcomes). There is no'
  + ' value-read surface here: consumption stays with the trusted local callers that hold secret.use.';

export function SecretActionsConsole(): ReactNode {
  const auth = useAuthSessionStore(state => state.status);
  const authority = useSyncExternalStore(subscribeAuthority, authorityState);
  const [secrets, setSecrets] = useState<readonly PublicSecret[] | null>(null);
  const [audit, setAudit] = useState<readonly SecretAuditEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<DraftState>(() => emptyDraft());
  const [rotating, setRotating] = useState<PublicSecret | null>(null);
  const [rotateValues, setRotateValues] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<PublicSecret | null>(null);
  const [editPatch, setEditPatch] = useState<{ label: string; scoped: boolean; scopeKind: string;
    scopeId: string; metadataName: string; metadataValue: string }>(() => emptyEdit());
  const active = useRef<AbortController | null>(null);
  const resetView = useCallback(() => { active.current?.abort(); active.current = null;
    setSecrets(null); setAudit(null); setError(null); setReceipt(null); setBusy(false); }, []);
  const load = useCallback(() => runOnce(auth, active, setBusy, setError, async (signal) => {
    const [nextSecrets, nextAudit] = await Promise.all([readBrokerSecrets(signal), readSecretAudit(signal, 100)]);
    setSecrets(nextSecrets); setAudit(nextAudit); setError(null);
  }), [auth]);
  const act = useCallback((label: string, work: (signal: AbortSignal) => Promise<void>) =>
    runOnce(auth, active, setBusy, setError, async (signal) => { await work(signal); setReceipt(label); }), [auth]);
  useEffect(() => mountConsole(resetView, load), [resetView, load]);
  useEffect(() => syncWatch(authority, auth, secrets !== null, active, setBusy, load),
    [authority, auth, secrets, load]);
  return <SettingsSection item="native-secret-actions.settings">
    <div className="flex items-center justify-between gap-3">
      <SettingsGroupTitle>NNA secret actions</SettingsGroupTitle>
      <button type="button" className={BUTTON} onClick={load}
        disabled={busy || auth !== 'ok' || authority !== 'ready'}>Refresh</button>
    </div>
    <p className="text-xs">The census secret_action family: list, create, update (label, scope, metadata),
      rotate (values), enable/disable, delete, and audit — each one forwarded to the runtime SecretBroker verbatim,
      with its redacted receipt shown here. {VALUES_NOTE}</p>
    {auth !== 'ok' ? <p role="alert">Sign in to operate the native secret broker.</p> : null}
    {authority !== 'ready' ? <p role="alert">Native authority is resynchronizing. Secret actions are paused.</p> : null}
    {busy ? <p role="status">Working…</p> : null}
    {error ? <p role="alert">{secretActionErrorText(error)} ({error})</p> : null}
    {receipt ? <p role="status" data-testid="secret-receipt">{receipt}</p> : null}
    <Roster secrets={secrets} audit={audit} act={act} rotating={rotating} setRotating={setRotating}
      rotateValues={rotateValues} setRotateValues={setRotateValues} load={load} editing={editing}
      setEditing={setEditing} editPatch={editPatch} setEditPatch={setEditPatch} />
    <DraftPanel draft={draft} setDraft={setDraft} act={act} load={load} disabled={busy} />
  </SettingsSection>;
}

interface EditPatch { label: string; scoped: boolean; scopeKind: string; scopeId: string;
  metadataName: string; metadataValue: string }
const emptyEdit = (): EditPatch => ({ label: '', scoped: false, scopeKind: 'deployment', scopeId: '',
  metadataName: '', metadataValue: '' });

interface DraftState { label: string; kind: SecretKindName; scoped: boolean; scopeKind: string; scopeId: string;
  metadataName: string; metadataValue: string; entries: { name: string; value: string }[] }
const emptyDraft = (): DraftState => ({ label: '', kind: 'api_key', scoped: false, scopeKind: 'deployment',
  scopeId: '', metadataName: '', metadataValue: '', entries: [{ name: 'value', value: '' }] });

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

/** Runtime switches and unmount reset the console; each connected endpoint
 * triggers one fresh observation. */
function mountConsole(reset: () => void, load: () => void): () => void {
  reset(); load();
  const off = onRuntimeEndpointChanged(() => { reset(); load(); });
  return () => { off(); reset(); };
}

/** While native authority resynchronizes, in-flight work pauses honestly; once
 * ready, a missing roster triggers one fresh read. */
function syncWatch(authority: string, auth: string, hasView: boolean,
  active: React.RefObject<AbortController | null>, setBusy: (busy: boolean) => void,
  load: () => void): void {
  if (authority !== 'ready') { active.current?.abort(); active.current = null; setBusy(false); }
  else if (!hasView && auth === 'ok') load();
}

type ConsoleAct = (label: string, work: (signal: AbortSignal) => Promise<void>) => void;

function Roster({ secrets, audit, act, rotating, setRotating, rotateValues, setRotateValues, load,
  editing, setEditing, editPatch, setEditPatch }: {
  secrets: readonly PublicSecret[] | null; audit: readonly SecretAuditEvent[] | null; act: ConsoleAct;
  rotating: PublicSecret | null; setRotating: (value: PublicSecret | null) => void;
  rotateValues: Record<string, string>; setRotateValues: (next: Record<string, string>) => void;
  load: () => void; editing: PublicSecret | null; setEditing: (value: PublicSecret | null) => void;
  editPatch: EditPatch; setEditPatch: (next: EditPatch) => void }): ReactNode {
  if (!secrets) return <ul className="text-xs" data-testid="secret-roster"><li>waiting for the native roster…</li></ul>;
  return <ul className="text-xs" data-testid="secret-roster">
    {secrets.length === 0 ? <li>no secrets configured natively yet</li> : null}
    {secrets.map(secret => <SecretRow key={secret.id} secret={secret} act={act} rotating={rotating}
      setRotating={setRotating} rotateValues={rotateValues} setRotateValues={setRotateValues} load={load}
      editing={editing} setEditing={setEditing} editPatch={editPatch} setEditPatch={setEditPatch} />)}
    {audit ? <AuditPanel audit={audit} /> : null}
  </ul>;
}

function SecretRow({ secret, act, rotating, setRotating, rotateValues, setRotateValues, load,
  editing, setEditing, editPatch, setEditPatch }: {
  secret: PublicSecret; act: ConsoleAct; rotating: PublicSecret | null;
  setRotating: (value: PublicSecret | null) => void; rotateValues: Record<string, string>;
  setRotateValues: (next: Record<string, string>) => void; load: () => void;
  editing: PublicSecret | null; setEditing: (value: PublicSecret | null) => void;
  editPatch: EditPatch; setEditPatch: (next: EditPatch) => void }): ReactNode {
  const scope = secret.scope ? `${secret.scope.kind}:${secret.scope.id}` : 'global (null scope)';
  return <li data-testid="secret-row">
    <code>{secret.label}</code> · {secret.kind} · {scope} · fields [{secret.fields.join(', ')}]
    {' '}· {secret.enabled ? 'enabled' : 'disabled'} · used {secret.useCount}×
    {' '}(updated {secret.updatedAt.slice(0, 10)})
    <div className="flex flex-wrap gap-2 pt-1">
      <button type="button" className={BUTTON} data-testid="secret-toggle"
        onClick={() => act(secret.enabled ? `disabled ${secret.label}` : `enabled ${secret.label}`,
          async (signal) => { await setSecretEnabled(secret.id, !secret.enabled, signal); await refresh(load, signal); })}>
        {secret.enabled ? 'Disable' : 'Enable'}</button>
      <button type="button" className={BUTTON} data-testid="secret-delete"
        onClick={() => act(`deleted ${secret.label}`, async (signal) => {
          await deleteSecret(secret.id, signal); setRotating(null); setEditing(null);
          await refresh(load, signal); })}>
        Delete</button>
      <button type="button" className={BUTTON} data-testid="secret-edit"
        onClick={() => { setRotating(null);
          setEditing(editing && editing.id === secret.id ? null : secret); }}>Edit label/scope/metadata…</button>
      <button type="button" className={BUTTON} data-testid="secret-rotate"
        onClick={() => { setEditing(null);
          setRotating(rotating && rotating.id === secret.id ? null : secret); }}>Rotate values…</button>
    </div>
    {editing && editing.id === secret.id ? <EditForm secret={secret} act={act} load={load}
      editPatch={editPatch} setEditPatch={setEditPatch} /> : null}
    {rotating && rotating.id === secret.id ? <RotateForm secret={secret} rotateValues={rotateValues}
      setRotateValues={setRotateValues} act={act} load={load} /> : null}
  </li>;
}

function EditForm({ secret, act, load, editPatch, setEditPatch }: {
  secret: PublicSecret; act: ConsoleAct; load: () => void; editPatch: EditPatch;
  setEditPatch: (next: EditPatch) => void }): ReactNode {
  const set = (patch: Partial<EditPatch>) => setEditPatch({ ...editPatch, ...patch });
  return <div className="pl-4 pt-1" data-testid="secret-edit-panel">
    <input className={FIELD} placeholder={`label (${secret.label})`} value={editPatch.label}
      onChange={event => set({ label: event.target.value })} />
    <label className="pl-2"><input type="checkbox" checked={editPatch.scoped}
      onChange={event => set({ scoped: event.target.checked })} /> scoped</label>
    {editPatch.scoped ? <span>
      <select className={FIELD} value={editPatch.scopeKind}
        onChange={event => set({ scopeKind: event.target.value })}>
        {['deployment', 'workspace', 'group', 'role', 'user'].map(kind =>
          <option key={kind} value={kind}>{kind}</option>)}
      </select>
      <input className={FIELD} placeholder="scope id" value={editPatch.scopeId}
        onChange={event => set({ scopeId: event.target.value })} />
    </span> : null}
    <div>
      <input className={FIELD} placeholder="metadata name (replaces metadata)" value={editPatch.metadataName}
        onChange={event => set({ metadataName: event.target.value })} />
      <input className={FIELD} placeholder="metadata value" value={editPatch.metadataValue}
        onChange={event => set({ metadataValue: event.target.value })} />
    </div>
    <button type="button" className={BUTTON} onClick={() => act(`updated ${secret.label}`,
      async (signal) => {
        const patch: SecretDraftInput = { scope: editPatch.scoped
          ? { kind: editPatch.scopeKind as SecretScopeName, id: editPatch.scopeId } : null,
        metadata: editPatch.metadataName ? { [editPatch.metadataName]: editPatch.metadataValue } : undefined };
        if (editPatch.label) patch.label = editPatch.label;
        await updateSecret(secret.id, patch, signal);
        setEditPatch(emptyEdit()); load();
      })}>Apply</button>
    <span className="pl-2">a values-free rename: the receipt stays redacted</span>
  </div>;
}

async function refresh(load: () => void, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  load();
}

function RotateForm({ secret, rotateValues, setRotateValues, act, load }: {
  secret: PublicSecret; rotateValues: Record<string, string>;
  setRotateValues: (next: Record<string, string>) => void; act: ConsoleAct; load: () => void }): ReactNode {
  return <div className="pl-4 pt-1" data-testid="secret-rotate-panel">
    {secret.fields.map(name => <div key={name}>
      <input className={FIELD} type="password" placeholder={`new ${name}`} value={rotateValues[secret.id + name] ?? ''}
        onChange={event => setRotateValues({ ...rotateValues, [secret.id + name]: event.target.value })} />
    </div>)}
    <button type="button" className={BUTTON} onClick={() => act(`rotated ${secret.label}`, async (signal) => {
      const values: Record<string, string> = {};
      for (const name of secret.fields) values[name] = rotateValues[secret.id + name] ?? '';
      await rotateSecret(secret.id, values, signal);
      setRotateValues({}); load();
    })}>Set new values</button>
    <span className="pl-2">values clear after send; the receipt is the redacted record</span>
  </div>;
}

function DraftPanel({ draft, setDraft, act, load, disabled }: {
  draft: DraftState; setDraft: (next: DraftState) => void; act: ConsoleAct; load: () => void;
  disabled: boolean }): ReactNode {
  return <div className="pt-2" data-testid="secret-draft">
    <input className={FIELD} placeholder="label" value={draft.label}
      onChange={event => setDraft({ ...draft, label: event.target.value })} />
    <select className={FIELD} value={draft.kind}
      onChange={event => setDraft({ ...draft, kind: event.target.value as SecretKindName })}>
      {SECRET_KINDS.map(kind => <option key={kind} value={kind}>{kind}</option>)}
    </select>
    <label className="pl-2"><input type="checkbox" checked={draft.scoped}
      onChange={event => setDraft({ ...draft, scoped: event.target.checked })} /> scoped</label>
    {draft.scoped ? <span>
      <select className={FIELD} value={draft.scopeKind}
        onChange={event => setDraft({ ...draft, scopeKind: event.target.value })}>
        {['deployment', 'workspace', 'group', 'role', 'user'].map(kind =>
          <option key={kind} value={kind}>{kind}</option>)}
      </select>
      <input className={FIELD} placeholder="scope id" value={draft.scopeId}
        onChange={event => setDraft({ ...draft, scopeId: event.target.value })} />
    </span> : null}
    <div className="pt-1">
      <input className={FIELD} type="password" placeholder="field name" value={draft.entries[0]?.name ?? ''}
        onChange={event => setDraft({ ...draft, entries: [{ name: event.target.value, value: draft.entries[0]?.value ?? '' }] })} />
      <input className={FIELD} type="password" placeholder="field value" value={draft.entries[0]?.value ?? ''}
        onChange={event => setDraft({ ...draft, entries: [{ name: draft.entries[0]?.name ?? '', value: event.target.value }] })} />
      <span className="pl-2">username_password needs the names username + password</span>
    </div>
    <div className="pt-1">
      <input className={FIELD} placeholder="metadata name (optional)" value={draft.metadataName}
        onChange={event => setDraft({ ...draft, metadataName: event.target.value })} />
      <input className={FIELD} placeholder="metadata value" value={draft.metadataValue}
        onChange={event => setDraft({ ...draft, metadataValue: event.target.value })} />
    </div>
    <button type="button" className={BUTTON} disabled={disabled} onClick={() => act(`created ${draft.label}`,
      async (signal) => {
        const body = draftBody(draft);
        await createSecret(body, signal);
        setDraft(emptyDraft()); await refresh(load, signal);
      })}>Create secret</button>
  </div>;
}

function draftBody(draft: DraftState): SecretDraftInput {
  const body: SecretDraftInput = { label: draft.label, kind: draft.kind,
    fields: Object.fromEntries(draft.entries.filter(entry => entry.name).map(entry => [entry.name, entry.value])) };
  body.scope = draft.scoped ? { kind: draft.scopeKind as SecretScopeName, id: draft.scopeId } : null;
  if (draft.metadataName && draft.metadataValue.length > 0 && draft.metadataValue.length <= 2_000) {
    body.metadata = { [draft.metadataName]: draft.metadataValue };
  }
  return body;
}

function AuditPanel({ audit }: { audit: readonly SecretAuditEvent[] }): ReactNode {
  if (audit.length === 0) return <li data-testid="secret-audit">the native audit ledger is empty</li>;
  return <li data-testid="secret-audit">
    <span>native audit (newest last, no values, ever):</span>
    <ul className="ml-3">
      {audit.slice(-12).map(entry => <li key={entry.id}>
        {entry.at.slice(11, 19)} {entry.event} {entry.outcome}
        {entry.consumer ? ` · ${entry.consumer}` : ''}{entry.reason ? ` · ${entry.reason}` : ''}</li>)}
    </ul>
  </li>;
}
