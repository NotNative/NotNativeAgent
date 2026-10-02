// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../../lib/i18n/context.tsx';
import { useAuthSessionStore } from '../../../lib/runtime-auth-expiry.ts';
import { requestNativeConfiguration, type NativeConfigurationView } from '../../../lib/nnd/configuration.ts';
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
it('labels unsupported endpoint separately from a native missing source', async () => {
  vi.mocked(requestNativeConfiguration).mockRejectedValueOnce(new Error('native-configuration-unsupported'));
  mount(); await act(async () => {});
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('does not provide');
  vi.mocked(requestNativeConfiguration).mockResolvedValueOnce({ ...view, source_state: 'missing', fields: [] });
  await act(async () => container.querySelector('button')?.click());
  expect(container.textContent).toContain('missing');
  expect(container.querySelector('[role="alert"]')).toBeNull();
});
