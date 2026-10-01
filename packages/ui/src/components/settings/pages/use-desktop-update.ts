// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from 'react';
import type { I18nKey } from '../../../lib/i18n/messages/en.ts';

type UpdateInfo = { available: boolean; currentVersion?: string; version?: string | null; body?: string | null; date?: string | null };
type ProgressInfo = { event: string; data?: { downloaded?: number; total?: number | null } };

function updateInfo(value: unknown): UpdateInfo | null {
  if (!value || typeof value !== 'object') return null;
  const result = value as Partial<UpdateInfo>;
  if (typeof result.available !== 'boolean') return null;
  return result as UpdateInfo;
}

/** Keep updater subscriptions and operation results in one controller. */
export function useDesktopUpdate() {
  const updater = window.__NOTNATIVE_DESKTOP_UPDATER__;
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<ProgressInfo | null>(null);
  const [error, setError] = useState<I18nKey | null>(null);

  useEffect(() => {
    if (!updater) return;
    return updater.onProgress(setProgress);
  }, [updater]);

  const run = async (operation: 'check' | 'download' | 'install'): Promise<void> => {
    if (!updater || busy) return;
    setBusy(true);
    setError(null);
    try {
      const reply = await updater[operation]();
      if (!reply.ok) {
        if (operation === 'download') setProgress(null);
        setError('settings.desktopUpdate.error.generic');
        return;
      }
      if (operation === 'check') {
        const parsed = updateInfo(reply.result);
        if (!parsed) {
          setError('settings.desktopUpdate.error.invalid');
          return;
        }
        setInfo(parsed);
      }
    } catch {
      if (operation === 'download') setProgress(null);
      setError('settings.desktopUpdate.error.generic');
    } finally { setBusy(false); }
  };

  return { updater, info, busy, progress, error, run };
}
