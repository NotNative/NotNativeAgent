// SPDX-License-Identifier: Apache-2.0
/**
 * FileTree (doc 06 §2.1/§2.2/§2.3 minus status dots = P6-2): directory
 * children load through DirectoryRequests (one in-flight read per path,
 * force replaces, `clear()` on scope change), sorted dirs-first then
 * name.localeCompare; expanded directories re-read on the 8 s poller while
 * visible; load errors keep the previous snapshot + inline Refresh;
 * "Directory not found" collapses the path. Search (200 ms debounce) rides
 * /api/fs/search. Row menus + header actions expose the exact doc labels.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { DirectoryRequests } from '../../lib/files/directory-requests.ts';
import { listDirectory, searchWorkspaceFiles, type FsEntry } from '../../lib/files/api.ts';
import { TREE_SEARCH_DEBOUNCE_MS, DIRECTORY_POLL_INTERVAL_MS } from '../../lib/files/edit-support.ts';
import { useFilesViewTabsStore } from '../../lib/files/tabs-store.ts';
import { useI18n } from '../I18nProvider.tsx';

export interface FileNode { name: string; path: string; isDirectory: boolean }

type ChildrenByDir = Record<string, { nodes: FileNode[]; error?: string }>;

const requests = new DirectoryRequests();
const requestsClear = (): void => requests.clear();

/** §2.1/§2.3 full machine: state, loaders, effects. */
function useFileTreeModel(root: string, runtimeKey: string, visible: boolean, expanded: string[]): TreeModel {
  const [childrenByDir, setChildrenByDir] = useState<ChildrenByDir>({});
  const [rootError, setRootError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setResults] = useState<FileNode[] | null>(null);
  const model = useTreeLoaders({ root, runtimeKey, setChildrenByDir, setRootError });
  const scopeRef = useRef({ root, runtimeKey });
  const loadDirRef = useRef(model.loadDir);
  loadDirRef.current = model.loadDir;

  const inScope = useCallback((): boolean =>
    scopeRef.current.root === root && scopeRef.current.runtimeKey === runtimeKey, []);

  // §2.3: search debounce 200 ms → /api/fs/search.
  useEffect(() => {
    if (searchQuery.trim().length === 0) {
      setResults(null);
      return undefined;
    }
    const timer = window.setTimeout(() => {
      void searchWorkspaceFiles(root, searchQuery.trim(), 150).then((entries) => {
        if (!inScope()) return;
        setResults(toNodes(entries.filter((entry) => !entry.isDirectory)));
      });
    }, TREE_SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [searchQuery, root, inScope]);

  useTreeScopeEffects({ root, runtimeKey, visible, expanded, scopeRef, loadDirRef, setChildrenByDir, setRootError });

  return {
    childrenByDir,
    rootError,
    searchQuery,
    setSearchQuery,
    searchResults,
    loadDir: model.loadDir,
    refreshAll: model.refreshAll,
  };
}

interface TreeModel {
  childrenByDir: ChildrenByDir;
  rootError: string | null;
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  searchResults: FileNode[] | null;
  loadDir: (dir: string, force?: boolean) => Promise<FsEntry[] | null>;
  refreshAll: () => void;
}

interface TreeLoadersDeps {
  root: string;
  runtimeKey: string;
  setChildrenByDir: (update: (current: ChildrenByDir) => ChildrenByDir) => void;
  setRootError: (error: string | null) => void;
}

interface TreeLoaders {
  loadDir: (dir: string, force?: boolean) => Promise<FsEntry[] | null>;
  refreshAll: () => void;
}

/** §2.1 loaders: one in-flight read per key; completions publish through
 * applyChildren; "." failures land in the root error box. */
function useTreeLoaders(deps: TreeLoadersDeps): TreeLoaders {
  const { root, runtimeKey, setChildrenByDir, setRootError } = deps;
  const applyChildren = useCallback((dir: string, nodes: FileNode[] | null, error?: string): void => {
    setChildrenByDir((current) => {
      if (nodes === null) {
        const collapsed = { ...current }; // §2.1 step 6: collapse
        delete collapsed[dir];
        return collapsed;
      }
      return { ...current, [dir]: { nodes, error } };
    });
  }, [setChildrenByDir]);

  const loadDir = useCallback(async (dir: string, force = false): Promise<FsEntry[] | null> => {
    const live = scopeFor(root, runtimeKey);
    try {
      const entries = await requests.run(`${runtimeKey}::${root}::${dir}`, () => listDirectory(root, dir, false), force);
      if (live.root !== root || live.runtimeKey !== runtimeKey) return null;
      applyChildren(dir, toNodes(entries));
      return entries;
    } catch (error) {
      if (live.root !== root || live.runtimeKey !== runtimeKey) return null;
      const message = error instanceof Error ? error.message : String(error);
      if (dir === '.') {
        setRootError(message);
        return null;
      }
      applyChildren(dir, /not found/iu.test(message) ? null : [], message);
      return null;
    }
  }, [root, runtimeKey, applyChildren, setRootError]);

  const refreshAll = useCallback((): void => {
    requestsClear();
    void loadDir('.', true);
  }, [loadDir]);
  return { loadDir, refreshAll };
}

interface ScopeRecord {
  root: string;
  runtimeKey: string;
}

function scopeFor(root: string, runtimeKey: string): ScopeRecord {
  return { root, runtimeKey };
}



/** §2.1 step 8/9: scope identification, stale-clearing, freshness kick and
 * the 8 s expanded-dirs poller (live only; hidden tabs never consume IO). */
interface ScopeRecord {
  root: string;
  runtimeKey: string;
}

/** §2.1 step 8/9: scope identification, stale-clearing, freshness kick and
 * the 8 s expanded-dirs poller (live only; hidden tabs never consume IO). */
function useTreeScopeEffects(deps: {
  root: string;
  runtimeKey: string;
  visible: boolean;
  expanded: string[];
  scopeRef: { current: ScopeRecord };
  loadDirRef: { current: (dir: string, force?: boolean) => Promise<FsEntry[] | null> };
  setChildrenByDir: (update: (current: ChildrenByDir) => ChildrenByDir) => void;
  setRootError: (error: string | null) => void;
}): void {
  const { root, runtimeKey, visible, expanded, scopeRef, loadDirRef, setChildrenByDir, setRootError } = deps;
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const scopeKey = `${runtimeKey}::${root}`;

  // Scope identification sync: completions compare scopeRef; a change
  // clears the reports so stale completions never publish (§2.1 step 8).
  useEffect(() => {
    const changed = scopeRef.current.root !== root || scopeRef.current.runtimeKey !== runtimeKey;
    scopeRef.current = { root, runtimeKey };
    if (changed) {
      requestsClear();
      setChildrenByDir((current) => ({ ...current }));
      setRootError(null);
    }
    return () => requestsClear();
  }, [root, runtimeKey, scopeRef, setChildrenByDir, setRootError]);

  // Freshness pass on scope entry, then the 8 s poller (visibility-gated).
  useEffect(() => {
    if (!visible) return undefined;
    requestsClear();
    const kick = window.setTimeout(() => void loadDirRef.current('.', true), 0);
    const poll = window.setInterval(() => {
      if (document.hidden) return;
      if (!requests.has(`${scopeKey}::.`)) void loadDirRef.current('.', true);
      for (const dir of expandedRef.current) {
        if (requests.has(`${scopeKey}::${dir}`)) continue;
        void loadDirRef.current(dir, true);
      }
    }, DIRECTORY_POLL_INTERVAL_MS);
    return () => {
      window.clearTimeout(kick);
      window.clearInterval(poll);
    };
  }, [root, visible, scopeKey, loadDirRef]);
}

function toNodes(entries: FsEntry[]): FileNode[] {
  return entries
    .map((entry) => ({ name: entry.name, path: entry.path, isDirectory: Boolean(entry.isDirectory) }))
    .sort((a, b) => a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name) : a.isDirectory ? -1 : 1);
}

export function FileTree({ root, runtimeKey, visible, onOpenFile, onNewFile, onNewFolder, onRename, onDelete }: {
  root: string;
  runtimeKey: string;
  visible: boolean;
  onOpenFile: (path: string) => void;
  onNewFile: (parentDir: string) => void;
  onNewFolder: (parentDir: string) => void;
  onRename: (path: string) => void;
  onDelete: (path: string) => void;
}): ReactNode {
  const { t } = useI18n();
  const expanded = useFilesViewTabsStore((state) => state.byRoot[root]?.expandedPaths ?? []);
  const toggleExpandedPath = useFilesViewTabsStore((state) => state.toggleExpandedPath);
  const collapseAllExpandedPaths = useFilesViewTabsStore((state) => state.collapseAllExpandedPaths);
  const model = useFileTreeModel(root, runtimeKey, visible, expanded);
  const viewError = model.childrenByDir['.']?.error;

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="files-tree">
      <TreeToolbar searchQuery={model.searchQuery} setSearchQuery={model.setSearchQuery} onNewFile={() => onNewFile(root)} onNewFolder={() => onNewFolder(root)} onRefresh={model.refreshAll} onCollapseAll={() => collapseAllExpandedPaths(root)} />
      <div className="min-h-0 flex-1 overflow-y-auto px-1 py-1">
        {model.rootError !== null ? (
          <div className="rounded border border-status-error/40 p-2 text-xs text-status-error">
            {model.rootError}
            <button type="button" className="ml-2 underline" onClick={model.refreshAll}>{t('common.retry')}</button>
          </div>
        ) : null}
        {model.searchResults !== null ? (
          <TreeSearchResults nodes={model.searchResults} onOpenFile={onOpenFile} />
        ) : null}
        {model.searchResults === null ? (
          <TreeRows root={root} nodes={model.childrenByDir['.']?.nodes ?? []} error={viewError} expanded={expanded} childrenByDir={model.childrenByDir} onToggle={toggleExpandedPath} onRefreshDir={model.loadDir} onOpenFile={onOpenFile} onNewFile={onNewFile} onNewFolder={onNewFolder} onRename={onRename} onDelete={onDelete} />
        ) : null}
      </div>
    </div>
  );
}

