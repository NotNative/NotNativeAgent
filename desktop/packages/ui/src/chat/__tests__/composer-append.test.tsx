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
import { __resetDraftStoreForTests, draftKey, readDraft } from '../drafts.ts';
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
  session: [],
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
  it('accepts a targeted todo only for its mounted project and session', async () => {
    await renderComposer();
    let accepted = 0;
    const target = { text: 'Todo: Ship MVP', append: true, directory: '/proj', sessionKey: 'draft', accept: () => { accepted += 1; } };
    await act(async () => { fill({ ...target, directory: '/other' }); fill({ ...target, sessionKey: 'wrong' }); await Promise.resolve(); });
    expect(editor().value).toBe('');
    expect(accepted).toBe(0);
    await act(async () => { fill(target); await Promise.resolve(); });
    expect(editor().value).toBe('Todo: Ship MVP');
    expect(readDraft('/proj', 'draft').text).toBe('Todo: Ship MVP');
    expect(accepted).toBe(1);
  });
  it('retains both accepted todo handoffs before a render flush', async () => {
    await renderComposer();
    await act(async () => {
      fill({ text: 'Todo: First', append: true, directory: '/proj', sessionKey: 'draft' });
      fill({ text: 'Todo: Second', append: true, directory: '/proj', sessionKey: 'draft' });
      await Promise.resolve();
    });
    expect(editor().value).toBe('Todo: First\n\nTodo: Second');
    expect(readDraft('/proj', 'draft').text).toBe(editor().value);
  });
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

  it('accepts a bounded annotation image and text as one unsent draft', async () => {
    await renderComposer();
    await typePending('Keep this');
    let accepted = false;
    await act(async () => {
      window.dispatchEvent(new CustomEvent('nnd:composer-annotation', { detail: {
        id: '00000000-0000-4000-8000-000000000001',
        targetKey: draftKey('/proj', 'draft'),
        text: 'Page annotation (highlighted viewport screenshot attached)\nUser comment: Fix this',
        attachment: { name: 'browser-annotation-1-00000000-0000-4000-8000-000000000001.jpg', mime: 'image/jpeg', dataUrl: 'data:image/jpeg;base64,AA==' },
        accept: () => { accepted = true; },
      } }));
    });
    expect(accepted).toBe(true);
    expect(editor().value).toContain('Keep this\n\nPage annotation');
    expect(readDraft('/proj', 'draft').attachments).toMatchObject([{ name: 'browser-annotation-1-00000000-0000-4000-8000-000000000001.jpg' }]);
    expect(readDraft('/proj', 'draft').text).toBe(editor().value);
  });

  it('rejects an invalid annotation image without changing the draft', async () => {
    await renderComposer();
    await typePending('Keep this');
    let accepted = false;
    await act(async () => {
      window.dispatchEvent(new CustomEvent('nnd:composer-annotation', { detail: {
        id: '00000000-0000-4000-8000-000000000002',
        targetKey: draftKey('/proj', 'draft'),
        text: 'Page annotation (highlighted viewport screenshot attached)',
        attachment: { name: 'browser-annotation-2-00000000-0000-4000-8000-000000000002.jpg', mime: 'image/jpeg', dataUrl: 'blob:unsafe' },
        accept: () => { accepted = true; },
      } }));
    });
    expect(accepted).toBe(false);
    expect(editor().value).toBe('Keep this');
    expect(readDraft('/proj', 'draft').attachments).toEqual([]);
  });

  it('acknowledges an already accepted annotation retry without duplicating text or image', async () => {
    await renderComposer();
    const detail = { id: '00000000-0000-4000-8000-000000000003',
      targetKey: draftKey('/proj', 'draft'),
      text: 'Page annotation (highlighted viewport screenshot attached)',
      attachment: { name: 'browser-annotation-3-00000000-0000-4000-8000-000000000003.jpg',
        mime: 'image/jpeg', dataUrl: 'data:image/jpeg;base64,AA==' }, accept: () => undefined };
    await act(async () => {
      window.dispatchEvent(new CustomEvent('nnd:composer-annotation', { detail }));
      window.dispatchEvent(new CustomEvent('nnd:composer-annotation', { detail }));
    });
    expect(readDraft('/proj', 'draft').attachments).toHaveLength(1);
    expect(editor().value.match(/Page annotation/gu)).toHaveLength(1);
  });

  it('keeps two distinct same-turn annotation transfers together', async () => {
    await renderComposer();
    const transfer = (suffix: string): void => { window.dispatchEvent(new CustomEvent('nnd:composer-annotation', { detail: {
      id: `00000000-0000-4000-8000-00000000000${suffix}`, targetKey: draftKey('/proj', 'draft'),
      text: `Page annotation ${suffix}`, attachment: {
        name: `browser-annotation-${suffix}-00000000-0000-4000-8000-00000000000${suffix}.jpg`,
        mime: 'image/jpeg', dataUrl: 'data:image/jpeg;base64,AA==' }, accept: () => undefined,
    } })); };
    await act(async () => { transfer('4'); transfer('5'); });
    expect(readDraft('/proj', 'draft').attachments).toHaveLength(2);
    expect(editor().value).toContain('Page annotation 4\n\nPage annotation 5');
  });

  it('does not acknowledge or write a late transfer after switching composer targets', async () => {
    await renderComposer();
    const previousTarget = draftKey('/proj', 'draft');
    let capturedTarget = '';
    act(() => window.dispatchEvent(new CustomEvent('nnd:composer-annotation-target', { detail: {
      accept: (key: string) => { capturedTarget = key; },
    } })));
    expect(capturedTarget).toBe(previousTarget);
    await act(async () => { rootHandle!.render(<Composer services={services} sessionID='next' directory='/proj'
      sessionKey='next' />); await Promise.resolve(); });
    let accepted = false;
    await act(async () => { window.dispatchEvent(new CustomEvent('nnd:composer-annotation', { detail: {
      id: '00000000-0000-4000-8000-000000000006', targetKey: capturedTarget,
      text: 'Page annotation old session', attachment: {
        name: 'browser-annotation-6-00000000-0000-4000-8000-000000000006.jpg',
        mime: 'image/jpeg', dataUrl: 'data:image/jpeg;base64,AA==' }, accept: () => { accepted = true; },
    } })); });
    expect(accepted).toBe(false);
    expect(readDraft('/proj', 'next').attachments).toEqual([]);
    expect(readDraft('/proj', 'draft').attachments).toEqual([]);
  });
});
