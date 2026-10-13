// SPDX-License-Identifier: Apache-2.0
/** @vitest-environment jsdom */
import { afterEach, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { StatusChip } from '../transcript.tsx';
import { createDirectoryStore } from '../../sync/child-store.ts';
import { useGlobalSessionStatusStore } from '../../sync/global-stores.ts';
import type { HarnessConfig } from '../../lib/nnd/types.ts';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  useGlobalSessionStatusStore.getState().reset();
});

it('names the active NNA engine rather than the mock model in the busy chip', () => {
  const store = createDirectoryStore();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<StatusChip store={store} sessionID="s1" />));
  act(() => useGlobalSessionStatusStore.getState().applyEvent('s1', { type: 'busy' }));
  expect(container.textContent).toContain('mock-smart is');
  act(() => store.getState().patch({ config: { nnd: { engine: 'nna' } } as HarnessConfig }));
  expect(container.textContent).toContain('NNA is');
  expect(container.textContent).not.toContain('mock-smart');
});
