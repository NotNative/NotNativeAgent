// SPDX-License-Identifier: Apache-2.0
/** Native user-manifest MCP intents; running sessions are unchanged until NNA applies them. */
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { authorityState, subscribeAuthority } from '../../../sync/authority-sync.ts';
import { SettingsGroupTitle } from '../primitives.tsx';
import { useNativeMcpModel, type NativeMcpDraft } from './native-mcp-model.ts';

const INPUT = 'block w-full max-w-md rounded border border-border bg-background px-2 py-1 text-xs';
const BUTTON = 'rounded border border-border px-2 py-1 text-xs disabled:opacity-50';
const DEADLINES = ['timeout_ms', 'connect_timeout_ms', 'list_timeout_ms', 'call_timeout_ms', 'shutdown_timeout_ms'] as const;

export function NativeMcpEditor(): ReactNode {
  const model = useNativeMcpModel();
  const authority = useSyncExternalStore(subscribeAuthority, authorityState);
  const [deleteConfirmed, setDeleteConfirmed] = useState(false);
  useEffect(() => { setDeleteConfirmed(false); }, [model.draft.op, model.draft.id]);
  const disabled = model.busy || model.pending !== null || model.auth !== 'ok' || authority !== 'ready';
  const shadowed = model.view?.project_shadowed === true;
  return <section className="mb-4 space-y-2 rounded-lg border border-border/35 p-3 text-xs" aria-label="Native MCP configuration">
    <div className="flex items-center justify-between gap-3">
      <SettingsGroupTitle>Native MCP configuration</SettingsGroupTitle>
      <button type="button" className={BUTTON} onClick={() => void model.load()} disabled={model.busy || model.auth !== 'ok'}>Refresh</button>
    </div>
    <p>NNA owns these user-manifest servers. Commands, destinations, credentials and headers remain private inside NNA.</p>
    <p role="status">Saving changes the manifest only. It does not apply to current sessions; activate setup or restart the native service for future sessions.</p>
    {model.auth !== 'ok' ? <p role="alert">Sign in before editing native MCP settings.</p> : null}
    {authority !== 'ready' ? <p role="alert">Native authority is resynchronizing. Editing is paused.</p> : null}
    {model.busy ? <p role="status">Working…</p> : null}
    {model.error ? <p role="alert">{errorText(model.error)} ({model.error})</p> : null}
    {shadowed ? <p role="alert">A trusted project MCP array owns the effective settings. User-manifest edits are unavailable.</p> : null}
    {model.view ? <>
      <p>Selected source: {model.view.source_revision.slice(0, 12)} · {model.view.servers.length} user server(s)</p>
      <ul>{model.view.servers.map(server => <li key={server.id}>{server.id} · {server.transport} ·
        {server.enabled ? ' enabled' : ' disabled'} · {server.trusted ? ' trusted' : ' untrusted'}</li>)}</ul>
      <fieldset disabled={disabled || shadowed} className="space-y-2">
        <NativeMcpDraftForm draft={model.draft} servers={model.view.servers} onChange={model.changeDraft} />
        {model.draft.op === 'delete' ? <label className="flex items-center gap-2">
          <input type="checkbox" checked={deleteConfirmed} onChange={event => setDeleteConfirmed(event.target.checked)} />
          Delete this user-manifest server definition</label> : null}
        <button type="button" className={BUTTON} onClick={model.previewDraft}
          disabled={model.draft.op === 'delete' && !deleteConfirmed}>Preview native change</button>
      </fieldset>
    </> : null}
    {model.preview ? <div role="status" className="rounded border border-border p-2">
      <p>Native preview is valid. {model.preview.request.change.op} {model.preview.request.change.id};
        candidate has {model.preview.view.servers.length} user server(s). No change has been applied.</p>
      <button type="button" className={BUTTON} onClick={model.save}
        disabled={disabled || shadowed || model.preview.request.change.op === 'delete' && !deleteConfirmed}>
        Save with native revision check</button>
    </div> : null}
    {model.pending ? <div role="status" className="rounded border border-border p-2">
      <p>Operation {model.pending.operation_id} may have an uncertain outcome. Inspect its native receipt before another change.</p>
      <button type="button" className={BUTTON} onClick={model.inspect} disabled={model.busy || authority !== 'ready'}>Inspect operation</button>
    </div> : null}
    {model.receipt ? <p role="status">Operation {model.receipt.operation_id}: {model.receipt.persistence}.
      {model.receipt.persistence === 'saved' ? 'Saved to NNA’s manifest; not applied to current sessions.'
        : 'The write is not confirmed. Inspect this operation before retrying.'}</p> : null}
  </section>;
}

