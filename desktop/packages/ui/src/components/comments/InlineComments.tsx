// SPDX-License-Identifier: Apache-2.0
/**
 * Inline comment widgets v1 (doc 06 §10.2) on the textarea hosts: the
 * new-comment input (`data-comment-input`, placeholder with the save
 * shortcut, "Lines {start}-{end}" range label, Save/Cancel) and the
 * per-draft card (`data-comment-card`, Edit/Delete). Line-anchored slot
 * widgets ride the render rails here until the CodeMirror swap (E20).
 */
import { type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { useI18n } from '../I18nProvider.tsx';
import { isMac } from '../../lib/platform.ts';
import { lineRangeFromOffsets, type LineRange } from '../../lib/inline-comments.ts';
import type { CommentDraft } from '../../lib/comments/drafts.ts';
import type { InlineCommentController } from './controller.ts';

/** Caret selection → line range comment begin (textarea-host v1; the
 * gutter-drag contract rides the CodeMirror swap, E20). The content the
 * selection lived in rides along so the controller freezes it as the comment's
 * snapshot (doc 06 section 10.2: the extraction source, even if the host's
 * content drifts while the input is open). */
export function beginCommentFromSelection(content: string, selection: { start: number; end: number } | null, begin: (range: LineRange, snapshot?: string) => void): void {
  if (selection === null) return;
  const range = lineRangeFromOffsets(content, selection.start, selection.end);
  if (range !== null) begin(range, content);
}

export function InlineComments({ controller, hostId }: { controller: InlineCommentController; hostId: string }): ReactNode {
  const cards = [...controller.drafts].sort((a, b) => a.startLine - b.startLine || a.createdAt.localeCompare(b.createdAt));
  return (
    <div className="flex shrink-0 flex-col gap-1 border-t border-border/40 px-3 py-1.5" data-testid={`${hostId}-comments`}>
      {controller.inputRange !== null ? (
        <InlineCommentInput controller={controller} inputId={`${hostId}-new-comment-input`} />
      ) : null}
      {cards.map((draft) => <InlineCommentCard key={draft.id} draft={draft} controller={controller} />)}
    </div>
  );
}

function InlineCommentInput({ controller, inputId }: { controller: InlineCommentController; inputId: string }): ReactNode {
  const { t } = useI18n();
  const saveHint = isMac() ? 'Mod+Enter' : 'Ctrl+Enter';
  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      controller.save();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      controller.cancel();
    }
  };
  return (
    <div className="flex flex-col gap-1 rounded border border-border/60 bg-card/70 p-2" data-comment-input="true" id={inputId} data-testid="comment-input">
      <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
        <span data-testid="comment-lines">{t('comments.lines', { start: controller.inputRange!.startLine + 1, end: controller.inputRange!.endLine + 1 })}</span>
      </div>
      <textarea
        className="min-h-14 resize-y rounded border border-border/50 bg-transparent p-2 font-mono text-xs text-foreground outline-none"
        value={controller.inputText}
        autoFocus
        placeholder={t('comments.placeholder', { shortcut: saveHint })}
        onChange={(event) => controller.setText(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="flex items-center gap-2">
        <button type="button" className="rounded bg-primary/20 px-2 py-0.5 text-[11px] text-primary hover:bg-primary/30" onClick={controller.save} data-testid="comment-save">
          {t('comments.save')}
        </button>
        <button type="button" className="rounded px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground" onClick={controller.cancel}>
          {t('comments.cancel')}
        </button>
      </div>
    </div>
  );
}

function InlineCommentCard({ draft, controller }: { draft: CommentDraft; controller: InlineCommentController }): ReactNode {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-1 rounded border border-border/40 bg-card/40 px-2 py-1.5" data-comment-card="true" data-testid="comment-card">
      <div className="flex items-center gap-2">
        <span className="text-[10px] text-muted-foreground">{t('comments.lines', { start: draft.startLine + 1, end: draft.endLine + 1 })}</span>
        <button type="button" className="ml-auto rounded px-1 text-[10px] text-muted-foreground hover:text-foreground" onClick={() => controller.startEdit(draft)} data-testid="comment-edit">
          {t('comments.editComment')}
        </button>
        <button type="button" className="rounded px-1 text-[10px] text-muted-foreground hover:text-status-error" onClick={() => controller.remove(draft.id)} data-testid="comment-delete">
          {t('comments.deleteComment')}
        </button>
      </div>
      <div className="whitespace-pre-wrap text-xs text-foreground">{draft.text}</div>
    </div>
  );
}
