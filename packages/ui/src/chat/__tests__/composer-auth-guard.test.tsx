// SPDX-License-Identifier: Apache-2.0
/**
 * @vitest-environment jsdom
 * Composer send guard (doc 08 §6.7 step 3): a confirmed session expiry blocks
 * sends — the button disables, the Enter path no-ops, and the engine send is
 * never called — and a recovery (markOk on successful re-login) unblocks
 * without changing any pending draft text.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { StoreApi } from 'zustand/vanilla';

import { Composer } from '../composer.tsx';
import { __resetDraftStoreForTests } from '../drafts.ts';
import {
  __resetAuthExpiryForTests,
  useAuthSessionStore,
} from '../../lib/runtime-auth-expiry.ts';
import type { DirectoryStore } from '../../sync/types.ts';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const EMPTY_SNAPSHOT = {
  command: [],
  agent: [],
  provider: [],
  message: {},
  part: {},
  permission: {},
  question: {},
} as unknown as DirectoryStore;

const storeStub = {
  subscribe: () => () => undefined,
  getState: () => EMPTY_SNAPSHOT,
} as unknown as StoreApi<DirectoryStore>;

let engineSend: ReturnType<typeof vi.fn>;
let engineCreate: ReturnType<typeof vi.fn>;
let engineAbort: ReturnType<typeof vi.fn>;

const services = () => ({
  engine: {
    actions: {
      send: engineSend,
      createSession: engineCreate,
      abort: engineAbort,
    },
  } as never,
  store: () => storeStub,
  dispatch: () => undefined,
});

let container: HTMLDivElement | null = null;
let rootHandle: Root | null = null;
const nativeSet = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;

function editor(): HTMLTextAreaElement {
  return document.querySelector('[data-testid="composer-editor"]') as HTMLTextAreaElement;
}

function composerForm(): HTMLElement {
  return document.querySelector('[data-testid="composer"]') as HTMLElement;
}

function sendButton(): HTMLButtonElement {
  return document.querySelector('[aria-label="Send message"]') as HTMLButtonElement;
}

async function renderComposer(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  rootHandle = createRoot(container);
  await act(async () => {
    rootHandle!.render(
      <Composer
        services={services()}
        sessionID={null}
        directory="/proj"
        sessionKey="draft"
      />,
    );
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function typePending(value: string): Promise<void> {
  const target = editor();
  await act(async () => {
    nativeSet.call(target, value);
    target.dispatchEvent(new Event('input', { bubbles: true }));
    await Promise.resolve();
  });
}

async function pressEnter(): Promise<void> {
  await act(async () => {
    editor().dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  __resetDraftStoreForTests();
  __resetAuthExpiryForTests();
  window.localStorage.clear();
  document.body.innerHTML = '';
  engineSend = vi.fn(async () => undefined);
  engineCreate = vi.fn(async () => ({ id: 's1' }));
  engineAbort = vi.fn(async () => undefined);
});

afterEach(() => {
  try {
    act(() => rootHandle?.unmount());
  } finally {
    container?.remove();
    container = null;
    rootHandle = null;
  }
});

describe('Composer send guard (doc 08 §6.7 step 3)', () => {
  it('sends while the session is believed alive', async () => {
    await renderComposer();
    await typePending('hello there');
    await pressEnter();
    expect(engineCreate).toHaveBeenCalledTimes(1);
    expect(engineSend).toHaveBeenCalledTimes(1);
    expect(editor().value).toBe('');
  });

  it('blocks sends while the expiry is confirmed, and unblocks on markOk', async () => {
    await renderComposer();
    await act(() => {
      useAuthSessionStore.setState({ status: 'expired' });
    });

    expect(composerForm().getAttribute('data-send-blocked')).toBe('auth-expired');
    const button = sendButton();
    expect(button).toBeTruthy();
    expect(button.disabled).toBe(true);

    await typePending('should not ship');
    expect(button.disabled).toBe(true);
    await pressEnter();
    expect(engineCreate).not.toHaveBeenCalled();
    expect(engineSend).not.toHaveBeenCalled();
    expect(editor().value).toBe('should not ship');

    await act(() => {
      useAuthSessionStore.getState().markOk();
    });
    expect(sendButton().disabled).toBe(false);
    expect(composerForm().getAttribute('data-send-blocked')).toBe(null);
    await pressEnter();
    expect(engineCreate).toHaveBeenCalledTimes(1);
    expect(engineSend).toHaveBeenCalledTimes(1);
    expect(editor().value).toBe('');
  });

  it('reauthenticating stays usable (transport failure semantics are not ours)', async () => {
    await renderComposer();
    await act(() => {
      useAuthSessionStore.setState({ status: 'reauthenticating' });
    });
    await typePending('draft work');
    await pressEnter();
    expect(engineSend).toHaveBeenCalledTimes(1);
    expect(editor().value).toBe('');
  });
});
