// SPDX-License-Identifier: Apache-2.0
/**
 * WorktreesView (doc 06 section 7) v1 with the live topology: list per-
 * worktree cards (branch, path, reorder) + a New Worktree creation dialog
 * (mode 'new' through /api/git/worktrees #63; session bootstrap/rollback
 * semantics are the session domain, registered) + per-card Remove (#66,
 * local branch kept unless the caller opts in). Ordering store per §7
 * (localStorage mobile-worktree-order): known paths first, unknown appended
 * alphabetically. On a list failure the previous topology stays on screen;
 * creation failure toasts the exact string "Failed to create worktree".
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { create } from 'zustand';
import { toast } from 'sonner';
import { useI18n, type I18nApi } from '../I18nProvider.tsx';
import { createWorktree, listWorktrees, removeWorktree, type GitWorktreeEntry, type WorktreeCreatePayload } from '../../lib/server-api.ts';

export interface WorktreeCard {
  path: string;
  branch: string;
}

interface WorktreeOrderState {
  orders: Record<string, string[]>;
  orderFor: (projectRoot: string) => string[];
  setOrder: (projectRoot: string, paths: string[]) => void;
  /** test-only: wipes the order map and its localStorage persistence. */
  __resetForTests: () => void;
}

const ORDER_KEY = 'mobile-worktree-order'; // doc 06 §7: documented persistence name
const NO_ORDER: string[] = []; // stable getSnapshot: selector must not allocate a fresh array (zustand v5)

export const useWorktreeOrderStore = create<WorktreeOrderState>((set, getState) => ({
  orders: hydrateOrders(),
  orderFor: (projectRoot: string) => getState().orders[projectRoot] ?? NO_ORDER,
  setOrder: (projectRoot, paths) => set((state) => {
    const orders = { ...state.orders, [projectRoot]: paths };
    saveOrders(orders);
    return { orders };
  }),
  __resetForTests: () => set({ orders: {} }),
}));

function hydrateOrders(): Record<string, string[]> {
  try {
    const raw = localStorage.getItem(ORDER_KEY);
    if (raw === null) return {};
    return JSON.parse(raw) as Record<string, string[]>;
  } catch {
    return {};
  }
}

function saveOrders(orders: Record<string, string[]>): void {
  try {
    localStorage.setItem(ORDER_KEY, JSON.stringify(orders));
  } catch { /* private mode: order stays session-only */ }
}

/** section 7: known paths first in stored order, unknown appended. */
export function orderWorktrees(orderedPaths: string[], worktrees: WorktreeCard[]): WorktreeCard[] {
  const indexOf = new Map(orderedPaths.map((path, index) => [path, index]));
  const known = worktrees.filter((entry) => indexOf.has(entry.path))
    .sort((a, b) => (indexOf.get(a.path) ?? 0) - (indexOf.get(b.path) ?? 0));
  const unknown = worktrees.filter((entry) => !indexOf.has(entry.path))
    .sort((a, b) => a.path.localeCompare(b.path));
  return [...known, ...unknown];
}

function worktreeCardsOf(entries: GitWorktreeEntry[] | null): WorktreeCard[] {
  if (entries === null) return [];
  return entries.map((entry) => ({
    path: entry.path,
    branch: entry.branch ?? (entry.detached ? `HEAD (${(entry.head ?? '').slice(0, 7)})` : 'HEAD'),
  }));
}

interface WorktreesViewProps {
  projectRoot: string;
  onClose: () => void;
}

