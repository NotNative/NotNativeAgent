// SPDX-License-Identifier: Apache-2.0
/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ConversationRenameDialog } from '../conversation-rename-dialog.tsx';
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ''; });
it('retains the entered name after a failed save, then closes on a successful retry', async () => {
  const save = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined); const close = vi.fn();
  const holder = document.createElement('div'); document.body.appendChild(holder); root = createRoot(holder);
  act(() => root.render(<ConversationRenameDialog title="Existing" save={save} close={close} />));
  const input = document.querySelector('input')!;
  act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Updated'); input.dispatchEvent(new Event('input', { bubbles: true })); });
  const submit = async () => { await act(async () => { document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await Promise.resolve(); }); };
  await submit(); expect(close).not.toHaveBeenCalled(); expect(input.value).toBe('Updated'); expect(document.querySelector('[role="alert"]')).toBeTruthy();
  await submit(); expect(save).toHaveBeenLastCalledWith('Updated'); expect(close).toHaveBeenCalledOnce();
});
