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

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const base = {
  command: [], agent: [], provider: [], config: {}, message: {}, part: {}, permission: {}, question: {},
};
let snapshot = base as unknown as DirectoryStore;
const store = { subscribe: () => () => undefined, getState: () => snapshot } as unknown as StoreApi<DirectoryStore>;
let root: Root | null = null;
let container: HTMLDivElement | null = null;
const send = vi.fn(async () => undefined);
const createSession = vi.fn(async () => ({ id: 'session_1' }));
const nativeSet = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;

async function render(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<Composer services={{ engine: { actions: { send, createSession } } as never, store: () => store, dispatch: () => undefined }}
      sessionID={null} directory="/proj" sessionKey="draft" />);
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
  window.localStorage.clear();
  document.body.innerHTML = '';
  send.mockClear();
  createSession.mockClear();
  snapshot = base as unknown as DirectoryStore;
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe('NNA configured composer model', () => {
  it('shows the configured primary route, hides unsupported controls, and sends its exact model', async () => {
    snapshot = { ...base, config: { model: 'primary/test', default_agent: 'nna', nnd: {
      engine: 'nna', modelSelection: 'configured', primaryModel: { providerID: 'primary', modelID: 'test' },
    } } } as unknown as DirectoryStore;
    await render();
    const trigger = document.querySelector('[data-testid="model-trigger"]') as HTMLButtonElement;
    expect(trigger.textContent).toBe('primary · test');
    expect(trigger.disabled).toBe(true);
    expect(document.querySelector('[aria-label="Agent persona"]')).toBeNull();
    expect(document.querySelector('[aria-label="Enable permission auto-accept"]')).toBeNull();
    expect(document.body.textContent).toContain('NNA governed');
    await submit('hello NNA');
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      model: { providerID: 'primary', modelID: 'test' }, agent: 'nna',
    }));
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
    const trigger = document.querySelector('[data-testid="model-trigger"]') as HTMLButtonElement;
    expect(trigger.disabled).toBe(true);
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
    expect(trigger.textContent).toBe('mock · mock-smart');
  });
});
