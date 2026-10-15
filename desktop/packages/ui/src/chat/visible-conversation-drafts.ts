// SPDX-License-Identifier: Apache-2.0
import type { ConversationDraft } from '../stores/useConversationDraftStore.ts';
import { readDraft } from './drafts.ts';

/** Compatibility: coalesce legacy blank rows without deleting saved input or settings. */
export function visibleConversationDrafts(drafts: ConversationDraft[], active: string | null): ConversationDraft[] {
  const blank = (row: ConversationDraft) => {
    const value = readDraft(row.directory, row.id);
    return !value.start && !value.text.trim() && !value.attachments.length && !value.queue.length
      && !value.projectContextPins.notes.length && !value.projectContextPins.plans.length;
  };
  const keep = drafts.find(row => row.id === active) ?? drafts.filter(row => !blank(row)).at(-1) ?? drafts.at(-1);
  return drafts.filter(row => row.id === keep?.id || !blank(row));
}
