// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { harnessClient, type HarnessSession } from '../../../lib/nnd/client.ts';
import { useAuthSessionStore } from '../../../lib/runtime-auth-expiry.ts';
import { beginAuthorityRecovery, finishAuthorityRecovery } from '../../../sync/authority-sync.ts';
import { useGlobalSessionsStore } from '../../../sync/global-stores.ts';
import { ConversationData } from '../pages/operational-conversations.tsx';
vi.mock('../../../lib/nnd/client.ts', () => ({ normalizeDirectory: (value: string) => value, harnessClient: { listSessions: vi.fn(), updateSession: vi.fn() } }));
let node: HTMLDivElement, root: Root, saved: HarnessSession;
const button = (text: string) => [...node.querySelectorAll('button')].find(row => row.textContent === text)!;
async function mount() { await act(async () => root.render(<ConversationData />)); }
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true; vi.resetAllMocks(); useGlobalSessionsStore.getState().reset();
  useAuthSessionStore.getState().markOk(); const token = beginAuthorityRecovery('local'); finishAuthorityRecovery('local', token, true);
  saved = { id: 'ses_data', title: 'Owned conversation', directory: 'D:/workspace', time: { created: 1000, updated: 2000, archived: 1500 } } as HarnessSession;
  vi.mocked(harnessClient.listSessions).mockImplementation(async () => ({ data: [saved] }));
  vi.mocked(harnessClient.updateSession).mockImplementation(async (id, body) => {
    const archived = (body.time as { archived: number }).archived;
    saved = { ...saved, id, time: { created: 1000, updated: 2001, ...(archived ? { archived } : {}) } };
    return { data: saved };
  });
  node = document.createElement('div'); document.body.append(node); root = createRoot(node);
});
afterEach(() => { act(() => root.unmount()); node.remove(); });

it('accepts the native omitted archive timestamp on restore, refreshes the list and preserves workspace ownership', async () => {
  await mount(); await act(async () => button('Restore').click());
  expect(harnessClient.updateSession).toHaveBeenCalledExactlyOnceWith('ses_data', { time: { archived: 0 } }, { directory: 'D:/workspace' });
  expect(node.querySelector('[role="alert"]')).toBeNull(); expect(button('Archive')).toBeTruthy();
  expect(node.textContent).toContain('Conversation restored to its workspace.'); expect(node.textContent).toContain('D:/workspace · Active');
  await act(async () => button('Archive').click()); expect(saved.time.archived).toBeGreaterThan(0); expect(button('Restore')).toBeTruthy();
});

it('retains the row and exposes a failed acknowledgement instead of claiming success', async () => {
  vi.mocked(harnessClient.updateSession).mockResolvedValueOnce({ error: 'permission denied' });
  await mount(); await act(async () => button('Restore').click());
  expect(node.querySelector('[role="alert"]')?.textContent).toContain('did not confirm'); expect(button('Restore').disabled).toBe(false);
  expect(node.textContent).toContain('D:/workspace · Archived'); expect(node.textContent).not.toContain('Conversation restored');
});

it('filters authoritative rows by archive state and workspace text', async () => {
  await mount(); const filter = node.querySelector('select')!;
  await act(async () => { filter.value = 'active'; filter.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(node.querySelector('[data-testid="data-conversation"]')).toBeNull();
  await act(async () => { filter.value = 'archived'; filter.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(node.querySelector('[data-testid="data-conversation"]')).not.toBeNull();
  await act(async () => { const input = node.querySelector('input')!; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'D:/other'); input.dispatchEvent(new Event('input', { bubbles: true })); });
  expect(node.querySelector('[data-testid="data-conversation"]')).toBeNull(); expect(harnessClient.updateSession).not.toHaveBeenCalled();
});
