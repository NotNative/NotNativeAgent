// SPDX-License-Identifier: Apache-2.0
/**
 * @vitest-environment jsdom
 * Blocking cards §F.2/§F.3 (W-20): per-tool permission bodies + patterns
 * chips + Alt-key stack; question tabs/Summary/Other free-text/submit-deny
 * payloads. The send-while-blocked rule (§F.4) is composer/planner-owned and
 * tested in composer tests.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { StoreApi } from 'zustand/vanilla';

import { BlockingCardsColumn } from '../blocking-cards.tsx';
import type { DirectoryStore } from '../../sync/types.ts';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const SESSION = 'ses_cards';
const BASH_REQUEST = {
  id: 'perm_1',
  sessionID: SESSION,
  permission: 'bash',
  patterns: ['pnpm test*'],
  metadata: { command: 'pnpm --filter ui test', cwd: 'D:/work', timeoutMs: 123000, description: 'run suite' },
  always: ['pnpm test'],
};

function storeWith(permission: unknown[], question: unknown[]): StoreApi<DirectoryStore> {
  const snapshot = {
    command: [], agent: [], provider: [], message: {}, part: {},
    permission: { [SESSION]: permission }, question: { [SESSION]: question },
  } as unknown as DirectoryStore;
  return { subscribe: () => () => undefined, getState: () => snapshot } as unknown as StoreApi<DirectoryStore>;
}

function engineWith(): { engine: Record<string, unknown>; perms: ReturnType<typeof vi.fn>; questions: ReturnType<typeof vi.fn> } {
  const perms = vi.fn().mockResolvedValue(undefined);
  const questions = vi.fn().mockResolvedValue(undefined);
  return {
    engine: {
      actions: new Proxy({}, { get: (_t, key) => (key === 'replyPermission' ? perms : questions) }),
    },
    perms,
    questions,
  };
}

let container: HTMLDivElement | null = null;
let rootHandle: Root | null = null;

function mount(store: StoreApi<DirectoryStore>, engine: unknown): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  rootHandle = createRoot(container);
  act(() => { rootHandle!.render(<BlockingCardsColumn store={store} engine={engine as never} sessionID={SESSION} />); });
}

async function keyOnColumn(key: string, alt = true, shift = false): Promise<void> {
  const column = document.querySelector('[data-testid="blocking-cards"]')!;
  await act(async () => {
    column.dispatchEvent(new KeyboardEvent('keydown', { key, altKey: alt, shiftKey: shift, bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
}

afterEach(() => {
  act(() => { rootHandle?.unmount(); });
  container?.remove();
  container = null;
  rootHandle = null;
  document.body.innerHTML = '';
});

describe('permission card §F.2', () => {
  it('bash body highlights the command and shows working directory/timeout', () => {
    mount(storeWith([BASH_REQUEST], []), engineWith().engine);
    const card = document.querySelector('[data-testid="permission-card"]')!;
    expect(card.textContent).toContain('Permission Required');
    expect(card.textContent).toContain('pnpm --filter ui test');
    expect(card.textContent).toContain('working directory D:/work');
    expect(card.textContent).toContain('123000ms');
    expect(card.textContent).toContain('pnpm test*');
  });

  it('Alt+Enter = allow once, Alt+Shift+Enter = always, Alt+Backspace = reject', async () => {
    const harness = engineWith();
    mount(storeWith([BASH_REQUEST], []), harness.engine);
    await keyOnColumn('Enter');
    expect(harness.perms).toHaveBeenCalledWith(SESSION, expect.objectContaining({ id: 'perm_1' }), 'once');
    await keyOnColumn('Enter', true, true);
    expect(harness.perms).toHaveBeenLastCalledWith(SESSION, expect.anything(), 'always');
    await keyOnColumn('Backspace');
    expect(harness.perms).toHaveBeenLastCalledWith(SESSION, expect.anything(), 'reject');
  });

  it('edit body shows the path and the diff preview; buttons answer through the engine', async () => {
    const harness = engineWith();
    mount(storeWith([{ id: 'perm_e', sessionID: SESSION, permission: 'edit', patterns: [], metadata: { path: 'src/a.ts', diff: '--- a\n+++ b' }, always: [] }], []), harness.engine);
    const card = document.querySelector('[data-testid="permission-card"]')!;
    expect(card.textContent).toContain('src/a.ts');
    expect(card.textContent).toContain('--- a');
    await act(async () => {
      (card.querySelector('[data-testid="permission-allow-once"]') as HTMLButtonElement).click();
      await Promise.resolve();
    });
    expect(harness.perms).toHaveBeenCalledWith(SESSION, expect.objectContaining({ id: 'perm_e' }), 'once');
  });
});

describe('question card §F.3', () => {
  const QUESTION = {
    id: 'qq_1',
    sessionID: SESSION,
    questions: [{ question: 'Use PORT 3000 or 5173?', header: 'Port', options: [{ label: 'Use 3000', description: 'server default' }, { label: 'Use 5173', description: 'vite' }], multiple: false, custom: true }],
  };

  it('radio submit sends the picked label; custom text answers as the single element', async () => {
    const harness = engineWith();
    mount(storeWith([], [QUESTION]), harness.engine);
    const card = document.querySelector('[data-testid="question-card"]')!;
    expect((document.querySelector('[data-testid="question-submit"]') as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      (card.querySelector('input[type="radio"]') as HTMLInputElement).click();
      await Promise.resolve();
    });
    expect((document.querySelector('[data-testid="question-submit"]') as HTMLButtonElement).disabled).toBe(false);
    await act(async () => {
      (document.querySelector('[data-testid="question-submit"]') as HTMLButtonElement).click();
      await Promise.resolve();
    });
    expect(harness.questions).toHaveBeenCalledWith(SESSION, expect.objectContaining({ id: 'qq_1' }), [['Use 3000']], false);
  });

  it('typed "Other…" content satisfies the answer rule and rides the answer array', async () => {
    const harness = engineWith();
    const OTHER = {
      id: 'qq_2', sessionID: SESSION,
      questions: [{ question: 'which pkg?', header: 'Pkg', options: [], multiple: false, custom: true }],
    };
    mount(storeWith([], [OTHER]), harness.engine);
    const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
    expect((document.querySelector('[data-testid="question-submit"]') as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
      set.call(textarea, 'use the ui package');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });
    expect((document.querySelector('[data-testid="question-submit"]') as HTMLButtonElement).disabled).toBe(false);
    await act(async () => {
      (document.querySelector('[data-testid="question-submit"]') as HTMLButtonElement).click();
      await Promise.resolve();
    });
    expect(harness.questions).toHaveBeenCalledWith(SESSION, expect.anything(), [['use the ui package']], false);
  });

  it('multi-question requests render the Q tab strip with a Summary tab and Next jumps', async () => {
    const MULTI = {
      id: 'qq_3', sessionID: SESSION,
      questions: [
        { question: 'Q1', header: 'Port', options: [{ label: '3000', description: '' }], multiple: false },
        { question: 'Q2', header: 'Mode', options: [{ label: 'aot', description: '' }], multiple: false },
      ],
    };
    mount(storeWith([], [MULTI]), engineWith().engine);
    const tabs = document.querySelector('[data-testid="question-tabs"]');
    expect(tabs?.textContent).toContain('Q1 Port');
    expect(tabs?.textContent).toContain('Q2 Mode');
    expect(tabs?.textContent).toContain('Summary');
    expect(document.querySelector('[data-testid="question-summary"]')).toBeNull(); // Q1 active first
    const buttons = [...document.querySelectorAll('[data-testid="question-tabs"] button')] as HTMLButtonElement[];
    const summaryButton = buttons.find((button) => button.textContent === 'Summary')!;
    await act(async () => {
      summaryButton.click();
      await Promise.resolve();
    });
    expect(document.querySelector('[data-testid="question-summary"]')?.textContent).toContain('Port');
    const next = document.querySelector('[data-testid="question-next"]') as HTMLButtonElement;
    await act(async () => {
      next.click(); // from Summary, Next jumps to Q2 (first unanswered)
      await Promise.resolve();
    });
    expect(document.querySelector('[data-testid="question-card"]')!.textContent).toContain('Mode');
  });

  it('Dismiss answers with the reject reject-reactions route (empty payload)', async () => {
    const harness = engineWith();
    mount(storeWith([], [QUESTION]), harness.engine);
    await act(async () => {
      (document.querySelector('[data-testid="question-dismiss"]') as HTMLButtonElement).click();
      await Promise.resolve();
    });
    expect(harness.questions).toHaveBeenCalledWith(SESSION, expect.anything(), [], true);
  });
});
