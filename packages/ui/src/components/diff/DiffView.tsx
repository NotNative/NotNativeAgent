// SPDX-License-Identifier: Apache-2.0
/**
 * DiffView (doc 06 §5.3–§5.8, §11.3, P6-2 v1 + SLICE-B): the diff band JSX
 * over the headless model in ./diff-view-model.ts — scope selector (§5.5),
 * stacked entries keyed PER SCOPE (`path|staged`), §5.4 default expansion
 * (6/6/4/2), the §5.6.c >500-large-diff gate with the explicit render-anyway
 * escape, scope-aware hunk buttons, and the §5.8 scroll anchor capture/
 * restore across refreshes.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { DiffViewer } from './DiffViewer.tsx';
import { statusSymbol } from '../../lib/git/api';
import { getRestoredDiffScrollTop } from '../../lib/git/diff-scroll-anchor.ts';
import {
  useDiffModel, LARGE_DIFF_GATE, statusSymbolOf,
  type DiffModel, type Scope, type StackEntry,
} from './diff-view-model';

interface AnchorPending {
  path: string;
  oldViewportOffset: number;
}

type AnchorPendingRef = { current: AnchorPending | null };

export function DiffView({ directory, visible }: { directory: string; visible: boolean }): ReactNode {
  const model = useDiffModel({ directory, visible });
  const [expandAll, setExpandAll] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const anchorPendingRef: AnchorPendingRef = anchorPendingRefFactory();
  useAnchorRestore(containerRef, anchorPendingRef, model.entries.length);

  return (
    <div className="flex h-full min-h-0 gap-3 px-3 pb-3 pt-2" data-testid="diff-view">
      <Sidebar model={model} />
      <div ref={containerRef} className="min-w-0 flex-1 overflow-y-auto" data-testid="diff-scroll">
        <div className="mb-2 flex items-center gap-2 px-1">
          <button type="button" className="rounded bg-primary/20 px-2 py-0.5 text-[11px] text-primary disabled:opacity-40" disabled={model.inFlight !== null} onClick={() => void model.stageAll()}>Stage all changes</button>
          <button type="button" className="rounded border border-border/60 px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground" onClick={() => setExpandAll(!expandAll)}>Expand all</button>
        </div>
        {model.entries.map((item) => (
          <EntryRow
            key={`${item.entry.path}:${item.staged}`}
            model={{ ...model, isExpanded: (path: string) => model.isExpanded(path) || expandAll }}
            entry={item}
            containerRef={containerRef}
            anchorPendingRef={anchorPendingRef}
          />
        ))}
        {model.status !== null && model.status.files.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground">Working tree clean, no changes to display</div>
        ) : null}
      </div>
    </div>
  );
}

function anchorPendingRefFactory(): AnchorPendingRef {
  return { current: null };
}

function diffSectionElement(container: HTMLElement, path: string): HTMLElement | null {
  for (const section of container.querySelectorAll<HTMLElement>('[data-diff-section]')) {
    if (section.dataset.path === path) return section;
  }
  return null;
}

/** §5.8: an action captures the acted section's viewport offset; after the
 * refresh settles (two frames) the same section is re-aligned so the list
 * does not jump under the user. Missing sections leave the position alone. */
function useAnchorRestore(
  containerRef: React.RefObject<HTMLDivElement | null>,
  pendingRef: AnchorPendingRef,
  entryCount: number,
): void {
  useEffect(() => {
    const pending = pendingRef.current;
    const container = containerRef.current;
    if (pending === null || container === null) return undefined;
    let frames = 0;
    const tick = (): void => {
      frames += 1;
      if (frames < 2) {
        window.requestAnimationFrame(tick);
        return;
      }
      const section = diffSectionElement(container, pending.path);
      if (section !== null) {
        const viewportOffset = container.getBoundingClientRect().top;
        const currentTopOffset = section.getBoundingClientRect().top - viewportOffset;
        const maxScrollTop = container.scrollHeight - container.clientHeight;
        container.scrollTop = getRestoredDiffScrollTop(container.scrollTop, pending.oldViewportOffset, currentTopOffset, maxScrollTop);
      }
      pendingRef.current = null;
    };
    const handle = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(handle);
  }, [entryCount, containerRef, pendingRef]);
}

function captureAnchor(containerRef: React.RefObject<HTMLDivElement | null>, pendingRef: AnchorPendingRef, path: string): void {
  const container = containerRef.current;
  if (container === null) return;
  const section = diffSectionElement(container, path);
  if (section === null) return;
  const viewportOffset = container.getBoundingClientRect().top;
  pendingRef.current = { path, oldViewportOffset: section.getBoundingClientRect().top - viewportOffset };
}

function symbolColor(symbol: string): string {
  if (symbol === 'A') return 'var(--status-success)';
  if (symbol === 'D' || symbol === 'U') return 'var(--status-error)';
  if (symbol === 'M') return 'var(--status-warning)';
  return 'var(--status-info)';
}

