// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
import { act, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../../lib/i18n/context.tsx';
import { useAuthSessionStore } from '../../../lib/runtime-auth-expiry.ts';
import { beginAuthorityRecovery, finishAuthorityRecovery } from '../../../sync/authority-sync.ts';
import { OperationalSettingsPage } from '../pages/operational-settings.tsx';
import { useNativeObservation } from '../pages/use-native-observation.ts';
const context = vi.hoisted(() => ({ key: 'local', origin: 'http://127.0.0.1:3000', listeners: new Set<() => void>(), mounts: [] as string[], closes: [] as string[] }));
vi.mock('../../../lib/runtime-switch.ts', async original => ({ ...(await original<object>()), getRuntimeKey: () => context.key,
  onRuntimeEndpointChanged: (notify: () => void) => { context.listeners.add(notify); return () => { context.listeners.delete(notify); }; } }));
vi.mock('../../../lib/runtime-url.ts', async original => ({ ...(await original<object>()), getApiBaseUrl: () => context.origin }));
vi.mock('../pages/web-search-settings.tsx', () => ({ WebSearchSettings: () => <Probe name="search" /> }));
vi.mock('../pages/web-fetch-trust.tsx', () => ({ WebFetchTrust: () => <Probe name="fetch" /> }));
vi.mock('../pages/browser-observation.tsx', () => ({ BrowserObservationPanel: () => <Probe name="browser" /> }));
function Probe({ name }: { name: string }) {
  const [value, setValue] = useState('');
  useEffect(() => { context.mounts.push(name); return () => { context.closes.push(name); }; }, [name]);
  return <label>{name}<input aria-label="Probe draft" value={value} onChange={event => setValue(event.target.value)} /></label>;
}
let root: Root, node: HTMLDivElement;
async function render(child: React.ReactNode) { await act(async () => root.render(child)); }
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true; context.key = 'local'; context.origin = 'http://127.0.0.1:3000'; context.mounts = []; context.closes = [];
  useAuthSessionStore.getState().markOk(); const token = beginAuthorityRecovery('local'); finishAuthorityRecovery('local', token, true);
  node = document.createElement('div'); document.body.append(node); root = createRoot(node);
});
afterEach(() => { act(() => root.unmount()); node.remove(); context.listeners.clear(); });

it('mounts only the active operational section, including search jumps to a different tab', async () => {
  await render(<I18nProvider><OperationalSettingsPage page="operations-search" /></I18nProvider>);
  expect(context.mounts).toEqual(['search']); expect(node.querySelector('[role="tabpanel"]')?.getAttribute('aria-label')).toBe('Web search');
  await act(async () => [...node.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(row => row.textContent === 'Managed browser')!.click());
  expect(context.mounts).toEqual(['search', 'browser']); expect(context.closes).toEqual(['search']);
  await render(<I18nProvider><OperationalSettingsPage page="operations-search" focusItem="operations.fetch" /></I18nProvider>);
  expect(node.querySelector('[role="tabpanel"]')?.getAttribute('aria-label')).toBe('Web fetch');
  expect(context.closes).toEqual(['search', 'browser']); expect(context.mounts).not.toContain('deployment');
});

it('clears the active child on a same-key origin switch and unmounts controls during authority recovery', async () => {
  await render(<I18nProvider><OperationalSettingsPage page="operations-search" /></I18nProvider>);
  await act(async () => { const input = node.querySelector('input')!; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Host A draft'); input.dispatchEvent(new Event('input', { bubbles: true })); });
  await act(async () => { context.origin = 'http://127.0.0.1:4000'; for (const notify of context.listeners) notify(); });
  expect(node.querySelector('input')?.value).toBe(''); expect(context.mounts).toEqual(['search', 'search']); expect(context.closes).toEqual(['search']);
  let token = 0; await act(async () => { token = beginAuthorityRecovery('local'); }); expect(node.querySelector('input')).toBeNull();
  await act(async () => { finishAuthorityRecovery('local', token, true); }); expect(node.querySelector('input')).not.toBeNull();
});

it('does not mount operational capabilities while authentication is expired', async () => {
  useAuthSessionStore.setState({ status: 'expired' });
  await render(<I18nProvider><OperationalSettingsPage page="operations-search" /></I18nProvider>);
  expect(context.mounts).toEqual([]); expect(node.querySelector('[role="alert"]')?.textContent).toContain('Reconnect');
  await act(async () => useAuthSessionStore.getState().markOk()); expect(context.mounts).toEqual(['search']);
});

it('aborts stale observations, ignores late replies, and permits retry after a failed read', async () => {
  const read = vi.fn<(signal: AbortSignal) => Promise<string>>(); let old!: (value: string) => void;
  read.mockImplementationOnce(() => new Promise(resolve => { old = resolve; })).mockResolvedValueOnce('Host B');
  function Observation() { const state = useNativeObservation(read); return <><p>{state.data}</p><span role="alert">{state.error}</span><button onClick={() => { void state.reload(); }}>Retry</button></>; }
  await render(<Observation />); const signal = read.mock.calls[0]![0];
  await act(async () => { context.origin = 'http://127.0.0.1:4000'; for (const notify of context.listeners) notify(); });
  expect(signal.aborted).toBe(true); expect(node.textContent).toContain('Host B');
  await act(async () => old('Host A')); expect(node.textContent).not.toContain('Host A');
  read.mockRejectedValueOnce(new Error('disk unavailable')); await act(async () => node.querySelector('button')!.click());
  expect(node.textContent).toContain('Host B'); expect(node.querySelector('[role="alert"]')?.textContent).toBe('disk unavailable');
  read.mockResolvedValueOnce('Recovered'); await act(async () => node.querySelector('button')!.click());
  expect(node.textContent).toContain('Recovered'); expect(node.querySelector('[role="alert"]')?.textContent).toBe('');
});
