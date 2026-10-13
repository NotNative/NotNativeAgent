// SPDX-License-Identifier: Apache-2.0
import type { ReactNode } from 'react';
import type { NativeConfigurationView } from '../../../lib/nnd/configuration.ts';
import { useI18n } from '../../I18nProvider.tsx';
import { chooseNativeField, previewNativeField, publishNativeField } from './native-configuration-controls-actions.ts';
import { invalidateNativePreview, type ControlsModel } from './native-configuration-controls-model.ts';

function selectedValue(draft: string): string {
  try { const value: unknown = JSON.parse(draft); return typeof value === 'string' ? value : ''; }
  catch { return ''; }
}

function TuiValue({ model }: { model: ControlsModel }): ReactNode {
  const { t } = useI18n(), selected = model.selected;
  if (!selected || model.mode === 'reset') return null;
  if (selected.type === 'boolean') return <label className="flex items-center gap-2">
    <input type="checkbox" checked={model.draft === 'true'} disabled={model.busy || Boolean(model.pendingOperation)}
      onChange={event => { invalidateNativePreview(model); model.setDraft(JSON.stringify(event.target.checked)); }} />
    {t(selected.path === 'tui.color' ? 'settings.nativeTui.color' : 'settings.nativeTui.reducedMotion')}
  </label>;
  return <label className="block">{t('settings.nativeTui.binding')}
    <input type="text" value={selectedValue(model.draft)} maxLength={32} disabled={model.busy || Boolean(model.pendingOperation)}
      onChange={event => { invalidateNativePreview(model); model.setDraft(JSON.stringify(event.target.value)); }}
      className="ml-2 rounded border border-border bg-background p-1" />
  </label>;
}

export function NativeTuiEditForm({ model, view }: { model: ControlsModel; view: NativeConfigurationView }): ReactNode {
  const { t } = useI18n();
  const fields = model.fields.filter(field => field.path === 'tui.color' || field.path === 'tui.reduced_motion'
    || field.path.startsWith('tui.key_bindings.'));
  const selected = fields.find(field => field.path === model.fieldPath);
  const row = view.fields.find(field => field.path === selected?.path);
  const current = row?.explicit.present && 'value' in row.explicit ? String(row.explicit.value)
    : t('settings.nativeTui.inherited');
  if (fields.length === 0) return <p role="status">{t('settings.nativeTui.unavailable')}</p>;
  return <div className="space-y-2" data-settings-item="native-tui.preferences">
    <p>{t('settings.nativeConfiguration.manageScope')}</p>
    <label className="block">{t('settings.nativeTui.choose')}
      <select value={model.fieldPath} disabled={model.busy || Boolean(model.pendingOperation)}
        onChange={event => chooseNativeField(model, view, event.target.value)}
        className="ml-2 rounded border border-border bg-background p-1">
        <option value="">{t('settings.nativeConfiguration.choosePlaceholder')}</option>
        {fields.map(field => <option value={field.path} key={field.path}>{field.path}</option>)}
      </select>
    </label>
    {selected ? <>
      <p>{t('settings.nativeTui.current')}: {current}</p>
      <label className="block">{t('settings.nativeConfiguration.action')}
        <select value={model.mode} disabled={model.busy || Boolean(model.pendingOperation)}
          onChange={event => { invalidateNativePreview(model); model.setMode(event.target.value as 'set' | 'reset'); }}
          className="ml-2 rounded border border-border bg-background p-1">
          <option value="set">{t('settings.nativeConfiguration.set')}</option>
          <option value="reset">{t('settings.nativeConfiguration.reset')}</option>
        </select>
      </label>
      <TuiValue model={model} />
      <button type="button" disabled={model.busy || Boolean(model.pendingOperation)}
        onClick={() => previewNativeField(model, view)}>{t('settings.nativeConfiguration.preview')}</button>
      {model.preview ? <div role="status" className="rounded border border-border p-2">
        <p>{t('settings.nativeConfiguration.previewReady')}</p>
        <button type="button" disabled={model.busy} onClick={() => publishNativeField(model, view)}>
          {t('settings.nativeConfiguration.save')}</button>
      </div> : null}
    </> : null}
  </div>;
}
