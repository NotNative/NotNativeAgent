// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState, type ReactNode } from 'react';
import { useTheme } from '../../ThemeProvider.tsx';
import { useSettingsField } from '../page-helpers.tsx';
import { useNativePreferenceState, reloadNativePreferences, retryNativePreferences } from '../../../lib/settings/native-preferences.ts';
import { useSettingsStore } from '../../../lib/settings/store.ts';
import { listBuiltInThemes } from '../../../lib/theme/themes.ts';
import { NATIVE_PREFERENCE_DEFAULTS } from '../../../lib/settings/native-registry.ts';
import { runtimeFetch } from '../../../lib/runtime-fetch.ts';
import { InstallationObservationPanel } from './installation-observation.tsx';

export const NATIVE_FOUNDATION_SEARCH = [
  { page: 'general', id: 'native.general', title: 'General and About', keywords: 'version desktop browser tray startup installation' },
  { page: 'appearance', id: 'native.theme', title: 'Theme', keywords: 'system light dark appearance colors' },
  { page: 'appearance', id: 'native.fontSize', title: 'Interface size', keywords: 'font size text scale zoom' },
  { page: 'chat', id: 'native.enterToSend', title: 'Send message with', keywords: 'enter keyboard composer newline' },
  { page: 'chat', id: 'native.inputSpellcheckEnabled', title: 'Spellcheck', keywords: 'spelling composer input' },
  { page: 'chat', id: 'native.wideChatLayoutEnabled', title: 'Wide conversation layout', keywords: 'width transcript composer' },
  { page: 'chat', id: 'native.userMessageRenderingMode', title: 'Your message format', keywords: 'plain markdown rendering' },
  { page: 'notifications', id: 'native.celebrationPreference', title: 'Turn completion indicator', keywords: 'notifications celebration pulse animation motion' },
  { page: 'shortcuts', id: 'shortcuts.application', title: 'Keyboard shortcuts', keywords: 'keybind rebind reset conflicts' },
] as const;

export function NativePreferenceStatus(): ReactNode {
  const { status, error } = useNativePreferenceState();
  const loadError = useSettingsStore(state => state.loadError);
  return <div className="border-b border-border/50 px-4 py-2 text-xs" aria-live="polite">
    {error ? <p role="alert">{error}</p> : <span role="status">{status === 'saved' ? 'Interface preferences saved · applies immediately · shared by this installation’s desktop and web UI' : status === 'saving' ? 'Saving interface preferences…' : 'Loading saved interface preferences…'}</span>}
    {status === 'error' ? <button type="button" className="ml-3 underline" onClick={() => void retryNativePreferences()}>{loadError ? 'Retry loading settings' : 'Retry save'}</button> : null}
    {status === 'error' || status === 'conflict' ? <button type="button" className="ml-3 underline" onClick={() => void reloadNativePreferences()}>Reload saved settings (discard local edits)</button> : null}
  </div>;
}

