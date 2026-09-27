// SPDX-License-Identifier: Apache-2.0
/** @vitest-environment jsdom */
import { afterEach, expect, it } from 'vitest';
import { Profiler, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { WorkStatusPanel } from '../work-status-panel.tsx';
import type { DirectoryStore } from '../../sync/types.ts';
import { createDirectoryStore } from '../../sync/child-store.ts';
import { useSessionViewStore } from '../../sync/view-store.ts';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  useSessionViewStore.setState({ currentSessionId: null, activeDirectory: '' });
});

it('commits completed-turn stats once and never leaks them to another session', async () => {
  const store = createDirectoryStore();
  store.setState({
    sessionStatusReady: true,
    message: {
      s1: [
        { id: 'user-1', sessionID: 's1', role: 'user', time: { created: 100 } },
        { id: 'assistant-1', sessionID: 's1', role: 'assistant', time: { created: 200, completed: 1100 },
          providerID: 'p', modelID: 'm', tokens: { total: 20, input: 10, output: 10 } },
      ],
      s2: [],
    },
  } as unknown as Partial<DirectoryStore>);
  useSessionViewStore.setState({ currentSessionId: 's1', activeDirectory: '/work' });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  let commits = 0;
  await act(async () => {
    root!.render(<Profiler id="context" onRender={() => { commits += 1; }}>
      <WorkStatusPanel store={store} engine={{} as never} embedded />
    </Profiler>);
    await Promise.resolve();
  });
  expect(container.textContent).toContain('Whole turn');
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect(commits).toBeLessThanOrEqual(3);
  await act(async () => useSessionViewStore.setState({ currentSessionId: 's2' }));
  expect(container.textContent).not.toContain('Whole turn');
});
