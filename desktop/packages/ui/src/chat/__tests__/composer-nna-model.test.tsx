// SPDX-License-Identifier: Apache-2.0
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { StoreApi } from 'zustand/vanilla';
import { Composer } from '../composer.tsx';
import { __resetDraftStoreForTests } from '../drafts.ts';
import { __resetAuthExpiryForTests } from '../../lib/runtime-auth-expiry.ts';
import type { DirectoryStore } from '../../sync/types.ts';
import { useGlobalSyncStore } from '../../sync/global-stores.ts';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const base = {
  command: [], agent: [], provider: [], config: {}, message: {}, part: {}, permission: {}, question: {},
};
let snapshot = base as unknown as DirectoryStore;
const store = { subscribe: () => () => undefined, getState: () => snapshot } as unknown as StoreApi<DirectoryStore>;
let root: Root | null = null;
let container: HTMLDivElement | null = null;
const send = vi.fn(async () => undefined);
const createSession = vi.fn(async (): Promise<{ id: string; metadata?: unknown }> => ({ id: 'session_1', metadata: { nnd: {
  configuredModel: { providerID: 'primary', modelID: 'test' },
} } }));
const nativeSet = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;

async function render(sessionID: string | null = null, directory = '/proj'): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<Composer services={{ engine: { actions: { send, createSession } } as never, store: () => store, dispatch: () => undefined }}
      sessionID={sessionID} directory={directory} sessionKey={sessionID ?? 'draft'} />);
    await Promise.resolve();
  });
}

