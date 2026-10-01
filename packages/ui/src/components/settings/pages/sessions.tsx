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
        <SettingsGroupTitle>{t('settings.sessions.defaults')}</SettingsGroupTitle>
        <SettingsInset>
          <div className="text-[11px] leading-relaxed text-muted-foreground">
            {t('settings.sessions.defaultsNote')}
          </div>
        </SettingsInset>
      </SettingsSection>

      <SettingsSection>
        <SettingsGroupTitle>{t('settings.sessions.behavior')}</SettingsGroupTitle>
        <SettingsCheckboxRow label={t('settings.sessions.confirmDelete')} item="sessions.deletion-dialog" checked={yes(showDeletionDialog.value, true)} onChange={showDeletionDialog.set} />
        <SettingsCheckboxRow label={t('settings.sessions.previewOpenFiles')} item="sessions.file-preview" checked={yes(filePreview.value, false)} onChange={filePreview.set} />
        <SettingsFieldRow label={t('settings.sessions.messageTransport')} item="sessions.message-transport" helper={t('settings.sessions.messageTransportHelper')}>
          <SettingsSelect
            value={messageTransport.value ?? 'auto'}
            resetValue="auto"
            onChange={(value) => messageTransport.set(value as 'auto' | 'ws' | 'sse')}
            options={[
              { value: 'auto', label: t('settings.sessions.transportAuto') },
              { value: 'ws', label: 'WebSocket' },
              { value: 'sse', label: t('settings.sessions.transportSse') },
            ]}
          />
        </SettingsFieldRow>
      </SettingsSection>

      <SettingsSection item="sessions.retention">
        <SettingsGroupTitle>{t('settings.sessions.retention')}</SettingsGroupTitle>
        <SettingsCheckboxRow label={t('settings.sessions.autoDelete')} item="sessions.auto-delete" checked={yes(autoDeleteEnabled.value, false)} onChange={autoDeleteEnabled.set} />
        <SettingsFieldRow label={t('settings.sessions.deleteOlderThan')} item="sessions.auto-delete-days">
          <SettingsNumberInput value={autoDeleteAfterDays.value ?? 30} min={1} max={365} step={1} unit={t('settings.sessions.days')} resetValue={30} onChange={autoDeleteAfterDays.set} disabled={!autoDeleteEnabled.value} />
        </SettingsFieldRow>
        <SettingsCheckboxRow label={t('settings.sessions.archiveOnly')} item="sessions.retention-archived" checked={yes(retentionArchived.value, false)} onChange={retentionArchived.set} />
        <SettingsFieldRow label={t('settings.sessions.retentionAction')} item="sessions.retention-action">
          <SettingsSelect
            value={retentionAction.value ?? 'archive'}
            resetValue="archive"
            onChange={(value) => retentionAction.set(value as 'archive' | 'delete')}
            options={[
              { value: 'archive', label: t('settings.sessions.archive') },
              { value: 'delete', label: t('settings.sessions.delete') },
            ]}
          />
        </SettingsFieldRow>
      </SettingsSection>
    </div>
  );
}

