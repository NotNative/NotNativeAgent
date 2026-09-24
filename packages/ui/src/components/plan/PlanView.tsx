// SPDX-License-Identifier: Apache-2.0
/**
 * PlanView (doc 06 §8, P6-3 subset): document resolution (file target →
 * session paths `.opencode/plans/<created>-<slug>.md`; saved project plans =
 * P9 routes), 350 ms autosave through the plan save queue with close/switch
 * flush and revision dedup, textarea host with the same inline-comment
 * contract (source 'plan'; input widgets = P6-3b), Improve/Implement send
 * dialogs land with the send-family surfaces (P8) — registered.
 * §8.1 key = JSON['plan-file', runtimeKey, path]; the §8.2 drop-on-runtime-
 * switch rides the queue's LIVE runtime source (the key embeds the runtime,
 * so a stale per-key binding alone could never fire the drop).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPlanSaveQueue, PLAN_AUTOSAVE_DEBOUNCE_MS, planEpochFor, sessionPlanPath } from '../../lib/plan/save-queue.ts';
import { readFileText, writeFileText } from '../../lib/files/api.ts';
import { getRuntimeKey } from '../../lib/runtime-switch.ts';
import { useI18n } from '../I18nProvider.tsx';
import { beginCommentFromSelection, InlineComments } from '../comments/InlineComments.tsx';
import { useInlineCommentController } from '../comments/controller.ts';
import { useActiveSessionKey } from '../comments/useActiveSessionKey.ts';
import type { LineRange } from '../../lib/inline-comments.ts';

const planQueue = createPlanSaveQueue();
planQueue.bindRuntimeSource(() => getRuntimeKey()); // §8.2: the drop check reads the LIVE runtime

export interface PlanBuffer {
  directory: string;
  docPath: string;
  runtimeKey: string;
  content: string; // §8.3: synchronous per-document buffer — a flush never crosses documents
}

interface PlanRefs {
  buffer: { current: PlanBuffer | null };
  baseline: { current: string };
  scheduled: { current: string };
  revision: { current: number };
  timer: { current: number | null };
  loadSeq: { current: number };
}

interface PlanUi {
  setDocPath: (path: string | null) => void;
  setContent: (text: string) => void;
  setDirty: (dirty: boolean) => void;
  setSaveError: (error: string | null) => void;
}

function documentKey(path: string, runtimeKey: string): string {
  return JSON.stringify(['plan-file', runtimeKey, path]);
}

/** §8.5 session-plan path with a deterministic v1 epoch (full session
 * resolution is registered): the plan authored on save is found again. */
export function sessionPlanFile(directory: string, runtimeKey: string): { path: string; key: string } {
  const path = sessionPlanPath(directory, planEpochFor(directory), 'plan');
  return { path, key: documentKey(path, runtimeKey) };
}

function firstHeading(content: string): string {
  for (const row of content.split('\n')) {
    if (row.startsWith('# ')) return row.slice(2).trim();
  }
  return '';
}

/** One queued attempt: the write REJECTS on failure (§8.2 clears the
 * watermark while-latest; the caller may then retry the exact revision). */
function flushPlanBuffer(buffer: PlanBuffer, revision: number, content: string): Promise<void> {
  return planQueue.schedule(documentKey(buffer.docPath, buffer.runtimeKey), revision, async () => {
    await writeFileText(buffer.directory, buffer.docPath, content);
  });
}

/** §8.3 scheduleSave: revision watermark discipline over the buffer — the
 * same content never re-schedules until its attempt FAILS (exact-revision
 * retry, §8.2); a settled attempt advances the save baseline. */
function planFlush(refs: PlanRefs, onSettle: (error: string | null) => void): void {
  const buffer = refs.buffer.current;
  if (buffer === null) return;
  const attempt = buffer.content;
  const revision = refs.revision.current;
  if (attempt === refs.scheduled.current) return;
  const next = revision + 1;
  refs.revision.current = next;
  refs.scheduled.current = attempt;
  flushPlanBuffer(buffer, next, attempt).then(
    () => {
      refs.baseline.current = attempt;
      onSettle(null);
    },
    (error: unknown) => {
      if (refs.revision.current === next) { // failed while still latest: reopen the revision
        refs.revision.current = revision;
        refs.scheduled.current = '';
      }
      onSettle(error instanceof Error ? error.message : String(error));
    },
  );
}

function planStopTimer(refs: PlanRefs): void {
  if (refs.timer.current !== null) {
    window.clearTimeout(refs.timer.current);
    refs.timer.current = null;
  }
}

function planApplyLoaded(refs: PlanRefs, ui: PlanUi, directory: string, runtimeKey: string, path: string, text: string): void {
  refs.baseline.current = text;
  refs.scheduled.current = text; // unchanged content skips the redundant first write
  refs.revision.current = 0;
  refs.buffer.current = { directory, docPath: path, runtimeKey, content: text };
  ui.setDocPath(path); ui.setContent(text); ui.setDirty(false); ui.setSaveError(null);
}

function planOnEdit(refs: PlanRefs, ui: PlanUi, settle: (error: string | null) => void, next: string): void {
  const buffer = refs.buffer.current;
  if (buffer === null) return;
  buffer.content = next; // §8.3 synchronous buffer tracking
  ui.setContent(next);
  ui.setDirty(next !== refs.baseline.current);
  planStopTimer(refs); // §8.3: one debounce per edit burst
  refs.timer.current = window.setTimeout(() => planFlush(refs, settle), PLAN_AUTOSAVE_DEBOUNCE_MS);
}

/** §8.1/§8.3 document load: epoch-keyed fresh read with a seq guard so a
 * stale load loses the switch race; switch/unmount flushes the OLD buffer
 * synchronously (never crosses documents). */
