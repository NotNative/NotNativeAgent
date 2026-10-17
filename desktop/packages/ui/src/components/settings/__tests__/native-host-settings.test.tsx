// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
vi.mock('../../../chat/conversation-draft-persistence.ts', async original => ({ ...(await original<object>()), flushConversationDraftPersistence: vi.fn(async () => {}) }));
import { flushConversationDraftPersistence } from '../../../chat/conversation-draft-persistence.ts';
import { useAuthSessionStore } from '../../../lib/runtime-auth-expiry.ts';
import { NativeHostSettings } from '../pages/native-host-settings.tsx';
import { SettingsEditBoundary } from '../edit-boundary.tsx';
let root: Root, node: HTMLDivElement;
let state: { revision: string; target: string; enabled: boolean; login_installed: boolean; login_supported: boolean; version: string; generation: string };
let writes: { action: string; value?: any }[];
const invoke = vi.fn();
const generation = '00000000-0000-4000-8000-000000000000';
async function settle() { await act(async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); }); }
async function mount(desktop = true) {
  window.__NOTNATIVE_ELECTRON__ = desktop ? { runtime: 'electron' } as never : undefined;
  node = document.createElement('div'); document.body.append(node); root = createRoot(node);
  await act(async () => root.render(<StrictMode><SettingsEditBoundary><NativeHostSettings /></SettingsEditBoundary></StrictMode>)); await settle();
}
async function click(text: string) {
  const button = [...node.querySelectorAll('button')].find(button => button.textContent === text)!; expect(button, text).toBeTruthy();
  await act(async () => button.click()); await settle();
}
async function select(target: string) {
  const select = node.querySelector('select')!;
  await act(async () => { select.value = target; select.dispatchEvent(new Event('change', { bubbles: true })); });
}
beforeEach(() => {
  vi.mocked(flushConversationDraftPersistence).mockReset().mockResolvedValue();
  globalThis.IS_REACT_ACT_ENVIRONMENT = true; useAuthSessionStore.getState().markOk();
  state = { revision: 'absent', target: 'desktop', enabled: false, login_installed: false, login_supported: true, version: '20261017-1', generation };
  writes = []; invoke.mockReset(); window.__NOTNATIVE_DESKTOP_INVOKE__ = invoke;
  invoke.mockImplementation(async (_command, payload) => {
    const { action, value } = payload;
    if (action === 'read') return { ok: true, result: { ...state } };
    writes.push(payload);
    if (action === 'preferences') { state = { ...state, target: value.target, revision: 'a'.repeat(64) }; return { ok: true, result: { target: state.target, revision: state.revision } }; }
    if (action === 'login') { state.enabled = value.enabled; state.login_installed = value.enabled; return { ok: true, result: { enabled: value.enabled, login_installed: value.enabled } }; }
    return { ok: true, result: action === 'restart' ? { restarted: true, generation: '10000000-0000-4000-8000-000000000000' } : { opened: true } };
  });
});
afterEach(() => { act(() => root?.unmount()); node?.remove(); delete window.__NOTNATIVE_ELECTRON__; delete window.__NOTNATIVE_DESKTOP_INVOKE__; });

it('saves the changed launch target with its revision, refreshes and discards without a write', async () => {
  await mount(); await select('browser'); await click('Discard launch change'); expect(writes).toEqual([]);
  await select('browser'); await click('Save launch preference');
  expect(writes).toEqual([{ action: 'preferences', value: { revision: 'absent', target: 'browser' } }]);
  expect(node.querySelector('select')?.value).toBe('browser'); expect(node.textContent).toContain('next NNA shortcut launch');
  await click('Refresh host'); expect(node.querySelector('select')?.value).toBe('browser');
});
it('uses native background login wiring and opens the browser without shell-login preference writes', async () => {
  await mount(); await act(async () => (node.querySelector('input[type=checkbox]') as HTMLInputElement).click()); await settle();
  expect(state.enabled).toBe(true); expect(node.querySelector<HTMLInputElement>('input')?.checked).toBe(true);
  await click('Open in browser'); expect(writes).toEqual([{ action: 'login', value: { enabled: true } }, { action: 'browser' }]);
  expect(invoke.mock.calls.every(([command]) => command === 'desktop_native_host')).toBe(true);
});
it('restart requires confirmation, cancellation is inert, and success requires a new generation', async () => {
  await mount(); await click('Restart NNA'); await click('Cancel restart'); expect(writes).toEqual([]);
  await click('Restart NNA'); await click('Confirm restart'); expect(writes).toEqual([{ action: 'restart' }]);
  expect(node.textContent).toContain('Reconnecting this desktop');
});
it('refuses restart when pending durable draft publication fails', async () => {
  await mount(); await click('Restart NNA');
  vi.mocked(flushConversationDraftPersistence).mockRejectedValueOnce(new Error('Draft save was not confirmed.'));
  await click('Confirm restart'); expect(writes).toEqual([]);
  expect(node.querySelector('[role=alert]')?.textContent).toContain('Draft save was not confirmed');
});
it('preserves a conflicted launch draft and refuses an unconfirmed restart receipt', async () => {
  await mount(); await select('browser'); invoke.mockResolvedValueOnce({ ok: false, error: 'launch-preferences-conflict' });
  await click('Save launch preference'); expect(node.querySelector('select')?.value).toBe('browser');
  expect(node.querySelector('[role=alert]')?.textContent).toContain('Refresh before saving');
  await click('Discard launch change'); await click('Restart NNA');
  invoke.mockResolvedValueOnce({ ok: true, result: { restarted: true, generation } });
  await click('Confirm restart'); expect(node.querySelector('[role=alert]')?.textContent).toContain('did not confirm');
  expect(node.textContent).not.toContain('New NNA service generation is ready');
});
it('a failed read blocks mutations and refresh recovers; web exposes truthful host guidance', async () => {
  invoke.mockResolvedValue({ ok: false, error: 'native-host-unavailable' }); await mount();
  expect(node.querySelector('select')?.disabled).toBe(true);
  invoke.mockResolvedValue({ ok: true, result: { ...state } }); await click('Refresh host'); expect(node.querySelector('select')?.disabled).toBe(false);
  act(() => root.unmount()); node.remove(); invoke.mockClear(); await mount(false);
  expect(invoke).not.toHaveBeenCalled(); expect(node.querySelector('select')).toBeNull(); expect(node.textContent).toContain('use Open in browser');
});
it('authentication change drops a late host result and clears the launch draft', async () => {
  await mount(); await select('browser'); let finish: (reply: unknown) => void = () => {};
  invoke.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await click('Save launch preference');
  await act(async () => useAuthSessionStore.setState({ status: 'expired' }));
  await act(async () => finish({ ok: true, result: { target: 'browser', revision: 'b'.repeat(64) } }));
  expect(node.textContent).not.toContain('Launch preference saved'); expect(node.querySelector('select')?.disabled).toBe(true);
});
