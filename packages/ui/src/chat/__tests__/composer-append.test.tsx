// SPDX-License-Identifier: Apache-2.0
/**
 * @vitest-environment jsdom
 * Composer add-to-chat wiring (doc 06 §10.5 + §B.9): `nnd:composer-fill`
 * with detail.append APPENDS the capture to the pending input and puts the
 * caret after it; without the flag it REPLACES (§B.9 revert/chips contract
 * unchanged). `nnd:composer-focus` focuses the editor with no capture
 * (focus-only §10.5). Rides the real Composer, store stubbed.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { StoreApi } from 'zustand/vanilla';

import { Composer } from '../composer.tsx';
import { __resetDraftStoreForTests } from '../drafts.ts';
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

const services = {
  engine: {} as never,
  store: () => storeStub,
  dispatch: () => undefined,
};

let container: HTMLDivElement | null = null;
let rootHandle: Root | null = null;
const nativeSet = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;

function editor(): HTMLTextAreaElement {
  return document.querySelector('[data-testid="composer-editor"]') as HTMLTextAreaElement;
}

function fill(detail: Record<string, unknown>): void {
  window.dispatchEvent(new CustomEvent('nnd:composer-fill', { detail }));
}

async function flushAnimationFrame(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolvePromise) => window.requestAnimationFrame(() => resolvePromise()));
    await Promise.resolve();
  });
}

beforeEach(() => {
  __resetDraftStoreForTests();
  window.localStorage.clear();
  document.body.innerHTML = '';
  window.requestAnimationFrame = window.requestAnimationFrame
    ?? ((callback: FrameRequestCallback): number => window.setTimeout(() => callback(Date.now()), 0));
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

async function renderComposer(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  rootHandle = createRoot(container);
  await act(async () => {
    rootHandle!.render(
      <Composer
        services={services}
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

describe('Composer add-to-chat fill channel', () => {
  it('append:true appends the capture to non-empty pending input and parks the caret after it', async () => {
    await renderComposer();
    await typePending('pending');
    await act(async () => {
      fill({ text: '```\ncaptured\n```', append: true });
      await Promise.resolve();
    });
    await flushAnimationFrame();
    expect(editor().value).toBe('pending\n\n```\ncaptured\n```');
    expect(editor().selectionStart).toBe(editor().value.length);
    expect(document.activeElement).toBe(editor());
  });

  it('append:true on an empty composer delivers the capture alone', async () => {
    await renderComposer();
    await act(async () => {
      fill({ text: 'capture only', append: true });
      await Promise.resolve();
    });
    await flushAnimationFrame();
    expect(editor().value).toBe('capture only');
  });

  it('without the append flag the fill replaces (§B.9 revert/chips), no caret move', async () => {
    await renderComposer();
    await typePending('before');
    await act(async () => {
      fill({ text: 'replacement' });
      await Promise.resolve();
    });
    await flushAnimationFrame();
    expect(editor().value).toBe('replacement');
    expect(document.activeElement).toBe(editor());
  });

  it('nnd:composer-focus focuses the editor without touching pending input', async () => {
    await renderComposer();
    await typePending('queued work');
    await act(async () => {
      window.dispatchEvent(new CustomEvent('nnd:composer-focus'));
      await Promise.resolve();
    });
    expect(editor().value).toBe('queued work');
    expect(document.activeElement).toBe(editor());
  });
});
