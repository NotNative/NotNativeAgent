// SPDX-License-Identifier: Apache-2.0
/**
 * Shortcuts page (doc 14 §I.3): grouped rows (customizable only — internals
 * never render), kbd display, Edit → ShortcutRecordingDialog, per-row Reset
 * when overridden, "Reset all" on the first section header. Rows persist
 * through the `shortcutOverrides` registry key.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { SettingsSection, SettingsGroupTitle } from '../primitives.tsx';
import { useSettingsField } from '../page-helpers.tsx';
import { useI18n } from '../../I18nProvider.tsx';
import { SHORTCUT_SCHEMA, type ShortcutCategory, type ShortcutDecl } from '../../../lib/shortcuts/config.ts';
import { displayCombo, effectiveBinding, parseCombo, UNASSIGNED_SHORTCUT } from '../../../lib/shortcuts/bindings.ts';
import { ShortcutRecordingDialog } from '../recorder-dialog.tsx';
import type { I18nKey } from '../../../lib/i18n/messages/en.ts';
import { NATIVE_SHORTCUT_IDS } from '../../../lib/settings/native-registry.ts';
import { useNativePreferenceState } from '../../../lib/settings/native-preferences.ts';
import { useSettingsStore } from '../../../lib/settings/store.ts';

const CATEGORY_TITLE_KEYS: Record<ShortcutCategory, I18nKey> = {
  session: 'settings.search.shortcutsSession',
  models: 'settings.search.shortcutsModels',
  panels: 'settings.search.shortcutsPanels',
  navigation: 'settings.search.shortcutsNavigation',
  application: 'settings.search.shortcutsApplication',
};

export function ShortcutsPage({ native = false }: { native?: boolean }): ReactNode {
  const { t } = useI18n();
  const overridesField = useSettingsField<Record<string, string>>('shortcutOverrides');
  const overrides = useMemo(() => overridesField.value ?? {}, [overridesField.value]);
  const [recording, setRecording] = useState<ShortcutDecl | null>(null);
  const status = useNativePreferenceState(s => s.status);
  const loadError = useSettingsStore(s => s.loadError);

  const groups = useMemo(() => SHORTCUT_SCHEMA, []);

  // §I.3: customize-only page registry — internals never render as rows.
  const rendered = useMemo(
    () => groups.map((group) => ({ category: group.category, entries: group.entries.filter((entry) => entry.customizable && (!native || NATIVE_SHORTCUT_IDS.includes(entry.id as typeof NATIVE_SHORTCUT_IDS[number]))) })).filter(group => group.entries.length),
    [groups, native],
  );

  const applyOverrides = (next: Record<string, string>): void => {
    overridesField.set(next);
    setRecording(null);
  };

  const resetRow = (decl: ShortcutDecl): void => {
    const next = { ...overrides };
    delete next[decl.id];
    overridesField.set(next);
  };

  return (
    <fieldset disabled={native && (loadError || ['loading', 'conflict'].includes(status))} className="flex min-w-0 flex-col gap-3">
      {rendered.map((group, groupIndex) => (
        <SettingsSection key={group.category} item={`shortcuts.${group.category}`}>
          <div className="flex items-center justify-between">
            <SettingsGroupTitle>{t(CATEGORY_TITLE_KEYS[group.category])}</SettingsGroupTitle>
            {groupIndex === 0 ? (
              <button
                type="button"
                className="rounded border border-border/60 px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
                onClick={() => overridesField.set({})}
              >
                {t('settings.shortcuts.resetAll')}
              </button>
            ) : null}
          </div>
          {group.entries.map((decl) => (
            <ShortcutRow
              key={decl.id}
              decl={decl}
              overrides={overrides}
              onEdit={() => setRecording(decl)}
              onReset={() => resetRow(decl)}
            />
          ))}
        </SettingsSection>
      ))}
      {recording !== null ? (
        <ShortcutRecordingDialog
          decl={recording}
          overrides={overrides}
          onConfirm={applyOverrides}
          onCancel={() => setRecording(null)}
        />
      ) : null}
    </fieldset>
  );
}

function ShortcutRow({
  decl, overrides, onEdit, onReset,
}: { decl: ShortcutDecl; overrides: Record<string, string>; onEdit: () => void; onReset: () => void }): ReactNode {
  const { t } = useI18n();
  const binding = effectiveBinding(decl, overrides);
  const combo = parseCombo(binding);
  const overridden = overrides[decl.id] !== undefined && overrides[decl.id] !== decl.defaultBinding;
  return (
    <div className="flex min-h-9 items-center justify-between gap-4 rounded px-2 py-1 hover:bg-interactive-hover/30" data-settings-item={`shortcuts.row.${decl.id}`}>
      <div className="min-w-0">
        <div className="text-xs font-medium text-foreground">
          {t(decl.settingsLabelKey ?? 'shortcuts.label.focus_input')}
        </div>
        {binding === UNASSIGNED_SHORTCUT ? (
          <div className="text-[11px] text-muted-foreground">{t('settings.shortcuts.unassigned')}</div>
        ) : null}
      </div>
      <div className="flex items-center gap-2">
        {combo.chords.length > 0 ? (
          <kbd className="rounded border border-border/50 bg-interactive-hover/40 px-1.5 py-0.5 font-mono text-[11px] text-foreground">
            {displayCombo(combo, false)}
          </kbd>
        ) : null}
        {decl.customizable ? (
          <>
            <button type="button" className="rounded border border-border/60 px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground" onClick={onEdit}>
              {t('settings.shortcuts.edit')}
            </button>
            {overridden ? (
              <button type="button" className="rounded px-1 py-0.5 text-[11px] text-muted-foreground hover:text-foreground" onClick={onReset}>
                {t('settings.shortcuts.reset')} ↺
              </button>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}

