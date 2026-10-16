// SPDX-License-Identifier: Apache-2.0
import { useState } from 'react';
import { createSecret, updateSecret, rotateSecret, SECRET_KINDS,
  type PublicSecret, type SecretKindName, type SecretScopeName } from '../../../lib/nnd/secret-actions.ts';
import { useSettingsEdit } from '../edit-boundary.tsx';
import { confirmSecret, type useSecretActions } from './secret-actions-model.ts';

type Model = ReturnType<typeof useSecretActions>;
const namesFor = (kind: SecretKindName) => kind === 'username_password' ? ['username', 'password'] : [kind === 'text' ? 'value' : kind];
export function SecretEditor({ mode, secret, model, onClose }: {
  mode: 'create' | 'edit' | 'rotate'; secret?: PublicSecret; model: Model; onClose(): void;
}) {
  const [label, setLabel] = useState(secret?.label ?? ''), [kind, setKind] = useState<SecretKindName>(secret?.kind ?? 'api_key');
  const initialScope = mode === 'create' ? model.data?.scopes[0] : secret?.scope;
  const [scopeKind, setScopeKind] = useState<string>(initialScope?.kind ?? ''), [scopeId, setScopeId] = useState(initialScope?.id ?? '');
  const scopes = [...(model.data?.scopes ?? [])];
  if (secret?.scope && !scopes.some(scope => scope.kind === secret.scope!.kind && scope.id === secret.scope!.id)) scopes.push(secret.scope);
  const [fields, setFields] = useState<string[]>(mode === 'rotate' ? [...secret!.fields] : namesFor(kind));
  const [values, setValues] = useState<Record<string, string>>({});
  const [replaceMetadata, setReplaceMetadata] = useState(false), [metadataName, setMetadataName] = useState(''), [metadataValue, setMetadataValue] = useState('');
  const scope = scopeKind ? { kind: scopeKind as SecretScopeName, id: scopeId.trim() } : null;
  const scopeChanged = scopeKind !== (initialScope?.kind ?? '') || (scopeKind && scopeId.trim() !== initialScope?.id);
  useSettingsEdit('Secret editor', Boolean(Object.values(values).some(Boolean) || scopeChanged || replaceMetadata ||
    label !== (secret?.label ?? '') || mode === 'create' && (kind !== 'api_key' || fields.join(',') !== namesFor('api_key').join(','))));
  const validName = (name: string) => /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(name);
  const valid = label.trim().length > 0 && label.trim().length <= 96 && (!scope || scope.id.length > 0)
    && (mode === 'edit' || fields.every(name => validName(name) && (values[name]?.length ?? 0) > 0 && values[name]!.length <= 20000))
    && (!replaceMetadata || !metadataName || validName(metadataName))
    && (mode !== 'edit' || label.trim() !== secret?.label || Boolean(scopeChanged) || replaceMetadata);
  const submit = () => {
    const metadata = mode === 'edit' && !replaceMetadata ? secret!.metadata : metadataName ? { [metadataName]: metadataValue } : {};
    const expected = { label: label.trim(), scope, metadata };
    void model.run(mode === 'create' ? `Created ${label.trim()}` : mode === 'edit' ? `Updated ${label.trim()}` : `Rotated ${secret!.label}`,
      async signal => {
        if (mode === 'rotate') return confirmSecret(await rotateSecret(secret!.id, values, signal), { id: secret!.id, fields: secret!.fields });
        if (mode === 'edit') {
          const patch = { ...(label.trim() !== secret!.label ? { label: label.trim() } : {}), ...(scopeChanged ? { scope } : {}), ...(replaceMetadata ? { metadata } : {}) };
          return confirmSecret(await updateSecret(secret!.id, patch, signal), { id: secret!.id, ...patch });
        }
        return confirmSecret(await createSecret({ ...expected, kind, fields: values }, signal), { ...expected, kind, fields: [...fields].sort() });
      }, onClose);
  };
  return <fieldset disabled={model.busy || !model.ready || !model.data?.can_manage || Boolean(model.error)} className="space-y-3 rounded-lg border border-primary/40 p-4" data-testid="secret-editor">
    <legend className="px-2 text-sm font-semibold">{mode === 'create' ? 'New secret' : mode === 'edit' ? `Edit ${secret!.label}` : `Rotate ${secret!.label}`}</legend>
    {mode !== 'rotate' ? <><label className="block">Label <input aria-label="Secret label" maxLength={96} value={label} onChange={event => setLabel(event.target.value)} /></label>
      {mode === 'create' ? <label className="block">Kind <select aria-label="Secret kind" value={kind} onChange={event => { const next = event.target.value as SecretKindName; setKind(next); setFields(namesFor(next)); setValues({}); }}>
        {SECRET_KINDS.map(item => <option key={item} value={item}>{item === 'username_password' ? 'Username and password' : item}</option>)}</select></label> : null}
      <label className="block">Ownership scope <select aria-label="Secret scope" value={`${scopeKind}:${scopeId}`} onChange={event => {
        const selected = scopes.find(scope => `${scope.kind}:${scope.id}` === event.target.value); if (selected) { setScopeKind(selected.kind); setScopeId(selected.id); }
      }}>{!initialScope ? <option value=":">Existing scope (unchanged)</option> : null}
        {scopes.map(scope => <option key={`${scope.kind}:${scope.id}`} value={`${scope.kind}:${scope.id}`}>{scope.kind} · {scope.id}</option>)}</select></label>
      <p>NNA reports available ownership scopes. Selecting one does not grant additional workspace or tool authority.</p>
      <label className="block"><input type="checkbox" checked={replaceMetadata} onChange={event => setReplaceMetadata(event.target.checked)} /> Replace metadata</label>
      {replaceMetadata ? <><label>Metadata name <input aria-label="Metadata name" maxLength={64} value={metadataName} onChange={event => setMetadataName(event.target.value)} /></label>
        <label>Metadata value <input aria-label="Metadata value" maxLength={2000} value={metadataValue} onChange={event => setMetadataValue(event.target.value)} /></label><p>An empty name clears metadata. Otherwise this replaces metadata with one entry.</p></> : null}</> : null}
    {mode !== 'edit' ? fields.map((name, index) => <div key={index} className="flex flex-wrap gap-2">
      {mode === 'create' && kind !== 'username_password' ? <label>Field name <input aria-label="Secret field name" maxLength={64} value={name}
        onChange={event => { const next = event.target.value; setFields([next]); setValues(previous => ({ [next]: previous[name] ?? '' })); }} /></label> : <span>{name}</span>}
      <label>Value <input aria-label={`Secret value ${name}`} type="password" autoComplete="new-password" maxLength={20000} value={values[name] ?? ''}
        onChange={event => { const value = event.target.value; setValues(previous => ({ ...previous, [name]: value })); }} /></label></div>) : null}
    <p>Values are write-only. No stored value is read or shown. A failed or uncertain request requires checking the roster and audit before retrying.</p>
    <div className="flex gap-3"><button type="button" disabled={!valid} onClick={submit}>{mode === 'create' ? 'Create secret' : mode === 'edit' ? 'Save changes' : 'Rotate secret'}</button>
      <button type="button" onClick={onClose}>Cancel editor</button></div>
  </fieldset>;
}
