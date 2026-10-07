// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../../lib/i18n/context.tsx';
import { useAuthSessionStore } from '../../../lib/runtime-auth-expiry.ts';
import { requestNativeConfiguration, type NativeConfigurationView, type NativeConfigurationField } from '../../../lib/nnd/configuration.ts';
import { NativeConfigurationPage } from '../pages/native-configuration.tsx';

const runtime = vi.hoisted(() => ({ key: 'local', callback: () => {} }));
vi.mock('../../../lib/nnd/configuration.ts', () => ({ requestNativeConfiguration: vi.fn() }));
vi.mock('../../../lib/runtime-switch.ts', () => ({ getRuntimeKey: () => runtime.key,
  isTransientRuntimeKey: (key: string) => key === 'url:default' || key === 'mobile-disconnected',
  onRuntimeEndpointChanged: (callback: () => void) => { runtime.callback = callback; return () => {}; } }));

const view: NativeConfigurationView = {
  schema_version: '1.0', installation_id: 'nna_one', data_id: 'data_one', scope: 'user',
  source_state: 'present', source_revision: 'absent', resolution_revision: 'absent', source_revisions: [],
  application: 'not_applied', fields: [
    { path: 'provider.credential', catalog_path: 'provider.credential', explicit: { present: true, redacted: true },
      effective: { present: true, redacted: true, source: 'user' }, application: 'not_applied' },
    { path: 'streaming', catalog_path: 'streaming', explicit: { present: false },
      effective: { present: true, value: true, source: 'compiled_default' }, application: 'not_applied' },
  ],
};
let root: Root; let container: HTMLDivElement;
function mount() {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  act(() => root.render(<I18nProvider><NativeConfigurationPage /></I18nProvider>));
}
afterEach(() => { act(() => root?.unmount()); container?.remove(); vi.resetAllMocks(); runtime.key = 'local';
  useAuthSessionStore.getState().markOk(); });

it('shows explicit and effective values, provenance, redaction and not-applied without saving', async () => {
  vi.mocked(requestNativeConfiguration).mockResolvedValue(view); mount(); await act(async () => {});
  expect(container.textContent).toContain('nna_one');
  expect(container.textContent).toContain('Not set');
  expect(container.textContent).toContain('compiled_default');
  expect(container.textContent).toContain('Redacted');
  expect(container.textContent).toContain('Application status: not applied');
  expect(requestNativeConfiguration).toHaveBeenCalledTimes(1);
  expect(container.querySelector('button')?.textContent).toContain('Refresh');
});
it('aborts old runtime read and ignores late completion from the previous installation', async () => {
  let finish!: (value: NativeConfigurationView) => void;
  vi.mocked(requestNativeConfiguration).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
    .mockResolvedValue({ ...view, installation_id: 'nna_two' });
  mount(); const signal = vi.mocked(requestNativeConfiguration).mock.calls[0]![0];
  await act(async () => { runtime.key = 'remote'; runtime.callback(); });
  expect(signal.aborted).toBe(true);
  await act(async () => finish(view));
  expect(container.textContent).toContain('nna_two');
  expect(container.textContent).not.toContain('nna_one');
});
it('clears private rows on auth expiry and only reloads after reauthentication', async () => {
  vi.mocked(requestNativeConfiguration).mockResolvedValue(view); mount(); await act(async () => {});
  expect(container.textContent).toContain('provider.credential');
  await act(async () => useAuthSessionStore.getState().markExpired());
  expect(container.textContent).not.toContain('provider.credential');
  expect(container.textContent).toContain('Reauthenticate');
  await act(async () => useAuthSessionStore.getState().markOk());
  expect(requestNativeConfiguration).toHaveBeenCalledTimes(2);
});
it('aborts an in-flight read on auth expiry and ignores its late response', async () => {
  let finish!: (value: NativeConfigurationView) => void;
  vi.mocked(requestNativeConfiguration).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  mount(); const signal = vi.mocked(requestNativeConfiguration).mock.calls[0]![0];
  await act(async () => useAuthSessionStore.getState().markExpired());
  expect(signal.aborted).toBe(true);
  await act(async () => finish(view));
  expect(container.textContent).not.toContain('provider.credential');
  expect(requestNativeConfiguration).toHaveBeenCalledTimes(1);
});
it('renders the mission authority rows as honest absence for the desktop principal', async () => {
  const paths = ['mission', 'mission.id', 'mission.outcome', 'mission.revocation_id',
    'mission.not_before', 'mission.expires_at', 'mission.resources', 'mission.targets',
    'mission.side_effects', 'mission.credential_refs', 'mission.bounds', 'mission.termination',
    'mission.bounds.max_turns', 'mission.bounds.max_tool_calls', 'mission.bounds.max_duration_ms',
    'mission.termination.suspend_on', 'mission.termination.terminate_on'];
  const missionView: NativeConfigurationView = {
    ...view,
    fields: paths.map((path) => ({
      path, catalog_path: path,
      explicit: { present: false },
      effective: { present: false },
      application: 'not_applied' as const,
    })),
  };
  vi.mocked(requestNativeConfiguration).mockResolvedValue(missionView);
  mount(); await act(async () => {});
  for (const path of paths) expect(container.textContent).toContain(path);
  expect((container.textContent?.match(/Not set/g) ?? []).length).toBeGreaterThanOrEqual(paths.length);
  expect(container.textContent).not.toContain('mission_authority_forbidden');
  expect(container.textContent).not.toContain('ship the release');
});

