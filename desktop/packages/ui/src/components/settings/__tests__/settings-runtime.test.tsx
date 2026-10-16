// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
vi.mock('../../../lib/runtime-fetch.ts', () => ({ runtimeFetch: vi.fn() }));
import { runtimeFetch } from '../../../lib/runtime-fetch.ts';
import { useSettingsRuntime, PendingSettingsRuntime } from '../use-settings-runtime.tsx';
import { SettingsWindow } from '../window.tsx';
import { I18nProvider } from '../../I18nProvider.tsx';
import { ThemeProvider } from '../../ThemeProvider.tsx';
const mock = vi.mocked(runtimeFetch);
let root: Root, node: HTMLDivElement;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function Host({ runtimeKey }: { runtimeKey: string }) {
  const runtime = useSettingsRuntime(runtimeKey);
  return runtime.status === 'ready' ? <SettingsWindow nativeAlpha={runtime.nativeAlpha} onClose={() => undefined} />
    : <PendingSettingsRuntime failed={runtime.status === 'error'} retry={runtime.retry} close={() => undefined} />;
}
async function render(runtimeKey = 'host:a') { await act(async () => root.render(<I18nProvider><ThemeProvider><Host runtimeKey={runtimeKey} /></ThemeProvider></I18nProvider>)); }
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  mock.mockReset(); mock.mockImplementation(async url => String(url) === '/health' ? json({ runtime: 'service', version: 'test' })
    : String(url) === '/api/ui-preferences' ? json({ revision: 0, settings: { fontSize: 100 } }) : json({ themes: [] }));
  node = document.createElement('div'); document.body.appendChild(node); root = createRoot(node);
});
afterEach(() => { act(() => root.unmount()); node.remove(); vi.unstubAllGlobals(); });
it('keeps compatibility controls unavailable until the runtime is identified', async () => {
  let resolve!: (response: Response) => void;
  mock.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  await render(); expect(node.textContent).toContain('Checking settings capabilities'); expect(node.querySelector('nav')).toBeNull();
  await act(async () => resolve(json({ runtime: 'service' })));
  expect(node.querySelector('nav')?.textContent).toContain('Preferences'); expect(node.textContent).not.toContain('Harness binary path');
});
it.each([json({}, 503), json({})])('reports failed or malformed runtime detection and retries through the visible action', async response => {
  mock.mockResolvedValueOnce(response); await render();
  expect(node.querySelector('[role="alert"]')?.textContent).toContain('Could not identify'); expect(node.querySelector('nav')).toBeNull();
  const retry = [...node.querySelectorAll('button')].find(button => button.textContent === 'Retry settings connection')!;
  await act(async () => retry.click()); expect(node.querySelector('nav')?.textContent).toContain('Preferences');
});
it('ignores an old runtime identification after switching hosts', async () => {
  let resolve!: (response: Response) => void;
  mock.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  await render(); await render('host:b');
  await act(async () => resolve(json({ runtime: 'web' })));
  expect(node.querySelector('nav')?.textContent).toContain('Preferences'); expect(node.querySelector('nav')?.textContent).not.toContain('opencode');
});
