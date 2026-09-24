// SPDX-License-Identifier: Apache-2.0
/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../../lib/runtime-fetch.ts', () => ({
  runtimeFetch: vi.fn(async () => ({ ok: false, status: 404, text: async () => '' })),
}));

import { createDirectoryStore } from '../../sync/child-store.ts';
import { OperatorRail } from '../operator-rail.tsx';
import { useSessionViewStore } from '../../sync/view-store.ts';
import { I18nProvider } from '../../components/I18nProvider.tsx';

declare global { var IS_REACT_ACT_ENVIRONMENT: boolean | undefined; }
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let rootHandle: Root | null = null;

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
});