function TreeToolbar({
  searchQuery, setSearchQuery, onNewFile, onNewFolder, onRefresh, onCollapseAll,
}: {
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  onNewFile: () => void;
  onNewFolder: () => void;
  onRefresh: () => void;
  onCollapseAll: () => void;
}): ReactNode {
  const { t } = useI18n();
  return (
    <div className="flex items-center gap-1 px-2 py-1.5">
      <input
        className="h-7 min-w-0 flex-1 rounded border border-border/50 bg-interactive-hover/30 px-2 text-xs text-foreground outline-none placeholder:text-muted-foreground"
        placeholder={t('filesView.tree.search.placeholder')}
        value={searchQuery}
        onChange={(event) => setSearchQuery(event.target.value)}
        aria-label={t('filesView.tree.search.placeholder')}
      />
      <button type="button" title={t('filesView.tree.actions.newFile')} aria-label={t('filesView.tree.actions.newFile')} className="rounded px-1.5 py-0.5 text-muted-foreground hover:text-foreground" onClick={onNewFile}>＋</button>
      <button type="button" title={t('filesView.tree.actions.newFolder')} aria-label={t('filesView.tree.actions.newFolder')} className="rounded px-1.5 py-0.5 text-muted-foreground hover:text-foreground" onClick={onNewFolder}>＋□</button>
      <button type="button" title={t('filesView.tree.actions.refresh')} aria-label={t('filesView.tree.actions.refresh')} className="rounded px-1.5 py-0.5 text-muted-foreground hover:text-foreground" onClick={onRefresh}>↻</button>
      <button type="button" title="Collapse all folders" aria-label="Collapse all folders" className="rounded px-1.5 py-0.5 text-muted-foreground hover:text-foreground" onClick={onCollapseAll}>⊟</button>
    </div>
  );
}

