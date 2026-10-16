// SPDX-License-Identifier: Apache-2.0
import { useEffect, useSyncExternalStore, type ReactNode } from 'react';
import type { NativeConfigurationView, NativeValue } from '../../../lib/nnd/configuration.ts';
import { authorityState, subscribeAuthority } from '../../../sync/authority-sync.ts';
import { AGENT_SETTINGS, agentDraftValid, type AgentSetting } from './agent-settings-fields.ts';
import { invalidateNativePreview, useNativeConfigurationControlsModel, type ControlsModel } from './native-configuration-controls-model.ts';
import { chooseNativeField, inspectNativeOperation, previewNativeField, publishNativeField } from './native-configuration-controls-actions.ts';
import { LadderDraftInput, ladderDraftValid, localRetryLimit } from './native-configuration-ladder.tsx';

export function agentValue(value: NativeValue | undefined): string {
  if (!value?.present) return 'Not set';
  if (!('value' in value)) return 'Value unavailable';
  if (value.value === null) return 'Unset';
  if (Array.isArray(value.value)) return value.value.join(' → ');
  return String(value.value) || '(empty)';
}

export function AgentSettingsEditor({ view, groups, onReload }: {
  view: NativeConfigurationView; groups: AgentSetting['group'][]; onReload: () => void;
}): ReactNode {
  const model = useNativeConfigurationControlsModel(view);
  const authority = useSyncExternalStore(subscribeAuthority, authorityState);
  useEffect(() => { if (authority !== 'ready') invalidateNativePreview(model); }, [authority]);
  const fields = AGENT_SETTINGS.filter(field => groups.includes(field.group));
  const selected = fields.find(field => field.path === model.selected?.path);
  const locked = authority !== 'ready' || model.busy || Boolean(model.pendingOperation);
  if (view.source_state !== 'present') return <p role="alert">The user configuration is missing or invalid. Repair it in Advanced before editing.</p>;
  return <div className="space-y-4" data-testid="agent-settings-editor">
    {authority !== 'ready' ? <p role="alert">Changes are paused until native authority has resynchronized.</p> : null}
    {model.catalogError ? <p role="alert">Could not load editable settings. Reload values to retry.</p> : null}
    {fields.map(field => <div key={field.path}><fieldset disabled={locked}>
      <AgentSettingRow field={field} view={view} model={model} />
      {selected?.path === field.path ? <AgentSettingForm field={field} model={model} view={view} fields={fields} /> : null}
    </fieldset>{selected?.path === field.path ? <AgentEditOutcome model={model} view={view} onReload={onReload} /> : null}</div>)}
    {!selected ? <><p className="text-xs text-muted-foreground">Choose a setting to edit. Every change requires native preview before saving.</p>
      <AgentEditOutcome model={model} view={view} onReload={onReload} /></> : null}
  </div>;
}

function AgentSettingForm({ field, model, view, fields }: {
  field: AgentSetting; model: ControlsModel; view: NativeConfigurationView; fields: AgentSetting[];
}): ReactNode {
  return <section className="mt-2 space-y-3 rounded-lg border border-primary/40 p-4" aria-label={`Edit ${field.label}`}>
    <h3 className="font-medium">{field.label}</h3>
    <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={model.mode === 'reset'}
      onChange={event => { invalidateNativePreview(model); model.setMode(event.target.checked ? 'reset' : 'set'); }} />Reset this user override</label>
    {model.mode === 'set' ? <AgentDraftInput field={field} model={model} view={view} /> : <p className="text-xs">Preview the inherited value before saving.</p>}
    <button type="button" className="rounded border border-border px-3 py-2 text-sm" disabled={model.mode === 'set'
      && (!agentDraftValid(field, model.draft) || field.type === 'array' && !ladderDraftValid(model.draft, localRetryLimit(view)))}
      onClick={() => previewNativeField(model, view)}>Preview change</button>
    <button type="button" className="ml-3 rounded border border-border px-3 py-2 text-sm" onClick={() => {
      invalidateNativePreview(model); model.setFieldPath(''); model.setDraft(''); model.setMode('set'); model.setError(null); model.setReceipt(null);
    }}>Cancel edit</button>
    {model.preview ? <AgentPreview model={model} view={view} fields={fields} /> : null}
  </section>;
}

