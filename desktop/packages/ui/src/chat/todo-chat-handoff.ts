// SPDX-License-Identifier: Apache-2.0
/** Stage a project todo in the active or new chat composer. */
import { flushDraftsNow, readDraft, saveDraft } from './drafts.ts';
import { useSessionViewStore } from '../sync/view-store.ts';
import { persistLastActiveSession } from '../sync/persist-cache.ts';

export function addTodoToCurrentChat(directory: string, sessionKey: string, text: string): boolean {
  let accepted = false;
  window.dispatchEvent(new CustomEvent('nnd:composer-fill', { detail: {
    text: `Todo: ${text}`, append: true, directory, sessionKey,
    accept: () => { accepted = true; },
  } }));
  return accepted;
}

export function stageTodoInNewChat(directory: string, text: string): void {
  const draft = readDraft(directory, 'draft');
  const addition = `Todo: ${text}`;
  saveDraft(directory, 'draft', { ...draft, text: draft.text ? `${draft.text}\n\n${addition}` : addition });
  flushDraftsNow();
  // Match the sidebar's Open draft path: boot must not reopen an old session
  // over the Todo draft the operator explicitly chose to work on next.
  persistLastActiveSession(null, directory);
  useSessionViewStore.setState({ activeDirectory: directory, currentSessionId: null });
}
