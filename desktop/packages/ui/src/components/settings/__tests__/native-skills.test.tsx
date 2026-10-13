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
import { NativeSkillsPanel } from '../pages/native-skills.tsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const fetchMock = runtimeFetch as unknown as Mock;
const receipt = () => ({ schema_version: '1.0', installation_id: 'nna_1', data_id: 'data_1',
  scope: 'workspace', scope_root: 'C:\\workspace', trusted: false,
  catalog: [
    { id: 'demo.one', version: '1', description: 'first demo skill', invocation: 'both',
      source: 'bundled:demo', requires_tools: [], body_sha256: 'a'.repeat(64) },
    { id: 'demo.two', version: '2', description: null, invocation: 'agent',
      source: 'user:C:\\nna\\skills', requires_tools: ['web_browse'], body_sha256: 'b'.repeat(64) },
  ],
  diagnostics: [{ status: 'skipped', scope: 'user', path: 'C:\\nna\\skills\\broken.md',
    code: 'skill_duplicate', message: 'duplicate skill demo.one' }] });
let container: HTMLDivElement;
let root: Root | undefined;
async function settle() { await act(async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); }); }
async function mount(panel: () => React.ReactNode) { container = document.createElement('div');
  document.body.append(container); root = createRoot(container);
  await act(async () => { root!.render(panel() as React.ReactNode); }); await settle(); }
beforeEach(() => { fetchMock.mockReset(); sessionStorage.clear();
  runtime.key = 'native-runtime'; useAuthSessionStore.getState().markOk();
  fetchMock.mockImplementation((path: string) => {
    if (String(path).endsWith('/configuration/skills/catalog')) {
      return Promise.resolve(new Response(JSON.stringify(receipt()), { status: 200 }));
    }
    return Promise.resolve(new Response('{}', { status: 404 }));
  });
});
afterEach(() => { act(() => { if (root) root.unmount(); }); container?.remove(); root = undefined;
  runtime.listeners.clear(); });

it('reads the native skills catalog on readiness and renders entries with digests only', async () => {
  await mount(() => <NativeSkillsPanel />);
  const rendered = () => container.querySelector('[data-testid="native-skills-receipt"]')?.textContent ?? '';
  expect(rendered()).toContain('2 skills registered');
  expect(rendered()).toContain('untrusted (project skills excluded)');
  // Every census field for a skill row renders: id, version, description,
  // invocation, source, requires_tools, and the body only as its digest.
  expect(rendered()).toContain('demo.one');
  expect(rendered()).toContain('(1, both, from bundled:demo, sha256:');
  expect(rendered()).toContain('— first demo skill');
  expect(rendered()).toContain('demo.two');
  expect(rendered()).toContain('(2, agent, from user:C:\\nna\\skills, requires web_browse, sha256:');
  expect(rendered()).toContain(`sha256:${'a'.repeat(12)}…`);
  expect(rendered()).toContain('requires web_browse');
  expect(rendered()).toContain('[user] duplicate skill demo.one');
  expect(rendered()).not.toContain('SENTINEL');
  expect(fetchMock.mock.calls.some(([path]) => String(path).endsWith('/configuration/skills/catalog'))).toBe(true);
});

it('surfaces the honest wrapped authority sentence when the registry cannot load', async () => {
  fetchMock.mockImplementation((path: string) => {
    if (String(path).endsWith('/configuration/skills/catalog')) {
      return Promise.resolve(new Response(JSON.stringify({ error: {
        code: 'nnd_skills_catalog_unavailable' } }), { status: 503 }));
    }
    return Promise.resolve(new Response('{}', { status: 404 }));
  });
  await mount(() => <NativeSkillsPanel />);
  const alert = () => container.querySelector('[role="alert"]')?.textContent ?? '';
  expect(alert()).toContain('could not be loaded; check the skill folders');
});