it('renders the tui keyboard family with merged defaults, provenance and honest container absence', async () => {
  const binding = (action: string, key: string, explicit: boolean): NativeConfigurationField => ({
    path: `tui.key_bindings.${action}`, catalog_path: `tui.key_bindings.${action}`,
    explicit: explicit ? { present: true, value: key } : { present: false },
    effective: explicit ? { present: true, value: key, source: 'user' }
      : { present: true, value: key, source_unavailable: true }, application: 'not_applied' });
  const tuiView: NativeConfigurationView = { ...view, fields: [
    { path: 'tui.reduced_motion', catalog_path: 'tui.reduced_motion', explicit: { present: true, value: true },
      effective: { present: true, value: true, source: 'user' }, application: 'not_applied' },
    { path: 'tui.color', catalog_path: 'tui.color', explicit: { present: false },
      effective: { present: true, value: true, source: 'compiled_default' }, application: 'not_applied' },
    { path: 'tui.key_bindings', catalog_path: 'tui.key_bindings', explicit: { present: true, value_unavailable: true },
      effective: { present: true, value_unavailable: true, source_unavailable: true }, application: 'not_applied' },
    binding('submit', 'ctrl+e', true), binding('cancel', 'ctrl+x', true),
    binding('newline', 'ctrl+j', false), binding('help', 'ctrl+g', false),
    binding('allow_once', 'ctrl+y', false), binding('deny', 'ctrl+n', false),
    binding('reset_keys', 'f12', false), binding('undo', 'ctrl+z', false),
    binding('toggle_activity', 'ctrl+o', false), binding('new_tab', 'ctrl+t', false),
    binding('close_tab', 'ctrl+w', false), binding('previous_tab', 'ctrl+pageup', false),
    binding('next_tab', 'ctrl+pagedown', false), binding('cycle_review', 'shift+tab', false),
    binding('scroll_page_up', 'pageup', false), binding('scroll_page_down', 'pagedown', false),
    binding('scroll_bottom', 'end', false),
  ] };
  vi.mocked(requestNativeConfiguration).mockResolvedValue(tuiView);
  mount(); await act(async () => {});
  expect(container.textContent).toContain('tui.key_bindings.submit');
  expect(container.textContent).toContain('ctrl+e');
  expect(container.textContent).toContain('shift+tab');
  expect(container.textContent).toContain('Value unavailable');
  expect(container.textContent).toContain('compiled_default');
  expect(container.textContent).toContain('user');
  expect(container.textContent).toContain('Application status: not applied');
});
it('labels unsupported endpoint separately from a native missing source', async () => {
  vi.mocked(requestNativeConfiguration).mockRejectedValueOnce(new Error('native-configuration-unsupported'));
  mount(); await act(async () => {});
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('does not provide');
  vi.mocked(requestNativeConfiguration).mockResolvedValueOnce({ ...view, source_state: 'missing', fields: [] });
  await act(async () => container.querySelector('button')?.click());
  expect(container.textContent).toContain('missing');
  expect(container.querySelector('[data-settings-item="native-configuration.inventory"] [role="alert"]')).toBeNull();
});

it('renders all four recovery census rows with the unset wall clock and the unavailable ladder origin', async () => {
  const recoveryView: NativeConfigurationView = { ...view, fields: [
    { path: 'recovery.max_model_steps', catalog_path: 'recovery.max_model_steps', explicit: { present: false },
      effective: { present: true, value: 1024, source: 'compiled_default' }, application: 'not_applied' },
    { path: 'recovery.local_retry_limit', catalog_path: 'recovery.local_retry_limit', explicit: { present: false },
      effective: { present: true, value: 3, source: 'compiled_default' }, application: 'not_applied' },
    { path: 'recovery.turn_wall_clock_ms', catalog_path: 'recovery.turn_wall_clock_ms', explicit: { present: false },
      effective: { present: true, value: null, source: 'compiled_default' }, application: 'not_applied' },
    { path: 'recovery.ladder', catalog_path: 'recovery.ladder', explicit: { present: false },
      effective: { present: true, value: ['nudge', 'compact'], source_unavailable: true }, application: 'not_applied' },
  ] };
  vi.mocked(requestNativeConfiguration).mockResolvedValue(recoveryView);
  mount(); await act(async () => {});
  const rowText = (path: string) => Array.from(container.querySelectorAll('.font-mono'))
    .find(node => node.textContent === path)?.parentElement?.textContent ?? '';
  expect(rowText('recovery.max_model_steps')).toContain('1024');
  expect(rowText('recovery.max_model_steps')).toContain('compiled_default');
  expect(rowText('recovery.local_retry_limit')).toContain('3');
  expect(rowText('recovery.turn_wall_clock_ms')).toContain('null');
  expect(rowText('recovery.ladder')).toContain('["nudge","compact"]');
  expect(rowText('recovery.ladder')).toContain('Unavailable');
  expect(container.textContent).toContain('Not set');
});

