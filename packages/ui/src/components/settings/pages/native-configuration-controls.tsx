// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react';
import type { NativeConfigurationView } from '../../../lib/nnd/configuration.ts';
import { useI18n } from '../../I18nProvider.tsx';
import { chooseNativeField, inspectNativeOperation, previewNativeField, publishNativeField, repairNativeSource } from './native-configuration-controls-actions.ts';
import { invalidateNativePreview, useNativeConfigurationControlsModel, type ControlsModel } from './native-configuration-controls-model.ts';
import { NativeTuiEditForm } from './native-tui-edit-form.tsx';
import { NativeRouteEditForm } from './native-route-edit-form.tsx';
import { NativeRouteBindingForm } from './native-route-binding-form.tsx';
import { authorityState, subscribeAuthority } from '../../../sync/authority-sync.ts';

const MEMORY_LIMITS: Record<string, { label: 'settings.nativeMemory.timeout' | 'settings.nativeMemory.maxItems'
  | 'settings.nativeMemory.maxBytes'; min: number; max: number }> = {
  'memory.timeout_ms': { label: 'settings.nativeMemory.timeout', min: 50, max: 30000 },
  'memory.max_items': { label: 'settings.nativeMemory.maxItems', min: 1, max: 64 },
  'memory.max_bytes': { label: 'settings.nativeMemory.maxBytes', min: 1024, max: 262144 },
};
const MEMORY_BOOLEAN: Record<string, 'settings.nativeMemory.enabled' | 'settings.nativeMemory.required'> = {
  'memory.enabled': 'settings.nativeMemory.enabled', 'memory.required': 'settings.nativeMemory.required',
};
const PROVIDER_SCHEDULING: Record<string, { label: 'settings.nativeScheduling.concurrency' | 'settings.nativeScheduling.queueLimit'; min: number; max: number }> = {
  provider_concurrency: { label: 'settings.nativeScheduling.concurrency', min: 1, max: 16 },
  provider_queue_limit: { label: 'settings.nativeScheduling.queueLimit', min: 1, max: 4096 },
};

export function NativeConfigurationControls({ view, onReload, family }: { view: NativeConfigurationView; onReload: () => void; family?: 'tui' | 'routes' }): ReactNode {
  const { t } = useI18n(), model = useNativeConfigurationControlsModel(view);
  const authority = useSyncExternalStore(subscribeAuthority, authorityState);
  const priorAuthority = useRef(authority);
  useEffect(() => {
    if (authority !== 'ready') invalidateNativePreview(model);
    else if (priorAuthority.current !== 'ready') onReload();
    priorAuthority.current = authority;
  }, [authority]);
  const title = family === 'tui' ? 'settings.page.nativeTui.title' : family === 'routes'
    ? 'settings.page.nativeRoutes.title' : 'settings.nativeConfiguration.manageTitle';
  return <section className="mt-4 space-y-2 border-t border-border pt-3 text-xs" aria-label={t(title)}>
    <h3 className="font-semibold">{t(title)}</h3>
    {authority !== 'ready' ? <p role="alert">Native settings changes are paused until authority has resynchronized.</p> : null}
    {model.catalogError ? <p role="status">{t('settings.nativeConfiguration.catalogUnavailable')}</p> : null}
    <fieldset disabled={authority !== 'ready'}>{view.source_state === 'present' && model.catalog ? family === 'tui'
      ? <NativeTuiEditForm model={model} view={view} /> : family === 'routes'
        ? <><NativeRouteEditForm model={model} view={view} />
          {model.catalog.routeBindings?.length ? <NativeRouteBindingForm model={model} view={view} /> : null}</>
        : <NativeEditForm model={model} view={view} /> : null}
    {view.source_state !== 'present' && model.catalog ? family === 'tui'
      ? <p role="status">{t('settings.nativeTui.sourceMissing')}</p> : family === 'routes'
        ? <p role="status">{t('settings.nativeRoutes.sourceMissing')}</p> : <NativeRepairForm model={model} view={view} /> : null}</fieldset>
    <NativeOutcome model={model} view={view} onReload={onReload} />
  </section>;
}

