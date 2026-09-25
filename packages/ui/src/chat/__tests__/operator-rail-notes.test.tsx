// SPDX-License-Identifier: Apache-2.0
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../../lib/runtime-fetch.ts', () => ({
  runtimeFetch: vi.fn(async () => ({ ok: false, status: 404, text: async () => '' })),
}));

import { createDirectoryStore } from '../../sync/child-store.ts';
import { OperatorRail } from '../operator-rail.tsx';
import { useSessionViewStore } from '../../sync/view-store.ts';
import { I18nProvider } from '../../components/I18nProvider.tsx';
import { runtimeFetch } from '../../lib/runtime-fetch.ts';

declare global { var IS_REACT_ACT_ENVIRONMENT: boolean | undefined; }
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let rootHandle: Root | null = null;

beforeEach(() => {
  vi.mocked(runtimeFetch).mockImplementation(async () => ({ ok: false, status: 404, text: async () => '', clone: () => ({ json: async () => ({ error: 'File not found', reason: 'not-found' }) }) }) as Response);
});

afterEach(() => {
  act(() => rootHandle?.unmount());
  container?.remove();
  container = null;
  rootHandle = null;
  document.body.innerHTML = '';
  useSessionViewStore.setState({ currentSessionId: null, activeDirectory: '' });
});

describe('OperatorRail Notes surface', () => {
  it('keeps project notes distinct and opens the plan editor on demand', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    rootHandle = createRoot(container);
    await act(async () => {
      rootHandle!.render(
        <I18nProvider>
          <OperatorRail store={createDirectoryStore()} engine={{} as never} directory="D:/work" />
        </I18nProvider>,
      );
      await Promise.resolve();
    });

    await act(async () => {
      (document.querySelector('button[aria-label="Notes"]') as HTMLButtonElement).click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(document.querySelector('[data-testid="project-notes"]')!.textContent).toContain('General notes');
    await act(async () => {
      ([...document.querySelectorAll('[data-testid="project-notes"] button')].find((button) => button.textContent === 'Plans') as HTMLButtonElement).click();
      await Promise.resolve();
    });
    expect(document.querySelector('[data-testid="plan-view"]')).not.toBeNull();
    expect(document.querySelector('[data-plan-host] textarea')).not.toBeNull();
  });

  it('does not let a failed notes read overwrite an existing note', async () => {
    vi.mocked(runtimeFetch).mockImplementation(async () => ({ ok: false, status: 403, clone: () => ({ json: async () => ({ error: 'Access denied' }) }) }) as Response);
    container = document.createElement('div'); document.body.appendChild(container); rootHandle = createRoot(container);
    await act(async () => { rootHandle!.render(<I18nProvider><OperatorRail store={createDirectoryStore()} engine={{} as never} directory="D:/work" /></I18nProvider>); });
    await act(async () => { (document.querySelector('button[aria-label="Notes"]') as HTMLButtonElement).click(); });
    const notes = document.querySelector('[data-testid="project-notes"]')!;
    expect(notes.textContent).toContain('Load failed');
    expect((notes.querySelector('textarea') as HTMLTextAreaElement).disabled).toBe(true);
    expect(([...notes.querySelectorAll('button')].find((button) => button.textContent === 'Save notes') as HTMLButtonElement).disabled).toBe(true);
    expect(vi.mocked(runtimeFetch).mock.calls.every(([, init]) => init?.method !== 'POST')).toBe(true);
  });

  it('does not replace malformed saved todos with an empty list', async () => {
    vi.mocked(runtimeFetch).mockImplementation(async () => ({ ok: true, status: 200, text: async () => '{broken' }) as Response);
    container = document.createElement('div'); document.body.appendChild(container); rootHandle = createRoot(container);
    await act(async () => { rootHandle!.render(<I18nProvider><OperatorRail store={createDirectoryStore()} engine={{} as never} directory="D:/work" /></I18nProvider>); });
    await act(async () => { (document.querySelector('button[aria-label="Notes"]') as HTMLButtonElement).click(); });
    await act(async () => { ([...document.querySelectorAll('[data-testid="project-notes"] button')].find((button) => button.textContent === 'Todos') as HTMLButtonElement).click(); });
    const todos = document.querySelector('[data-testid="project-notes"]')!;
    expect(todos.textContent).toContain('Load failed');
    expect((todos.querySelector('input') as HTMLInputElement).disabled).toBe(true);
    expect(([...todos.querySelectorAll('button')].find((button) => button.textContent === 'Add') as HTMLButtonElement).disabled).toBe(true);
    expect(vi.mocked(runtimeFetch).mock.calls.every(([, init]) => init?.method !== 'POST')).toBe(true);
  });

  it('does not confuse an unknown read endpoint with a missing note', async () => {
    vi.mocked(runtimeFetch).mockImplementation(async () => ({ ok: false, status: 404, clone: () => ({ json: async () => ({ error: 'Not Found' }) }) }) as Response);
    container = document.createElement('div'); document.body.appendChild(container); rootHandle = createRoot(container);
    await act(async () => { rootHandle!.render(<I18nProvider><OperatorRail store={createDirectoryStore()} engine={{} as never} directory="D:/work" /></I18nProvider>); });
    await act(async () => { (document.querySelector('button[aria-label="Notes"]') as HTMLButtonElement).click(); });
    const notes = document.querySelector('[data-testid="project-notes"]')!;
    expect(notes.textContent).toContain('Load failed');
    expect((notes.querySelector('textarea') as HTMLTextAreaElement).disabled).toBe(true);
    expect(([...notes.querySelectorAll('button')].find((button) => button.textContent === 'Save notes') as HTMLButtonElement).disabled).toBe(true);
  });
});
