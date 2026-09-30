// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState, type ReactNode } from 'react';
import { SettingsCheckboxRow, SettingsGroupTitle, SettingsSection } from '../primitives.tsx';

type LoginItem = { supported: boolean; enabled: boolean };

function loginItemResult(result: unknown): LoginItem | null {
  if (typeof result !== 'object' || result === null) return null;
  const value = result as { supported?: unknown; enabled?: unknown };
  return typeof value.supported === 'boolean' && typeof value.enabled === 'boolean'
    ? { supported: value.supported, enabled: value.enabled }
    : null;
}

export function LaunchAtLoginControl(): ReactNode {
  const [value, setValue] = useState<LoginItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const invoke = window.__NOTNATIVE_DESKTOP_INVOKE__;
    if (!invoke) return;
    let active = true;
    void invoke('desktop_get_launch_at_login').then((reply) => {
      if (!active) return;
      const result = reply.ok ? loginItemResult(reply.result) : null;
      setValue(result);
      if (!reply.ok || result === null) setError(reply.error ?? 'Could not read the launch-at-login setting.');
    }).catch(() => {
      if (active) setError('Could not read the launch-at-login setting.');
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
      setValue(result);
      if (!reply.ok || result === null) setError(reply.error ?? 'Could not update the launch-at-login setting.');
    } catch {
      setError('Could not update the launch-at-login setting.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsSection item="general.startup">
      <SettingsGroupTitle>Startup</SettingsGroupTitle>
      <SettingsCheckboxRow
        label="Launch at login"
        item="general.startup.launch-at-login"
        checked={value?.enabled ?? false}
        disabled={value === null || !value.supported || busy}
        helper={error ?? (value?.supported ? 'Starts NotNativeDesktop in the tray.' : 'This platform does not support launch at login.')}
        onChange={(enabled) => { void change(enabled); }}
      />
    </SettingsSection>
  );
}
