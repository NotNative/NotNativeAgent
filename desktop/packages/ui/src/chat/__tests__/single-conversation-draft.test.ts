// SPDX-License-Identifier: Apache-2.0
/** @vitest-environment jsdom */
import { beforeEach, expect, it } from 'vitest';
import { useConversationDraftStore } from '../../stores/useConversationDraftStore.ts';
import { __resetDraftStoreForTests, readDraft, saveDraft } from '../drafts.ts';
import { visibleConversationDrafts } from '../visible-conversation-drafts.ts';
import { initializeRuntimeEndpoint } from '../../lib/runtime-switch.ts';
initializeRuntimeEndpoint({ apiBaseUrl: 'http://127.0.0.1:61776', runtimeKey: 'local' });
beforeEach(() => {
  localStorage.clear(); __resetDraftStoreForTests();
  useConversationDraftStore.setState({ drafts: [], phase: 'local', error: null });
});
it('reuses one unfinished conversation across repeated clicks and workspace choices', () => {
  const first = useConversationDraftStore.getState().create('D:/one');
  saveDraft(first.directory, first.id, { ...readDraft(first.directory, first.id), text: 'Keep my prompt', attachments: [{ name: 'proof', mime: 'text/plain' }] });
  useConversationDraftStore.getState().update(first.id, { model: { providerID: 'local', modelID: 'model' }, reviewMode: 'unattended' });
  const second = useConversationDraftStore.getState().create('D:/two');
  expect(second.id).toBe(first.id); expect(second.directory).toBe('D:/two');
  expect(second.reviewMode).toBe('unattended'); expect(second.model?.providerID).toBe('local');
  expect(readDraft(second.directory, second.id).text).toBe('Keep my prompt');
  expect(readDraft(second.directory, second.id).attachments).toHaveLength(1);
  expect(useConversationDraftStore.getState().drafts).toHaveLength(1);
});
it('keeps a pending start in its original workspace', () => {
  const first = useConversationDraftStore.getState().create('D:/one');
  saveDraft(first.directory, first.id, { ...readDraft(first.directory, first.id), start: { operationId: 'op', messageID: 'msg', title: 'Pending', model: { providerID: 'local', modelID: 'model' }, reviewMode: 'auto-review', parts: [] } });
  expect(useConversationDraftStore.getState().create('D:/two')).toEqual(first);
});
it('coalesces old blank rows globally while preserving saved input and start recovery', () => {
  const base = useConversationDraftStore.getState().create('D:/one');
  const drafts = [base, { ...base, id: 'second', directory: 'D:/two' }, { ...base, id: 'input' }, { ...base, id: 'pins' }];
  saveDraft(base.directory, 'input', { ...readDraft(base.directory, 'input'), text: 'Do not discard' });
  saveDraft(base.directory, 'pins', { ...readDraft(base.directory, 'pins'), projectContextPins: { notes: ['note'], plans: [] } });
  expect(visibleConversationDrafts(drafts, base.id).map(row => row.id)).toEqual([base.id, 'input', 'pins']);
  expect(visibleConversationDrafts(drafts, 'input').map(row => row.id)).toEqual(['input', 'pins']);
  expect(drafts).toHaveLength(4);
});