it('renders the three telemetry census rows with the inert nulls and the user destination', async () => {
  const telemetryView: NativeConfigurationView = { ...view, fields: [
    { path: 'telemetry.enabled', catalog_path: 'telemetry.enabled', explicit: { present: true, value: true },
      effective: { present: true, value: true, source: 'user' }, application: 'not_applied' },
    { path: 'telemetry.destination', catalog_path: 'telemetry.destination',
      explicit: { present: true, value: 'https://collector.example/uploads' },
      effective: { present: true, value: 'https://collector.example/uploads', source: 'user' }, application: 'not_applied' },
    { path: 'telemetry.retention', catalog_path: 'telemetry.retention', explicit: { present: false },
      effective: { present: true, value: null, source: 'compiled_default' }, application: 'not_applied' },
  ] };
  vi.mocked(requestNativeConfiguration).mockResolvedValue(telemetryView);
  mount(); await act(async () => {});
  const rowText = (path: string) => Array.from(container.querySelectorAll('.font-mono'))
    .find(node => node.textContent === path)?.parentElement?.textContent ?? '';
  expect(rowText('telemetry.enabled')).toContain('true');
  expect(rowText('telemetry.destination')).toContain('https://collector.example/uploads');
  expect(rowText('telemetry.retention')).toContain('Not set');
  expect(rowText('telemetry.retention')).toContain('null');
  expect(rowText('telemetry.retention')).toContain('compiled_default');
});

it('renders the reviewer-ledger retention row with its default budget', async () => {
  const ledgerPath = 'reviewer_ledger.retention_entries';
  const ledgerView: NativeConfigurationView = { ...view, fields: [
    { path: ledgerPath, catalog_path: ledgerPath, explicit: { present: false },
      effective: { present: true, value: 10000, source: 'compiled_default' }, application: 'not_applied' },
  ] };
  vi.mocked(requestNativeConfiguration).mockResolvedValue(ledgerView);
  mount(); await act(async () => {});
  const rowText = (path: string) => Array.from(container.querySelectorAll('.font-mono'))
    .find(node => node.textContent === path)?.parentElement?.textContent ?? '';
  expect(rowText(ledgerPath)).toContain('Not set');
  expect(rowText(ledgerPath)).toContain('10000');
  expect(rowText(ledgerPath)).toContain('compiled_default');
});

it('renders provider profile rows with derived values, redaction, and honest absence', async () => {
  // NNA serves provider profiles read-only: derived limits name no layer,
  // the capability container has no printable value, and a credential
  // reference arrives already redacted. The page states each of those
  // instead of leaving a blank cell that reads like a missing secret.
  const providerView: NativeConfigurationView = { ...view, fields: [
    { path: 'providers[local].trust_zone', catalog_path: 'providers[local].trust_zone', explicit: { present: false },
      effective: { present: true, value: 'loopback', source: 'user' }, application: 'not_applied' },
    { path: 'providers[local].tool_call_mode', catalog_path: 'providers[local].tool_call_mode',
      explicit: { present: false }, effective: { present: true, value: 'single', source_unavailable: true },
      application: 'not_applied' },
    { path: 'providers[local].capabilities', catalog_path: 'providers[local].capabilities', explicit: { present: false },
      effective: { present: true, value_unavailable: true, source_unavailable: true }, application: 'not_applied' },
    { path: 'providers[local].credential', catalog_path: 'providers[local].credential', explicit: { present: false },
      effective: { present: false }, application: 'not_applied' },
    { path: 'providers[local].credential_env', catalog_path: 'providers[local].credential_env',
      explicit: { present: false }, effective: { present: true, redacted: true, source: 'user' },
      application: 'not_applied' },
    { path: 'provider.capabilities.tools', catalog_path: 'provider.capabilities.tools', explicit: { present: false },
      effective: { present: true, value: 'unknown', source_unavailable: true }, application: 'not_applied' },
  ] };
  vi.mocked(requestNativeConfiguration).mockResolvedValue(providerView);
  mount(); await act(async () => {});
  const rowText = (path: string) => Array.from(container.querySelectorAll('.font-mono'))
    .find(node => node.textContent === path)?.parentElement?.textContent ?? '';
  expect(rowText('providers[local].trust_zone')).toContain('loopback');
  expect(rowText('providers[local].tool_call_mode')).toContain('single');
  expect(rowText('providers[local].capabilities')).toContain('Value unavailable');
  expect(rowText('providers[local].credential')).toContain('Not set');
  expect(rowText('providers[local].credential_env')).toContain('Redacted');
  expect(rowText('provider.capabilities.tools')).toContain('unknown');
  expect(container.textContent).not.toContain('undefined');
});
