// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CompletionAffordance } from '../completion-affordance.tsx';
import { createDirectoryStore } from '../../sync/child-store.ts';
import { useSettingsStore } from '../../lib/settings/store.ts';
import type { AssistantMessage } from '../../lib/nnd/types.ts';
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, node: HTMLDivElement;
const message = (id: string, finish = 'stop'): AssistantMessage => ({ id, sessionID: 's1', role: 'assistant', modelID: 'm', providerID: 'p', time: { created: 1, completed: 2 }, finish });
function mount(pref = 'pulse', reduced = false) {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: reduced, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  useSettingsStore.setState({ doc: { celebrationPreference: pref } });
  const store = createDirectoryStore({ session_status: { s1: { type: 'busy' } }, message: { s1: [] } });
  const render = (id = 's1') => act(() => root.render(<CompletionAffordance store={store} sessionID={id} />));
  render();
  const complete = (finish = 'stop', id = 'a1') => act(() => store.setState({ session_status: { s1: { type: 'idle' } }, message: { s1: [message(id, finish)] } }));
  return { store, render, complete };
}
beforeEach(() => { vi.useFakeTimers(); node = document.createElement('div'); document.body.appendChild(node); root = createRoot(node); });
afterEach(() => { act(() => root.unmount()); node.remove(); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); useSettingsStore.setState({ doc: {} }); });
it.each([['pulse', false, true], ['pulse', true, false], ['static', false, false], ['off', false, false]] as const)('successful turn honors %s and reduced motion %s', (pref, reduced, animated) => {
  const view = mount(pref, reduced); view.complete();
  expect(node.textContent).toBe(pref === 'off' ? '' : 'Turn completed');
  expect(node.querySelector('.completion-pulse') !== null).toBe(animated);
  act(() => vi.advanceTimersByTime(4000)); expect(node.textContent).toBe('');
});
it.each(['abort', 'error', 'tool-calls', 'length'])('does not report %s as successful completion', finish => { const view = mount(); view.complete(finish); expect(node.textContent).toBe(''); });
it.each(['completed', 'cancelled', 'needs_input', 'failed', 'unknown'] as const)('uses the native %s outcome when transcript messages have no compatibility finish', turnOutcome => {
  const view = mount('static');
  act(() => view.store.setState({ session_status: { s1: { type: 'idle' } }, activity: [{ id: 'native-turn', sessionID: 's1', kind: 'turn', status: 'completed', summary: 'Turn completed', time: 2, turnOutcome }] }));
  expect(node.textContent).toBe(turnOutcome === 'completed' ? 'Turn completed' : '');
});
it('waits for successful message evidence after idle and consumes it once', () => {
  const view = mount(); act(() => view.store.setState({ session_status: { s1: { type: 'idle' } } })); expect(node.textContent).toBe('');
  view.complete(); expect(node.textContent).toBe('Turn completed');
  act(() => vi.advanceTimersByTime(4000));
  act(() => view.store.setState({ session_status: { s1: { type: 'idle' } } })); expect(node.textContent).toBe('');
});
it('does not replay an old successful turn on idle or a session switch', () => {
  const view = mount(); view.complete();
  view.render('s2'); expect(node.textContent).toBe('');
  view.render(); expect(node.textContent).toBe('');
  act(() => view.store.setState({ session_status: { s1: { type: 'busy' } } }));
  act(() => view.store.setState({ session_status: { s1: { type: 'idle' } } })); expect(node.textContent).toBe('');
  act(() => view.store.setState({ session_status: { s1: { type: 'busy' } } })); view.complete('stop', 'a2'); expect(node.textContent).toBe('Turn completed');
});