function TreeSearchResults({ nodes, onOpenFile }: { nodes: FileNode[]; onOpenFile: (path: string) => void }): ReactNode {
  if (nodes.length === 0) {
    return <div className="px-2 py-1 text-xs text-muted-foreground">—</div>;
  }
  return (
    <div className="flex flex-col gap-0.5">
      {nodes.map((node) => (
        <button
          key={node.path}
          type="button"
          className="truncate rounded px-2 py-1 text-left text-xs text-foreground hover:bg-interactive-hover/40"
          title={node.path}
          onClick={() => onOpenFile(node.path)}
        >
          {node.path}
        </button>
      ))}
    </div>
  );
}

interface TreeRowsProps {
  root: string;
  nodes: FileNode[];
  error?: string;
  expanded: string[];
  childrenByDir: ChildrenByDir;
  onToggle: (root: string, path: string) => void;
  onRefreshDir: (dir: string, force?: boolean) => Promise<FsEntry[] | null>;
  onOpenFile: (path: string) => void;
  onNewFile: (parentDir: string) => void;
  onNewFolder: (parentDir: string) => void;
  onRename: (path: string) => void;
  onDelete: (path: string) => void;
}

function TreeRows(props: TreeRowsProps): ReactNode {
  const { t } = useI18n();
  if (props.error !== undefined) {
    return (
      <div className="rounded border border-status-error/40 p-2 text-xs text-status-error">
        {props.error}
        <button type="button" className="ml-2 underline" onClick={() => void props.onRefreshDir('.', true)}>{t('common.retry')}</button>
      </div>
    );
  }
  if (props.nodes.length === 0) {
    return <div className="px-2 py-1 text-xs text-muted-foreground">{t('filesView.editor.loading')}</div>;
  }
  return <DirNodeList {...props} depth={0} walkDir="." />;
}

