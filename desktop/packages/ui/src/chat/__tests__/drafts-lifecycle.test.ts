// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { initializeRuntimeEndpoint } from '../../lib/runtime-switch.ts';
import { __resetDraftStoreForTests, draftKey, saveDraft, readDraft, flushDraftsForLifecycle } from '../drafts.ts';
initializeRuntimeEndpoint({ apiBaseUrl: 'http://127.0.0.1:12345', runtimeKey: 'native:here' });
beforeEach(() => { localStorage.clear(); __resetDraftStoreForTests(); });
afterEach(() => { vi.restoreAllMocks(); __resetDraftStoreForTests(); });
it('refuses lifecycle flush on storage failure, retains the unsent draft, and can retry it', () => {
  saveDraft('/work', 's1', { text: 'keep unsent text', attachments: [], queue: [] });
  const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Full', 'QuotaExceededError'); });
  expect(() => flushDraftsForLifecycle()).toThrow('The service was not stopped');
  expect(readDraft('/work', 's1').text).toBe('keep unsent text');
  write.mockRestore(); flushDraftsForLifecycle();
  expect(JSON.parse(localStorage.getItem('nnd.draft.v1')!)[draftKey('/work', 's1')].text).toBe('keep unsent text');
});
