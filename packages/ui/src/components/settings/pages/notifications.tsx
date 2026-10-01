// SPDX-License-Identifier: Apache-2.0
/**
 * Notifications page (doc 14 §§G.8 NotificationSettings structure, web
 * slice): master toggle with the Web-Notification permission path, mode,
 * event checkboxes, and the i18n-KEY template references (custom editors
 * land with the templates UI; the keys render read-only here so the
 * contract stays visible).
 */
import type { ReactNode } from 'react';
import {
  SettingsSection, SettingsGroupTitle, SettingsFieldRow, SettingsCheckboxRow, SettingsRadioGroup, SettingsInset,
} from '../primitives.tsx';
import { useSettingsField } from '../page-helpers.tsx';
import { useI18n } from '../../I18nProvider.tsx';
import type { I18nKey } from '../../../lib/i18n/messages/en.ts';
import { BrowserPushControl } from './browser-push-control.tsx';

const TEMPLATE_EVENTS = ['completion', 'error', 'question', 'subtask'] as const;
type TemplateEvent = (typeof TEMPLATE_EVENTS)[number];

export function NotificationsPage(): ReactNode {
  const { t } = useI18n();
  const master = useSettingsField<boolean>('nativeNotificationsEnabled');
  const mode = useSettingsField<'always' | 'hidden-only'>('notificationMode');
  const subtasks = useSettingsField<boolean>('notifyOnSubtasks');
  const completion = useSettingsField<boolean>('notifyOnCompletion');
  const error = useSettingsField<boolean>('notifyOnError');
  const question = useSettingsField<boolean>('notifyOnQuestion');
  const updates = useSettingsField<boolean>('showOpenCodeUpdateNotifications');

  // Plain-browser gate (§§G.8): the web Notification permission path.
  const permission: NotificationPermission | 'unavailable' =
    typeof Notification === 'undefined' ? 'unavailable' : Notification.permission;

  return (
    <div className="flex flex-col gap-3">
      <BrowserPushControl />
      <SettingsSection item="notifications.master">
        <SettingsGroupTitle>{t('settings.search.notifications')}</SettingsGroupTitle>
        <SettingsCheckboxRow
          label={t('settings.notifications.enable')}
          item="notifications.master"
          checked={master.value ?? false}
          disabled={permission === 'unavailable'}
          helper={permission === 'unavailable' ? t('settings.notifications.apiUnavailable') : undefined}
          onChange={(checked) => {
            if (checked && typeof Notification !== 'undefined' && Notification.permission === 'default') {
              void Notification.requestPermission();
            }
            master.set(checked);
          }}
        />
        <SettingsFieldRow label={t('settings.notifications.deliver')} item="notifications.mode">
          <SettingsRadioGroup
            value={mode.value ?? 'always'}
            options={[
              { value: 'always', label: t('settings.notifications.always') },
              { value: 'hidden-only', label: t('settings.notifications.hiddenOnly') },
            ]}
            onChange={(value) => mode.set(value as 'always' | 'hidden-only')}
          />
        </SettingsFieldRow>
      </SettingsSection>

      <SettingsSection item="notifications.events">
        <SettingsGroupTitle>{t('settings.search.notificationEvents')}</SettingsGroupTitle>
        <SettingsCheckboxRow label={t('settings.notifications.onCompletion')} item="notifications.completion" checked={completion.value ?? false} onChange={completion.set} />
        <SettingsCheckboxRow label={t('settings.notifications.onError')} item="notifications.error" checked={error.value ?? false} onChange={error.set} />
        <SettingsCheckboxRow label={t('settings.notifications.onQuestion')} item="notifications.question" checked={question.value ?? false} onChange={question.set} />
        <SettingsCheckboxRow label={t('settings.notifications.onSubtask')} item="notifications.subtasks" checked={subtasks.value ?? false} onChange={subtasks.set} />
        <SettingsCheckboxRow label={t('settings.notifications.harnessUpdates')} item="notifications.updates" checked={updates.value ?? false} onChange={updates.set} />
      </SettingsSection>

      <SettingsSection item="notifications.templates">
        <SettingsGroupTitle>{t('settings.notifications.templates')}</SettingsGroupTitle>
        <SettingsInset>
          <div className="flex flex-col gap-1 font-mono text-[10px] text-muted-foreground">
            {TEMPLATE_EVENTS.map((event: TemplateEvent) => (
              <div key={event}>
                <span className="text-foreground">{event}</span>
                {' → '}
                {t(`settings.notifications.page.template.defaults.${event}.title` as I18nKey)}
                {' / '}
                {t(`settings.notifications.page.template.defaults.${event}.message` as I18nKey)}
              </div>
            ))}
          </div>
        </SettingsInset>
      </SettingsSection>
    </div>
  );
}

