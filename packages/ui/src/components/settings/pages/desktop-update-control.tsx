// SPDX-License-Identifier: Apache-2.0
import type { ReactNode } from 'react';
import { useDesktopUpdate } from './use-desktop-update.ts';
import { SettingsGroupTitle, SettingsSection } from '../primitives.tsx';
import { useI18n } from '../../I18nProvider.tsx';

export function DesktopUpdateControl(): ReactNode {
  const { t } = useI18n();
  const { updater, info, busy, progress, error, run } = useDesktopUpdate();
  if (!updater) return null;
  const downloading = progress?.event === 'Started' || progress?.event === 'Progress';
  const percent = progress?.data?.total && progress.data.total > 0
    ? Math.min(100, Math.floor((progress.data.downloaded ?? 0) / progress.data.total * 100)) : null;

  return (
    <SettingsSection item="general.desktop-updates">
      <SettingsGroupTitle>{t('settings.desktopUpdate.title')}</SettingsGroupTitle>
      <div className="flex flex-wrap items-center gap-2 px-2 py-1">
        {info?.available && info.version ? <span className="text-xs text-foreground">{t('settings.desktopUpdate.versionAvailable', { version: info.version })}</span>
          : info ? <span className="text-xs text-muted-foreground">{t('settings.desktopUpdate.upToDate')}</span> : null}
        {downloading ? <span role="status" className="text-xs text-muted-foreground">{percent === null ? t('settings.desktopUpdate.downloading') : t('settings.desktopUpdate.progress', { percent })}</span> : null}
        {progress?.event === 'Finished' ? <span role="status" className="text-xs text-muted-foreground">{t('settings.desktopUpdate.downloaded')}</span> : null}
        {info?.available && progress?.event === 'Finished'
          ? <button type="button" className="rounded border border-border px-2 py-1 text-xs" disabled={busy} onClick={() => { void run('install'); }}>{t('settings.desktopUpdate.install')}</button>
          : info?.available
            ? <button type="button" className="rounded border border-border px-2 py-1 text-xs" disabled={busy || downloading} onClick={() => { void run('download'); }}>{busy ? t('settings.desktopUpdate.working') : t('settings.desktopUpdate.download')}</button>
            : <button type="button" className="rounded border border-border px-2 py-1 text-xs" disabled={busy || downloading} onClick={() => { void run('check'); }}>{busy ? t('settings.desktopUpdate.checking') : t('settings.desktopUpdate.check')}</button>}
      </div>
      {info?.body ? <p className="px-2 text-xs text-muted-foreground">{info.body}</p> : null}
      {error ? <p role="alert" className="px-2 text-xs text-destructive">{t(error)}</p> : null}
    </SettingsSection>
  );
}
