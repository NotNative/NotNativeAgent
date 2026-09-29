// SPDX-License-Identifier: Apache-2.0
/** P10-46 settings-page regressions for MCP config and runtime integration. */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../../../lib/runtime-switch.ts', () => ({ onRuntimeEndpointChanged: vi.fn(() => () => undefined) }));
vi.mock('../../../lib/runtime-fetch.ts', () => ({ runtimeFetch: vi.fn() }));

import { runtimeFetch } from '../../../lib/runtime-fetch.ts';
import { directoryKey, useMcpStore } from '../../../stores/useMcpStore.ts';
import { useMcpConfigStore } from '../../../stores/useMcpConfigStore.ts';
import { useSessionViewStore } from '../../../sync/view-store.ts';
import { McpPage } from '../pages/mcp.tsx';

const runtimeFetchMock = runtimeFetch as unknown as Mock;

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let rootHandle: Root | null = null;

const jsonResponse = (body: unknown): Response => (
  {
    ok: true, status: 200,
    json: async () => body, text: async () => JSON.stringify(body),
  } as unknown as Response
);

function renderPage(): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  rootHandle = createRoot(container);
  act(() => { rootHandle!.render(<McpPage />); });
}

function inputByPlaceholder(placeholder: string): HTMLInputElement {
  const input = [...document.querySelectorAll<HTMLInputElement>('input')].find((node) => node.placeholder === placeholder);
  if (!input) throw new Error(`missing input: ${placeholder}`);
  return input;
}

async function clickButton(label: string): Promise<void> {
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent === label);
  if (!button) throw new Error(`missing button: ${label}`);
  await act(async () => { button.click(); await Promise.resolve(); await Promise.resolve(); });
}

function fixture(name: string, config: Record<string, unknown>) {
  return { name, scope: 'user', enabled: true, ...config };
}

beforeEach(() => {
  runtimeFetchMock.mockReset();
  runtimeFetchMock.mockImplementation((url: unknown) => {
    const path = String(url);
    if (path.includes('/api/config/mcp?directory=')) return Promise.resolve(jsonResponse({
      mcp: { alpha: fixture('alpha', { type: 'local', command: ['demo'] }) },
    }));
    if (path.includes('/mcp?directory=')) return Promise.resolve(jsonResponse({ alpha: { status: 'connected' } }));
    if (path.includes('/v1/nnd/mcp')) return Promise.resolve(jsonResponse({ version: 1, state: 'configured', servers: [] }));
    return Promise.reject(new Error(`unexpected request: ${path}`));
  });
  useSessionViewStore.getState().setActiveDirectory('C:/ws');
  useMcpStore.getState().resetForRuntimeSwitch();
  useMcpConfigStore.getState().resetForRuntimeSwitch();
  document.body.innerHTML = '';
});

afterEach(() => {
  try { act(() => rootHandle?.unmount()); } finally {
    container?.remove();
    container = null;
    rootHandle = null;
  }
});

describe('MCP settings page', () => {
  it('loads workspace configuration and separate connection status', async () => {
    renderPage();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    const config = document.querySelector('[data-testid="mcp-config"]');
    expect(config?.textContent).toContain('alpha');
    expect(config?.textContent).toContain('user scope');
    expect(config?.textContent).toContain('connected');
    expect(document.body.textContent).not.toContain('demo');
  });

  it('creates a draft and reports the deferred restart', async () => {
    runtimeFetchMock.mockImplementation((url: unknown, init?: { method?: string }) => {
      const path = String(url);
      if ((init?.method ?? 'GET') === 'POST' && path.includes('/api/config/mcp/beta')) {
        return Promise.resolve(jsonResponse({ ok: true, requiresRestart: true, restartDeferred: true, message: 'created' }));
      }
      if (path.includes('/api/config/mcp?directory=')) return Promise.resolve(jsonResponse({
        mcp: { alpha: fixture('alpha', { type: 'local', command: ['demo'] }) },
      }));
      if (path.includes('/mcp?directory=')) return Promise.resolve(jsonResponse({ alpha: { status: 'connected' } }));
      if (path.includes('/v1/nnd/mcp')) return Promise.resolve(jsonResponse({ version: 1, state: 'configured', servers: [] }));
      return Promise.reject(new Error(`unexpected request: ${path}`));
    });
    renderPage();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    await clickButton('New');
    const name = inputByPlaceholder('');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(name, 'beta');
      name.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const command = [...document.querySelectorAll<HTMLInputElement>('input')].find(node => node.value === '') as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(command, 'demo');
      command.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await clickButton('Save');
    expect(useMcpConfigStore.getState().draft).toBeNull();
    expect(document.body.textContent).toContain('Created "beta". Restart OpenCode to apply.');
  });

  it('surfaces a failed runtime connect to the user', async () => {
    runtimeFetchMock.mockImplementation((url: unknown, init?: { method?: string }) => {
      const path = String(url);
      const method = init?.method ?? 'GET';
      if (method === 'POST' && path.includes('/mcp/alpha/connect')) {
        return Promise.resolve({ ...jsonResponse({ error: 'connect denied' }), ok: false, status: 400 });
      }
      if (method === 'GET' && path.includes('/api/config/mcp?directory=')) return Promise.resolve(jsonResponse({
        mcp: { alpha: fixture('alpha', { type: 'local', command: ['demo'] }) },
      }));
      if (method === 'GET' && path.includes('/mcp?directory=')) return Promise.resolve(jsonResponse({
        alpha: { status: 'failed', error: 'connect denied' },
      }));
      if (path.includes('/v1/nnd/mcp')) return Promise.resolve(jsonResponse({ version: 1, state: 'configured', servers: [] }));
      return Promise.reject(new Error('unexpected request: ' + path));
    });
    renderPage();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    await clickButton('Connect');
    expect(document.body.textContent).toContain('connect denied');
  });

  it('closes a scoped draft when the active directory changes', async () => {
    renderPage();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    await clickButton('Edit');
    expect(useMcpConfigStore.getState().draft).not.toBeNull();
    await act(async () => { useSessionViewStore.getState().setActiveDirectory('D:/other'); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(useMcpConfigStore.getState().draft).toBeNull();
  });

  it('does not report OAuth success when the harness omits the URL', async () => {
    runtimeFetchMock.mockImplementation((url: unknown, init?: { method?: string }) => {
      const path = String(url);
      const method = init?.method ?? 'GET';
      if (method === 'POST' && path.includes('/mcp/alpha/auth')) return Promise.resolve(jsonResponse({}));
      if (method === 'GET' && path.includes('/api/config/mcp?directory=')) return Promise.resolve(jsonResponse({
        mcp: { alpha: fixture('alpha', { type: 'remote', url: 'https://example.test' }) },
      }));
      if (method === 'GET' && path.includes('/mcp?directory=')) return Promise.resolve(jsonResponse({
        alpha: { status: 'needs_auth', error: 'authorization required' },
      }));
      if (path.includes('/v1/nnd/mcp')) return Promise.resolve(jsonResponse({ version: 1, state: 'configured', servers: [] }));
      return Promise.reject(new Error('unexpected request: ' + path));
    });
    renderPage();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    await clickButton('Authorize');
    expect(document.body.textContent).toContain('authorization URL missing');
    expect(document.body.textContent).not.toContain('Started authorization');
  });
});
