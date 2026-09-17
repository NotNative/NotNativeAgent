// SPDX-License-Identifier: Apache-2.0
/**
 * Sessions page (doc 14 §G.5): retention + deletion dialog + open-files
 * preview. The defaults section (default model/agent/variant, small model,
 * walkthrough override) is the HARNESS PORT (doc 14 §F.4) — its pickers
 * land with the provider/agent surfaces (registered P6+), so the section
 * renders the honest landing note today.
 */
import type { ReactNode } from 'react';
import {
  SettingsSection, SettingsGroupTitle, SettingsFieldRow, SettingsCheckboxRow, SettingsSelect, SettingsNumberInput, SettingsInset,
} from '../primitives.tsx';
import { useSettingsField } from '../page-helpers.tsx';
import { useI18n } from '../../I18nProvider.tsx';

export function SessionsPage(): ReactNode {
  const { t } = useI18n();
  const autoDeleteEnabled = useSettingsField<boolean>('autoDeleteEnabled');
  const autoDeleteAfterDays = useSettingsField<number>('autoDeleteAfterDays');
  const retentionArchived = useSettingsField<boolean>('sessionRetentionOnlyArchived');
  const retentionAction = useSettingsField<'archive' | 'delete'>('sessionRetentionAction');
  const showDeletionDialog = useSettingsField<boolean>('showDeletionDialog');
  const filePreview = useSettingsField<boolean>('defaultFileViewerPreview');
  const messageTransport = useSettingsField<'auto' | 'ws' | 'sse'>('messageStreamTransport');

  const yes = (value: boolean | undefined, fallback: boolean): boolean => value ?? fallback;

  return (
    <div className="flex flex-col gap-3">
      <SettingsSection item="sessions.defaults">
        <SettingsGroupTitle>Defaults</SettingsGroupTitle>
        <SettingsInset>
          <div className="text-[11px] leading-relaxed text-muted-foreground">
            Default model/agent/variant, the small-model override, and the walkthrough model pickers
            write into the agent harness configuration (doc 14 §F.4 HARNESS PORT). They land with the
            Providers/Agents surfaces — registered, not silently dropped.
          </div>
        </SettingsInset>
      </SettingsSection>

      <SettingsSection>
        <SettingsGroupTitle>Behavior</SettingsGroupTitle>
        <SettingsCheckboxRow label="Show a confirmation before deleting a session" item="sessions.deletion-dialog" checked={yes(showDeletionDialog.value, true)} onChange={showDeletionDialog.set} />
        <SettingsCheckboxRow label={t('settings.search.toolsFiles') + ' — preview open files'} item="sessions.file-preview" checked={yes(filePreview.value, false)} onChange={filePreview.set} />
        <SettingsFieldRow label="Message stream transport" item="sessions.message-transport" helper="auto lets the instance decide (ws preferred, sse fallback)">
          <SettingsSelect
            value={messageTransport.value ?? 'auto'}
            resetValue="auto"
            onChange={(value) => messageTransport.set(value as 'auto' | 'ws' | 'sse')}
            options={[
              { value: 'auto', label: 'Auto' },
              { value: 'ws', label: 'WebSocket' },
              { value: 'sse', label: 'Server-sent events' },
            ]}
          />
        </SettingsFieldRow>
      </SettingsSection>

      <SettingsSection item="sessions.retention">
        <SettingsGroupTitle>{t('settings.search.retention')}</SettingsGroupTitle>
        <SettingsCheckboxRow label="Auto-delete sessions" item="sessions.auto-delete" checked={yes(autoDeleteEnabled.value, false)} onChange={autoDeleteEnabled.set} />
        <SettingsFieldRow label="Delete sessions older than" item="sessions.auto-delete-days">
          <SettingsNumberInput value={autoDeleteAfterDays.value ?? 30} min={1} max={365} step={1} unit="days" resetValue={30} onChange={autoDeleteAfterDays.set} disabled={!autoDeleteEnabled.value} />
        </SettingsFieldRow>
        <SettingsCheckboxRow label="Only archive; never hard-delete" item="sessions.retention-archived" checked={yes(retentionArchived.value, false)} onChange={retentionArchived.set} />
        <SettingsFieldRow label="Retention action" item="sessions.retention-action">
          <SettingsSelect
            value={retentionAction.value ?? 'archive'}
            resetValue="archive"
            onChange={(value) => retentionAction.set(value as 'archive' | 'delete')}
            options={[
              { value: 'archive', label: 'Archive' },
              { value: 'delete', label: 'Delete' },
            ]}
          />
        </SettingsFieldRow>
      </SettingsSection>
    </div>
  );
}

