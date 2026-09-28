// SPDX-License-Identifier: Apache-2.0
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { __resetDraftStoreForTests, readDraft, saveDraft } from '../drafts.ts';
import { addTodoToCurrentChat, stageTodoInNewChat } from '../todo-chat-handoff.ts';
import { useSessionViewStore } from '../../sync/view-store.ts';
import { persistLastActiveSession, readLastActiveSession } from '../../sync/persist-cache.ts';

beforeEach(() => {
  __resetDraftStoreForTests();
  useSessionViewStore.setState({ activeDirectory: '/project', currentSessionId: 'existing' });
});
afterEach(() => { __resetDraftStoreForTests(); });

describe('new-chat todo handoff', () => {
  it('only acknowledges a current chat handoff when its composer accepts', () => {
    expect(addTodoToCurrentChat('/project', 'existing', 'Ship MVP')).toBe(false);
    const receiver = (event: Event): void => { (event as CustomEvent<{ accept: () => void }>).detail.accept(); };
    window.addEventListener('nnd:composer-fill', receiver);
    expect(addTodoToCurrentChat('/project', 'existing', 'Ship MVP')).toBe(true);
    window.removeEventListener('nnd:composer-fill', receiver);
  });
  it('appends to an existing draft without dropping attachments, queue, or session draft', () => {
    const attachment = { name: 'trace.txt', mime: 'text/plain', dataUrl: 'data:text/plain,trace' };
    const queued = { id: 'queued', text: 'later', mentions: [], attachments: [], queuedAt: 1 };
    saveDraft('/project', 'draft', { text: 'Existing idea', attachments: [attachment], autoAccept: true, queue: [queued] });
    saveDraft('/project', 'existing', { text: 'Ongoing work', attachments: [], autoAccept: false, queue: [] });
    persistLastActiveSession('existing', '/project');
    expect(readLastActiveSession()?.sessionId).toBe('existing');
    stageTodoInNewChat('/project', 'Ship MVP');
    expect(readDraft('/project', 'draft')).toMatchObject({
      text: 'Existing idea\n\nTodo: Ship MVP', attachments: [attachment], autoAccept: true, queue: [queued],
    });
    expect(readDraft('/project', 'existing').text).toBe('Ongoing work');
    expect(readLastActiveSession()).toBeNull();
    expect(useSessionViewStore.getState()).toMatchObject({ activeDirectory: '/project', currentSessionId: null });
  });
  it('does not leak a todo into another project draft', () => {
    saveDraft('/other', 'draft', { text: 'Other project', attachments: [], autoAccept: false, queue: [] });
    stageTodoInNewChat('/project', 'Scoped work');
    expect(readDraft('/project', 'draft').text).toBe('Todo: Scoped work');
    expect(readDraft('/other', 'draft').text).toBe('Other project');
  });
});