export function WorktreesView({ projectRoot, onClose }: WorktreesViewProps): ReactNode {
  const { t } = useI18n();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);
  const topology = useWorktreeTopology(projectRoot);
  const removeEntry = useWorktreeRemove(projectRoot, t, topology.refresh);

  const createWorktreeOnServer = useCallback(async (payload: WorktreeCreatePayload): Promise<boolean> => {
    const created = await createWorktree(projectRoot, payload);
    if (!created.ok) {
      toast.error(t('worktrees.createFailed'));
      return false;
    }
    await topology.refresh();
    return true;
  }, [projectRoot, t, topology.refresh]);

  const submitCreate = useCallback(async (payload: WorktreeCreatePayload): Promise<void> => {
    if (createBusy) return; // single-flight: the pending POST owns the button
    setCreateBusy(true);
    try {
      const created = await createWorktreeOnServer(payload);
      if (created) setDialogOpen(false);
    } finally {
      setCreateBusy(false);
    }
  }, [createBusy, createWorktreeOnServer]);

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40" data-testid="worktrees-view">
      <div className="flex max-h-[85vh] w-[640px] max-w-[92vw] flex-col rounded-xl border border-border/60 bg-background p-4 shadow-2xl">
        <header className="mb-2 flex items-center gap-2">
          <span className="text-sm font-medium text-foreground">{t('worktrees.title')}</span>
          <button type="button" className="ml-auto rounded px-2 py-1 text-muted-foreground hover:text-foreground" onClick={onClose} data-testid="worktrees-close">X</button>
        </header>
        <div className="flex items-center gap-2">
          <button type="button" className="self-start rounded bg-primary/20 px-3 py-1 text-xs text-primary hover:bg-primary/30" onClick={() => setDialogOpen(true)} data-testid="worktrees-new">
            {t('worktrees.new')}
          </button>
          {topology.listError !== null ? <span className="text-[10px] text-status-error">{topology.listError}</span> : null}
        </div>
        <WorktreeList cards={topology.cards} entries={topology.entries} onMove={topology.onMove} onRemove={(path) => void removeEntry(path)} emptyLabel={t('worktrees.empty')} showEmpty={topology.entries !== null} />
      </div>
      {dialogOpen ? (
        <WorktreeCreateDialog
          title={t('worktrees.new')}
          busyLabel={t('worktrees.creating')}
          branchLabel={t('worktrees.branch')}
          startLabel={t('worktrees.start')}
          nameLabel={t('worktrees.name')}
          submitLabel={t('worktrees.create')}
          cancelLabel={t('comments.cancel')}
          busy={createBusy}
          onSubmit={(payload) => void submitCreate(payload)}
          onCancel={() => setDialogOpen(false)}
        />
      ) : null}
    </div>
  );
}

/** The live worktree topology for one project root: order-store-backed card
 * list, refresh with a sequence guard (only the newest response may apply)
 * and the keep-last-topology rule (doc 03 #61: list failure keeps the cards). */
