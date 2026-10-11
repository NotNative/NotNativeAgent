// SPDX-License-Identifier: Apache-2.0
/** W-14 setup wizard: detect → setup → verify → done, with recovery retries. */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SetupWizard } from '../setup-wizard.tsx';
import { useAuthSessionStore } from '../../../lib/runtime-auth-expiry.ts';

const urls: string[] = [];
let respond: (url: string) => Response | Promise<Response> = () => new Response('{}', { status: 503 });
const { runtimeFetch } = vi.hoisted(() => ({ runtimeFetch: vi.fn() }));
vi.mock('../../../lib/runtime-fetch.ts', () => ({ runtimeFetch: (...args: unknown[]) => runtimeFetch(...args) }));

vi.mock('../../../lib/nnd/setup.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/nnd/setup.ts')>();
  return {
    ...actual,
    requestNativeSetup: (activate: boolean, signal: AbortSignal) => {
      urls.push(activate ? 'activate' : 'status');
      return actual.requestNativeSetup(activate, signal);
    },
  };
});

vi.mock('../../../lib/nnd/setup-readiness.ts', () => ({
  waitForNativeModelReady: vi.fn(async (signal: AbortSignal) => {
    if (signal.aborted) throw new Error('native-setup-cancelled');
    return undefined;
  }),
}));

function statusBody(service: string, configuration = 'ready', execution = 'ready', failure: string | null = null): string {
  return JSON.stringify({ service_state: service, configuration_state: configuration, execution_state: execution, provider_state: 'unknown', failure_code: failure });
}

function readyResponse(): Response {
  return new Response(statusBody('ready'), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('setup wizard (W-14)', () => {
  let container: HTMLDivElement | null = null;
  beforeEach(() => {
    urls.length = 0;
    act(() => { useAuthSessionStore.setState({ status: 'ok' }); });
  });
  afterEach(() => {
    container?.remove();
    container = null;
    vi.restoreAllMocks();
  });

  function mount(): HTMLDivElement {
    container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => root.render(<SetupWizard />));
    return container;
  }

  it('ready detection skips straight to verify and done (model attached)', async () => {
    respond = () => readyResponse();
    runtimeFetch.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/nnd/setup/status')) return readyResponse();
      throw new Error('unexpected fetch');
    });
    const node = mount();
    await vi.waitFor(() => {
      expect(node.querySelector('[data-testid="wizard-done"]')?.textContent).toContain('NNA is ready');
    });
    expect(node.querySelector('[data-testid="wizard-step-detect"]')?.className).toContain('emerald');
  });

  it('setup_required routes to the setup step; activation verifies then completes', async () => {
    runtimeFetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'POST') return readyResponse();
      return new Response(statusBody('setup_required', 'unverified', 'unavailable'), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    const node = mount();
    await vi.waitFor(() => {
      expect(node.querySelector('[data-testid="wizard-setup"]')).toBeTruthy();
    });
    expect(node.querySelector('[data-testid="wizard-activate"]')?.textContent).toContain('Activate NNA');
    await act(async () => { (node.querySelector('[data-testid="wizard-activate"]') as HTMLButtonElement).click(); });
    await vi.waitFor(() => {
      expect(node.querySelector('[data-testid="wizard-done"]')?.textContent).toContain('NNA is ready');
    });
  });

  it('a failed service routes to recovery with the failure code and retries work', async () => {
    let failed = true;
    runtimeFetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'POST') {
        return failed
          ? new Response(statusBody('failed', 'ready', 'unavailable', 'nnd_setup_activation_timeout'), { status: 503, headers: { 'Content-Type': 'application/json' } })
          : readyResponse();
      }
      return failed
        ? new Response(statusBody('failed', 'ready', 'unavailable', 'nnd_setup_activation_timeout'), { status: 200, headers: { 'Content-Type': 'application/json' } })
        : readyResponse();
    });
    const node = mount();
    await vi.waitFor(() => {
      expect(node.querySelector('[data-testid="wizard-recovery"]')?.textContent).toContain('nnd_setup_activation_timeout');
    });
    failed = false;
    await act(async () => { (node.querySelector('[data-testid="wizard-retry-activation"]') as HTMLButtonElement).click(); });
    await vi.waitFor(() => {
      expect(node.querySelector('[data-testid="wizard-done"]')?.textContent).toContain('NNA is ready');
    });
  });

  it('detection failure routes to recovery; retry detection re-runs the status read', async () => {
    let failing = true;
    runtimeFetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== 'POST' && failing) throw new TypeError('network down');
      return readyResponse();
    });
    const node = mount();
    await vi.waitFor(() => {
      expect(node.querySelector('[data-testid="wizard-recovery"]')?.textContent).toContain('detection-failed');
    });
    failing = false;
    await act(async () => { (node.querySelector('[data-testid="wizard-retry-detection"]') as HTMLButtonElement).click(); });
    await vi.waitFor(() => {
      expect(node.querySelector('[data-testid="wizard-done"]')?.textContent).toContain('NNA is ready');
    });
  });

  it('the guided native-setup panel embeds the wizard and reaches done', async () => {
    const { NativeSetupPanel } = await import('../../settings/pages/native-setup.tsx');
    const { I18nProvider } = await import('../../I18nProvider.tsx');
    runtimeFetch.mockImplementation(async () => readyResponse());
    container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container!);
    act(() => root.render(<I18nProvider><NativeSetupPanel guided /></I18nProvider>));
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="wizard-done"]')?.textContent).toContain('NNA is ready');
    });
    act(() => { root.unmount(); });
    container = null;
  });
});