function SelectField({ name, label, value, options, onChange }: { name: string; label: string; value: string; options: { value: string; label: string }[]; onChange(value: string): void }): ReactNode {
  return <label className="flex items-center justify-between gap-4 py-3 text-sm" data-settings-item={`native.${name}`}>
    {label}<select aria-label={label} className="max-w-[65%] rounded border border-border bg-background p-2" value={value} onChange={e => onChange(e.target.value)}>
      {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
  </label>;
}

function Choice({ name, label, options }: { name: string; label: string; options?: { value: string; label: string }[] }): ReactNode {
  const field = useSettingsField<unknown>(name), value = field.value ?? NATIVE_PREFERENCE_DEFAULTS[name];
  if (options) return <SelectField name={name} label={label} value={String(value)} options={options} onChange={field.set} />;
  return <label className="flex items-center justify-between gap-4 py-3 text-sm" data-settings-item={`native.${name}`}>
    {label}<input type="checkbox" checked={value === true} onChange={e => field.set(e.target.checked)} />
  </label>;
}

function Appearance(): ReactNode {
  const theme = useTheme();
  const size = useSettingsField<number>('fontSize');
  return <>
    <SelectField name="theme" label="Theme" value={theme.mode} options={['system', 'light', 'dark'].map(value => ({ value, label: value === 'system' ? 'Follow system' : value === 'light' ? 'Light' : 'Dark' }))} onChange={value => theme.setMode(value as 'system' | 'light' | 'dark')} />
    {(['light', 'dark'] as const).map(variant => <SelectField key={variant} name={`${variant}ThemeId`} label={`${variant === 'light' ? 'Light' : 'Dark'} theme`} value={variant === 'light' ? theme.lightThemeId : theme.darkThemeId}
      options={listBuiltInThemes(variant).map(item => ({ value: item.metadata.id, label: item.metadata.name }))}
      onChange={variant === 'light' ? theme.setLightTheme : theme.setDarkTheme} />)}
    <SelectField name="fontSize" label="Interface size" value={String(size.value ?? 100)} options={[75, 90, 100, 110, 125, 150, 175, 200].map(value => ({ value: String(value), label: `${value}%` }))} onChange={value => size.set(Number(value))} />
  </>;
}

function Conversations(): ReactNode {
  const configured = useSettingsField<boolean>('enterToSendConfigured'), enter = useSettingsField<boolean>('enterToSend');
  return <>
    <SelectField name="enterToSend" label="Send message with" value={configured.value ? enter.value ? 'enter' : 'modifier' : 'default'} options={[
      { value: 'default', label: 'Platform default' }, { value: 'enter', label: 'Enter (Shift+Enter adds a line)' }, { value: 'modifier', label: 'Ctrl/Cmd+Enter (Enter adds a line)' },
    ]} onChange={value => { enter.set(value !== 'modifier'); configured.set(value !== 'default'); }} />
    <Choice name="inputSpellcheckEnabled" label="Spellcheck" />
    <Choice name="wideChatLayoutEnabled" label="Wide conversation layout" />
    <Choice name="userMessageRenderingMode" label="Your message format" options={[{ value: 'markdown', label: 'Markdown' }, { value: 'plain', label: 'Plain text' }]} />
  </>;
}

function General(): ReactNode {
  const [health, setHealth] = useState<Record<string, unknown> | null>(null), [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    void runtimeFetch('/health', { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('Could not read service version.');
      const value = await response.json(); if (!controller.signal.aborted) setHealth(value);
    }).catch(() => { if (!controller.signal.aborted) setError('Could not read service version. Reopen General to retry.'); });
    return () => controller.abort();
  }, []);
  return <div data-settings-item="native.general" className="space-y-4 text-sm">
    <h3 className="font-semibold">NotNativeAgent</h3>
    <p>NNA runs locally. Desktop and browser connect to the same background runtime.</p>
    <h3 className="font-semibold">Desktop and browser</h3>
    <p>The NNA tray opens the desktop or your system’s default browser. Closing the desktop window leaves the service running. Quit NNA stops it; Restart NNA restarts this runtime.</p>
    <p>Service startup, login wiring and update diagnostics are available under Advanced. Gateway and OpenCode are managed separately.</p>
    <h3 className="font-semibold">About</h3>
    {error ? <p role="alert">{error}</p> : health ? <dl className="grid grid-cols-[auto_1fr] gap-3"><dt>Desktop/web version</dt><dd>{String(health.version ?? 'Unavailable')}</dd><dt>Runtime</dt><dd>{health.runtime === 'service' ? 'NNA background service' : 'Web'}</dd></dl> : <p role="status">Reading service version…</p>}
    <InstallationObservationPanel />
  </div>;
}

export function NativeFoundationPage({ page }: { page: string }): ReactNode {
  const status = useNativePreferenceState(s => s.status);
  const loading = useSettingsStore(s => s.loading);
  const loadError = useSettingsStore(s => s.loadError);
  if (page === 'general') return <General />;
  return <fieldset disabled={loading || loadError || status === 'conflict'} className="min-w-0 space-y-2">
    <h2 className="text-lg font-semibold">{page === 'chat' ? 'Conversations' : page === 'appearance' ? 'Appearance' : 'Notifications'}</h2>
    {page === 'appearance' ? <Appearance /> : page === 'chat' ? <Conversations /> : <>
      <p className="text-sm text-muted-foreground">A completion indicator is shown only after a successful turn in the conversation you are viewing. Errors and cancelled turns do not trigger it.</p>
      <Choice name="celebrationPreference" label="Turn completion indicator" options={[{ value: 'off', label: 'Off' }, { value: 'static', label: 'Brief status' }, { value: 'pulse', label: 'Animated status (respects reduced motion)' }]} />
    </>}
  </fieldset>;
}
