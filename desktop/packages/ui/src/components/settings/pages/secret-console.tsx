// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from 'react';
import { deleteSecret, setSecretEnabled, type PublicSecret } from '../../../lib/nnd/secret-actions.ts';
import { useSettingsEdit, useSettingsLeave } from '../edit-boundary.tsx';
import { SettingsSection } from '../primitives.tsx';
import { nativeObservationScope } from './use-native-observation.ts';
import { confirmSecret, useSecretActions } from './secret-actions-model.ts';
import { SecretEditor } from './secret-editor.tsx';

type Selection = { mode: 'create' | 'edit' | 'rotate' | 'delete' | 'status'; secret?: PublicSecret };
export function SecretActionsConsole() {
  const model = useSecretActions(), leave = useSettingsLeave(), scope = nativeObservationScope();
  const [selection, setSelection] = useState<Selection | null>(null), [query, setQuery] = useState(''), [limit, setLimit] = useState(30);
  useEffect(() => { setSelection(null); setQuery(''); }, [scope, model.ready]);
  useSettingsEdit('Secret confirmation', selection?.mode === 'delete' || selection?.mode === 'status');
  const select = (next: Selection | null) => {
    if (next && selection?.mode === next.mode && selection.secret?.id === next.secret?.id) return;
    leave(() => setSelection(next));
  };
  const rows = model.data?.secrets.filter(row => `${row.label} ${row.kind}`.toLowerCase().includes(query.toLowerCase())) ?? [];
  return <SettingsSection title="Secret vault" item="native-secret-actions.settings">
    <div className="flex flex-wrap justify-between gap-3"><p>Manage native encrypted secrets. Providers select existing bindings in Providers and models. This page never reads stored values.</p>
      <button type="button" disabled={model.busy || !model.ready} onClick={() => { void model.reload(); }}>Refresh</button></div>
    <p>This roster shows only this connection’s admitted ownership scopes. Credential diagnostics can show additional vault metadata.
      Legacy unscoped records require their native owner; this page does not expand access to them.</p>
    <div className="my-3 flex flex-wrap gap-3"><input aria-label="Search secrets" placeholder="Search label or kind…" value={query} maxLength={256} onChange={event => { setQuery(event.target.value); setLimit(30); }} />
      <button type="button" disabled={model.busy || !model.ready || !model.data?.can_manage || !model.data.scopes.length || Boolean(model.error)} onClick={() => select({ mode: 'create' })}>New secret</button></div>
    {model.busy ? <p role="status">Waiting for NNA…</p> : null}
    {model.error || model.mutationError ? <p role="alert">{model.mutationError || `Could not refresh secrets: ${model.error}. Refresh to retry.`}</p> : null}
    {model.receipt ? <p role="status" data-testid="secret-receipt">{model.receipt}. Native acknowledgement received; stored values remain hidden.</p> : null}
    {!model.ready ? <p role="alert">Reconnect to NNA before managing secrets.</p> : null}
    {model.data && !model.data.can_manage ? <p role="status">NNA admitted this connection for read-only secret access. Management actions are unavailable.</p> : null}
    <ul className="space-y-3" data-testid="secret-roster">{rows.slice(0, limit).map(secret => <li key={secret.id} className="rounded-lg border border-border p-3" data-testid="secret-row">
      <h3 className="font-semibold">{secret.label}</h3><p>{secret.kind} · {secret.enabled ? 'Enabled' : 'Disabled'} · {secret.scope ? `${secret.scope.kind}: ${secret.scope.id}` : 'Global'} · fields: {secret.fields.join(', ')}</p>
      <p>Used {secret.useCount} times · Updated {secret.updatedAt}</p>
      <div className="mt-2 flex flex-wrap gap-3">{(['edit', 'rotate', 'status', 'delete'] as const).map(mode => <button key={mode} type="button" disabled={model.busy || !model.ready || !model.data?.can_manage || Boolean(model.error)}
        onClick={() => select({ mode, secret })}>{mode === 'edit' ? 'Edit details' : mode === 'rotate' ? 'Rotate values' : mode === 'status' ? secret.enabled ? 'Disable' : 'Enable' : 'Delete'}</button>)}</div>
    </li>)}</ul>
    {model.data && !rows.length ? <p>{query ? 'No matching secrets.' : 'No secrets in the current native scopes.'}</p> : null}
    {rows.length > limit ? <button type="button" onClick={() => setLimit(value => value + 30)}>Show more secrets</button> : null}
    {selection && ['create', 'edit', 'rotate'].includes(selection.mode) ? <SecretEditor key={`${selection.mode}:${selection.secret?.id ?? 'new'}`}
      mode={selection.mode as 'create' | 'edit' | 'rotate'} secret={selection.secret} model={model} onClose={() => setSelection(null)} /> : null}
    {selection && (selection.mode === 'delete' || selection.mode === 'status') ? <SecretConfirmation selection={selection} model={model} onClose={() => setSelection(null)} /> : null}
    <details className="mt-4"><summary>Recent audit events</summary><ul data-testid="secret-audit">{model.data?.audit.slice(-12).map(event => <li key={event.id}>{event.at} · {event.event} · {event.outcome}</li>)}</ul>
      {model.data && !model.data.auditAvailable ? <p>Audit access is unavailable for this connection.</p>
        : model.data?.audit.length === 0 ? <p>No audit events recorded.</p> : null}</details>
  </SettingsSection>;
}
function SecretConfirmation({ selection, model, onClose }: { selection: Selection; model: ReturnType<typeof useSecretActions>; onClose(): void }) {
  const secret = selection.secret!, deleting = selection.mode === 'delete';
  const confirm = () => { void model.run(deleting ? `Deleted ${secret.label}` : `${secret.enabled ? 'Disabled' : 'Enabled'} ${secret.label}`,
    signal => deleting ? deleteSecret(secret.id, signal) : setSecretEnabled(secret.id, !secret.enabled, signal).then(result => confirmSecret(result, { id: secret.id, enabled: !secret.enabled })), onClose); };
  return <fieldset disabled={model.busy || !model.ready || !model.data?.can_manage || Boolean(model.error)} className="my-3 space-y-3 rounded-lg border border-destructive p-4" aria-label="Confirm secret operation">
    <p>{deleting ? `Permanently delete ${secret.label}? Consumers bound to this secret may stop working. This cannot be undone.`
      : `${secret.enabled ? 'Disable' : 'Enable'} ${secret.label}? This changes whether existing consumers can use it.`}</p>
    <button type="button" onClick={confirm}>{deleting ? 'Confirm delete' : secret.enabled ? 'Confirm disable' : 'Confirm enable'}</button>
    <button type="button" onClick={onClose}>Cancel operation</button>
  </fieldset>;
}