function NativeMcpDraftForm({ draft, servers, onChange }: { draft: NativeMcpDraft;
  servers: { id: string; enabled: boolean }[]; onChange: (draft: NativeMcpDraft) => void }): ReactNode {
  const update = (patch: Partial<NativeMcpDraft>) => onChange({ ...draft, ...patch });
  return <>
    <label className="block">Action<select className={INPUT} value={draft.op} onChange={event => {
      const op = event.target.value as NativeMcpDraft['op'];
      const selected = servers[0]; onChange({ ...draft, op, id: op === 'create' ? '' : selected?.id ?? '',
        enabled: selected?.enabled ?? false, deadline: '', deadlineValue: '' });
    }}><option value="create">Create disabled server</option><option value="patch">Patch server</option>
      <option value="delete">Delete server</option></select></label>
    {draft.op === 'create' ? <label className="block">Server ID<input className={INPUT} value={draft.id} maxLength={64}
      onChange={event => update({ id: event.target.value })} /></label>
      : <label className="block">Server<select className={INPUT} value={draft.id} onChange={event => {
        const server = servers.find(item => item.id === event.target.value);
        update({ id: event.target.value, enabled: server?.enabled ?? false });
      }}><option value="">Choose a server</option>{servers.map(server => <option key={server.id} value={server.id}>{server.id}</option>)}</select></label>}
    {draft.op === 'create' ? <NativeMcpCreateFields draft={draft} update={update} /> : null}
    {draft.op === 'patch' ? <NativeMcpPatchFields draft={draft} update={update} /> : null}
  </>;
}

function NativeMcpCreateFields({ draft, update }: { draft: NativeMcpDraft;
  update: (patch: Partial<NativeMcpDraft>) => void }): ReactNode {
  return <>
    <label className="block">Transport<select className={INPUT} value={draft.transport}
      onChange={event => update({ transport: event.target.value as NativeMcpDraft['transport'] })}>
      <option value="stdio">Local process</option><option value="streamable_http">HTTP</option></select></label>
    {draft.transport === 'stdio' ? <>
      <label className="block">Command<input className={INPUT} value={draft.command} maxLength={4096}
        onChange={event => update({ command: event.target.value })} /></label>
      <label className="block">Arguments, one per line<textarea className={INPUT} value={draft.args} rows={3} maxLength={16384}
        onChange={event => update({ args: event.target.value })} /></label>
    </> : <label className="block">HTTP endpoint<input className={INPUT} type="url" value={draft.endpoint} maxLength={2048}
      onChange={event => update({ endpoint: event.target.value })} /></label>}
    <p>New servers are saved disabled and untrusted. Do not put secrets in commands, arguments, or URLs.
      OAuth and credential bindings are not configured here.</p>
  </>;
}

function NativeMcpPatchFields({ draft, update }: { draft: NativeMcpDraft;
  update: (patch: Partial<NativeMcpDraft>) => void }): ReactNode {
  return <>
    <label className="flex items-center gap-2"><input type="checkbox" checked={draft.enabled}
      onChange={event => update({ enabled: event.target.checked })} />Enabled</label>
    <label className="block">Deadline to change<select className={INPUT} value={draft.deadline}
      onChange={event => update({ deadline: event.target.value as NativeMcpDraft['deadline'], deadlineValue: '' })}>
      <option value="">None</option>{DEADLINES.map(key => <option key={key} value={key}>{key}</option>)}</select></label>
    {draft.deadline ? <label className="block">Milliseconds<input className={INPUT} type="number" min="0" step="1"
      value={draft.deadlineValue} onChange={event => update({ deadlineValue: event.target.value })} /></label> : null}
    <p>Existing commands, destinations and credential references stay inside NNA.</p>
  </>;
}

function errorText(code: string): string {
  if (['manifest_revision_conflict', 'nnd_configuration_resolution_conflict', 'configuration_source_shadowed'].includes(code)) {
    return 'Configuration changed. Refresh and preview again.';
  }
  if (code === 'integration_permission_denied') return 'Native permission denied.';
  if (code === 'operation_not_found') return 'No retained receipt was found. Do not retry this operation automatically.';
  if (code === 'nnd_mcp_unsupported') return 'This NNA does not expose native MCP editing.';
  return 'Native MCP change could not be completed.';
}