async function submit(text: string): Promise<void> {
  const editor = document.querySelector('[data-testid="composer-editor"]') as HTMLTextAreaElement;
  await act(async () => {
    nativeSet.call(editor, text);
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    await Promise.resolve();
  });
  await act(async () => {
    (document.querySelector('[data-testid="composer"]') as HTMLFormElement).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  __resetDraftStoreForTests();
  __resetAuthExpiryForTests();
  useGlobalSyncStore.getState().reset();
  window.localStorage.clear();
  document.body.innerHTML = '';
  send.mockClear();
  createSession.mockClear();
  createSession.mockImplementation(async () => ({ id: 'session_1', metadata: { nnd: {
    configuredModel: { providerID: 'primary', modelID: 'test' },
  } } }));
  snapshot = base as unknown as DirectoryStore;
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe('NNA configured composer model', () => {
  it('offers the configured route for a draft and sends its exact model', async () => {
    snapshot = { ...base, config: { model: 'primary/test', default_agent: 'nna', nnd: {
      engine: 'nna', modelSelection: 'configured', primaryModel: { providerID: 'primary', modelID: 'test' },
    } } } as unknown as DirectoryStore;
    await render();
    expect(document.querySelector('[aria-label="Choose model"]')?.getAttribute('title')).toBe('primary · test');
    expect(document.querySelector('[aria-label="Choose model"]')?.textContent).toContain('test');
    expect(document.querySelector('[aria-label="Agent persona"]')).toBeNull();
    expect(document.querySelector('[aria-label="Enable permission auto-accept"]')).toBeNull();
    expect(document.body.textContent).toContain('Auto-review');
    await submit('hello NNA');
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      model: { providerID: 'primary', modelID: 'test' }, agent: 'nna',
    }));
  });

  it('uses the model owned by an existing session after the primary route changes', async () => {
    snapshot = { ...base, session: [{ id: 'session_old', metadata: { nnd: {
      configuredModel: { providerID: 'old', modelID: 'old-model' },
    } } }], config: { nnd: { engine: 'nna', primaryModel: { providerID: 'new', modelID: 'new-model' } } } } as unknown as DirectoryStore;
    await render('session_old');
    expect(document.querySelector('[data-testid="model-trigger"]')?.textContent).toBe('old · old-model');
    await submit('continue old session');
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      sessionID: 'session_old', model: { providerID: 'old', modelID: 'old-model' },
    }));
  });

  it('refuses to send when creation reports a different route from the captured choice', async () => {
    snapshot = { ...base, config: { nnd: {
      engine: 'nna', primaryModel: { providerID: 'old', modelID: 'old-model' },
    } } } as unknown as DirectoryStore;
    createSession.mockImplementation(async () => ({ id: 'session_1', metadata: { nnd: {
      configuredModel: { providerID: 'new', modelID: 'new-model' },
    } } }));
    await render();
    await submit('new session');
    expect(send).not.toHaveBeenCalled();
    expect(document.querySelector<HTMLTextAreaElement>('[data-testid="composer-editor"]')?.value).toBe('new session');
  });

  it('shows the activated global route when a warm directory still has its old config', async () => {
    snapshot = { ...base, config: { nnd: {
      engine: 'nna', primaryModel: { providerID: 'old', modelID: 'old-model' },
    } } } as unknown as DirectoryStore;
    useGlobalSyncStore.getState().set({ config: { nnd: {
      engine: 'nna', primaryModel: { providerID: 'new', modelID: 'new-model' },
    } } });
    await render();
    expect(document.querySelector('[aria-label="Choose model"]')?.textContent).toContain('new-model');
  });

  it('uses an authenticated global native route while directory config is absent', async () => {
    snapshot = { ...base, config: null } as unknown as DirectoryStore;
    createSession.mockImplementation(async () => ({ id: 'session_1', metadata: { nnd: {
      configuredModel: { providerID: 'ready', modelID: 'test' },
    } } }));
    useGlobalSyncStore.getState().set({ config: { nnd: {
      engine: 'nna', primaryModel: { providerID: 'ready', modelID: 'test' },
    } } });
    await render();
    expect(document.querySelector('[aria-label="Choose model"]')?.getAttribute('title')).toBe('ready · test');
    await submit('native route');
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      model: { providerID: 'ready', modelID: 'test' }, agent: 'nna',
    }));
  });

  it('waits for the native workspace instead of sending from the bootstrap placeholder', async () => {
    snapshot = { ...base, config: { nnd: {
      engine: 'nna', primaryModel: { providerID: 'primary', modelID: 'test' },
    } } } as unknown as DirectoryStore;
    await render(null, 'global');
    expect(document.querySelector('[data-testid="composer"]')?.getAttribute('data-send-blocked')).toBe('nna-workspace-unavailable');
    expect(document.body.textContent).toContain('Waiting for the native workspace');
    await submit('wait for workspace');
    expect(createSession).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    await act(async () => {
      root!.render(<Composer services={{ engine: { actions: { send, createSession } } as never,
        store: () => store, dispatch: () => undefined }} sessionID={null} directory="/proj" sessionKey="draft" />);
      await Promise.resolve();
    });
    await submit('workspace ready');
    expect(createSession).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledOnce();
  });

  it('blocks an existing-session send until its own NNA route metadata is loaded', async () => {
    snapshot = { ...base, config: { nnd: {
      engine: 'nna', primaryModel: { providerID: 'new', modelID: 'new-model' },
    } }, session: [{ id: 'session_old', metadata: {} }] } as unknown as DirectoryStore;
    await render('session_old');
    await submit('do not guess old session model');
    expect(document.querySelector('[data-send-blocked]')?.getAttribute('data-send-blocked')).toBe('nna-model-unavailable');
    expect(send).not.toHaveBeenCalled();
  });

  it('does not send a draft when NNA omits its created session route', async () => {
    snapshot = { ...base, config: { nnd: {
      engine: 'nna', primaryModel: { providerID: 'old', modelID: 'old-model' },
    } } } as unknown as DirectoryStore;
    createSession.mockImplementation(async () => ({ id: 'session_1', metadata: { nnd: {} } }));
    await render();
    await submit('must not guess route');
    expect(createSession).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
  });

  it('blocks send when the authenticated NNA model projection is missing', async () => {
    snapshot = { ...base, config: { nnd: { engine: 'nna' } } } as unknown as DirectoryStore;
    await render();
    await submit('do not misroute');
    expect(document.querySelector('[data-send-blocked]')?.getAttribute('data-send-blocked')).toBe('nna-model-unavailable');
    expect(createSession).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('does not select the mock route while configuration is unavailable', async () => {
    snapshot = { ...base, config: null } as unknown as DirectoryStore;
    await render();
    const trigger = document.querySelector('[data-testid="model-trigger"]') as HTMLElement;
    expect(trigger.tagName).toBe('SPAN');
    expect(trigger.textContent).toBe('Model config unavailable');
    await submit('do not create a misrouted session');
    expect(document.querySelector('[data-send-blocked]')?.getAttribute('data-send-blocked')).toBe('model-config-unavailable');
    expect(createSession).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('keeps the mock model picker available', async () => {
    await render();
    const trigger = document.querySelector('[data-testid="model-trigger"]') as HTMLButtonElement;
    expect(trigger.disabled).toBe(false);
    expect(trigger.textContent).toContain('mock · mock-smart');
  });
});
