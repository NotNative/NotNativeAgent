// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState, type ReactNode } from 'react';
import type { I18nKey } from '../../../lib/i18n/messages/en.ts';
import { SettingsCheckboxRow, SettingsGroupTitle, SettingsSection } from '../primitives.tsx';
import { useI18n } from '../../I18nProvider.tsx';

type LoginItem = { supported: boolean; enabled: boolean };

function loginItemResult(result: unknown): LoginItem | null {
  if (typeof result !== 'object' || result === null) return null;
  const value = result as { supported?: unknown; enabled?: unknown };
  return typeof value.supported === 'boolean' && typeof value.enabled === 'boolean'
    ? { supported: value.supported, enabled: value.enabled }
    : null;
}

export function LaunchAtLoginControl(): ReactNode {
  const { t } = useI18n();
  const [value, setValue] = useState<LoginItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<I18nKey | null>(null);

  useEffect(() => {
    const invoke = window.__NOTNATIVE_DESKTOP_INVOKE__;
    if (!invoke) return;
    let active = true;
    void invoke('desktop_get_launch_at_login').then((reply) => {
      if (!active) return;
      const result = reply.ok ? loginItemResult(reply.result) : null;
      setValue(result);
      if (!reply.ok || result === null) setError('settings.launchAtLogin.error.read');
    }).catch(() => {
      if (active) setError('settings.launchAtLogin.error.read');
    });
    return () => { active = false; };
  }, []);

  const change = async (enabled: boolean): Promise<void> => {
    const invoke = window.__NOTNATIVE_DESKTOP_INVOKE__;
    if (!invoke) return;
    setBusy(true);
    setError(null);
    try {
      const reply = await invoke('desktop_set_launch_at_login', { enabled });
      const result = reply.ok ? loginItemResult(reply.result) : null;
      if (result) setValue(result);
      if (!reply.ok || result === null) setError('settings.launchAtLogin.error.update');
    } catch {
      setError('settings.launchAtLogin.error.update');
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsSection item="general.startup">
      <SettingsGroupTitle>{t('settings.launchAtLogin.title')}</SettingsGroupTitle>
      <SettingsCheckboxRow
        label={t('settings.launchAtLogin.label')}
        item="general.startup.launch-at-login"
        checked={value?.enabled ?? false}
        disabled={value === null || !value.supported || busy}
        helper={error ? t(error) : value?.supported ? t('settings.launchAtLogin.helperStarts') : t('settings.launchAtLogin.helperUnsupported')}
        onChange={(enabled) => { void change(enabled); }}
      />
    </SettingsSection>
  );
}
