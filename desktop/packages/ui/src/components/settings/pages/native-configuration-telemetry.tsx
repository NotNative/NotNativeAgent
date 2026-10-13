// SPDX-License-Identifier: Apache-2.0
import type { ReactNode } from 'react';
import type { NativeConfigurationView } from '../../../lib/nnd/configuration.ts';
import type { NativeEditableField } from '../../../lib/nnd/configuration-mutation.ts';
import { useI18n } from '../../I18nProvider.tsx';
import { chooseNativeField } from './native-configuration-controls-actions.ts';
import { invalidateNativePreview, type ControlsModel } from './native-configuration-controls-model.ts';

// Mirrors NNA src/config.js validateTelemetry and src/config-bounds.js
// telemetryDestination: enabled is opt-in exact true, the destination must be a
// credential-free HTTP(S) URL of at most 2048 characters, and retention is an
// optional nonempty string the engine ignores while telemetry is disabled.
export const telemetryPath = (path: string): boolean => path.startsWith('telemetry.');

function draftString(draft: string): string | null {
  try {
    const parsed = JSON.parse(draft);
    return typeof parsed === 'string' ? parsed : null;
  } catch { return null; }
}

export function telemetryDraftValid(field: NativeEditableField, draft: string): boolean {
  if (field.path === 'telemetry.enabled') return draft === 'true' || draft === 'false';
  const value = draftString(draft);
  if (field.path === 'telemetry.destination') {
    if (value === null || value === '') return true;
    try {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && value.length <= 2048;
    } catch { return false; }
  }
  if (field.path === 'telemetry.retention') return value === null || value === '' || value !== '';
  // Residual gap: the engine refuses an ENABLED telemetry with a null or
  // missing destination (telemetry_destination_required); the mirror cannot
  // see the enabled flag of the same single-field save, so that refusal
  // stays the engine's at preview and save.
  return true;
}

export function TelemetryDraftInput({ field, model }: { field: NativeEditableField; model: ControlsModel }): ReactNode {
  const { t } = useI18n();
  const guard = (draft: string): void => { invalidateNativePreview(model); model.setDraft(draft); };
  if (field.path === 'telemetry.enabled') return <label className="block">
    {t('settings.nativeTelemetry.enabled')}
    <input type="checkbox" checked={model.draft === 'true'} disabled={model.busy || Boolean(model.pendingOperation)}
      onChange={event => guard(event.target.checked ? 'true' : 'false')} />
  </label>;
  return <label className="block">{field.path === 'telemetry.destination'
    ? t('settings.nativeTelemetry.destination') : t('settings.nativeTelemetry.retention')}
    <input type="text" maxLength={2048} disabled={model.busy || Boolean(model.pendingOperation)}
      value={draftString(model.draft) ?? ''}
      onChange={event => guard(event.target.value ? JSON.stringify(event.target.value) : 'null')} />
  </label>;
}

export function NativeTelemetryBlock({ model, view }: { model: ControlsModel; view: NativeConfigurationView }): ReactNode {
  const { t } = useI18n();
  const fields = model.fields.filter(field => telemetryPath(field.path));
  const enabled = view.fields.find(field => field.path === 'telemetry.enabled')?.effective;
  return fields.length ? <div className="space-y-1 rounded border border-border/60 p-2"
    data-settings-item="native-configuration.telemetry">
    <h4 className="font-semibold">{t('settings.nativeTelemetry.title')}</h4>
    <p>{t('settings.nativeTelemetry.description')}</p>
    {enabled?.present && 'value' in enabled && enabled.value === true
      ? <p className="text-muted-foreground">{t('settings.nativeTelemetry.enabledNotice')}</p> : null}
    <div className="flex flex-wrap gap-2">{fields.map(field => <button type="button" key={field.path}
      aria-pressed={model.fieldPath === field.path} disabled={model.busy || Boolean(model.pendingOperation)}
      onClick={() => chooseNativeField(model, view, field.path)} className="rounded border border-border px-2 py-1">
      {t(field.path === 'telemetry.enabled' ? 'settings.nativeTelemetry.enabled'
        : field.path === 'telemetry.destination' ? 'settings.nativeTelemetry.destination'
          : 'settings.nativeTelemetry.retention')}
    </button>)}</div>
  </div> : null;
}
