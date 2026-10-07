// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest';

const runtime = vi.hoisted(() => ({ key: 'native-runtime', listeners: new Set<() => void>() }));
vi.mock('../../../lib/runtime-switch.ts', () => ({ getRuntimeKey: () => runtime.key,
  isTransientRuntimeKey: () => false, onRuntimeEndpointChanged: (listener: () => void) => {
    runtime.listeners.add(listener); return () => runtime.listeners.delete(listener); } }));
vi.mock('../../../lib/runtime-fetch.ts', () => ({ runtimeFetch: vi.fn() }));

import { runtimeFetch } from '../../../lib/runtime-fetch.ts';
import { useAuthSessionStore } from '../../../lib/runtime-auth-expiry.ts';
import { InvocationVocabularyPanel } from '../pages/invocation.tsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const fetchMock = runtimeFetch as unknown as Mock;
const flagEntry = (flag: string, overrides: Record<string, unknown> = {}) => ({
  flag, aliases: [] as string[], argument: 'value', modes: '*', headless: true,
  option: 'providerProfile', effect: 'selects the provider profile for this invocation',
  ...overrides });
const invocationView = () => ({ schema_version: '1.0', installation_id: 'nna_1',
  data_id: 'data_1', scope: 'user', family: 'invocation', application: 'not_applied',
  modes: ['opencode', 'skills', 'text', 'tui', 'uninstall', 'update'],
  flags: Array.from({ length: 23 }, (_, index) => {
    if (index === 6) return flagEntry('--provider-endpoint', { headless: false,
      option: 'providerEndpoint',
      effect: 'overrides the provider endpoint for this invocation; refused in host/headless mode' });
    if (index === 13) return flagEntry('--check', { modes: ['update'], option: 'prompt',
      effect: 'requests the update check for the update subcommand' });
    if (index === 15) return flagEntry('--help', { argument: 'none', option: null,
      effect: 'informational usage output; no configuration effect' });
    if (index === 18) return flagEntry('--prompt', { argument: 'prompt-text', option: 'prompt',
      effect: 'enters text mode with the prompt as conversation input' });
    return flagEntry(`--flag-${index}`);
  }) });
let container: HTMLDivElement;
let root: Root | undefined;
async function settle() { await act(async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); }); }
async function mount(panel: () => React.ReactNode) { container = document.createElement('div');
  document.body.append(container); root = createRoot(container);
  await act(async () => { root!.render(panel() as React.ReactNode); }); await settle(); }
beforeEach(() => { fetchMock.mockReset(); sessionStorage.clear();
  runtime.key = 'native-runtime'; useAuthSessionStore.getState().markOk();
  fetchMock.mockImplementation((path: string) => {
    const target = String(path);
    if (target.endsWith('/configuration/invocation')) {
      return Promise.resolve(new Response(JSON.stringify(invocationView()), { status: 200 }));
    }
    return Promise.resolve(new Response('{}', { status: 404 }));
  });
});
afterEach(() => { act(() => { if (root) root.unmount(); }); container?.remove(); root = undefined;
  runtime.listeners.clear(); });

it('renders the vocabulary read-only and fronts the manifest-refusal language', async () => {
  await mount(() => <InvocationVocabularyPanel />);
  const view = () => container.querySelector('[data-testid="invocation-receipt"]')?.textContent ?? '';
  expect(view()).toContain('--provider-endpoint');
  expect(view()).toContain('refused in host/headless');
  expect(view()).toContain('--check');
  expect(view()).toContain('update');
  const prose = container.textContent ?? '';
  expect(prose).toContain('stay terminal commands');
  expect(fetchMock.mock.calls.some(([path]) =>
    String(path).endsWith('/configuration/invocation'))).toBe(true);
  expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining('/invocation'),
    expect.objectContaining({ method: 'POST' }));
  await act(async () => {
    const button = container.querySelector('[data-testid="invocation-refresh"]') as HTMLButtonElement;
    button.click();
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  });
  expect(view()).toContain('--flag-22');
});

it('shows the honest unavailability sentence when the surface is absent', async () => {
  fetchMock.mockImplementation(() =>
    Promise.resolve(new Response('{}', { status: 404 })));
  await mount(() => <InvocationVocabularyPanel />);
  const error = () => container.querySelector('[data-testid="invocation-error"]')?.textContent ?? '';
  expect(error()).toContain('unreachable');
  expect(container.querySelector('[data-testid="invocation-receipt"]')).toBeNull();
});
