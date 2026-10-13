// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react';
import type { NativeConfigurationView } from '../../../lib/nnd/configuration.ts';
import { useI18n } from '../../I18nProvider.tsx';
import { chooseNativeField, inspectNativeOperation, previewNativeField, publishNativeField, repairNativeSource } from './native-configuration-controls-actions.ts';
import { invalidateNativePreview, useNativeConfigurationControlsModel, type ControlsModel } from './native-configuration-controls-model.ts';
import { NativeTuiEditForm } from './native-tui-edit-form.tsx';
import { NativeRouteEditForm } from './native-route-edit-form.tsx';
import { NativeRouteBindingForm } from './native-route-binding-form.tsx';
import { CONTEXT_BUDGETS, CONTEXT_THRESHOLD_PATHS, DREAM_LIMITS, MEMORY_BOOLEAN, MEMORY_LIMITS, PROVIDER_DEADLINE,
  PROVIDER_SCHEDULING, RECOVERY_BUDGETS, REVIEWER_RETENTION, RUNTIME_TIMEOUTS, SESSION_DEADLINES, STREAM_TIMEOUTS,
  boundedPositiveInteger, contextDraftValid, providerDeadlineValid, streamTimeoutValid } from './native-configuration-controls-map.ts';
import { NativeTelemetryBlock, TelemetryDraftInput, telemetryDraftValid, telemetryPath } from './native-configuration-telemetry.tsx';
import { NativePromptBlock, PromptDraftInput, promptDraftValid, promptPath } from './native-configuration-prompt.tsx';
import { LADDER_PATH, LadderDraftInput, TURN_WALL_CLOCK_PATH, ladderDraftValid, ladderLength, localRetryLimit } from './native-configuration-ladder.tsx';
import { authorityState, subscribeAuthority } from '../../../sync/authority-sync.ts';


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
  const recoveryFields = model.fields.filter(field => field.type === 'integer' && Object.hasOwn(RECOVERY_BUDGETS, field.path));
  const recoverySelected = selected?.type === 'integer' ? RECOVERY_BUDGETS[selected.path] : undefined;
  const sessionDeadlineFields = model.fields.filter(field => field.type === 'integer' && Object.hasOwn(SESSION_DEADLINES, field.path));
  const sessionDeadlineSelected = selected?.type === 'integer' ? SESSION_DEADLINES[selected.path] : undefined;
  const contextFields = model.fields.filter(field => CONTEXT_BUDGETS[field.path]?.type === field.type);
  const contextSelected = selected && CONTEXT_BUDGETS[selected.path]?.type === selected.type
    ? CONTEXT_BUDGETS[selected.path] : undefined;
  const reviewerRetentionField = model.fields.find(field => field.path === REVIEWER_RETENTION.path && field.type === 'integer');
  const reviewerRetentionSelected = selected?.path === REVIEWER_RETENTION.path && selected.type === 'integer';
  const dreamFields = model.fields.filter(field => field.type === 'integer' && Object.hasOwn(DREAM_LIMITS, field.path)
    || field.path === 'dream.enabled' && field.type === 'boolean');
  const dreamSelected = selected?.type === 'integer' ? DREAM_LIMITS[selected.path] : undefined;
  const dreamEnabledSelected = selected?.path === 'dream.enabled' && selected.type === 'boolean';
  const timeoutFields = model.fields.filter(field => field.type === 'integer' && Object.hasOwn(RUNTIME_TIMEOUTS, field.path));
  const timeoutSelected = selected?.type === 'integer' ? RUNTIME_TIMEOUTS[selected.path] : undefined;
  const deadlineFields = model.fields.filter(field => field.type === 'integer' && Object.hasOwn(PROVIDER_DEADLINE, field.path));
  const deadlineSelected = selected?.type === 'integer' ? PROVIDER_DEADLINE[selected.path] : undefined;
  const streamFields = model.fields.filter(field => field.type === 'integer' && Object.hasOwn(STREAM_TIMEOUTS, field.path));
  const streamSelected = selected?.type === 'integer' ? STREAM_TIMEOUTS[selected.path] : undefined;
  const telemetrySelected = Boolean(selected && telemetryPath(selected.path));
  const promptSelected = Boolean(selected && promptPath(selected.path));
  const ladderSelected = selected?.path === LADDER_PATH;
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
    <NativeTelemetryBlock model={model} view={view} />
    <NativePromptBlock model={model} view={view} />
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
    {(recoveryFields.length || model.fields.some(field => field.path === LADDER_PATH)) ? <div
      className="space-y-1 rounded border border-border/60 p-2"
      data-settings-item="native-configuration.recovery-budgets">
      <h4 className="font-semibold">{t('settings.nativeRecovery.title')}</h4>
      <p>{t('settings.nativeRecovery.description')}</p>
      <div className="flex flex-wrap gap-2">{recoveryFields.map(field => <button type="button" key={field.path}
        aria-pressed={model.fieldPath === field.path} disabled={model.busy || Boolean(model.pendingOperation)}
        onClick={() => chooseNativeField(model, view, field.path)} className="rounded border border-border px-2 py-1">
        {t(RECOVERY_BUDGETS[field.path]!.label)}
      </button>)}
      {model.fields.some(field => field.path === LADDER_PATH) ? <button type="button"
        aria-pressed={ladderSelected} disabled={model.busy || Boolean(model.pendingOperation)}
        onClick={() => chooseNativeField(model, view, LADDER_PATH)} className="rounded border border-border px-2 py-1">
        {t('settings.nativeRecovery.ladder')}
      </button> : null}</div>
    </div> : null}
    {sessionDeadlineFields.length ? <div className="space-y-1 rounded border border-border/60 p-2"
      data-settings-item="native-configuration.session-deadlines">
      <h4 className="font-semibold">{t('settings.nativeSessionDeadlines.title')}</h4>
      <p>{t('settings.nativeSessionDeadlines.description')}</p>
      <div className="flex flex-wrap gap-2">{sessionDeadlineFields.map(field => <button type="button" key={field.path}
        aria-pressed={model.fieldPath === field.path} disabled={model.busy || Boolean(model.pendingOperation)}
        onClick={() => chooseNativeField(model, view, field.path)} className="rounded border border-border px-2 py-1">
        {t(SESSION_DEADLINES[field.path]!.label)}
      </button>)}</div>
    </div> : null}
    {contextFields.length ? <div className="space-y-1 rounded border border-border/60 p-2"
      data-settings-item="native-configuration.context-budgets">
      <h4 className="font-semibold">{t('settings.nativeContext.title')}</h4>
      <p>{t('settings.nativeContext.description')}</p>
      <div className="flex flex-wrap gap-2">{contextFields.map(field => <button type="button" key={field.path}
        aria-pressed={model.fieldPath === field.path} disabled={model.busy || Boolean(model.pendingOperation)}
        onClick={() => chooseNativeField(model, view, field.path)} className="rounded border border-border px-2 py-1">
        {t(CONTEXT_BUDGETS[field.path]!.label)}
      </button>)}</div>
    </div> : null}
    {reviewerRetentionField ? <div className="space-y-1 rounded border border-border/60 p-2"
      data-settings-item="native-configuration.reviewer-retention">
      <h4 className="font-semibold">{t('settings.nativeReviewerRetention.title')}</h4>
      <p>{t('settings.nativeReviewerRetention.description')}</p>
      <button type="button" aria-pressed={model.fieldPath === REVIEWER_RETENTION.path}
        disabled={model.busy || Boolean(model.pendingOperation)}
        onClick={() => chooseNativeField(model, view, REVIEWER_RETENTION.path)}
        className="rounded border border-border px-2 py-1">{t('settings.nativeReviewerRetention.entries')}</button>
    </div> : null}
    {dreamFields.length ? <div className="space-y-1 rounded border border-border/60 p-2"
      data-settings-item="native-configuration.dream">
      <h4 className="font-semibold">{t('settings.nativeDream.title')}</h4>
      <p>{t('settings.nativeDream.description')}</p>
      <div className="flex flex-wrap gap-2">{dreamFields.map(field => <button type="button" key={field.path}
        aria-pressed={model.fieldPath === field.path} disabled={model.busy || Boolean(model.pendingOperation)}
        onClick={() => chooseNativeField(model, view, field.path)} className="rounded border border-border px-2 py-1">
        {t(field.path === 'dream.enabled' ? 'settings.nativeDream.enabled' : DREAM_LIMITS[field.path]!.label)}
      </button>)}</div>
    </div> : null}
    {timeoutFields.length ? <div className="space-y-1 rounded border border-border/60 p-2"
      data-settings-item="native-configuration.runtime-timeouts">
      <h4 className="font-semibold">{t('settings.nativeTimeouts.title')}</h4>
      <p>{t('settings.nativeTimeouts.description')}</p>
      <div className="flex flex-wrap gap-2">{timeoutFields.map(field => <button type="button" key={field.path}
        aria-pressed={model.fieldPath === field.path} disabled={model.busy || Boolean(model.pendingOperation)}
        onClick={() => chooseNativeField(model, view, field.path)} className="rounded border border-border px-2 py-1">
        {t(RUNTIME_TIMEOUTS[field.path]!.label)}
      </button>)}</div>
    </div> : null}
    {deadlineFields.length ? <div className="space-y-1 rounded border border-border/60 p-2"
      data-settings-item="native-configuration.provider-deadline">
      <h4 className="font-semibold">{t('settings.nativeDeadline.title')}</h4>
      <p>{t('settings.nativeDeadline.description')}</p>
      <div className="flex flex-wrap gap-2">{deadlineFields.map(field => <button type="button" key={field.path}
        aria-pressed={model.fieldPath === field.path} disabled={model.busy || Boolean(model.pendingOperation)}
        onClick={() => chooseNativeField(model, view, field.path)} className="rounded border border-border px-2 py-1">
        {t(PROVIDER_DEADLINE[field.path]!.label)}
      </button>)}</div>
    </div> : null}
    {streamFields.length ? <div className="space-y-1 rounded border border-border/60 p-2"
      data-settings-item="native-configuration.stream-timeouts">
      <h4 className="font-semibold">{t('settings.nativeStreamTimeouts.title')}</h4>
      <p>{t('settings.nativeStreamTimeouts.description')}</p>
      <div className="flex flex-wrap gap-2">{streamFields.map(field => <button type="button" key={field.path}
        aria-pressed={model.fieldPath === field.path} disabled={model.busy || Boolean(model.pendingOperation)}
        onClick={() => chooseNativeField(model, view, field.path)} className="rounded border border-border px-2 py-1">
        {t(STREAM_TIMEOUTS[field.path]!.label)}
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
      {model.mode === 'set' && recoverySelected ? <label className="block">
        {t(recoverySelected.label)}
        <input type="number" min={recoverySelected.min} max={recoverySelected.max} step="1"
          value={/^\d+$/u.test(model.draft) ? model.draft : ''}
          disabled={model.busy || Boolean(model.pendingOperation)}
          onChange={event => { invalidateNativePreview(model); model.setDraft(event.target.value); }}
          className="ml-2 rounded border border-border bg-background p-1" />
      </label> : null}
      {model.mode === 'set' && selected?.path === 'recovery.local_retry_limit' && /^\d+$/u.test(model.draft)
        && Number(model.draft) - 1 > ladderLength(view)
        ? <p role="status">{t('settings.nativeRecovery.ladderCoverage')}</p> : null}
      {model.mode === 'set' && ladderSelected ? <LadderDraftInput model={model} view={view} /> : null}
      {model.mode === 'set' && sessionDeadlineSelected ? <label className="block">
        {t(sessionDeadlineSelected.label)}
        <input type="number" min={sessionDeadlineSelected.min} max={sessionDeadlineSelected.max} step="1"
          value={/^\d+$/u.test(model.draft) ? model.draft : ''}
          disabled={model.busy || Boolean(model.pendingOperation)}
          onChange={event => { invalidateNativePreview(model); model.setDraft(event.target.value); }}
          className="ml-2 rounded border border-border bg-background p-1" />
      </label> : null}
      {model.mode === 'set' && contextSelected ? <label className="block">
        {t(contextSelected.label)}
        <input type={contextSelected.type === 'integer' ? 'number' : 'text'}
          inputMode={contextSelected.type === 'integer' ? 'numeric' : 'decimal'}
          min={contextSelected.type === 'integer' ? contextSelected.min : undefined}
          max={contextSelected.type === 'integer' ? contextSelected.max : undefined}
          step={contextSelected.type === 'integer' ? '1' : undefined}
          value={model.draft}
          disabled={model.busy || Boolean(model.pendingOperation)}
          onChange={event => { invalidateNativePreview(model); model.setDraft(event.target.value); }}
          className="ml-2 rounded border border-border bg-background p-1" />
      </label> : null}
      {model.mode === 'set' && reviewerRetentionSelected ? <label className="block">
        {t('settings.nativeReviewerRetention.entries')}
        <input type="number" min={REVIEWER_RETENTION.min} max={REVIEWER_RETENTION.max} step="1"
          value={/^\d+$/u.test(model.draft) ? model.draft : ''}
          disabled={model.busy || Boolean(model.pendingOperation)}
          onChange={event => { invalidateNativePreview(model); model.setDraft(event.target.value); }}
          className="ml-2 rounded border border-border bg-background p-1" />
      </label> : null}
      {model.mode === 'set' && dreamSelected ? <label className="block">
        {t(dreamSelected.label)}
        <input type="number" min={dreamSelected.min} max={dreamSelected.max} step="1"
          value={/^\d+$/u.test(model.draft) ? model.draft : ''}
          disabled={model.busy || Boolean(model.pendingOperation)}
          onChange={event => { invalidateNativePreview(model); model.setDraft(event.target.value); }}
          className="ml-2 rounded border border-border bg-background p-1" />
      </label> : null}
      {model.mode === 'set' && dreamEnabledSelected ? <label className="flex items-center gap-2">
        <input type="checkbox" checked={model.draft === 'true'} disabled={model.busy || Boolean(model.pendingOperation)}
          onChange={event => { invalidateNativePreview(model); model.setDraft(JSON.stringify(event.target.checked)); }} />
        {t('settings.nativeDream.enabled')}
      </label> : null}
      {model.mode === 'set' && timeoutSelected ? <label className="block">
        {t(timeoutSelected.label)}
        <input type="number" min={timeoutSelected.min} max={timeoutSelected.max} step="1"
          value={/^\d+$/u.test(model.draft) ? model.draft : ''}
          disabled={model.busy || Boolean(model.pendingOperation)}
          onChange={event => { invalidateNativePreview(model); model.setDraft(event.target.value); }}
          className="ml-2 rounded border border-border bg-background p-1" />
      </label> : null}
      {model.mode === 'set' && deadlineSelected ? <>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={model.draft === '0'} disabled={model.busy || Boolean(model.pendingOperation)}
            onChange={event => { invalidateNativePreview(model); model.setDraft(event.target.checked ? '0'
              : String(row?.effective.present && 'value' in row.effective && typeof row.effective.value === 'number'
                && row.effective.value >= 100 && row.effective.value <= 86400000 ? row.effective.value : 1800000)); }} />
          {t('settings.nativeDeadline.disabled')}
        </label>
        <label className="block">{t(deadlineSelected.label)}
          <input type="number" min={deadlineSelected.min} max={deadlineSelected.max} step="1"
            value={/^\d+$/u.test(model.draft) && model.draft !== '0' ? model.draft : ''}
            disabled={model.busy || Boolean(model.pendingOperation) || model.draft === '0'}
            onChange={event => { invalidateNativePreview(model); model.setDraft(event.target.value); }}
            className="ml-2 rounded border border-border bg-background p-1" />
        </label>
      </> : null}
      {model.mode === 'set' && streamSelected ? <>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={model.draft === '0'} disabled={model.busy || Boolean(model.pendingOperation)}
            onChange={event => { invalidateNativePreview(model); model.setDraft(event.target.checked ? '0'
              : String(row?.effective.present && 'value' in row.effective && typeof row.effective.value === 'number'
                && streamTimeoutValid(String(row.effective.value), streamSelected) ? row.effective.value : 120000)); }} />
          {t('settings.nativeStreamTimeouts.disabled')}
        </label>
        <label className="block">{t(streamSelected.label)}
          <input type="number" min="100" max="86400000" step="1"
            value={/^\d+$/u.test(model.draft) && model.draft !== '0' ? model.draft : ''}
            disabled={model.busy || Boolean(model.pendingOperation) || model.draft === '0'}
            onChange={event => { invalidateNativePreview(model); model.setDraft(event.target.value); }}
            className="ml-2 rounded border border-border bg-background p-1" />
        </label>
        <p>{t('settings.nativeStreamTimeouts.sentinels', { legacy: streamSelected.legacy,
          pairedDefault: streamSelected.pairedDefault })}</p>
      </> : null}
      {model.mode === 'set' && selected.path === 'semantic_review_timeout_ms' && model.draft === '15000'
        ? <p role="status">{t('settings.nativeTimeouts.legacySemanticReview')}</p> : null}
      {model.mode === 'set' && selected.path === 'memory.enabled' && model.draft === 'false'
        ? <p>{t('settings.nativeMemory.disableAlsoClearsRequired')}</p> : null}
      {model.mode === 'set' && selected.path === 'memory.required' && model.draft === 'true'
        ? <p>{t('settings.nativeMemory.requireAlsoEnables')}</p> : null}
      {model.mode === 'set' && telemetrySelected ? <TelemetryDraftInput field={selected} model={model} /> : null}
      {model.mode === 'set' && promptSelected ? <PromptDraftInput field={selected} model={model} /> : null}
      {model.mode === 'set' && !attachmentSelected && !memorySelected && !memoryBooleanSelected && !schedulingSelected
        && !recoverySelected && !sessionDeadlineSelected && !contextSelected && !reviewerRetentionSelected
        && !dreamSelected && !dreamEnabledSelected && !timeoutSelected && !deadlineSelected && !streamSelected
        && !telemetrySelected && !promptSelected && !ladderSelected
        && <label className="block">{t('settings.nativeConfiguration.jsonValue')}
        <textarea value={model.draft} onChange={event => { invalidateNativePreview(model); model.setDraft(event.target.value); }}
          disabled={model.busy || Boolean(model.pendingOperation)} rows={3} maxLength={8192}
          className="block w-full rounded border border-border bg-background p-2 font-mono" />
      </label>}
      <button type="button" onClick={() => previewNativeField(model, view)} disabled={model.busy || Boolean(model.pendingOperation)
        || Boolean(recoverySelected && model.mode === 'set' && (selected?.path === TURN_WALL_CLOCK_PATH
          ? !(/^(?:0|[1-9]\d*)$/u.test(model.draft) && (model.draft === '0'
            || Number(model.draft) >= recoverySelected.min && Number(model.draft) <= recoverySelected.max))
          : (!/^[1-9]\d*$/u.test(model.draft)
            || Number(model.draft) < recoverySelected.min || Number(model.draft) > recoverySelected.max)))
        || Boolean(ladderSelected && model.mode === 'set' && !ladderDraftValid(model.draft, localRetryLimit(view)))
        || Boolean(sessionDeadlineSelected && model.mode === 'set' && !boundedPositiveInteger(model.draft, sessionDeadlineSelected))
        || Boolean(contextSelected && model.mode === 'set' && !contextDraftValid(model.draft, contextSelected))
        || Boolean(reviewerRetentionSelected && model.mode === 'set' && !boundedPositiveInteger(model.draft, REVIEWER_RETENTION))
        || Boolean(deadlineSelected && model.mode === 'set' && !providerDeadlineValid(model.draft))
        || Boolean(streamSelected && model.mode === 'set' && !streamTimeoutValid(model.draft, streamSelected))
        || Boolean(telemetrySelected && model.mode === 'set' && !telemetryDraftValid(selected, model.draft))
        || Boolean(promptSelected && model.mode === 'set' && !promptDraftValid(selected, model.draft))}>
        {t('settings.nativeConfiguration.preview')}</button>
      {model.preview && <div role="status" className="rounded border border-border p-2">
        <p>{t('settings.nativeConfiguration.previewReady')}</p>
        {streamSelected ? (['first_token_timeout_ms', 'idle_timeout_ms'] as const).map(path => {
          const before = view.fields.find(item => item.path === path)?.effective;
          const after = model.preview?.result.view.fields.find(item => item.path === path)?.effective;
          const value = (item: typeof before) => item?.present && 'value' in item
            ? item.value === null || item.value === 0 ? t('settings.nativeStreamTimeouts.disabled') : String(item.value)
            : t('settings.nativeConfiguration.absent');
          return <p key={path}>{t(STREAM_TIMEOUTS[path]!.label)}: {value(before)}{' → '}{value(after)}</p>;
        }) : deadlineSelected ? (['provider_timeout_ms', 'routes.primary.deadline_ms'] as const).map(path => {
          const before = view.fields.find(item => item.path === path)?.effective;
          const after = model.preview?.result.view.fields.find(item => item.path === path)?.effective;
          const value = (item: typeof before) => item?.present && 'value' in item
            ? item.value === null || item.value === 0 ? t('settings.nativeDeadline.disabled') : String(item.value)
            : t('settings.nativeConfiguration.absent');
          const explicitBefore = view.fields.find(item => item.path === path)?.explicit;
          const explicitAfter = model.preview?.result.view.fields.find(item => item.path === path)?.explicit;
          return <p key={path}>{t(PROVIDER_DEADLINE[path]!.label)}: {value(before)}{' → '}{value(after)}
            {path === selected.path ? <>; {t('settings.nativeDeadline.savedValue')}: {value(explicitBefore)}{' → '}{value(explicitAfter)}</> : null}</p>;
        }) : contextSelected && CONTEXT_THRESHOLD_PATHS.some(path => path === selected.path)
          ? CONTEXT_THRESHOLD_PATHS.map(path => {
            const before = view.fields.find(item => item.path === path)?.effective;
            const after = model.preview?.result.view.fields.find(item => item.path === path)?.effective;
            const value = (item: typeof before) => item?.present && 'value' in item
              ? String(item.value) : t('settings.nativeConfiguration.absent');
            return <p key={path}>{t(CONTEXT_BUDGETS[path]!.label)}: {value(before)}{' → '}{value(after)}</p>;
          }) : memoryBooleanSelected ? (['memory.enabled', 'memory.required'] as const).map(path => {
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
