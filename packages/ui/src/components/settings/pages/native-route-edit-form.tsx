// SPDX-License-Identifier: Apache-2.0
import type { ReactNode } from 'react';
import type { NativeConfigurationView } from '../../../lib/nnd/configuration.ts';
import { useI18n } from '../../I18nProvider.tsx';
import { chooseNativeField, previewNativeField, publishNativeField } from './native-configuration-controls-actions.ts';
import { invalidateNativePreview, type ControlsModel } from './native-configuration-controls-model.ts';

const ROUTE_SCALAR = /^routes\.(?:reviewer|vision)\.(?:budget|context_limit_bytes|deadline_ms|enable_thinking|max_output_tokens|reasoning_effort|temperature)$/u;

export function NativeRouteEditForm({ model, view }: { model: ControlsModel; view: NativeConfigurationView }): ReactNode {
  const { t } = useI18n();
  const fields = model.fields.filter(field => ROUTE_SCALAR.test(field.path) && field.type !== 'array');
  const selected = fields.find(field => field.path === model.fieldPath);
  const row = view.fields.find(field => field.path === selected?.path);
  const projected = model.preview?.result.view.fields.find(field => field.path === selected?.path)?.effective;
  if (fields.length === 0) return <p role="status">{t('settings.nativeRoutes.unavailable')}</p>;
  return <div className="space-y-2" data-settings-item="native-routes.tuning">
    <p>{t('settings.nativeConfiguration.manageScope')}</p>
    <label className="block">{t('settings.nativeRoutes.choose')}
      <select value={model.fieldPath} disabled={model.busy || Boolean(model.pendingOperation)}
        onChange={event => chooseNativeField(model, view, event.target.value)}>
        <option value="">{t('settings.nativeConfiguration.choosePlaceholder')}</option>
        {fields.map(field => <option key={field.path} value={field.path}>{field.path}</option>)}
      </select>
    </label>
    {selected ? <>
      <p>{t('settings.nativeConfiguration.type')}: {selected.type}</p>
      <p>{t('settings.nativeConfiguration.current')}: {row?.explicit.present && 'value' in row.explicit
        ? JSON.stringify(row.explicit.value) : t('settings.nativeConfiguration.absent')}</p>
      <label className="block">{t('settings.nativeConfiguration.action')}
        <select value={model.mode} disabled={model.busy || Boolean(model.pendingOperation)}
          onChange={event => { invalidateNativePreview(model); model.setMode(event.target.value as 'set' | 'reset'); }}>
          <option value="set">{t('settings.nativeConfiguration.set')}</option>
          <option value="reset">{t('settings.nativeConfiguration.reset')}</option>
        </select>
      </label>
      {model.mode === 'set' ? <label className="block">{t('settings.nativeConfiguration.jsonValue')}
        <textarea value={model.draft} rows={3} maxLength={8192} disabled={model.busy || Boolean(model.pendingOperation)}
          onChange={event => { invalidateNativePreview(model); model.setDraft(event.target.value); }} />
      </label> : null}
      <button type="button" disabled={model.busy || Boolean(model.pendingOperation)}
        onClick={() => previewNativeField(model, view)}>{t('settings.nativeConfiguration.preview')}</button>
      {model.preview ? <div role="status">
        <p>{t('settings.nativeConfiguration.previewReady')}</p>
        <p>{projected?.present ? JSON.stringify(projected) : t('settings.nativeConfiguration.absent')}</p>
        <button type="button" disabled={model.busy} onClick={() => publishNativeField(model, view)}>
          {t('settings.nativeConfiguration.save')}</button>
      </div> : null}
    </> : null}
  </div>;
}
