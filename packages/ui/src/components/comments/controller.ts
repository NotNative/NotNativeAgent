// SPDX-License-Identifier: Apache-2.0
/**
 * Inline comment controller (doc 06 §10.2 v1 on the textarea hosts): the
 * save path requires a target session (toast "Select a session to save
 * comment" when none), normalizes the range, extracts code from the SAME
 * content snapshot, appends (create focuses the chat input through the
 * composer-focus channel) or updates; a document-level mousedown cancels
 * ONLY while the input text is empty (comment inputs/cards and sonner
 * toasts are never outside targets). Draft persistence rides the §10.1
 * store (add/update/remove keyed by directory + live session slot).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  useInlineCommentDrafts, draftKeyFor, type CommentDraft, type DraftSource,
} from '../../lib/comments/drafts.ts';
import { extractLines, type LineRange } from '../../lib/inline-comments.ts';
import { useI18n, type I18nApi } from '../I18nProvider.tsx';
import { FOCUS_EVENT_NAME } from './focus-chat.ts';

const NO_DRAFTS: CommentDraft[] = [];

export interface InlineCommentConfig {
  directory: string;
  sessionKey: string | null;
  source: DraftSource;
  fileLabel: string;
  language: string;
  content: string;
}

export interface InlineCommentController {
  drafts: CommentDraft[];
  inputRange: LineRange | null;
  inputText: string;
  editingId: string | null;
  begin: (range: LineRange, snapshot?: string) => void;
  setText: (text: string) => void;
  startEdit: (draft: CommentDraft) => void;
  cancel: () => void;
  remove: (id: string) => void;
  save: () => void;
}

export function useInlineCommentController(config: InlineCommentConfig): InlineCommentController {
  const { directory, sessionKey, source, fileLabel, language, content } = config;
  const { t } = useI18n();
  const slotKey = sessionKey === null ? null : draftKeyFor(directory, sessionKey);
  const drafts = useInlineCommentDrafts(
    slotKey === null ? () => NO_DRAFTS : (state) => state.store[slotKey]?.drafts ?? NO_DRAFTS,
  );
  const store = useInlineCommentDrafts;
  const [inputRange, setInputRange] = useState<LineRange | null>(null);
  const [inputText, setInputText] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [inputSnapshot, setInputSnapshot] = useState<string | null>(null);
  const contentRef = useRef(content); // latest-value ref: the begin-time snapshot without a resubscribe
  contentRef.current = content;
  const inputTextRef = useRef(''); // latest-value ref so the mousedown listener is not resubscribed per keystroke
  inputTextRef.current = inputText;

  const clear = useCallback(() => {
    setInputRange(null);
    setInputText('');
    setEditingId(null);
    setInputSnapshot(null);
  }, []);

  const begin = useCallback((range: LineRange, snapshot?: string): void => {
    setInputRange(range);
    setInputText('');
    setEditingId(null);
    setInputSnapshot(snapshot ?? contentRef.current);
  }, []);

  const startEdit = useCallback((draft: CommentDraft): void => {
    setEditingId(draft.id);
    setInputRange({ startLine: draft.startLine, endLine: draft.endLine });
    setInputText(draft.text);
    setInputSnapshot(null); // the edit path never re-extracts (the stored code keeps its snapshot)
  }, []);

  const save = useCallback((): void => {
    commitComment({
      store, directory, sessionKey, source, fileLabel, content, language,
      inputRange, inputText, editingId, inputSnapshot, t, clear,
    });
  }, [directory, sessionKey, source, fileLabel, content, language, inputRange, inputText, editingId, inputSnapshot, store, t, clear]);

  const cancel = useCallback((): void => clear(), [clear]);
  const remove = useCallback((id: string): void => {
    if (sessionKey !== null) store.getState().removeDraft(directory, sessionKey, id);
  }, [store, directory, sessionKey]);

  useOutsideCommentCancel(inputRange, inputTextRef, clear);
  useSlotSwitchReset(directory, sessionKey, clear);

  return { drafts, inputRange, inputText, editingId, begin, setText: setInputText, startEdit, cancel, remove, save };
}

/** section 10.2 #6: outside mousedown cancels the input (except comment UI /
 * toasts) but only while the text is empty; the latest-value ref keeps the
 * listener subscribed exactly once per OPEN/CLOSE transition. */
function useOutsideCommentCancel(inputRange: LineRange | null, inputTextRef: { current: string }, clear: () => void): void {
  useEffect(() => {
    if (inputRange === null) return undefined;
    const handler = (event: Event): void => {
      if (isCommentUi(event.target)) return;
      if (inputTextRef.current.length === 0) clear(); // kept open on non-empty text (section 10.2 #6)
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [inputRange, clear, inputTextRef]);
}

/** Drafts are slot-scoped (directory + session): a slot switch must not carry
 * the open input (or an edit) into another slot's save target. */
function useSlotSwitchReset(directory: string, sessionKey: string | null, clear: () => void): void {
  useEffect(() => {
    clear();
  }, [directory, sessionKey, clear]);
}

interface CommentCommitContext {
  store: typeof useInlineCommentDrafts;
  directory: string;
  sessionKey: string | null;
  source: DraftSource;
  fileLabel: string;
  content: string;
  language: string;
  inputRange: LineRange | null;
  inputText: string;
  editingId: string | null;
  inputSnapshot: string | null;
  t: I18nApi['t'];
  clear: () => void;
}

function commitComment(context: CommentCommitContext): void {
  if (context.inputRange === null) return;
  if (context.sessionKey === null) {
    toast.error(context.t('comments.noSession'));
    return;
  }
  const text = context.inputText.trim();
  if (text.length === 0) return;
  const startLine = Math.min(context.inputRange.startLine, context.inputRange.endLine);
  const endLine = Math.max(context.inputRange.startLine, context.inputRange.endLine);
  if (context.editingId !== null) {
    context.store.getState().updateDraft(context.directory, context.sessionKey, context.editingId, text);
  } else {
    // doc 06 section 10.2: code comes from the SAME snapshot the selection lived
    // in (frozen at begin), never from content that drifted meanwhile.
    context.store.getState().addDraft(context.directory, context.sessionKey, {
      source: context.source, fileLabel: context.fileLabel, startLine, endLine,
      code: extractLines(context.inputSnapshot ?? context.content, startLine, endLine),
      language: context.language, text,
    });
    window.dispatchEvent(new CustomEvent(FOCUS_EVENT_NAME));
  }
  context.clear();
}

function isCommentUi(target: EventTarget | null): boolean {
  return target instanceof HTMLElement
    && (target.closest('[data-comment-input]') !== null
      || target.closest('[data-comment-card]') !== null
      || target.closest('[data-sonner-toast]') !== null);
}