function AgentSettingRow({ field, view, model }: { field: AgentSetting; view: NativeConfigurationView; model: ControlsModel }): ReactNode {
  const row = view.fields.find(item => item.path === field.path);
  const editable = model.fields.some(item => item.path === field.path && item.type === field.type)
    && !(row?.explicit.present && !('value' in row.explicit)) && !(row?.effective.present && !('value' in row.effective));
  return <section className="rounded-lg border border-border/60 p-3" data-settings-item={`agent.${field.path}`}>
    <div className="flex items-start justify-between gap-3"><div className="min-w-0">
      <h3 className="text-sm font-medium">{field.label}</h3><p className="mt-1 text-xs text-muted-foreground">{field.help}</p>
      <p className="mt-2 whitespace-pre-wrap break-words text-xs">{agentValue(row?.effective)}</p>
    </div><button type="button" aria-label={`Edit ${field.label}`} disabled={!editable} aria-pressed={model.fieldPath === field.path}
      onClick={() => { if (model.fieldPath !== field.path) chooseNativeField(model, view, field.path,
        field.zero && row?.effective.present && 'value' in row.effective && row.effective.value === null ? '0' : undefined); }}
      className="rounded border border-border px-3 py-1 text-xs">Edit</button></div>
    {!editable ? <p className="mt-1 text-xs text-muted-foreground">Editing is unavailable from this runtime.</p> : null}
    <details className="mt-2 text-xs text-muted-foreground"><summary>Source and user override</summary>
      <p className="break-all">{field.path}</p><p>Source: {row?.effective.source ?? 'Unknown'}</p>
      <p className="whitespace-pre-wrap break-words">User override: {agentValue(row?.explicit)}</p>
    </details>
  </section>;
}

function AgentDraftInput({ field, model, view }: { field: AgentSetting; model: ControlsModel; view: NativeConfigurationView }): ReactNode {
  const change = (value: string) => { invalidateNativePreview(model); model.setDraft(value); };
  const css = 'rounded border border-border bg-background p-2 text-sm';
  if (field.type === 'array') return <LadderDraftInput model={model} view={view} />;
  if (field.type === 'boolean') return <label className="flex items-center gap-2 text-sm"><input type="checkbox" aria-label={field.label}
    checked={model.draft === 'true'} onChange={event => change(String(event.target.checked))} />{field.label}</label>;
  if (field.type === 'enum') return <select className={css} aria-label={field.label} value={JSON.parse(model.draft)}
    onChange={event => change(JSON.stringify(event.target.value))}>{model.selected?.enum?.map(value => <option key={value}>{value}</option>)}</select>;
  if (field.type === 'string') {
    let value = ''; try { const parsed = JSON.parse(model.draft); if (typeof parsed === 'string') value = parsed; } catch { /* incomplete input stays unsaved */ }
    return <textarea className={`${css} w-full`} aria-label={field.label} rows={5} maxLength={4096} value={value}
      onChange={event => change(JSON.stringify(event.target.value))} />;
  }
  return <label className="block text-xs">{field.label}<input type="number" className={`${css} ml-3`} aria-label={field.label}
    min={field.zero ? 0 : field.min} max={field.max} step={field.type === 'integer' ? 1 : 'any'}
    value={model.draft === 'null' ? '' : model.draft} onChange={event => change(event.target.value)} /></label>;
}

function AgentPreview({ model, view, fields }: { model: ControlsModel; view: NativeConfigurationView; fields: AgentSetting[] }): ReactNode {
  return <div role="status" className="space-y-2 rounded border border-border p-3 text-xs">
    <h4 className="font-medium">Resolved preview</h4>
    <p>Native validation passed. Review the resolved values before saving.</p>
    <dl className="grid grid-cols-[1fr_1fr] gap-2">{fields.map(field => <div key={field.path} className="contents">
      <dt>{field.label}</dt><dd className="whitespace-pre-wrap break-words">{agentValue(model.preview?.result.view.fields.find(row => row.path === field.path)?.effective)}</dd>
    </div>)}</dl>
    <button type="button" className="rounded bg-primary px-3 py-2 text-primary-foreground" onClick={() => {
      if (model.preview) publishNativeField(model, view);
    }}>Save to NNA</button>
  </div>;
}

function AgentEditOutcome({ model, view, onReload }: { model: ControlsModel; view: NativeConfigurationView; onReload: () => void }): ReactNode {
  const conflict = ['manifest_revision_conflict', 'nnd_configuration_resolution_conflict', 'configuration_source_shadowed'].includes(model.error ?? '');
  return <div className="space-y-2 text-xs">
    {model.busy ? <p role="status">Waiting for NNA…</p> : null}
    {model.error ? <p role="alert">{conflict ? 'Configuration changed or a higher source owns this setting. Your edit is preserved. Reload values to compare before trying again.'
      : 'NNA did not confirm this change.'} ({model.error})</p> : null}
    {model.pendingOperation && !model.receipt && !model.busy ? <><p role="status">Save outcome is unknown. Check the operation before making another change.</p>
      <button type="button" onClick={() => inspectNativeOperation(model, view)}>Check save outcome</button></> : null}
    {model.receipt ? <p role="status">{model.receipt.persistence === 'saved' ? 'User defaults saved. Restart NNA to load them. Running engines were not changed.' : `Save outcome: ${model.receipt.persistence}.`}</p> : null}
    {model.receipt || conflict ? <button type="button" disabled={model.busy} onClick={onReload}>Reload values (discard edit)</button> : null}
  </div>;
}
