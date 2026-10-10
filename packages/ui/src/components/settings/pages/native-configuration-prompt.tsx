// SPDX-License-Identifier: Apache-2.0
import type { ReactNode } from 'react';
import type { NativeConfigurationView } from '../../../lib/nnd/configuration.ts';
import type { NativeEditableField } from '../../../lib/nnd/configuration-mutation.ts';
import { useI18n } from '../../I18nProvider.tsx';
import { chooseNativeField } from './native-configuration-controls-actions.ts';
import { invalidateNativePreview, type ControlsModel } from './native-configuration-controls-model.ts';

// Mirrors NNA src/configuration-catalog-metadata.js manifest family:
// persistence is the enum durable|ephemeral (a change needs a new session),
// and application_system_prompt is a free string the engine treats as empty
// when nullish. The engine revalidates every draft on save.
export const promptPath = (path: string): boolean => path === 'persistence' || path === 'application_system_prompt';

function draftString(draft: string): string | null {
  try {
    const parsed = JSON.parse(draft);
    return typeof parsed === 'string' ? parsed : null;
  } catch { return null; }
}

export function promptDraftValid(field: NativeEditableField, draft: string): boolean {
  if (field.path === 'persistence') {
    const value = draftString(draft);
    return value !== null && (field.enum ?? ['durable', 'ephemeral']).includes(value);
  }
  if (field.path === 'application_system_prompt') {
    // typedValue caps string drafts at 4096 on this layer (configuration-mutation.ts).
    try { const parsed = JSON.parse(draft); return parsed === null || typeof parsed === 'string'; } catch { return false; }
  }
  return true;
}

export function PromptDraftInput({ field, model }: { field: NativeEditableField; model: ControlsModel }): ReactNode {
  const { t } = useI18n();
  const guard = (draft: string): void => { invalidateNativePreview(model); model.setDraft(draft); };
  if (field.path === 'persistence') {
    const value = draftString(model.draft) ?? '';
    return <label className="block">{t('settings.nativePrompt.persistence')}
      <select value={value} disabled={model.busy || Boolean(model.pendingOperation)}
        onChange={event => guard(event.target.value ? JSON.stringify(event.target.value) : '')}>
        <option value="">{t('settings.nativeConfiguration.choosePlaceholder')}</option>
        {(field.enum ?? ['durable', 'ephemeral']).map(option => <option key={option} value={option}>{option}</option>)}
      </select>
    </label>;
  }
  return <label className="block">{t('settings.nativePrompt.systemPrompt')}
    <textarea rows={4} maxLength={4096} disabled={model.busy || Boolean(model.pendingOperation)}
      value={draftString(model.draft) ?? ''}
      onChange={event => guard(JSON.stringify(event.target.value))} />
  </label>;
}

export function NativePromptBlock({ model, view }: { model: ControlsModel; view: NativeConfigurationView }): ReactNode {
  const { t } = useI18n();
  const fields = model.fields.filter(field => promptPath(field.path));
  return fields.length ? <div className="space-y-1 rounded border border-border/60 p-2"
    data-settings-item="native-configuration.prompt">
    <h4 className="font-semibold">{t('settings.nativePrompt.title')}</h4>
    <p>{t('settings.nativePrompt.description')}</p>
    <div className="flex flex-wrap gap-2">{fields.map(field => <button type="button" key={field.path}
      aria-pressed={model.fieldPath === field.path} disabled={model.busy || Boolean(model.pendingOperation)}
      onClick={() => chooseNativeField(model, view, field.path)} className="rounded border border-border px-2 py-1">
      {t(field.path === 'persistence' ? 'settings.nativePrompt.persistence' : 'settings.nativePrompt.systemPrompt')}
    </button>)}</div>
  </div> : null;
}
