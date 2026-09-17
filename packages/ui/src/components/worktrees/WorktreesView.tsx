// SPDX-License-Identifier: Apache-2.0
/**
 * WorktreesView (doc 06 section 7): list per-worktree cards (branch, path,
 * reorder affordance) + a New Worktree entry (creation dialog = P6-3b,
 * registered). Ordering store keeps a per-project ordered path array
 * (localStorage mobile-worktree-order, doc 06 §7); known paths first, unknown appended
 * alphabetically.
 */
import { useCallback, useMemo, type ReactNode } from 'react';
import { create } from 'zustand';
import { useI18n } from '../I18nProvider.tsx';

interface WorktreeCard {
  path: string;
  branch: string;
}

export type { WorktreeCard };

interface WorktreeOrderState {
  orders: Record<string, string[]>;
  orderFor: (projectRoot: string) => string[];
  setOrder: (projectRoot: string, paths: string[]) => void;
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

interface WorktreesViewProps {
  projectRoot: string;
  worktrees: WorktreeCard[];
  onClose: () => void;
}

export function WorktreesView({ projectRoot, worktrees, onClose }: WorktreesViewProps): ReactNode {
  const { t } = useI18n();
  const ordered = useWorktreeOrderStore((state) => state.orderFor(projectRoot));
  const setOrder = useWorktreeOrderStore((state) => state.setOrder);
  const cards = useMemo(() => orderWorktrees(ordered, worktrees), [ordered, worktrees]);
  const onMove = useCallback((path: string, delta: number): void => {
    const paths = cards.map((entry) => entry.path);
    const index = paths.indexOf(path);
    const swap = index + delta;
    if (index < 0 || swap < 0 || swap >= paths.length) return;
    [paths[index], paths[swap]] = [paths[swap]!, paths[index]!];
    setOrder(projectRoot, paths);
  }, [cards, projectRoot, setOrder]);

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40" data-testid="worktrees-view">
      <div className="flex max-h-[85vh] w-[640px] max-w-[92vw] flex-col rounded-xl border border-border/60 bg-background p-4 shadow-2xl">
        <header className="mb-2 flex items-center gap-2">
          <span className="text-sm font-medium text-foreground">{t('worktrees.title')}</span>
          <button type="button" className="ml-auto rounded px-2 py-1 text-muted-foreground hover:text-foreground" onClick={onClose}>X</button>
        </header>
        <button type="button" className="self-start rounded bg-primary/20 px-3 py-1 text-xs text-primary" disabled title="New Worktree dialog lands with the worktree creation flows (P6-3b)">
          {t('worktrees.new')}
        </button>
        <div className="mt-2 flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
          {cards.map((card, index) => (
            <div key={card.path} className="flex min-h-9 items-center gap-2 rounded px-2 hover:bg-interactive-hover/30" data-testid="worktree-card">
              <span className="min-w-0 flex-1 truncate text-xs text-foreground" title={card.path}>{card.path}</span>
              <span className="rounded bg-interactive-selection/40 px-2 py-0.5 text-[10px] text-foreground">{card.branch}</span>
              <button type="button" aria-label="Move up" className="rounded px-1 text-muted-foreground hover:text-foreground" onClick={() => onMove(card.path, -1)}>&#8593;</button>
              <button type="button" aria-label="Move down" className="rounded px-1 text-muted-foreground hover:text-foreground" onClick={() => onMove(card.path, 1)}>&#8595;</button>
              <span className="hidden text-[10px] text-muted-foreground">{`# ${index + 1}`}</span>
            </div>
          ))}
          {cards.length === 0 ? <div className="px-2 py-3 text-xs text-muted-foreground">{t('worktrees.empty')}</div> : null}
        </div>
      </div>
    </div>
  );}