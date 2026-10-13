// SPDX-License-Identifier: Apache-2.0
/** NNA-discovered skill metadata for sessions created after this read. */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { harnessClient } from '../../../lib/nnd/client.ts';
import { SettingsGroupTitle, SettingsSection } from '../primitives.tsx';
import { useI18n } from '../../I18nProvider.tsx';
import type { I18nKey } from '../../../lib/i18n/messages/en.ts';

interface SkillSummary {
  id: string;
  version: string;
  description: string;
  invocation: 'user' | 'agent' | 'both';
}

type InventoryError = { kind: 'localized'; key: I18nKey } | { kind: 'raw'; message: string };

function validSkill(value: unknown): value is SkillSummary {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return typeof item.id === 'string' && typeof item.version === 'string'
    && typeof item.description === 'string' && ['user', 'agent', 'both'].includes(String(item.invocation));
}

export function SkillsPage(): ReactNode {
  const { t } = useI18n();
  const [skills, setSkills] = useState<SkillSummary[] | null>(null);
  const [error, setError] = useState<InventoryError | null>(null);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    let current = true;
    setLoading(true);
    void harnessClient.getNnaSkillsInventory().then((result) => {
      if (!current) return;
      const inventory = result.data;
      if (result.error || inventory?.version !== 1 || inventory.state !== 'discovered'
        || !Array.isArray(inventory.skills) || !inventory.skills.every(validSkill)) {
        setSkills(null);
        setError(result.error
          ? { kind: 'raw', message: result.error }
          : { kind: 'localized', key: 'settings.skills.inventory.invalid' });
      } else {
        setSkills(inventory.skills);
        setError(null);
      }
    }).catch(() => { if (current) { setSkills(null); setError({ kind: 'localized', key: 'settings.skills.inventory.unavailable' }); } })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [revision]);

  return (
    <SettingsSection item="skills.inventory">
      <div className="flex items-center justify-between gap-3">
        <SettingsGroupTitle>{t('settings.skills.inventory.title')}</SettingsGroupTitle>
        <button type="button" className="rounded border border-border/60 px-2 py-1 text-xs text-foreground disabled:opacity-50" onClick={refresh} disabled={loading}>{t('settings.skills.inventory.refresh')}</button>
      </div>
      <p className="text-xs text-muted-foreground">{t('settings.skills.inventory.description')}</p>
      {loading ? <p role="status" className="text-xs text-muted-foreground">{t('settings.skills.inventory.loading')}</p> : null}
      {!loading && error ? <p role="alert" className="text-xs text-destructive">{error.kind === 'raw' ? error.message : t(error.key)}</p> : null}
      {!loading && !error && skills?.length === 0 ? <p className="text-xs text-muted-foreground">{t('settings.skills.inventory.empty')}</p> : null}
      {!loading && !error && skills?.map((skill) => (
        <div key={skill.id} className="rounded-md border border-border/40 p-3 text-xs" data-testid="nna-skill">
          <div className="font-medium text-foreground">{skill.id} <span className="font-normal text-muted-foreground">v{skill.version}</span></div>
          <div className="mt-1 text-muted-foreground">{skill.description}</div>
          <div className="mt-1 text-[10px] uppercase tracking-wide text-muted-foreground">
            {skill.invocation === 'user' ? t('settings.skills.inventory.user') : skill.invocation === 'agent' ? t('settings.skills.inventory.agent') : t('settings.skills.inventory.userAndAgent')}
          </div>
        </div>
      ))}
    </SettingsSection>
  );
}
