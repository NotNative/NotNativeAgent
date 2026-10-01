// SPDX-License-Identifier: Apache-2.0
/** P10-46 settings-page regressions for MCP config and runtime integration. */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../../../lib/runtime-switch.ts', () => ({ onRuntimeEndpointChanged: vi.fn(() => () => undefined) }));
vi.mock('../../../lib/runtime-fetch.ts', () => ({ runtimeFetch: vi.fn() }));

import { runtimeFetch } from '../../../lib/runtime-fetch.ts';
import { onRuntimeEndpointChanged } from '../../../lib/runtime-switch.ts';
import { directoryKey, useMcpStore } from '../../../stores/useMcpStore.ts';
import { useMcpConfigStore } from '../../../stores/useMcpConfigStore.ts';
import { useSessionViewStore } from '../../../sync/view-store.ts';
import { useI18nStore } from '../../../lib/i18n/store.ts';
import { I18nProvider } from '../../I18nProvider.tsx';
import { McpPage } from '../pages/mcp.tsx';

const runtimeFetchMock = runtimeFetch as unknown as Mock;
const onRuntimeEndpointChangedMock = onRuntimeEndpointChanged as unknown as Mock;

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
  act(() => { rootHandle!.render(<I18nProvider><McpPage /></I18nProvider>); });
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

async function clickNnaRefresh(): Promise<void> {
  const button = document.querySelector<HTMLButtonElement>('[data-testid="mcp-inventory-refresh"]');
  if (!button) throw new Error('missing NNA inventory refresh button');
  await act(async () => { button.click(); await Promise.resolve(); await Promise.resolve(); });
}

function fixture(name: string, config: Record<string, unknown>) {
  return { name, scope: 'user', enabled: true, ...config };
}

