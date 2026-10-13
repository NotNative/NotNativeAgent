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
import { McpAdvancedPanel } from '../pages/mcp-advanced.tsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const fetchMock = runtimeFetch as unknown as Mock;
const presence = () => ({ schema_version: '1.0', installation_id: 'nna_1', data_id: 'data_1',
  scope: 'user', source_state: 'present', source_revision: 'a'.repeat(64),
  resolution_revision: 'b'.repeat(64), project_shadowed: false, application: 'not_applied',
  servers: [{ id: 'existing', has_credential: true, has_credential_target: true,
    header_credential_count: 1, has_header_env: true, tool_effect_count: 3,
    has_protocol_version: true, has_command: true, has_args: true, has_cwd: true,
    has_endpoint: false }] });
const inner = () => ({ schema_version: '1.0', installation_id: 'nna_1', data_id: 'data_1',
  scope: 'user', source_revision: 'a'.repeat(64), resolution_revision: 'b'.repeat(64),
  project_shadowed: false, application: 'not_applied',
  servers: [{ id: 'existing', credential: 'PRIVATE_TOKEN_REF', credential_target: 'MCP_TARGET_ENV',
    header_credentials: [{ header: 'x-signed', reference: 'secret:sec_demo-1#token', field: 'token' }],
    header_env: [{ header: 'x-mcp', name: 'MCP_HEADER_ENV' }],
    tool_effects: [{ tool: 'shell', effect: 'denied' }, { tool: 'write_file', effect: 'allowed' }],
    protocol_version: '2026-07-28',
    surface: { command: 'hidden-command', args: ['private-arg'], cwd: null, endpoint: null },
    presence: presence().servers[0] }] });
let container: HTMLDivElement;
let root: Root | undefined;
async function settle() { await act(async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); }); }
async function mount(panel: () => React.ReactNode) { container = document.createElement('div');
  document.body.append(container); root = createRoot(container);
  await act(async () => { root!.render(panel() as React.ReactNode); }); await settle(); }
beforeEach(() => { fetchMock.mockReset(); sessionStorage.clear();
  runtime.key = 'native-runtime'; useAuthSessionStore.getState().markOk();
  fetchMock.mockImplementation((path: string, init?: { headers?: Record<string, string> }) => {
    const target = String(path);
    if (target.endsWith('/configuration/mcp/advanced')) {
      if (init?.headers?.['x-nnd-inner'] === 'inner') {
        return Promise.resolve(new Response(JSON.stringify(inner()), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify(presence()), { status: 200 }));
    }
    return Promise.resolve(new Response('{}', { status: 404 }));
  });
});
afterEach(() => { act(() => { if (root) root.unmount(); }); container?.remove(); root = undefined;
  runtime.listeners.clear(); });

it('renders the presence read and the references read without any secret value', async () => {
  await mount(() => <McpAdvancedPanel />);
  const view = () => container.querySelector('[data-testid="mcp-advanced-receipt"]')?.textContent ?? '';
  expect(view()).toContain('existing');
  expect(view()).toContain('credential bound');
  expect(view()).toContain('transport surface: command, args, cwd');
  await act(async () => {
    const button = container.querySelector('[data-testid="mcp-inner-refresh"]') as HTMLButtonElement;
    button.click();
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  });
  const refs = () => container.querySelector('[data-testid="mcp-inner-receipt"]')?.textContent ?? '';
  expect(refs()).toContain('secret:sec_demo-1#token');
  expect(refs()).toContain('PRIVATE_TOKEN_REF');
  expect(refs()).toContain('shell: denied');
  expect(container.textContent ?? '').not.toContain('token value');
  expect(fetchMock.mock.calls.some(([path]) =>
    String(path).endsWith('/configuration/mcp/advanced'))).toBe(true);
});

it('shows the honest unavailability sentence when the surface is absent', async () => {
  fetchMock.mockImplementation(() =>
    Promise.resolve(new Response('{}', { status: 404 })));
  await mount(() => <McpAdvancedPanel />);
  const error = () => container.querySelector('[data-testid="mcp-advanced-error"]')?.textContent ?? '';
  expect(error()).toContain('unreachable');
  expect(container.querySelector('[data-testid="mcp-advanced-receipt"]')).toBeNull();
});
