// SPDX-License-Identifier: Apache-2.0
/**
 * Appearance page (doc 14 §G.4 OpenChamberVisualSettings visual column):
 * theme pair + reload, language, time/week format, typography + spacing,
 * fonts, editor keymap. VS Code/desktop-only rows (window controls, dock
 * badge, inputBarOffset, terminal shell) render with their phases.
 */
import { useMemo, type ReactNode } from 'react';
import {
  SettingsSection, SettingsGroupTitle, SettingsFieldRow, SettingsSelect, SettingsNumberInput,
  SettingsRadioGroup,
} from '../primitives.tsx';
import { useSettingsField } from '../page-helpers.tsx';
import { useI18n } from '../../I18nProvider.tsx';
import { useTheme } from '../../ThemeProvider.tsx';
import { LOCALES, type Locale } from '../../../lib/i18n/runtime.ts';
import { UI_FONT_OPTIONS, MONO_FONT_OPTIONS } from '../../../lib/settings/font-options.ts';
import type { TimeFormatPreference } from '../../../lib/format/time.ts';

interface ThemePick {
  id: string;
  name: string;
  variant: 'light' | 'dark';
}

export function AppearancePage(): ReactNode {
  const { t, locale, locales, setLocale, label } = useI18n();
  const { mode, setMode, lightThemeId, setLightTheme, darkThemeId, setDarkTheme, themes, reloadThemes, themesLoading } = useTheme();
  const timeFormat = useSettingsField<TimeFormatPreference>('timeFormatPreference');
  const weekStart = useSettingsField<'auto' | 'sunday' | 'monday'>('weekStartPreference');
  const fontSize = useSettingsField<number>('fontSize');
  const padding = useSettingsField<number>('padding');
  const uiFont = useSettingsField<string>('uiFont');
  const monoFont = useSettingsField<string>('monoFont');
  const editorFontSize = useSettingsField<number>('editorFontSize');
  const terminalFontSize = useSettingsField<number>('terminalFontSize');
  const fileEditorKeymap = useSettingsField<'default' | 'vim'>('fileEditorKeymap');

  const [lightThemes, darkThemes] = useMemo(() => {
    const split: { light: ThemePick[]; dark: ThemePick[] } = { light: [], dark: [] };
    for (const theme of themes) split[theme.variant].push(theme);
    return [split.light, split.dark] as const;
  }, [themes]);

  return (
    <div className="flex flex-col gap-3">
      <SettingsSection>
        <SettingsGroupTitle>{t('settings.search.themeMode')}</SettingsGroupTitle>
        <SettingsRadioGroup
          item="appearance.theme-mode"
          value={mode}
          options={[
            { value: 'system', label: t('settings.appearance.followSystem') },
            { value: 'light', label: t('settings.appearance.light') },
            { value: 'dark', label: t('settings.appearance.dark') },
          ]}
          onChange={(value) => setMode(value as 'system' | 'light' | 'dark')}
        />
        <SettingsFieldRow label={t('settings.search.lightTheme')} item="appearance.light-theme">
          <ThemeSelect fallback="notnative-light" value={lightThemeId} options={lightThemes} onChange={setLightTheme} />
        </SettingsFieldRow>
        <SettingsFieldRow label={t('settings.search.darkTheme')} item="appearance.dark-theme">
          <ThemeSelect fallback="notnative-dark" value={darkThemeId} options={darkThemes} onChange={setDarkTheme} />
        </SettingsFieldRow>
        <SettingsFieldRow
          label={t('settings.search.reloadThemes')}
          item="appearance.reload-themes"
          helper={t('settings.appearance.themesHelper')}
        >
          <button
            type="button"
            className="inline-flex h-8 items-center rounded-[7px] border border-primary/40 px-3 text-xs text-primary hover:bg-primary/10 disabled:opacity-50"
            disabled={themesLoading}
            onClick={() => void reloadThemes()}
          >
            {themesLoading ? t('settings.appearance.reloading') : t('settings.appearance.reloadAction')}
          </button>
        </SettingsFieldRow>
      </SettingsSection>

      <SettingsSection title={t('settings.appearance.languageFormats')}>
        <SettingsFieldRow label={t('settings.search.language')} item="appearance.language">
          <SettingsSelect
            value={locale}
            resetValue="en"
            onChange={(value) => setLocale(value as Locale)}
            options={locales.map((candidate) => ({ value: candidate, label: label(candidate) }))}
          />
        </SettingsFieldRow>
        <SettingsFieldRow label={t('settings.search.timeFormat')} item="appearance.time-format">
          <SettingsSelect
            value={timeFormat.value ?? 'auto'}
            resetValue="auto"
            onChange={(value) => timeFormat.set(value as TimeFormatPreference)}
            options={[
              { value: 'auto', label: t('settings.appearance.auto') },
              { value: '24h', label: t('settings.appearance.time24Hours') },
              { value: '12h', label: t('settings.appearance.time12Hours') },
            ]}
          />
        </SettingsFieldRow>
        <SettingsFieldRow label={t('settings.search.weekStart')} item="appearance.week-start">
          <SettingsSelect
            value={weekStart.value ?? 'auto'}
            resetValue="auto"
            onChange={(value) => weekStart.set(value as 'auto' | 'sunday' | 'monday')}
            options={[
              { value: 'auto', label: t('settings.appearance.auto') },
              { value: 'monday', label: t('settings.appearance.monday') },
              { value: 'sunday', label: t('settings.appearance.sunday') },
            ]}
          />
        </SettingsFieldRow>
      </SettingsSection>

      <SettingsSection title={t('settings.appearance.typographySpacing')}>
        <SettingsFieldRow label={t('settings.search.fontSize')} item="appearance.interface-font-size">
          <SettingsNumberInput value={fontSize.value ?? 100} min={50} max={200} step={5} unit="%" resetValue={100} onChange={fontSize.set} />
        </SettingsFieldRow>
        <SettingsFieldRow label={t('settings.search.padding')} item="appearance.spacing-density">
          <SettingsNumberInput value={padding.value ?? 100} min={50} max={200} step={5} unit="%" resetValue={100} onChange={padding.set} />
        </SettingsFieldRow>
        <SettingsFieldRow label={t('settings.search.uiFont')} item="appearance.interface-font">
          <SettingsSelect value={uiFont.value ?? 'system'} resetValue="system" onChange={uiFont.set}
            options={UI_FONT_OPTIONS.map((option) => ({ value: option.id, label: option.label }))} />
        </SettingsFieldRow>
        <SettingsFieldRow label={t('settings.search.monoFont')} item="appearance.code-font">
          <SettingsSelect value={monoFont.value ?? 'system-mono'} resetValue="system-mono" onChange={monoFont.set}
            options={MONO_FONT_OPTIONS.map((option) => ({ value: option.id, label: option.label }))} />
        </SettingsFieldRow>
        <SettingsFieldRow label={t('settings.search.editorFontSize')} item="appearance.editor-font-size">
          <SettingsNumberInput value={editorFontSize.value ?? 13} min={9} max={32} step={1} unit="px" resetValue={13} onChange={editorFontSize.set} />
        </SettingsFieldRow>
        <SettingsFieldRow label={t('settings.search.terminalFontSize')} item="appearance.terminal-font-size">
          <SettingsNumberInput value={terminalFontSize.value ?? 14} min={9} max={52} step={1} unit="px" resetValue={14} onChange={terminalFontSize.set} />
        </SettingsFieldRow>
        <SettingsFieldRow label={t('settings.search.keymap')} item="appearance.file-editor-keymap">
          <SettingsRadioGroup
            value={fileEditorKeymap.value ?? 'default'}
            options={[{ value: 'default', label: t('settings.appearance.defaultKeymap') }, { value: 'vim', label: t('settings.appearance.vimKeymap') }]}
            onChange={(value) => fileEditorKeymap.set(value as 'default' | 'vim')}
          />
        </SettingsFieldRow>
      </SettingsSection>
    </div>
  );
}

function ThemeSelect({
  value, options, onChange, fallback,
}: { value: string; fallback: string; options: ThemePick[]; onChange: (id: string) => void }): ReactNode {
  const known = options.some((option) => option.id === value);
  return (
    <SettingsSelect
      value={known ? value : fallback}
      onChange={onChange}
      options={options.map((option) => ({ value: option.id, label: option.name }))}
    />
  );
}

