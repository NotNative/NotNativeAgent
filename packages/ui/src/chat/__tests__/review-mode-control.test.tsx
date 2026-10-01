// SPDX-License-Identifier: Apache-2.0
/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ReviewModeControl } from '../review-mode-control.tsx';
import { harnessClient, type HarnessResult } from '../../lib/nnd/client.ts';
import type { ReviewModeSnapshot } from '../../lib/nnd/review-mode.ts';

const runtime = vi.hoisted(() => ({ key: 'local', listener: () => {} }));
vi.mock('../../lib/runtime-switch.ts', () => ({
  getRuntimeKey: () => runtime.key,
  onRuntimeEndpointChanged: (listener: () => void) => { runtime.listener = listener; return () => {}; },
}));
vi.mock('../../lib/nnd/client.ts', () => ({ harnessClient: {
  getSessionReviewMode: vi.fn(), setSessionReviewMode: vi.fn(),
} }));
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const snapshot = (mode: ReviewModeSnapshot['mode'] = 'default', revision = 0): ReviewModeSnapshot => ({
  mode, revision, effective: mode === 'unattended' ? 'unattended' : 'auto-review',
  defaultMode: 'auto-review', availableModes: ['default', 'auto-review', 'unattended'],
});
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.resetAllMocks(); runtime.key = 'local';
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  vi.mocked(harnessClient.getSessionReviewMode).mockResolvedValue({ data: snapshot() });
});
afterEach(() => { act(() => root.unmount()); container.remove(); });
const render = async (sessionID = 's1', busy = false) => {
  await act(async () => { root.render(<StrictMode><ReviewModeControl sessionID={sessionID} busy={busy} /></StrictMode>); });
};
const change = async (mode: string) => {
  await act(async () => {
    const select = container.querySelector('select')!; select.value = mode;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
};
const refresh = async () => {
  await act(async () => { container.querySelector('button')!.click(); });
};

it('loads safely in StrictMode and commits only the NNA-confirmed CAS response', async () => {
  vi.mocked(harnessClient.setSessionReviewMode).mockResolvedValue({ data: snapshot('unattended', 1) });
  await render();
  expect(container.querySelector('select')?.value).toBe('default');
  await change('unattended');
  expect(harnessClient.setSessionReviewMode).toHaveBeenCalledExactlyOnceWith('s1', 'unattended', 0);
  expect(container.querySelector('select')?.value).toBe('unattended');
  expect(container.textContent).toContain('Unresolved escalations are denied');
});

it('blocks busy sessions and only offers NNA-advertised modes', async () => {
  const state = snapshot(); state.availableModes = ['default', 'auto-review'];
  vi.mocked(harnessClient.getSessionReviewMode).mockResolvedValue({ data: state });
  await render('s1', true);
  expect(container.querySelector('select')?.disabled).toBe(true);
  expect(container.querySelector('option[value="unattended"]')).toBeNull();
  await change('auto-review');
  expect(harnessClient.setSessionReviewMode).not.toHaveBeenCalled();
});

it.each(['denied', 'throws', 'invalid', 'same revision'])('recovers from %s saves without assuming permission changed', async (failure) => {
  const setter = vi.mocked(harnessClient.setSessionReviewMode);
  if (failure === 'throws') setter.mockRejectedValueOnce(new Error('body disconnected'));
  else setter.mockResolvedValueOnce(failure === 'denied' ? { error: 'conflict', response: { status: 409 } }
    : { data: failure === 'invalid' ? { ...snapshot('unattended', 1), effective: 'auto-review' } : snapshot('unattended', 0) });
  await render(); await change('unattended');
  expect(container.querySelector('select')?.value).toBe('default');
  expect(container.querySelector('select')?.disabled).toBe(true);
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
  expect(container.querySelector('button')?.disabled).toBe(false);
  vi.mocked(harnessClient.getSessionReviewMode).mockResolvedValue({ data: snapshot('auto-review', 2) });
  await refresh();
  expect(container.querySelector('select')?.value).toBe('auto-review');
  expect(container.querySelector('select')?.disabled).toBe(false);
});

it('can retry a thrown initial read and rejects malformed snapshots', async () => {
  vi.mocked(harnessClient.getSessionReviewMode).mockRejectedValue(new Error('offline'));
  await render();
  expect(container.querySelector('select')).toBeNull();
  expect(container.querySelector('button')?.disabled).toBe(false);
  vi.mocked(harnessClient.getSessionReviewMode).mockResolvedValue({ data: { ...snapshot(), availableModes: ['default', 'default'] } });
  await refresh(); expect(container.querySelector('select')).toBeNull();
  vi.mocked(harnessClient.getSessionReviewMode).mockResolvedValue({ data: snapshot() });
  await refresh(); expect(container.querySelector('select')?.value).toBe('default');
});

it.each(['session', 'runtime'])('ignores old pending save replies after %s switches', async (kind) => {
  let finish!: (value: HarnessResult<ReviewModeSnapshot>) => void;
  vi.mocked(harnessClient.setSessionReviewMode).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  await render(); await change('unattended');
  if (kind === 'session') await render('s2');
  else await act(async () => { runtime.key = 'remote'; runtime.listener(); });
  await act(async () => { finish({ data: snapshot('unattended', 1) }); });
  expect(container.querySelector('select')?.value).toBe('default');
  expect(container.querySelector('select')?.disabled).toBe(false);
});

it('ignores an older read when switching sessions', async () => {
  const replies: ((value: HarnessResult<ReviewModeSnapshot>) => void)[] = [];
  vi.mocked(harnessClient.getSessionReviewMode).mockImplementation(() => new Promise((resolve) => replies.push(resolve)));
  await render();
  vi.mocked(harnessClient.getSessionReviewMode).mockResolvedValue({ data: snapshot('auto-review', 3) });
  await render('s2');
  await act(async () => { for (const finish of replies) finish({ data: snapshot('unattended', 1) }); });
  expect(container.querySelector('select')?.value).toBe('auto-review');
});