beforeEach(() => {
  runtimeFetchMock.mockReset();
  onRuntimeEndpointChangedMock.mockClear();
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
  useI18nStore.getState().setLocale('en');
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
    expect(config?.textContent).toContain('User scope');
    expect(config?.textContent).toContain('connected');
    expect(document.body.textContent).not.toContain('demo');
  });

  it('switches workspace copy while an unknown status keeps raw fallback diagnostics', async () => {
    runtimeFetchMock.mockImplementation((url: unknown, init?: { method?: string }) => {
      const path = String(url);
      const method = init?.method ?? 'GET';
      if (method === 'GET' && path.includes('/api/config/mcp?directory=')) return Promise.resolve(jsonResponse({
        mcp: { alpha: fixture('alpha', { type: 'local', command: ['demo'] }) },
      }));
      if (method === 'GET' && path.includes('/mcp?directory=')) return Promise.resolve(jsonResponse({
        alpha: { status: 'unrecognized_status' },
      }));
      if (path.includes('/v1/nnd/mcp')) return Promise.resolve(jsonResponse({ version: 1, state: 'configured', servers: [] }));
      return Promise.reject(new Error('unexpected request: ' + path));
    });
    renderPage();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    await act(async () => {
      useI18nStore.getState().setLocale('de');
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain('Arbeitsbereich-MCP-Konfiguration');
    expect(document.body.textContent).toContain('nicht geprüft');
    expect(document.body.textContent).toContain('MCP status failed');
    await act(async () => {
      useI18nStore.getState().setLocale('en');
      await Promise.resolve();
    });
  });

  it('rejects a stale NNA inventory response after a runtime switch', async () => {
    renderPage();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    let resolveStale!: (response: Response) => void;
    let resolveFresh: ((response: Response) => void) | undefined;
    let staleNnaResponse = true;
    runtimeFetchMock.mockImplementation((url: unknown) => {
      const path = String(url);
      if (path.includes('/api/config/mcp?directory=')) return Promise.resolve(jsonResponse({
        mcp: { alpha: fixture('alpha', { type: 'local', command: ['demo'] }) },
      }));
      if (path.includes('/mcp?directory=')) return Promise.resolve(jsonResponse({ alpha: { status: 'connected' } }));
      if (path.includes('/v1/nnd/mcp')) {
        const response = new Promise<Response>((resolve) => {
          if (staleNnaResponse) resolveStale = resolve;
          else resolveFresh = resolve;
          staleNnaResponse = false;
        });
        return response;
      }
      return Promise.reject(new Error(`unexpected request: ${path}`));
    });
    const staleBody = { version: 1, state: 'configured', servers: [
      { id: 'stale-runtime-server', transport: 'stdio', enabled: true, trusted: true },
    ] };
    const freshBody = { version: 1, state: 'configured', servers: [
      { id: 'fresh-runtime-server', transport: 'streamable_http', enabled: false, trusted: false },
    ] };
    await clickNnaRefresh();
    expect(document.body.textContent).toContain('Loading MCP inventory…');
    const listener = onRuntimeEndpointChangedMock.mock.calls.at(-1)![0];
    await act(async () => {
      listener({
        apiBaseUrl: 'http://fresh.test', previousApiBaseUrl: 'http://stale.test',
        previousRuntimeKey: 'stale', runtimeKey: 'fresh',
      });
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await clickNnaRefresh();
    await act(async () => {
      resolveStale(jsonResponse(staleBody));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(document.body.textContent).not.toContain('stale-runtime-server');
    expect(document.body.textContent).toContain('Loading MCP inventory…');

    await act(async () => {
      resolveFresh!(jsonResponse(freshBody));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain('fresh-runtime-server');
    expect(document.body.textContent).not.toContain('stale-runtime-server');
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
    const name = document.querySelector<HTMLInputElement>('[data-testid="mcp-draft-name"]')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(name, 'beta');
      name.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const command = document.querySelector<HTMLInputElement>('[data-testid="mcp-draft-command"]')!;
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
    await act(async () => { useI18nStore.getState().setLocale('fr'); await Promise.resolve(); });
    expect(document.body.textContent).toContain('connect denied');
    expect(document.body.textContent).toContain('Configuration MCP de l’espace de travail');
    await act(async () => { useI18nStore.getState().setLocale('en'); await Promise.resolve(); });
  });

  it('reports a rejected delete without changing the pending candidate', async () => {
    runtimeFetchMock.mockImplementation((url: unknown, init?: { method?: string }) => {
      const path = String(url);
      const method = init?.method ?? 'GET';
      if (method === 'DELETE' && path.includes('/api/config/mcp/alpha')) {
        return Promise.resolve({ ...jsonResponse({ error: 'delete denied' }), ok: false, status: 400 });
      }
      if (method === 'GET' && path.includes('/api/config/mcp?directory=')) return Promise.resolve(jsonResponse({
        mcp: { alpha: fixture('alpha', { type: 'local', command: ['demo'] }) },
      }));
      if (method === 'GET' && path.includes('/mcp?directory=')) return Promise.resolve(jsonResponse({
        alpha: { status: 'connected' },
      }));
      if (path.includes('/v1/nnd/mcp')) return Promise.resolve(jsonResponse({ version: 1, state: 'configured', servers: [] }));
      return Promise.reject(new Error('unexpected request: ' + path));
    });
    renderPage();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    await clickButton('Delete');
    await clickButton('Confirm delete');
    expect(document.body.textContent).toContain('delete denied');
    expect(document.body.textContent).not.toContain('Deleted "alpha"');
  });

  it('suppresses a deferred save result after a runtime switch', async () => {
    let resolvePatch!: (response: Response) => void;
    runtimeFetchMock.mockImplementation((url: unknown, init?: { method?: string }) => {
      const path = String(url);
      const method = init?.method ?? 'GET';
      if (method === 'PATCH' && path.includes('/api/config/mcp/alpha')) {
        return new Promise<Response>((resolve) => { resolvePatch = resolve; });
      }
      if (method === 'GET' && path.includes('/api/config/mcp?directory=')) return Promise.resolve(jsonResponse({
        mcp: { alpha: fixture('alpha', { type: 'local', command: ['demo'] }) },
      }));
      if (method === 'GET' && path.includes('/mcp?directory=')) return Promise.resolve(jsonResponse({
        alpha: { status: 'connected' },
      }));
      if (path.includes('/v1/nnd/mcp')) return Promise.resolve(jsonResponse({ version: 1, state: 'configured', servers: [] }));
      return Promise.reject(new Error('unexpected request: ' + path));
    });
    renderPage();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    await clickButton('Edit');
    await clickButton('Save');
    const listener = onRuntimeEndpointChangedMock.mock.calls[0]![0];
    await act(async () => {
      listener({
        apiBaseUrl: 'http://fresh.test', previousApiBaseUrl: 'http://stale.test',
        previousRuntimeKey: 'stale', runtimeKey: 'fresh',
      });
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await act(async () => {
      resolvePatch(jsonResponse({ ok: true, requiresRestart: true, restartDeferred: true, message: 'updated' }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(document.body.textContent).not.toContain('Updated "alpha"');
  });

  it('summarizes an NNA server error while retaining its transport detail', async () => {
    runtimeFetchMock.mockImplementation((url: unknown) => {
      const path = String(url);
      if (path.includes('/api/config/mcp?directory=')) return Promise.resolve(jsonResponse({
        mcp: { alpha: fixture('alpha', { type: 'local', command: ['demo'] }) },
      }));
      if (path.includes('/mcp?directory=')) return Promise.resolve(jsonResponse({ alpha: { status: 'connected' } }));
      if (path.includes('/v1/nnd/mcp')) {
        return Promise.resolve({ ...jsonResponse({ error: { message: 'upstream rejected the request' } }), ok: false, status: 502 });
      }
      return Promise.reject(new Error(`unexpected request: ${path}`));
    });
    renderPage();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(document.body.textContent).toContain('NNA returned a server error.');
    expect(document.body.textContent).toContain('upstream rejected the request');
  });

  it('allows the same import file to be selected again', async () => {
    renderPage();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    const input = document.querySelector<HTMLInputElement>('[data-testid="mcp-import-input"]')!;
    await act(async () => {
      Object.defineProperty(input, 'files', {
        value: [{ text: async () => '[]' } as File],
      });
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain('MCP share must be an object map');
    expect(input.value).toBe('');
  });

  it('clears a pasted OAuth code when the runtime switches', async () => {
    runtimeFetchMock.mockImplementation((url: unknown) => {
      const path = String(url);
      if (path.includes('/api/config/mcp?directory=')) return Promise.resolve(jsonResponse({
        mcp: { alpha: fixture('alpha', { type: 'remote', url: 'https://example.test', oauth: { clientId: 'id' } }) },
      }));
      if (path.includes('/mcp?directory=')) return Promise.resolve(jsonResponse({
        alpha: { status: 'needs_auth' },
      }));
      if (path.includes('/v1/nnd/mcp')) return Promise.resolve(jsonResponse({ version: 1, state: 'configured', servers: [] }));
      return Promise.reject(new Error('unexpected request: ' + path));
    });
    renderPage();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    await clickButton('Authorize');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      const input = inputByPlaceholder('authorization code');
      setter.call(input, 'stale-runtime-code');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const listener = onRuntimeEndpointChangedMock.mock.calls[0]![0];
    await act(async () => {
      listener({
        apiBaseUrl: 'http://fresh.test', previousApiBaseUrl: 'http://stale.test',
        previousRuntimeKey: 'stale', runtimeKey: 'fresh',
      });
    });
    expect(inputByPlaceholder('authorization code').value).toBe('');
  });

  it('retranslates an import summary while keeping skipped server errors raw', async () => {
    runtimeFetchMock.mockImplementation((url: unknown, init?: { method?: string }) => {
      const path = String(url);
      const method = init?.method ?? 'GET';
      if (method === 'POST' && path.includes('/api/config/mcp/beta')) return Promise.resolve(jsonResponse({
        ok: true, requiresRestart: true, restartDeferred: true, message: 'created',
      }));
      if (method === 'GET' && path.includes('/api/config/mcp?directory=')) return Promise.resolve(jsonResponse({
        mcp: { alpha: fixture('alpha', { type: 'local', command: ['demo'] }) },
      }));
      if (method === 'GET' && path.includes('/mcp?directory=')) return Promise.resolve(jsonResponse({
        alpha: { status: 'connected' },
      }));
      if (path.includes('/v1/nnd/mcp')) return Promise.resolve(jsonResponse({ version: 1, state: 'configured', servers: [] }));
      return Promise.reject(new Error('unexpected request: ' + path));
    });
    renderPage();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    const input = document.querySelector<HTMLInputElement>('[data-testid="mcp-import-input"]')!;
    await act(async () => {
      Object.defineProperty(input, 'files', {
        value: [{ text: async () => JSON.stringify({ beta: { type: 'local', command: ['demo'] } }) } as File],
      });
      input.dispatchEvent(new Event('change', { bubbles: true }));
      for (let index = 0; index < 12; index += 1) await Promise.resolve();
    });
    expect(document.body.textContent).toContain('MCP share import: Created: 1. Restart OpenCode to apply.');
    await act(async () => {
      useI18nStore.getState().setLocale('fr');
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain('Import de partage MCP : Créés : 1. Redémarrez OpenCode pour l’appliquer.');
    await act(async () => { useI18nStore.getState().setLocale('en'); await Promise.resolve(); });
  });

  it('locks the record scope while editing but allows it for a new draft', async () => {
    renderPage();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    await clickButton('New');
    const scopeButtons = (texts: string[]) => [...document.querySelectorAll<HTMLButtonElement>('button')]
      .filter((node) => texts.includes(node.textContent ?? ''));
    expect(scopeButtons(['User scope', 'Project scope']).every((node) => !node.disabled)).toBe(true);
    await clickButton('Cancel');
    await clickButton('Edit');
    expect(scopeButtons(['User scope', 'Project scope']).every((node) => node.disabled)).toBe(true);
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