function usePlanDocumentLoad(refs: PlanRefs, ui: PlanUi, settle: (error: string | null) => void, directory: string, runtimeKey: string, visible: boolean): void {
  useEffect(() => {
    if (!visible) return undefined;
    const seq = refs.loadSeq.current + 1;
    refs.loadSeq.current = seq;
    void (async (): Promise<void> => {
      const { path, key } = sessionPlanFile(directory, runtimeKey);
      await planQueue.pendingFor(key); // §8.1: a re-open reads post-write state
      planQueue.reset(key); // fresh revision series after the fresh load
      const text = await readFileText(directory, path).catch(() => ''); // missing plan: blank, authored on save
      if (seq !== refs.loadSeq.current) return; // stale load lost the switch race
      planApplyLoaded(refs, ui, directory, runtimeKey, path, text);
    })();
    return () => {
      planStopTimer(refs); // §8.3: switch/unmount clears the stale debounce…
      planFlush(refs, settle); // …and flushes the OLD buffer synchronously (never crossed)
    };
  }, [directory, visible, runtimeKey, refs, ui, settle]);
}

function PlanHeader(props: { title: string; fileLabel: string; dirty: boolean; saveError: string | null; statusSaveFailed: string; statusUnsaved: string; statusSaved: string; saveNow: string; onSaveNow: () => void }): ReactNode {
  const { title, fileLabel, dirty, saveError, statusSaveFailed, statusUnsaved, statusSaved, saveNow, onSaveNow } = props;
  return (
    <header className="flex min-w-0 items-center gap-2">
      <span className="min-w-0 truncate text-sm font-medium text-foreground" title={title}>{title}</span>
      <span className="min-w-0 truncate text-[10px] text-muted-foreground" title={fileLabel}>{fileLabel}</span>
      <span className="ml-auto shrink-0 text-[10px] text-muted-foreground" data-testid="plan-save-status" title={saveError ?? undefined}>
        {saveError !== null ? statusSaveFailed : dirty ? statusUnsaved : statusSaved}
      </span>
      <button type="button" className="shrink-0 rounded border border-border/60 px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground" onClick={onSaveNow}>
        {saveNow}
      </button>
    </header>
  );
}

interface PlanViewProps { directory: string; visible: boolean }

export function PlanView(props: PlanViewProps): ReactNode {
  const { directory, visible } = props;
  const { t } = useI18n();
  const runtimeKey = getRuntimeKey();
  const [docPath, setDocPath] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const planTextRef = useRef<HTMLTextAreaElement | null>(null);
  const refs: PlanRefs = useRef({
    buffer: { current: null }, baseline: { current: '' }, scheduled: { current: '' },
    revision: { current: 0 }, timer: { current: null }, loadSeq: { current: 0 },
  } satisfies PlanRefs).current;
  const ui = useMemo<PlanUi>(() => ({ setDocPath, setContent, setDirty, setSaveError }), []); // setState identities are stable
  const settle = useCallback((error: string | null): void => {
    setSaveError(error);
    if (error === null) setDirty(refs.buffer.current !== null && refs.buffer.current.content !== refs.baseline.current);
  }, [refs]);

  usePlanDocumentLoad(refs, ui, settle, directory, runtimeKey, visible);

  const title = useMemo(() => firstHeading(content) || t('plan.title'), [content, t]);
  const label = docPath?.split(/[\\/]/u).pop() ?? t('plan.file');
  const readSelection = useCallback((): { start: number; end: number } | null => readPlanSelection(planTextRef.current, content), [content]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 px-3 pb-3 pt-2" data-testid="plan-view" data-plan-host="">
      <PlanHeader
        title={title} fileLabel={label} dirty={dirty} saveError={saveError}
        statusSaveFailed={t('plan.saveFailed')} statusUnsaved={t('plan.unsaved')}
        statusSaved={t('plan.saved')} saveNow={t('plan.save')}
        onSaveNow={() => planFlush(refs, settle)}
      />
      <textarea
        ref={planTextRef}
        className="min-h-0 flex-1 resize-none rounded-lg border border-border/60 bg-card/40 p-3 font-mono text-xs text-foreground outline-none"
        style={{ whiteSpace: 'pre-wrap' }}
        value={content}
        spellCheck={false}
        data-language="markdown"
        onChange={(event) => planOnEdit(refs, ui, settle, event.target.value)}
      />
      <PlanCommentBar content={content} directory={directory} fileLabel={label} readSelection={readSelection} />
    </div>
  );
}

function readPlanSelection(field: HTMLTextAreaElement | null, content: string): { start: number; end: number } | null {
  if (field === null) return null;
  const start = field.selectionStart ?? 0;
  const end = field.selectionEnd ?? 0;
  if (start >= end || end > content.length) return null;
  return { start, end };
}

interface PlanCommentBarProps {
  content: string;
  directory: string;
  fileLabel: string;
  readSelection: () => { start: number; end: number } | null;
}

function PlanCommentBar(props: PlanCommentBarProps): ReactNode {
  const sessionKey = useActiveSessionKey();
  const comments = useInlineCommentController({
    directory: props.directory, sessionKey, source: 'plan', fileLabel: props.fileLabel, language: 'markdown', content: props.content,
  } as const);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex justify-end">
        <CommentBeginButton
          onClick={() => beginCommentFromSelection(props.content, props.readSelection(), comments.begin)}
        />
      </div>
      <InlineComments controller={comments} hostId="plan" />
    </div>
  );
}

function CommentBeginButton(props: { onClick: () => void }): ReactNode {
  const { t } = useI18n();
  return (
    <button
      type="button"
      className="rounded border border-border/50 bg-card/60 px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
      onClick={props.onClick}
      data-testid="plan-add-comment"
    >
      {t('comments.add')}
    </button>
  );
}
