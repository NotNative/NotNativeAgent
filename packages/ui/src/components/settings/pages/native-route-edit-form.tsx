// SPDX-License-Identifier: Apache-2.0
import type { ReactNode } from 'react';
import type { NativeConfigurationView } from '../../../lib/nnd/configuration.ts';
import type { NativeEditableField } from '../../../lib/nnd/configuration-mutation.ts';
import { useI18n } from '../../I18nProvider.tsx';
import { chooseNativeField, previewNativeField, publishNativeField } from './native-configuration-controls-actions.ts';
import { invalidateNativePreview, type ControlsModel } from './native-configuration-controls-model.ts';

const ROUTE_SCALAR = /^routes\.(?:reviewer|vision)\.(?:budget|context_limit_bytes|deadline_ms|enable_thinking|max_output_tokens|reasoning_effort|temperature)$/u;
const NUMERIC_DRAFT = /^\d+(?:\.\d+)?$/u;
// Loose enough to let a decimal be typed ("0." mid-keystroke); the strict
// gate that blocks the preview stays NUMERIC_DRAFT.
const NUMERIC_DISPLAY = /^\d*\.?\d*$/u;
// Mirrors src/configuration-rules.js so obviously wrong drafts never reach the
// preview; the engine stays the authority and revalidates on save.
const ROUTE_BOUNDS: Record<string, { min: number; max: number }> = {
  budget: { min: 1, max: 64 },
  context_limit_bytes: { min: 65_536, max: 16_777_216 },
  deadline_ms: { min: 100, max: 86_400_000 },
  max_output_tokens: { min: 1, max: 1_048_576 },
  temperature: { min: 0, max: 2 },
};

function parseDraft(draft: string): unknown {
  try { return JSON.parse(draft); } catch { return undefined; }
}

function routeScalarValid(field: NativeEditableField, draft: string): boolean {
  if (field.type === 'boolean') return draft === 'true' || draft === 'false';
  if (field.type === 'enum') {
    const value = parseDraft(draft);
    return typeof value === 'string' && Boolean(field.enum?.includes(value));
  }
  if (field.type !== 'integer' && field.type !== 'number') return true;
  if (!NUMERIC_DRAFT.test(draft)) return false;
  // Zero is legal for the deadline, where it canonically disables it, and for
  // temperature, where the engine stores it as a real value (zero: 'value').
  if (draft === '0' || draft === '0.0') {
    return field.path.endsWith('.deadline_ms') || field.path.endsWith('.temperature');
  }
  const bounds = ROUTE_BOUNDS[field.path.split('.').pop() ?? ''];
  if (!bounds) return true;
  const value = Number(draft);
  if (field.type === 'integer' && !Number.isInteger(value)) return false;
  return value >= bounds.min && value <= bounds.max;
}

function ScalarInput({ field, model }: { field: NativeEditableField; model: ControlsModel }): ReactNode {
  const { t } = useI18n();
  const guard = (draft: string): void => { invalidateNativePreview(model); model.setDraft(draft); };
  if (field.type === 'boolean') return <label className="block">
    {t('settings.nativeConfiguration.jsonValue')}
    <input type="checkbox" checked={model.draft === 'true'} disabled={model.busy || Boolean(model.pendingOperation)}
      onChange={event => guard(event.target.checked ? 'true' : 'false')} />
  </label>;
  if (field.type === 'enum') {
    const value = typeof parseDraft(model.draft) === 'string' ? String(parseDraft(model.draft)) : '';
    return <label className="block">{t('settings.nativeConfiguration.jsonValue')}
      <select value={value} disabled={model.busy || Boolean(model.pendingOperation)}
        onChange={event => guard(event.target.value ? JSON.stringify(event.target.value) : '')}>
        <option value="">{t('settings.nativeConfiguration.choosePlaceholder')}</option>
        {(field.enum ?? []).map(option => <option key={option} value={option}>{option}</option>)}
      </select>
    </label>;
  }
  if (field.type === 'integer' || field.type === 'number') {
    const bounds = ROUTE_BOUNDS[field.path.split('.').pop() ?? ''];
    return <label className="block">{t('settings.nativeConfiguration.jsonValue')}
      <input type="number" min={bounds?.min} max={bounds?.max}
        step={field.type === 'integer' ? '1' : 'any'} value={NUMERIC_DISPLAY.test(model.draft) ? model.draft : ''}
        disabled={model.busy || Boolean(model.pendingOperation)}
        onChange={event => guard(event.target.value)} />
    </label>;
  }
  return <label className="block">{t('settings.nativeConfiguration.jsonValue')}
    <textarea value={model.draft} rows={3} maxLength={8192} disabled={model.busy || Boolean(model.pendingOperation)}
      onChange={event => guard(event.target.value)} />
  </label>;
}

export function NativeRouteEditForm({ model, view }: { model: ControlsModel; view: NativeConfigurationView }): ReactNode {
  const { t } = useI18n();
  const fields = model.fields.filter(field => ROUTE_SCALAR.test(field.path) && field.type !== 'array');
  const selected = fields.find(field => field.path === model.fieldPath);
  const row = view.fields.find(field => field.path === selected?.path);
  const scalarPreview = model.preview?.request.operations[0]?.op !== 'bind_route' ? model.preview : null;
  const projected = scalarPreview?.result.view.fields.find(field => field.path === selected?.path)?.effective;
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
      {model.mode === 'set' ? <ScalarInput field={selected} model={model} /> : null}
      <button type="button" disabled={model.busy || Boolean(model.pendingOperation)
        || (model.mode === 'set' && !routeScalarValid(selected, model.draft))}
        onClick={() => previewNativeField(model, view)}>{t('settings.nativeConfiguration.preview')}</button>
      {scalarPreview ? <div role="status">
        <p>{t('settings.nativeConfiguration.previewReady')}</p>
        <p>{projected?.present ? JSON.stringify(projected) : t('settings.nativeConfiguration.absent')}</p>
        <button type="button" disabled={model.busy} onClick={() => publishNativeField(model, view)}>
          {t('settings.nativeConfiguration.save')}</button>
      </div> : null}
    </> : null}
  </div>;
}
