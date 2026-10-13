// SPDX-License-Identifier: Apache-2.0
/**
 * @vitest-environment jsdom
 * Launcher wiring: the pure create core runs against a mocked UI engine.
 * Catalog and NNA modes must produce real engine dispatches.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { launchedSessionDirectory, MultiRunLauncher } from '../multirun-launcher.tsx';
import { createDirectoryStore } from '../../sync/child-store.ts';
import type { SyncEngine } from '../../sync/sync-engine.ts';
import { useGlobalSyncStore } from '../../sync/global-stores.ts';
import { useAuthSessionStore } from '../../lib/runtime-auth-expiry.ts';
import type { Session as HarnessSession, Provider, Session } from '../../lib/nnd/types.ts';

vi.mock('../../lib/server-api.ts', () => ({
  gitStatus: vi.fn(async () => ({ isGitRepository: false, branch: null, ahead: 0, behind: 0, files: [] })),
  createWorktree: vi.fn(),
  removeWorktree: vi.fn(),
}));

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let rootHandle: Root | null = null;

afterEach(() => {
  if (rootHandle !== null) {
    const closing = rootHandle;
    act(() => { closing.unmount(); });
    rootHandle = null;
  }
  document.body.innerHTML = '';
  container = null;
  useGlobalSyncStore.setState({ config: null, projects: [], path: null });
  useAuthSessionStore.setState({ status: 'ok' });
});

describe('multi-run launcher', () => {
  it('prefers the authoritative session route when reopening after creation', () => {
    const engine = { routingDirectoryOf: (sessionID: string) => sessionID === 's-first' ? 'C:/wt' : undefined };
    expect(launchedSessionDirectory(engine, { firstSessionId: 's-first' }, 'C:/repo')).toBe('C:/wt');
    expect(launchedSessionDirectory({ routingDirectoryOf: () => undefined }, { firstSessionId: 's-first' }, 'C:/repo')).toBe('C:/repo');
    expect(launchedSessionDirectory({ routingDirectoryOf: () => undefined }, { firstSessionId: null }, 'C:/repo')).toBeNull();
  });

  it('launches the selected catalog models through the engine seam', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const createSession = vi.fn().mockImplementation((input: { title: string }) => testSession(`s_${input.title}`, input.title));
    const onLaunched = vi.fn(); const onClose = vi.fn();
    const engine = {
      actions: { createSession, send },
      routingDirectoryOf: (sessionID: string) => sessionID === 's_demo-group/mock/fast' ? 'C:/wt/demo-group/mock/fast' : undefined,
    } as unknown as SyncEngine;
    const store = createDirectoryStore({
      config: {},
      provider: [provider({ id: 'mock', name: 'Mock', models: { fast: { id: 'fast', name: 'Fast' } } })],
    });
    render({ engine, store, onLaunched, onClose });

    await type(document.querySelector('[data-testid="multirun-name"]') as HTMLInputElement, 'Demo Group');
    await type(document.querySelector('[data-testid="multirun-prompt"]') as HTMLTextAreaElement, 'Solve this');
    await click(document.querySelector('[data-testid="multirun-add-model"]'));
    await click((document.querySelector('[data-testid="model-row"]') as HTMLElement).querySelector('button'));
    await click(document.querySelector('[data-testid="multirun-submit"]'));

    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({ title: 'demo-group/mock/fast' }));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      directory: 'C:/repo', sessionID: 's_demo-group/mock/fast',
      model: { providerID: 'mock', modelID: 'fast' },
      agent: 'build',
    }));
    expect(onLaunched).toHaveBeenCalledWith(expect.objectContaining({
      groupSlug: 'demo-group', firstSessionId: 's_demo-group/mock/fast', sessionIds: ['s_demo-group/mock/fast'],
    }), 'C:/wt/demo-group/mock/fast');
    expect(onClose).toHaveBeenCalled();
  });

  it('launches the configured NNA primary model without opening the picker', async () => {
    useGlobalSyncStore.setState({ config: { nnd: { engine: 'nna', primaryModel: { providerID: 'openai', modelID: 'gpt' } } } as never });
    const send = vi.fn().mockResolvedValue(undefined);
    const createSession = vi.fn().mockImplementation((input: { title: string }) => testSession(`s_${input.title}`, input.title));
    const engine = { actions: { createSession, send } } as unknown as SyncEngine;
    const store = createDirectoryStore({
      config: { nnd: { engine: 'nna', primaryModel: { providerID: 'openai', modelID: 'gpt' } } } as never,
    });
    render({ engine, store, onLaunched: vi.fn(), onClose: vi.fn() });

    await type(document.querySelector('[data-testid="multirun-name"]') as HTMLInputElement, 'Demo');
    await type(document.querySelector('[data-testid="multirun-prompt"]') as HTMLTextAreaElement, 'Ship it');
    await click(document.querySelector('[data-testid="multirun-submit"]'));

    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({ title: 'demo/openai/gpt' }));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      model: { providerID: 'openai', modelID: 'gpt' },
      agent: 'nna',
    }));
  });

  it('blocks expired-auth launches before creating sessions', async () => {
    useAuthSessionStore.setState({ status: 'expired' });
    const send = vi.fn();
    const createSession = vi.fn();
    const store = createDirectoryStore({
      config: {},
      provider: [provider({ id: 'mock', name: 'Mock', models: { fast: { id: 'fast', name: 'Fast' } } })],
    });
    render({
      engine: { actions: { createSession, send } } as unknown as SyncEngine,
      store,
      onLaunched: vi.fn(),
      onClose: vi.fn(),
    });
    const submit = document.querySelector('[data-testid="multirun-submit"]') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    await click(submit);
    expect(createSession).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('prevents mid-launch dismissal from abandoning work', async () => {
    const send = vi.fn();
    const createSession = vi.fn().mockImplementation(() => new Promise<never>(() => undefined));
    const store = createDirectoryStore({
      config: {},
      provider: [provider({ id: 'mock', name: 'Mock', models: { fast: { id: 'fast', name: 'Fast' } } })],
    });
    render({
      engine: { actions: { createSession, send } } as unknown as SyncEngine,
      store,
      onLaunched: vi.fn(),
      onClose: vi.fn(),
    });
    await type(document.querySelector('[data-testid="multirun-name"]') as HTMLInputElement, 'Busy');
    await type(document.querySelector('[data-testid="multirun-prompt"]') as HTMLTextAreaElement, 'Wait');
    await click(document.querySelector('[data-testid="multirun-add-model"]'));
    await click((document.querySelector('[data-testid="model-row"]') as HTMLElement).querySelector('button'));
    await click(document.querySelector('[data-testid="multirun-submit"]'));
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    const overlay = document.querySelector('[data-testid="multirun-launcher"]');
    expect(overlay).not.toBeNull();
    expect((document.querySelector('[data-testid="multirun-close"]') as HTMLButtonElement).disabled).toBe(true);
    expect((document.querySelector('[data-testid="multirun-cancel"]') as HTMLButtonElement).disabled).toBe(true);
    expect(createSession).toHaveBeenCalledTimes(1);
  });
});

function render(input: { engine: SyncEngine; store: ReturnType<typeof createDirectoryStore>; onLaunched: ReturnType<typeof vi.fn>; onClose: ReturnType<typeof vi.fn> }): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  rootHandle = createRoot(container);
  act(() => {
    rootHandle!.render(<MultiRunLauncher
      services={{ engine: input.engine, store: () => input.store, dispatch: () => undefined }}
      directory='C:/repo' onLaunched={input.onLaunched} onClose={input.onClose} />);
  });
}

async function type(control: HTMLElement, value: string): Promise<void> {
  const propertySet = control instanceof HTMLTextAreaElement
    ? Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
    : Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    propertySet.call(control, value);
    control.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}

async function click(control: Element | null): Promise<void> {
  expect(control).not.toBeNull();
  await act(async () => { control!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
}

function provider(value: { id: string; name: string; models: Record<string, { id: string; name: string }> }): Provider {
  const models: Provider['models'] = {};
  for (const [key, model] of Object.entries(value.models)) {
    models[key] = { ...model, providerID: value.id } as never;
  }
  return { ...value, models } as Provider;
}

function testSession(id: string, title: string): Session {
  return {
    id, slug: title, projectID: 'p', directory: 'C:/repo', title,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    version: '1', time: { created: 1, updated: 1 },
  } as unknown as HarnessSession & Session;
}