function useWorktreeTopology(projectRoot: string): {
  entries: GitWorktreeEntry[] | null;
  listError: string | null;
  cards: WorktreeCard[];
  refresh: () => Promise<void>;
  onMove: (path: string, delta: number) => void;
} {
  const { t } = useI18n();
  const ordered = useWorktreeOrderStore((state) => state.orderFor(projectRoot));
  const setOrder = useWorktreeOrderStore((state) => state.setOrder);
  const [entries, setEntries] = useState<GitWorktreeEntry[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const refreshSeq = useRef(0); // only the newest refresh (create/remove race) may apply

  const refresh = useCallback(async (): Promise<void> => {
    const seq = refreshSeq.current + 1;
    refreshSeq.current = seq;
    const listed = await listWorktrees(projectRoot);
    if (seq !== refreshSeq.current) return; // a newer refresh owns the view now
    if (listed === null) {
      setListError(t('common.error'));
      return; // keep the last topology on the screen (doc 03 #61 rule)
    }
    setListError(null);
    setEntries(listed);
  }, [projectRoot, t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const cards = useMemo(() => orderWorktrees(ordered, worktreeCardsOf(entries)), [ordered, entries]);
  const onMove = useCallback((path: string, delta: number): void => {
    const paths = cards.map((entry) => entry.path);
    const index = paths.indexOf(path);
    const swap = index + delta;
    if (index < 0 || swap < 0 || swap >= paths.length) return;
    [paths[index], paths[swap]] = [paths[swap]!, paths[index]!];
    setOrder(projectRoot, paths);
  }, [cards, projectRoot, setOrder]);

  return { entries, listError, cards, refresh, onMove };
}

/** Per-linked-card Remove (doc 03 #66): DELETE with the local branch kept;
 * one removal at a time, failure toasts, success refreshes the topology. */
function useWorktreeRemove(projectRoot: string, t: I18nApi['t'], refresh: () => Promise<void>): (path: string) => Promise<void> {
  const removingPath = useRef<string | null>(null); // remove single-flight: a second click must not double-DELETE

  return useCallback(async (path: string): Promise<void> => {
    if (removingPath.current !== null) return; // one DELETE per path at a time
    removingPath.current = path;
    try {
      const removed = await removeWorktree(projectRoot, path, false);
      if (!removed.ok) {
        toast.error(t('worktrees.removeFailed'));
        return;
      }
      await refresh();
    } finally {
      removingPath.current = null;
    }
  }, [projectRoot, t, refresh]);
}

interface WorktreeListProps {
  cards: WorktreeCard[];
  entries: GitWorktreeEntry[] | null;
  onMove: (path: string, delta: number) => void;
  onRemove: (path: string) => void;
  emptyLabel: string;
  showEmpty: boolean;
}

function WorktreeList({ cards, entries, onMove, onRemove, emptyLabel, showEmpty }: WorktreeListProps): ReactNode {
  const { t } = useI18n();
  return (
    <div className="mt-2 flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
      {cards.map((card) => {
        const entry = entries?.find((candidate) => samePath(candidate.path, card.path));
        return (
          <div key={card.path} className="flex min-h-9 items-center gap-2 rounded px-2 hover:bg-interactive-hover/30" data-testid="worktree-card">
            <span className="min-w-0 flex-1 truncate text-xs text-foreground" title={card.path}>{card.path}</span>
            <span className="rounded bg-interactive-selection/40 px-2 py-0.5 text-[10px] text-foreground">{card.branch}</span>
            <button type="button" aria-label="Move up" className="rounded px-1 text-muted-foreground hover:text-foreground" onClick={() => onMove(card.path, -1)}>&#8593;</button>
            <button type="button" aria-label="Move down" className="rounded px-1 text-muted-foreground hover:text-foreground" onClick={() => onMove(card.path, 1)}>&#8595;</button>
            {entry?.linked === true ? (
              <button type="button" className="rounded px-1 text-[10px] text-muted-foreground hover:text-status-error" data-testid="worktree-remove" onClick={() => onRemove(card.path)}>
                {t('worktrees.remove')}
              </button>
            ) : null}
          </div>
        );
      })}
      {cards.length === 0 && showEmpty ? <div className="px-2 py-3 text-xs text-muted-foreground">{emptyLabel}</div> : null}
    </div>
  );
}

interface CreateDialogProps {
  title: string;
  branchLabel: string;
  nameLabel: string;
  startLabel: string;
  submitLabel: string;
  cancelLabel: string;
  busyLabel: string;
  busy?: boolean;
  onSubmit: (payload: WorktreeCreatePayload) => void;
  onCancel: () => void;
}

function WorktreeCreateDialog(props: CreateDialogProps): ReactNode {
  const [branch, setBranch] = useState('');
  const [name, setName] = useState('');
  const [startRef, setStartRef] = useState('');
  const submit = (): void => {
    if (props.busy === true) return; // a pending POST owns the button (single-flight)
    if (branch.trim().length === 0) return;
    props.onSubmit({
      mode: 'new',
      branchName: branch.trim(),
      worktreeName: name.trim() === '' ? undefined : name.trim(),
      startRef: startRef.trim() === '' ? undefined : startRef.trim(),
    });
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" data-testid="worktree-create-dialog">
      <div className="flex w-[420px] max-w-[90vw] flex-col gap-2 rounded-xl border border-border/60 bg-background p-4 shadow-2xl">
        <span className="text-sm font-medium text-foreground">{props.title}</span>
        <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
          {props.branchLabel}
          <input
            className="rounded border border-border/50 bg-transparent px-2 py-1 text-xs text-foreground outline-none"
            value={branch}
            autoFocus
            data-testid="worktree-branch-input"
            onChange={(event) => setBranch(event.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
          {props.nameLabel}
          <input
            className="rounded border border-border/50 bg-transparent px-2 py-1 text-xs text-foreground outline-none"
            value={name}
            data-testid="worktree-name-input"
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
          {props.startLabel}
          <input
            className="rounded border border-border/50 bg-transparent px-2 py-1 text-xs text-foreground outline-none"
            value={startRef}
            data-testid="worktree-start-input"
            onChange={(event) => setStartRef(event.target.value)}
          />
        </label>
        <div className="flex items-center gap-2 pt-1">
          <button type="button" className="rounded bg-primary/20 px-3 py-1 text-xs text-primary hover:bg-primary/30" onClick={submit} data-testid="worktree-create-submit">
            {props.busy === true ? props.busyLabel : props.submitLabel}
          </button>
          <button type="button" className="rounded px-3 py-1 text-xs text-muted-foreground hover:text-foreground" onClick={props.onCancel}>
            {props.cancelLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function samePath(left: string, right: string): boolean {
  return left === right || left.replaceAll('/', '\\') === right.replaceAll('/', '\\');
}