function Sidebar({ model }: { model: DiffModel }): ReactNode {
  const scopes: Array<{ key: Scope; label: string }> = [
    { key: 'all', label: `All: ${model.counts.total}` },
    { key: 'working', label: `Working: ${model.counts.working}` },
    { key: 'staged', label: `Staged: ${model.counts.staged}` },
  ];
  return (
    <div className="w-64 shrink-0 rounded-lg border border-border/60 bg-card/40">
      <div className="flex flex-wrap gap-1 px-2 py-1.5" role="group" aria-label="Select change scope" data-testid="diff-scope-selector">
        {scopes.map((entry) => (
          <button
            key={entry.key}
            type="button"
            data-testid={`diff-scope-${entry.key}`}
            aria-pressed={model.scope === entry.key}
            className={`rounded-full border px-2 py-0.5 text-[11px] ${model.scope === entry.key ? 'border-primary/60 bg-primary/10 text-primary' : 'border-border/60 text-muted-foreground hover:text-foreground'}`}
            onClick={() => model.setScope(entry.key)}
          >
            {entry.label}
          </button>
        ))}
      </div>
      <div className="flex max-h-[60vh] flex-col gap-0.5 px-1 overflow-y-auto">
        {model.entries.map((item) => (
          <button
            key={`${item.entry.path}:${item.staged}`}
            type="button"
            title={item.entry.path}
            className="truncate rounded px-2 py-1 text-left text-xs text-foreground hover:bg-interactive-hover/40"
            onClick={() => model.toggle(item.entry.path)}
          >
            <span className="mr-1 inline-block w-3 text-center" style={{ color: symbolColor(statusSymbol(item.entry)) }}>{statusSymbol(item.entry)}</span>
            {item.entry.path}
          </button>
        ))}
      </div>
    </div>
  );
}

interface EntryRowProps {
  model: DiffModel;
  entry: StackEntry;
  containerRef: React.RefObject<HTMLDivElement | null>;
  anchorPendingRef: AnchorPendingRef;
}

function EntryRow({ model, entry, containerRef, anchorPendingRef }: EntryRowProps): ReactNode {
  const diff = model.diffsOf(entry.entry.path, entry.staged);
  const changedLines = (diff?.metadata?.insertionCount ?? 0) + (diff?.metadata?.deletionCount ?? 0);
  const gated = changedLines > LARGE_DIFF_GATE;
  const isOpen = model.isExpanded(entry.entry.path);
  const busy = model.inFlight !== null;
  const staged = entry.staged;
  const symbol = statusSymbolOf(entry.entry);
  const overrides = model.renderAnywayOf(entry.entry.path, entry.staged);
  return (
    <section className="mb-2 rounded-lg border border-border/60 bg-card/40" data-testid="diff-entry" data-diff-section="" data-path={entry.entry.path} data-scope={staged ? 'staged' : 'working'}>
      <header className="flex items-center gap-2 px-3 py-1.5">
        <button type="button" className="min-w-0 flex-1 truncate text-left text-xs text-foreground" title={entry.entry.path} onClick={() => model.toggle(entry.entry.path)}>
          <span className="mr-1 inline-block w-3 text-center" style={{ color: symbolColor(symbol) }}>{symbol}</span>
          {entry.entry.path}
        </button>
        <span className="text-[10px] text-muted-foreground">{staged ? 'staged' : 'working'}</span>
        <button type="button" disabled={busy} className="rounded border border-border/60 px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground" data-testid="diff-entry-stage-toggle" onClick={() => void model.stageToggle(entry.entry, staged)}>
          {staged ? 'Unstage' : 'Stage'}
        </button>
      </header>
      {isOpen && gated && !overrides ? (
        <div className="p-3 text-xs text-muted-foreground" data-testid="diff-large-gate">
          {`Large diff (${changedLines} changed lines)`} — rendering may be slow.
          <button type="button" className="ml-2 rounded border border-border/60 px-2 py-0.5 text-[11px] text-foreground hover:text-primary" data-testid="diff-render-anyway" onClick={() => model.renderAnyway(entry.entry.path, entry.staged)}>Render anyway</button>
        </div>
      ) : isOpen ? (
        <div className="px-3 pb-2">
          {diff === undefined ? <div className="text-xs text-muted-foreground" data-testid="diff-loading">Loading...</div>
            : diff.error !== null ? <div className="text-xs text-status-error">{diff.error}</div>
              : diff.binary ? <div className="text-xs text-muted-foreground">Binary file — no diff available</div>
                : diff.metadata !== null && diff.metadata.hunks.length === 0 ? (
                  <div className="text-xs text-muted-foreground" data-testid="diff-no-hunks">No textual diff is available for this file.</div>
                ) : (
                  <DiffViewer
                    fileName={entry.entry.path}
                    fileDiff={diff.metadata}
                    renderSideBySide={false}
                    wrapLines={false}
                    hunkActions={(hunkIndex) => (
                      <span className="ml-auto flex gap-1">
                        {staged ? (
                          <HunkButton kind="unstage" index={hunkIndex} busy={busy} onClick={() => void model.hunkAction(entry.entry, staged, hunkIndex, 'unstage')} />
                        ) : (
                          <HunkButton kind="stage" index={hunkIndex} busy={busy} onClick={() => void model.hunkAction(entry.entry, staged, hunkIndex, 'stage')} />
                        )}
                        <HunkButton kind="discard" index={hunkIndex} busy={busy} onClick={() => {
                          captureAnchor(containerRef, anchorPendingRef, entry.entry.path);
                          void model.hunkAction(entry.entry, staged, hunkIndex, 'discard');
                        }} />
                      </span>
                    )}
                  />
                )}
        </div>
      ) : null}
    </section>
  );
}

interface HunkButtonProps {
  kind: 'stage' | 'unstage' | 'discard';
  index: number;
  busy: boolean;
  onClick: () => void;
}

function HunkButton({ kind, index, busy, onClick }: HunkButtonProps): ReactNode {
  return (
    <button
      type="button"
      disabled={busy}
      aria-label={`${kind} hunk ${index + 1}`}
      data-testid={`diff-hunk-${kind}-${index}`}
      className="rounded border border-border/60 px-1.5 text-[10px] text-muted-foreground hover:text-foreground"
      onClick={onClick}
    >
      {kind}
    </button>
  );
}
