// SPDX-License-Identifier: Apache-2.0
/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { OperatorRail } from '../operator-rail.tsx';
import { I18nProvider } from '../../components/I18nProvider.tsx';
import { createDirectoryStore } from '../../sync/child-store.ts';
import { useSessionViewStore } from '../../sync/view-store.ts';
import { requestContextRoute, useContextRouteStore } from '../../lib/workspace-route.ts';
import { registerRuntimeAPIs } from '../../lib/api/registry.ts';
import type { RuntimeAPIs } from '../../lib/api/types.ts';
import * as serverGit from '../../lib/git/server-api.ts';
import { useGitStore } from '../../lib/git/store.ts';
vi.mock('../../lib/runtime-switch.ts', () => ({ getRuntimeKey: () => 'local', isTransientRuntimeKey: () => false,
  onRuntimeEndpointChanged: () => () => undefined }));
vi.mock('../../lib/runtime-fetch.ts', () => ({ runtimeFetch: vi.fn(async (input: string) => {
  const body = String(input).includes('/api/git/status')
    ? { isGitRepository: true, branch: 'main', workspacePrefix: '', files: [{ path: 'work.ts', index: ' ', working_dir: 'M' }] }
    : String(input).includes('/api/git/diff') ? { diff: '--- a/work.ts\n+++ b/work.ts\n@@ -1 +1 @@\n-old\n+new\n' } : {};
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
}) }));
vi.mock('../../components/terminal/TerminalView.tsx', () => ({ TerminalView: ({ visible }: { visible: boolean }) => <div data-terminal={visible} /> }));
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root: Root; let container: HTMLDivElement;
const store = createDirectoryStore();
beforeEach(() => {
  localStorage.clear(); useContextRouteStore.setState({ request: null }); useGitStore.getState().__resetForTests();
  registerRuntimeAPIs({ git: serverGit } as unknown as RuntimeAPIs);
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0));
  vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id));
  useSessionViewStore.setState({ currentSessionId: null, activeDirectory: '/one' });
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); useContextRouteStore.setState({ request: null }); });
const render = async (directory: string, session: string | null = null) => {
  await act(async () => root.render(<I18nProvider><OperatorRail store={store} engine={{} as never} directory={directory} displayedSessionID={session} /></I18nProvider>));
};
it('opens a hidden Changes pane and reveals the routed file in the actual Diff view', async () => {
  localStorage.setItem('nnd.operator-rail.panels:local:nnd.operator-rail.surface:/one', JSON.stringify({ order: ['context'], visible: ['context'] }));
  await render('/one');
  await act(async () => requestContextRoute({ runtime: 'local', directory: '/one', session: null, tab: 'diff', file: 'work.ts' }));
  expect(container.querySelector('button[aria-label="Changes"]')?.getAttribute('aria-pressed')).toBe('true');
  const diff = container.querySelector('[data-testid="diff-view"]');
  expect(diff).not.toBeNull();
  expect(diff?.querySelector('[data-testid="diff-entry"]')?.getAttribute('data-path')).toBe('work.ts');
  await act(async () => requestContextRoute({ runtime: 'local', directory: '/one', session: null, tab: 'git', file: null }));
  expect(container.querySelector('[data-testid="diff-view"]')).toBe(diff);
  expect(diff?.parentElement?.className).toContain('hidden');
  expect(container.querySelector('[data-testid="git-file-preview"]')).toBeNull();
});
it('keeps a routed Terminal selection when a retained rail moves to the linked directory', async () => {
  await render('/one');
  await act(async () => requestContextRoute({ runtime: 'local', directory: '/two', session: 'linked', tab: 'terminal', file: null }));
  await render('/two', 'linked');
  expect(container.querySelector('button[aria-label="Terminal"]')?.getAttribute('aria-pressed')).toBe('true');
  expect(container.querySelector('[data-terminal="true"]')).not.toBeNull();
});
