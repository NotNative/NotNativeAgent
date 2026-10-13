// SPDX-License-Identifier: Apache-2.0
/**
 * First-party diff renderer behind the documented MODEL (docs 06 §5.1 data
 * model + §5.2 props table; delta E19 records the Pierre substitution).
 * Renders unified or side-by-side rows from FileDiffMetadata with hunk
 * separators, wrap toggle, and per-hunk action slots. No comments yet —
 * §10 lands with P6-3.
 */
import type { ReactNode } from 'react';
import type { DiffHunk, DiffRow, FileDiffMetadata } from '../../lib/git/diff-model.ts';
import { useI18n } from '../../lib/i18n/context.tsx';

export interface DiffViewerProps {
  fileName: string;
  fileDiff: FileDiffMetadata | null;
  original?: string | null;
  modified?: string | null;
  renderSideBySide: boolean;
  wrapLines: boolean;
  hunkActions?: (hunkIndex: number) => ReactNode;
}

export interface DiffSideRows {
  left: (DiffRow | null)[];
  right: (DiffRow | null)[];
}

/** Pair add/del rows for side-by-side (§5.5): a `del` lines up with the
 * next `add` when present, pairs otherwise pass null on the inner side. */
export function pairSideBySide(hunk: DiffHunk): DiffSideRows {
  const left: (DiffRow | null)[] = [];
  const right: (DiffRow | null)[] = [];
  let index = 0;
  while (index < hunk.rows.length) {
    const row = hunk.rows[index]!;
    if (row.kind === 'del' && hunk.rows[index + 1]?.kind === 'add') {
      left.push(row);
      right.push(hunk.rows[index + 1]!);
      index += 2;
      continue;
    }
    if (row.kind === 'add') {
      left.push(null);
      right.push(row);
      index += 1;
      continue;
    }
    if (row.kind === 'del') {
      left.push(row);
      right.push(null);
      index += 1;
      continue;
    }
    left.push(row);
    right.push(row);
    index += 1;
  }
  return { left, right };
}

export function DiffViewer({ fileName, fileDiff, original, modified, renderSideBySide, wrapLines, hunkActions }: DiffViewerProps): ReactNode {
  const { t } = useI18n();
  if (fileDiff === null) {
    if (original !== undefined && modified !== undefined) {
      return (
        <div className="p-3 text-xs text-muted-foreground" data-testid="diff-fallback">
          {t('diffUi.parseFallback')}
        </div>
      );
    }
    return <div className="p-3 text-xs text-status-error">{t('diffUi.failedToLoad')}</div>;
  }
  const holdClass = wrapLines ? 'whitespace-pre-wrap break-all' : 'whitespace-pre overflow-x-auto';
  return (
    <div className="flex flex-col gap-3 font-mono text-[11px] leading-5" data-testid="diff-viewer" data-file={fileName}>
      {fileDiff.hunks.map((hunk, hunkIndex) => (
        <section key={hunkIndex} className="rounded border border-border/40">
          <header className="flex items-center gap-2 bg-interactive-hover/40 px-2 py-1 text-[10px] text-muted-foreground">
            <span className="font-mono">{hunk.header || `@@ -${hunk.oldStart} +${hunk.newStart} @@`}</span>
            {hunkActions?.(hunkIndex) ?? null}
          </header>
          {renderSideBySide ? <SideBySide hunk={hunk} holdClass={holdClass} /> : <Unified hunk={hunk} holdClass={holdClass} />}
        </section>
      ))}
    </div>
  );
}

function Unified({ hunk, holdClass }: { hunk: DiffHunk; holdClass: string }): ReactNode {
  return (
    <div className="grid grid-cols-[3rem_1fr] font-mono" data-side="unified">
      {hunk.rows.map((row, index) => (
        <div key={index} className={`flex ${rowClassOf(row.kind)}`}>
          <span className="w-12 shrink-0 select-none text-right text-muted-foreground">{lineNumberFor(hunk, index)}</span>
          <span className={`flex-1 ${holdClass}`}>{row.text || ' '}</span>
        </div>
      ))}
    </div>
  );
}

function SideBySide({ hunk, holdClass }: { hunk: DiffHunk; holdClass: string }): ReactNode {
  const { left, right } = pairSideBySide(hunk);
  return (
    <div className="grid grid-cols-2 font-mono" data-side="split">
      <div className="border-r border-border/40">
        {left.map((row, index) => (
          <div key={index} className={`flex ${row !== null ? rowClassOf(row.kind) : ''}`}>
            <span className={`flex-1 ${holdClass}`}>{row?.text ?? ' '}</span>
          </div>
        ))}
      </div>
      <div>
        {right.map((row, index) => (
          <div key={index} className={`flex ${row !== null ? rowClassOf(row.kind) : ''}`}>
            <span className={`flex-1 ${holdClass}`}>{row?.text ?? ' '}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function rowClassOf(kind: 'add' | 'del' | 'context'): string {
  return kind === 'add' ? 'bg-success/10 text-foreground' : kind === 'del' ? 'bg-error/10 text-foreground' : '';
}

function lineNumberFor(hunk: DiffHunk, rowIndex: number): string {
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  for (let index = 0; index < rowIndex; index += 1) {
    const row = hunk.rows[index]!;
    if (row.kind !== 'add') oldLine += 1;
    if (row.kind !== 'del') newLine += 1;
  }
  const row = hunk.rows[rowIndex]!;
  return row.kind === 'add' ? `${newLine}` : row.kind === 'del' ? `${oldLine}` : `${oldLine}`;
}
