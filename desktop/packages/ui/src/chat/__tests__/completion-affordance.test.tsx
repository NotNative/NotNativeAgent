// SPDX-License-Identifier: Apache-2.0
/** W-96 completion celebration affordance: settings + reduced motion honored. */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CompletionAffordance } from '../completion-affordance.tsx';
import { createDirectoryStore } from '../../sync/child-store.ts';
import type { DirectoryStore } from '../../sync/types.ts';
import { useSettingsStore } from '../../lib/settings/store.ts';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

type Status = { type: 'busy' } | { type: 'idle' } | { type: 'retry'; attempt: number; message: string };

function mount(status: Status, sessionID = 's1'): { node: HTMLDivElement; store: ReturnType<typeof createDirectoryStore>; set: (s: Status) => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const store = createDirectoryStore({ session_status: { [sessionID]: status }, session: [], message: {}, part: {}, permission: {}, question: {} } as unknown as Partial<DirectoryStore>);
  act(() => root.render(<CompletionAffordance store={store} sessionID={sessionID} />));
  return { node: container, store, set: (next) => act(() => store.setState({ session_status: { [sessionID]: next } } as Partial<DirectoryStore>)) };
}

describe('completion celebration affordance (W-96)', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() } as unknown as MediaQueryList)));
    act(() => { useSettingsStore.setState({ doc: {} }); });
    window.history.replaceState(null, '', window.location.pathname);
  });
  afterEach(() => {
    act(() => { vi.runOnlyPendingTimers(); });
    vi.unstubAllGlobals();
    vi.useRealTimers();
    if (root !== null) { const r = root; root = null; act(() => { r.unmount(); }); }
    container?.remove();
    container = null;
    act(() => { useSettingsStore.setState({ doc: {} }); });
  });

  it('pulse (default): busy→idle fires a self-clearing pulse; idle→busy re-arms', () => {
    const mounted = mount({ type: 'busy' });
    container = mounted.node; root = null;
    expect(mounted.node.querySelector('[data-testid="completion-affordance"]')).toBeNull();
    mounted.set({ type: 'idle' });
    const badge = mounted.node.querySelector('[data-testid="completion-affordance"]');
    expect(badge?.textContent).toContain('Session completed');
    expect(badge?.className).toContain('completion-pulse');
    act(() => { vi.advanceTimersByTime(4000); });
    expect(mounted.node.querySelector('[data-testid="completion-affordance"]')).toBeNull();
    mounted.set({ type: 'busy' });
    mounted.set({ type: 'idle' });
    expect(mounted.node.querySelector('[data-testid="completion-affordance"]')).toBeTruthy(); // re-armed
  });

  it('never fires without a busy→idle transition; idle start stays silent', () => {
    const mounted = mount({ type: 'idle' });
    expect(mounted.node.querySelector('[data-testid="completion-affordance"]')).toBeNull();
  });

  it("preference 'off' renders nothing; 'static' renders without the animation class", () => {
    act(() => { useSettingsStore.setState({ doc: { celebrationPreference: 'off' } }); });
    const off = mount({ type: 'busy' });
    off.set({ type: 'idle' });
    expect(off.node.querySelector('[data-testid="completion-affordance"]')).toBeNull();
    act(() => { useSettingsStore.setState({ doc: { celebrationPreference: 'static' } }); });
    const staticMount = mount({ type: 'busy' });
    staticMount.set({ type: 'idle' });
    const badge = staticMount.node.querySelector('[data-testid="completion-affordance"]');
    expect(badge?.textContent).toContain('Session completed');
    expect(badge?.className).not.toContain('completion-pulse');
  });

  it('prefers-reduced-motion forces the static rendering even on pulse', () => {
    const match = vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() } as unknown as MediaQueryList));
    vi.stubGlobal('matchMedia', match);
    const mounted = mount({ type: 'busy' });
    mounted.set({ type: 'idle' });
    const badge = mounted.node.querySelector('[data-testid="completion-affordance"]');
    expect(badge?.textContent).toContain('Session completed');
    expect(badge?.className).not.toContain('completion-pulse');
    vi.unstubAllGlobals();
  });
});
