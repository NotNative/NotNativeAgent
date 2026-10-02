// SPDX-License-Identifier: Apache-2.0
import type { ReactNode } from 'react';
import type { NativeConfigurationView } from '../../../lib/nnd/configuration.ts';
import { useI18n } from '../../I18nProvider.tsx';
import { chooseNativeField, inspectNativeOperation, previewNativeField, publishNativeField, repairNativeSource } from './native-configuration-controls-actions.ts';
import { invalidateNativePreview, useNativeConfigurationControlsModel, type ControlsModel } from './native-configuration-controls-model.ts';

export function NativeConfigurationControls({ view, onReload }: { view: NativeConfigurationView; onReload: () => void }): ReactNode {
  const { t } = useI18n(), model = useNativeConfigurationControlsModel(view);
  return <section className="mt-4 space-y-2 border-t border-border pt-3 text-xs" aria-label={t('settings.nativeConfiguration.manageTitle')}>
    <h3 className="font-semibold">{t('settings.nativeConfiguration.manageTitle')}</h3>
    {model.catalogError ? <p role="status">{t('settings.nativeConfiguration.catalogUnavailable')}</p> : null}
    {view.source_state === 'present' && model.catalog ? <NativeEditForm model={model} view={view} /> : null}
    {view.source_state !== 'present' && model.catalog ? <NativeRepairForm model={model} view={view} /> : null}
    <NativeOutcome model={model} view={view} onReload={onReload} />
  </section>;
}

function NativeEditForm({ model, view }: { model: ControlsModel; view: NativeConfigurationView }): ReactNode {
  const { t } = useI18n(), selected = model.selected, row = model.selectedRow;
  const projected = model.preview?.result.view.fields.find(item => item.path === selected?.path)?.effective;
  return <>
    <p>{t('settings.nativeConfiguration.manageScope')}</p>
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
      {model.mode === 'set' && <label className="block">{t('settings.nativeConfiguration.jsonValue')}
        <textarea value={model.draft} onChange={event => { invalidateNativePreview(model); model.setDraft(event.target.value); }}
          disabled={model.busy || Boolean(model.pendingOperation)} rows={3} maxLength={8192}
          className="block w-full rounded border border-border bg-background p-2 font-mono" />
      </label>}
      <button type="button" onClick={() => previewNativeField(model, view)} disabled={model.busy || Boolean(model.pendingOperation)}>
        {t('settings.nativeConfiguration.preview')}</button>
      {model.preview && <div role="status" className="rounded border border-border p-2">
        <p>{t('settings.nativeConfiguration.previewReady')}</p>
        <p>{projected?.present ? JSON.stringify(projected) : t('settings.nativeConfiguration.absent')}</p>
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