function NativeEditForm({ model, view }: { model: ControlsModel; view: NativeConfigurationView }): ReactNode {
  const { t } = useI18n(), selected = model.selected, row = model.selectedRow;
  const projected = model.preview?.result.view.fields.find(item => item.path === selected?.path)?.effective;
  const attachmentFields = model.fields.filter(field =>
    (field.path === 'attachments.enabled' || field.path === 'attachments.retain') && field.type === 'boolean'
      || field.path === 'attachments.max_bytes' && field.type === 'integer');
  const attachmentSelected = selected && attachmentFields.some(field => field.path === selected.path);
  const memoryFields = model.fields.filter(field => field.type === 'integer' && Object.hasOwn(MEMORY_LIMITS, field.path)
    || field.type === 'boolean' && Object.hasOwn(MEMORY_BOOLEAN, field.path));
  const memorySelected = selected?.type === 'integer' ? MEMORY_LIMITS[selected.path] : undefined;
  const memoryBooleanSelected = selected?.type === 'boolean' ? MEMORY_BOOLEAN[selected.path] : undefined;
  const schedulingFields = model.fields.filter(field => field.type === 'integer' && Object.hasOwn(PROVIDER_SCHEDULING, field.path));
  const schedulingSelected = selected?.type === 'integer' ? PROVIDER_SCHEDULING[selected.path] : undefined;
  return <>
    <p>{t('settings.nativeConfiguration.manageScope')}</p>
    {attachmentFields.length ? <div className="space-y-1 rounded border border-border/60 p-2"
      data-settings-item="native-configuration.attachments">
      <h4 className="font-semibold">{t('settings.nativeAttachments.title')}</h4>
      <p>{t('settings.nativeAttachments.description')}</p>
      <div className="flex flex-wrap gap-2">{attachmentFields.map(field => <button type="button" key={field.path}
        aria-pressed={model.fieldPath === field.path} disabled={model.busy || Boolean(model.pendingOperation)}
        onClick={() => chooseNativeField(model, view, field.path)} className="rounded border border-border px-2 py-1">
        {t(field.path === 'attachments.enabled' ? 'settings.nativeAttachments.enabled'
          : field.path === 'attachments.retain' ? 'settings.nativeAttachments.retain' : 'settings.nativeAttachments.maxBytes')}
      </button>)}</div>
    </div> : null}
    {memoryFields.length ? <div className="space-y-1 rounded border border-border/60 p-2"
      data-settings-item="native-configuration.memory-limits">
      <h4 className="font-semibold">{t('settings.nativeMemory.title')}</h4>
      <p>{t('settings.nativeMemory.description')}</p>
      <div className="flex flex-wrap gap-2">{memoryFields.map(field => <button type="button" key={field.path}
        aria-pressed={model.fieldPath === field.path} disabled={model.busy || Boolean(model.pendingOperation)}
        onClick={() => chooseNativeField(model, view, field.path)} className="rounded border border-border px-2 py-1">
        {t(field.type === 'boolean' ? MEMORY_BOOLEAN[field.path]! : MEMORY_LIMITS[field.path]!.label)}
      </button>)}</div>
    </div> : null}
    {schedulingFields.length ? <div className="space-y-1 rounded border border-border/60 p-2"
      data-settings-item="native-configuration.provider-scheduling">
      <h4 className="font-semibold">{t('settings.nativeScheduling.title')}</h4>
      <p>{t('settings.nativeScheduling.description')}</p>
      <div className="flex flex-wrap gap-2">{schedulingFields.map(field => <button type="button" key={field.path}
        aria-pressed={model.fieldPath === field.path} disabled={model.busy || Boolean(model.pendingOperation)}
        onClick={() => chooseNativeField(model, view, field.path)} className="rounded border border-border px-2 py-1">
        {t(PROVIDER_SCHEDULING[field.path]!.label)}
      </button>)}</div>
    </div> : null}
    <label className="block">{t('settings.nativeConfiguration.chooseField')}
      <select value={model.fieldPath} onChange={event => chooseNativeField(model, view, event.target.value)}
        disabled={model.busy || Boolean(model.pendingOperation)} className="ml-2 rounded border border-border bg-background p-1">
        <option value="">{t('settings.nativeConfiguration.choosePlaceholder')}</option>
        {model.fields.map(field => <option key={field.path} value={field.path}>{field.path}</option>)}
      </select>
    </label>
    {selected && <>
      <p>{t('settings.nativeConfiguration.type')}: {selected.type}{selected.type === 'enum' ? ` (${selected.enum?.join(', ')})` : ''}</p>
      <p>{t('settings.nativeConfiguration.current')}: {row?.explicit.present && 'value' in row.explicit
        ? JSON.stringify(row.explicit.value) : t('settings.nativeConfiguration.absent')}</p>
      <label className="block">{t('settings.nativeConfiguration.action')}
        <select value={model.mode} onChange={event => { invalidateNativePreview(model); model.setMode(event.target.value as 'set' | 'reset'); }}
          disabled={model.busy || Boolean(model.pendingOperation)} className="ml-2 rounded border border-border bg-background p-1">
          <option value="set">{t('settings.nativeConfiguration.set')}</option>
          <option value="reset">{t('settings.nativeConfiguration.reset')}</option>
        </select>
      </label>
      {model.mode === 'set' && attachmentSelected && selected.type === 'boolean' ? <label className="flex items-center gap-2">
        <input type="checkbox" checked={model.draft === 'true'} disabled={model.busy || Boolean(model.pendingOperation)}
          onChange={event => { invalidateNativePreview(model); model.setDraft(JSON.stringify(event.target.checked)); }} />
        {t(selected.path === 'attachments.enabled' ? 'settings.nativeAttachments.enabled' : 'settings.nativeAttachments.retain')}
      </label> : null}
      {model.mode === 'set' && attachmentSelected && selected.type === 'integer' ? <label className="block">
        {t('settings.nativeAttachments.maxBytes')}
        <input type="number" min="1024" max="104857600" step="1" value={/^\d+$/u.test(model.draft) ? model.draft : ''}
          disabled={model.busy || Boolean(model.pendingOperation)}
          onChange={event => { invalidateNativePreview(model); model.setDraft(event.target.value); }}
          className="ml-2 rounded border border-border bg-background p-1" />
      </label> : null}
      {model.mode === 'set' && memorySelected ? <label className="block">
        {t(memorySelected.label)}
        <input type="number" min={memorySelected.min} max={memorySelected.max} step="1"
          value={/^\d+$/u.test(model.draft) ? model.draft : ''}
          disabled={model.busy || Boolean(model.pendingOperation)}
          onChange={event => { invalidateNativePreview(model); model.setDraft(event.target.value); }}
          className="ml-2 rounded border border-border bg-background p-1" />
      </label> : null}
      {model.mode === 'set' && memoryBooleanSelected ? <label className="flex items-center gap-2">
        <input type="checkbox" checked={model.draft === 'true'} disabled={model.busy || Boolean(model.pendingOperation)}
          onChange={event => { invalidateNativePreview(model); model.setDraft(JSON.stringify(event.target.checked)); }} />
        {t(memoryBooleanSelected)}
      </label> : null}
      {model.mode === 'set' && schedulingSelected ? <label className="block">
        {t(schedulingSelected.label)}
        <input type="number" min={schedulingSelected.min} max={schedulingSelected.max} step="1"
          value={/^\d+$/u.test(model.draft) ? model.draft : ''}
          disabled={model.busy || Boolean(model.pendingOperation)}
          onChange={event => { invalidateNativePreview(model); model.setDraft(event.target.value); }}
          className="ml-2 rounded border border-border bg-background p-1" />
      </label> : null}
      {model.mode === 'set' && selected.path === 'memory.enabled' && model.draft === 'false'
        ? <p>{t('settings.nativeMemory.disableAlsoClearsRequired')}</p> : null}
      {model.mode === 'set' && selected.path === 'memory.required' && model.draft === 'true'
        ? <p>{t('settings.nativeMemory.requireAlsoEnables')}</p> : null}
      {model.mode === 'set' && !attachmentSelected && !memorySelected && !memoryBooleanSelected && !schedulingSelected && <label className="block">{t('settings.nativeConfiguration.jsonValue')}
        <textarea value={model.draft} onChange={event => { invalidateNativePreview(model); model.setDraft(event.target.value); }}
          disabled={model.busy || Boolean(model.pendingOperation)} rows={3} maxLength={8192}
          className="block w-full rounded border border-border bg-background p-2 font-mono" />
      </label>}
      <button type="button" onClick={() => previewNativeField(model, view)} disabled={model.busy || Boolean(model.pendingOperation)}>
        {t('settings.nativeConfiguration.preview')}</button>
      {model.preview && <div role="status" className="rounded border border-border p-2">
        <p>{t('settings.nativeConfiguration.previewReady')}</p>
        {memoryBooleanSelected ? (['memory.enabled', 'memory.required'] as const).map(path => {
          const before = view.fields.find(item => item.path === path)?.effective;
          const after = model.preview?.result.view.fields.find(item => item.path === path)?.effective;
          return <p key={path}>{t(MEMORY_BOOLEAN[path]!)}: {before?.present && 'value' in before ? String(before.value) : t('settings.nativeConfiguration.absent')}
            {' → '}{after?.present && 'value' in after ? String(after.value) : t('settings.nativeConfiguration.absent')}</p>;
        }) : <p>{projected?.present ? JSON.stringify(projected) : t('settings.nativeConfiguration.absent')}</p>}
        <button type="button" onClick={() => publishNativeField(model, view)} disabled={model.busy}>{t('settings.nativeConfiguration.save')}</button>
      </div>}
    </>}
  </>;
}