function DirNodeList(props: TreeRowsProps & { depth: number; walkDir: string }): ReactNode {
  const nodes = props.childrenByDir[props.walkDir]?.nodes ?? [];
  return (
    <>
      {nodes.map((node) => (
        <TreeRow props={props} node={node} depth={props.depth} />
      ))}
    </>
  );
}

function TreeRow({ props, node, depth }: { props: TreeRowsProps; node: FileNode; depth: number }): ReactNode {
  const isExpanded = props.expanded.includes(node.path);
  return (
    <div data-tree-path={node.path}>
      <div className="group flex min-h-7 items-center gap-1 rounded px-1 hover:bg-interactive-hover/30" style={{ paddingLeft: depth * 14 + 4 }}>
        {node.isDirectory ? (
          <button
            type="button"
            aria-label={`${isExpanded ? 'Collapse directory ' : 'Expand directory '}${node.path}`}
            className="px-1 text-muted-foreground hover:text-foreground"
            onClick={() => props.onToggle(props.root, node.path)}
          >
            {isExpanded ? '▾' : '▸'}
          </button>
        ) : <span className="px-2 text-muted-foreground">·</span>}
        <button
          type="button"
          className="min-w-0 flex-1 truncate text-left text-xs text-foreground hover:text-primary"
          title={node.path}
          onClick={() => (node.isDirectory ? props.onToggle(props.root, node.path) : props.onOpenFile(node.path))}
        >
          {node.name}
        </button>
        <RowMenu props={props} node={node} />
      </div>
      {node.isDirectory && isExpanded ? <DirNodeList {...props} depth={depth + 1} walkDir={node.path} /> : null}
    </div>
  );
}

function RowMenu({ props, node }: { props: TreeRowsProps; node: FileNode }): ReactNode {
  const { t } = useI18n();
  const dir = node.isDirectory ? node.path : parentDir(node.path);
  const entries: { label: string; action: () => void; danger?: boolean }[] = [
    { label: t('filesView.tree.row.rename'), action: () => props.onRename(node.path) },
  ];
  if (node.isDirectory) {
    entries.push({ label: t('filesView.tree.row.newFile'), action: () => props.onNewFile(dir) });
    entries.push({ label: t('filesView.tree.row.newFolder'), action: () => props.onNewFolder(dir) });
  }
  entries.push({ label: t('filesView.tree.row.delete'), action: () => props.onDelete(node.path), danger: true });
  const [open, setOpen] = useState(false);
  return (
    <span className="relative">
      <button type="button" aria-label={node.name} className="px-1 text-muted-foreground hover:text-foreground" onClick={() => setOpen((current) => !current)}>
        …
      </button>
      {open ? (
        <span className="absolute right-0 top-5 z-30 flex min-w-36 flex-col rounded-md border border-border/60 bg-card py-1 shadow-xl">
          {entries.map((entry) => (
            <button
              key={entry.label}
              type="button"
              className={`px-3 py-1 text-left text-xs hover:bg-interactive-hover/40 ${entry.danger ? 'text-status-error' : 'text-foreground'}`}
              onClick={() => {
                setOpen(false);
                entry.action();
              }}
            >
              {entry.label}
            </button>
          ))}
        </span>
      ) : null}
    </span>
  );
}

function parentDir(path: string): string {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return index > 0 ? path.slice(0, index) : path;
}
