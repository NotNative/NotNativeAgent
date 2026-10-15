// SPDX-License-Identifier: Apache-2.0
/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from 'vitest';
import { pickWorkspaceDirectory } from '../workspace-picker.ts';

afterEach(() => {
  delete window.__NOTNATIVE_DESKTOP_INVOKE__;
});

it('returns the folder chosen through the desktop bridge', async () => {
  window.__NOTNATIVE_DESKTOP_INVOKE__ = vi.fn().mockResolvedValue({ ok: true, result: 'D:/chosen' });
  await expect(pickWorkspaceDirectory()).resolves.toBe('D:/chosen');
  expect(window.__NOTNATIVE_DESKTOP_INVOKE__).toHaveBeenCalledWith('desktop_pick_directory');
});

it('treats native dialog cancellation as no workspace', async () => {
  window.__NOTNATIVE_DESKTOP_INVOKE__ = vi.fn().mockResolvedValue({ ok: true, result: null });
  await expect(pickWorkspaceDirectory()).resolves.toBeNull();
});

it('reports the bridge error without opening a browser prompt', async () => {
  const prompt = vi.spyOn(window, 'prompt');
  window.__NOTNATIVE_DESKTOP_INVOKE__ = vi.fn().mockResolvedValue({ ok: false, error: 'dialog-unavailable' });
  await expect(pickWorkspaceDirectory()).rejects.toThrow('dialog-unavailable');
  expect(prompt).not.toHaveBeenCalled();
  prompt.mockRestore();
});