function NativeRepairForm({ model, view }: { model: ControlsModel; view: NativeConfigurationView }): ReactNode {
  const { t } = useI18n();
  return <div className="space-y-2">
    <p>{t('settings.nativeConfiguration.repairGuidance')}</p>
    <label className="block">{t('settings.nativeConfiguration.repairDocument')}
      <textarea value={model.repairDraft} onChange={event => model.setRepairDraft(event.target.value)}
        disabled={model.busy || Boolean(model.pendingOperation)} rows={8} maxLength={8192}
        className="block w-full rounded border border-border bg-background p-2 font-mono" />
    </label>
    <label className="flex gap-2"><input type="checkbox" checked={model.repairConfirmed}
      onChange={event => model.setRepairConfirmed(event.target.checked)} disabled={model.busy || Boolean(model.pendingOperation)} />
      {t('settings.nativeConfiguration.repairConfirm')}</label>
    <button type="button" onClick={() => repairNativeSource(model, view)}
      disabled={!model.repairConfirmed || model.busy || Boolean(model.pendingOperation)}>{t('settings.nativeConfiguration.repair')}</button>
  </div>;
}

function NativeOutcome({ model, view, onReload }: { model: ControlsModel; view: NativeConfigurationView; onReload: () => void }): ReactNode {
  const { t } = useI18n(), error = model.error;
  const conflict = error && ['manifest_revision_conflict', 'nnd_configuration_resolution_conflict', 'configuration_source_shadowed'].includes(error);
  return <>
    {model.busy ? <p role="status">{t('settings.nativeConfiguration.working')}</p> : null}
    {error ? <p role="alert">{conflict ? t('settings.nativeConfiguration.conflict')
      : error === 'integration_permission_denied' ? t('settings.nativeConfiguration.denied')
        : error === 'operation_not_found' ? t('settings.nativeConfiguration.operationMissing')
          : t('settings.nativeConfiguration.mutationError')} ({error})</p> : null}
    {model.pendingOperation && !model.receipt && !model.busy ? <div role="status">
      <p>{t('settings.nativeConfiguration.outcomeUnknown')} {model.pendingOperation}</p>
      <button type="button" onClick={() => inspectNativeOperation(model, view)} disabled={model.busy}>
        {t('settings.nativeConfiguration.inspectOperation')}</button>
    </div> : null}
    {model.receipt ? <div role="status"><p>{t('settings.nativeConfiguration.receipt')}: {model.receipt.persistence}; {model.receipt.operation_id}</p>
      <p>{t('settings.nativeConfiguration.notApplied')}</p>
      {model.receipt.persistence === 'saved' ? <button type="button" onClick={onReload}>{t('settings.nativeConfiguration.refresh')}</button>
        : <button type="button" onClick={() => inspectNativeOperation(model, view)} disabled={model.busy}>
          {t('settings.nativeConfiguration.inspectOperation')}</button>}
    </div> : null}
  </>;
}
