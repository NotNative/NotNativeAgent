# NotNativeDesktop — Document 06: Code Review Surfaces (Files, Editor, Diffs, Git, Plan, PR/Issues, Inline Comments)

Cleanroom re-implementation specification, document 06 of the NotNativeDesktop reference set.
Audience: engineers/agents building an equivalent UI on their own agent harness (an OpenCode
replacement), with **zero** access to the original repository. Everything needed to reproduce the
behavior below is inline here. Source citations (`src: ...`) are traceability hints only — the
authority is this document.

Route-table authority: **doc 03** owns every HTTP route (fs, git, projects, GitHub, Linear,
walkthrough). This doc names routes by method + path and summarizes request/response shapes for
the subscribing UIs. Chat tool cards: **doc 05**. Walkthrough server internals and preview sharing:
**doc 13**. Theme tokens, icon names, CodeMirror color tokens: **doc 14**. Multi-run review and
session-goal review UX: **doc 12**. VS Code-only variants: **doc 10**.

HARNESS PORTS are marked explicitly: places where data arrives from the harness replacement
(OpenCode SDK v2 equivalents: sessions, messages, parts, tool state) rather than from the
OpenChamber server routes. All file/diff/git content below flows from OpenChamber **server** routes
(`RuntimeAPIs` delegates to them on every runtime unless stated) — not from the harness.

All interactions are i18n'd (`t(key)`); the English strings quoted as `'"Repeat"'` format are
behavioral contracts (menu labels, buttons, statuses, aria labels). Literature: keys live under
groups `filesView.*`, `sidebarFilesTree.*`, `diffView.*`, `gitView.*`, `planView.*`,
`inlineComment.*`, `goToLineDialog.*`, `walkthrough.action.*`, `commitComparison.*`,
`pullRequestComparison.*`, `session.githubIntegration.tabs.*`, `contextPanel.linear.*`
(src: `packages/ui/src/lib/i18n/messages/en.ts`).

---

## Table of contents

1. Surface information architecture
2. File browser (tree, tabs, search, icons, menus, dialogs)
3. Shared file editor (CodeMirror 6 config, autosave, guards)
4. Preview surface variants (image/PDF/HTML/JSON/Markdown/Draw.io)
5. Diff system (data model, PierreDiffViewer, DiffView scopes, hunk actions, scroll)
6. Git view (panes, dialogs, action inventory)
7. Worktrees UI
8. Plan view + persistence
9. PR / issue review surfaces (GitHub + Linear)
10. Inline comments and the review flow
11. Caching and invalidation trigger tables
12. States catalog
13. Build checklist
14. Appendix A: consolidated constants and timings
15. Appendix B: keyboard shortcuts on these surfaces

---

# 1. Surface information architecture

## 1.1 The retained context views

All primary review surfaces mount inside a **ContextPanel** — a retained tab host. Retention rules
(shared contract, src: `packages/ui/src/components/views/DOCUMENTATION.md`):

- Every view receives `visible` (or `isActive` for GitView) = panel-open AND panel-active-tab.
- Hiding is CSS-only. Hidden views keep React effects alive by design, so each view must gate its
  own I/O on `visible` (directory reads, git fetches, per-file reads, polling, keyboard nav) while
  retaining in-memory caches (drafts, loaded content, scroll positions, expanded sections).
- Hidden views must buffer "refresh hints" with only the dirty paths, scoped to
  runtime+directory, and replay them when re-shown (DiffView behavior, §5.9).
- Completed range diffs stay cached while hidden; pending reservations are cancelled and retried
  on resume. Hidden tabs never consume another tab's pending navigation request.
- `FilesView` in editor-only mode neither loads nor constructs its unused file tree; mobile retains
  its tree. Hidden file surfaces stop directory/stat polling; on reopen they check freshness once,
  then resume normal polling. Autosave is independent of visibility.

## 1.2 View inventory (files surfaces + git surfaces)

| View component | Modes / props | Hosted where | Role |
|---|---|---|---|
| `FilesView` | `mode: 'full' \| 'editor-only'`, `visible` | Files tabs (web), desktop context-panel file surface (editor-only), mobile Files surface | File tree + open-file tabs + editor/preview (src: `packages/ui/src/components/views/FilesView.tsx`) |
| `SidebarFilesTree` | — | Sidebar | Standalone sidebar tree variant sharing the same tasks (`components/layout/SidebarFilesTree.tsx`); see §2.9a for its delta from the FilesView tree |
| `DiffView` | `visible`, `diffScope`, `targetFilePath`, layout props | Context-panel "Changes" tab; mobile Changes; embeds elsewhere | Multi-file stacked diff (src: `views/DiffView.tsx`) |
| `GitView` | `isActive` | Main "Git" tab | Repository workbench: header, changes, commit, dialogs (src: `views/GitView.tsx`) |
| `PlanView` | `targetPath?`, `savedProjectPlan?` | Context-panel Plan tab; mobile overlay | Session/project plan editor (src: `views/PlanView.tsx`) |
| `PullRequestView` | — | Context-panel PR surface | Full-size GitHub PR workflow (src: `views/PullRequestView.tsx` → `git/PullRequestSection.tsx`) |
| `LinearIssuesView` | — | Context-panel Linear surface | Linear issue list + detail (src: `views/LinearIssuesView.tsx`) |
| `WorktreesView` | — | Full-page overlay from sidebar project menu | Worktree list + New-worktree entry (src: `views/WorktreesView.tsx`) |
| `WalkthroughView` + parts | — | Context-panel walkthrough surface | Guided change walkthrough; UI-level navigation only here (§8.6), internals in doc 13 (src: `views/walkthrough/*`) |
| `GoToLineDialog` | `variant: 'overlay' \| 'inline'` | Inside editor surfaces | Jump-to-line (src: `views/GoToLineDialog.tsx`) |
| `MarkdownPreviewSearch` | — | During markdown preview | In-preview find bar (src: `views/MarkdownPreviewSearch.tsx`) |
| `PreviewToggleButton` | `currentMode: 'preview' \| 'edit'` | Editor toolbars | Eye / eye-off toggle (src: `views/PreviewToggleButton.tsx`) |
| `OpenCodeReloadFooterAction` | — | Sidebar footer | Apply pending harness restarts / reload config (src: `views/OpenCodeReloadFooterAction.tsx`) |

Shared store list (reading views): `useFilesViewTabsStore`, `useGitStore` (+ `useGitStatus`,
`useGitBranches`, `useGitLog`, `useGitIdentity`, `useIsGitRepo`, `useEffectiveGitDirectory`,
nested-repo hooks), `useCommitSelectionStore`, `usePrContextStore`, `usePullRequestSelectionStore`,
`useInlineCommentDraftStore`, `useWorktreeOrderStore`, `useGitBaseBranchStore`,
`useGitHubPrStatusStore` (branch→PR chip + auto-selection), plus the `useGitComparison` /
`useCommitComparison` / `usePullRequestComparison` / `useBranchComparisonBase` hooks that own the
range-diff pipelines.

---

# 2. File browser (FilesView): tree, tabs, search, icons, menus, dialogs

`FilesView` is simultaneously the file browser and the open-file editor. Layouts (src:
`FilesView.tsx:4467-4506`):

- Desktop `mode:'full'`: `w-72` tree panel (only when viewport ≥ 700 px) + file viewer panel
  separated by a 3-column gap (`gap-3 px-3 pb-3 pt-2`), each a rounded `border-border/60` card.
  Below 700 px only the viewer renders (tree hidden by window width).
- Desktop `mode:'editor-only'` (desktop context panel): viewer only; the surface that owns the tree
  (shared sidebar) reveals the selected path in its own tree.
- Mobile: tree and viewer alternate in one screen (“page content” flag); the viewer shows a
  back arrow button (aria `filesView.editor.back` = "Back") into the tree.

## 2.1 Tree data model and loading (flow: directory request)

1. Every entry is `{ name, path, type: 'file'|'directory', extension?, relativePath? }`.
   Paths are normalized (backslashes → `/`, duplicate slashes collapsed, trailing slash removed
   except on roots `/` and drive roots; UNC `//` prefix preserved).
2. Directory children live in component state `childrenByDir[dirPath]`. Each read is run through a
   `DirectoryRequests` instance (src: `views/files/directoryRequests.ts`): one in-flight read per
   path; repeated callers await the same promise; `force=true` replaces the slot; scope/dir change
   or unmount calls `clear()` so stale completions cannot publish. Callers additionally check the
   runtime identity at completion time.
3. Source: `RuntimeAPIs.files.listDirectory(dir)` → `{ entries: Array<{ name, path, isDirectory }> }`
   (OpenChamber fs route; doc 03 §5.14). Runtime without `listDirectory` falls back to the
   OpenCode harness filesystem listing (`opencodeClient.listLocalDirectory`) — HARNESS PORT.
4. Mapping rules: skip dotfile-named entries when "show hidden" is off; skip entries named
   `node_modules` when "show gitignored" is off (`DEFAULT_IGNORED_DIR_NAMES = { node_modules }`,
   and any path containing `node_modules` is filtered — `shouldIgnorePath`). Sorting: directories
   first, then `name.localeCompare`.
5. Only entries whose field values and order changed are written to state
   (`areDirectoryNodesEqual`; src: `views/files/fileTreeStatus.ts:11-17`).
6. Failure handling per directory: the previous snapshot is preserved; the error string is stored in
   `loadErrorsByDir[dirPath]` and rendered inline with a retry button
   (`filesView.tree.actions.refreshTitle` = "Refresh"). `"Directory not found"` on a subdir
   collapses it (removes it and its descendants from expanded paths) instead of erroring. A unknown
   file error containing enoent/not-found closes the file (see §3.5 flow).
7. Root/visibility: `loadDirectory` is gated on `treeActive` (`treeEnabled && visible`).
   `treeEnabled = isMobile || mode === 'full'`.
8. Refresh scopes: switching runtime, root directory, or the hidden/gitignored toggle remounts the
   whole tree (clears `loadedDirs`, requests, children). Returning to the tab: one freshness pass —
   expanded dirs without an in-flight request are refreshed; then the normal poller (below)
   resumes.
9. Polling: expanded directories are re-read on a **8000 ms** interval while the tab is visible and
   `document.hidden === false`, skipping paths with in-flight requests `src: FilesView.tsx:1362-1374`.
   Also on `visibilitychange` returning to visible.
10. After any create/rename/delete operation, only the affected parent directory is refreshed
    in-place (`refreshDirectory`), keeping other cached directories intact.

## 2.2 Tree row: status dots, badges, icons

- Icons: shared `FileTypeIcon` (file-type icon registry; doc 14) for files; `folder-3` closed /
  `folder-open` expanded icons for directories.
- Status dot colors (`FileStatusDot`, CSS var per status): `open` = `--status-info`,
  `modified` = `--status-warning`, `git-modified` = `--status-warning`, `git-added` =
  `--status-success`, `git-deleted` = `--status-error`.
- Status derivation from Git status (src: `views/files/fileTreeStatus.ts:22-46`): a path carries
  exactly one of `git-added` (index `A` or working_dir `?`), `git-deleted` (index `D`),
  `git-modified` (index/working `M`), otherwise null; `open` (tab open) beats git status.
  The index (path→status, dir→badge) is rebuilt once per git snapshot; open-tab membership is a
  separate set so tab changes never rebuild the git index.
- Directory badges aggregate descendants: `M{count}` in warning color and `+{count}` in success
  color, rendered row-right.
- Long names in the mobile open-file dropdown scroll as a marquee (`ScrollingFileName`) when they
  overflow.

## 2.3 Tree search

- Input placeholder `"Search files..."` (`filesView.tree.search.placeholder`), clear button
  `"Clear search"`; debounce **200 ms** (`useDebouncedValue`).
- The query is answered by the workspace-wide file search: `searchFiles(root, query, 150,
  { includeHidden: showHidden, respectGitignore: !showGitignored, type: 'file' })`
  (store `useFileSearchStore`; search backend is doc 03 fs/scan territory). Results are filtered
  again for gitignore rules, mapped to FileNodes, and rendered as a flat list (RTL-truncated
  relative paths, title = absolute path). An in-flight spinner shows `"Searching..."`.
- Selecting a search result selects and opens the file like any tab (and on mobile opens the page).

## 2.4 Row menus (exact actions)

Each row has a hover "..." dropdown and a right-click context menu with identical items
(`FileRow`, src: `FilesView.tsx:424-505`). Items are permission-gated by `RuntimeAPIs.files`
capability presence (`writeFile`, `createDirectory`, `rename`, `delete`, `revealPath`,
`downloadFile`):

| Item | Label (en) | Action |
|---|---|---|
| Rename | `"Rename"` | opens rename dialog (prefilled current name) |
| Copy Path | `"Copy Path"` | clipboard absolute path; toast `"Path copied"` / `"Copy failed"` |
| Copy Relative Path | `"Copy Relative Path"` | clipboard path relative to root; toast `"Relative path copied"` |
| Save / Download | `"Save"` (desktop) / `"Download"` (browser) | `files.downloadFile(path)` |
| Reveal (desktop only) | via `getRevealLabelKey()` (platform "Reveal in Finder/Show in Explorer" label, doc 14) | `files.revealPath(path)`; failure toast `"Failed to reveal path"` |
| New File (directories only) | `"New File"` | create-file dialog at that directory |
| New Folder (directories only) | `"New Folder"` | create-folder dialog |
| Delete | `"Delete"` (destructive styling) | delete confirm dialog |

Tree header actions (top bar): search field, `"New File"`, `"New Folder"`, `"Refresh"` buttons
(all with identical title/aria). The mobile tree has the same actions.

## 2.5 File dialogs (create/rename/delete)

One shared dialog (title/description per mode), input field, `Cancel` and
`Confirm`/`Delete` buttons (src: `FilesView.tsx:586-649, 1376-1528`):

- Create File: title `"Create File"`, description `"Create a new file in {path}"` (path or
  `"root"`), input placeholder `"Name"`. Shows `"Filename is required"` on empty. Writes an empty
  file via `files.writeFile(newPath, '')`; on success toast `"File created"` + refresh parent.
- Create Folder: title `"Create Folder"`, `"Create a new folder in {path}"`;
  `"Folder name is required"`; `files.createDirectory` → `"Folder created"`.
- Rename: title `"Rename"`, `"Rename {name}"`, placeholder `"New name"`; `"Name is required"` on
  empty; `files.rename(old,new)` → `"Renamed successfully"`, refresh parent, remove open tabs under
  the old path, clear selection if the open file (or any file under it) was renamed.
- Delete: title `"Delete"`, description `"Are you sure you want to delete {name}? This action
  cannot be undone."`; confirm button labeled `Delete` (destructive); remove open tabs under the
  path, clear viewer if it was deleted.
- Mutations call `sessionEvents.requestGitRefresh({ directory: root, paths: [relativePath] })` so
  the git/diff surfaces refresh for the touched path (§11).

## 2.6 Open-file tabs (useFilesViewTabsStore)

State shape (src: `stores/useFilesViewTabsStore.ts`): per project root
`{ openPaths: string[], selectedPath: string | null, expandedPaths: string[], touchedAt }`, plus
runtime scoping: `activeRuntimeKey` + `runtimeSnapshots: Record<runtimeKey, { byRoot, updatedAt }>`.
Persisted (zustand persist, storage key `files-view-tabs-store`, version 3; snapshots saved, not
the live map).

Hard limits: `MAX_ROOTS = 20`, `MAX_OPEN_PATHS_PER_ROOT = 50`, `MAX_EXPANDED_PATHS_PER_ROOT = 500`,
`MAX_PATH_LENGTH = 4096`, root TTL **90 days**; `MAX_RUNTIME_SNAPSHOTS = 8`. Sanitizer: paths must
be absolute-normalizable, within the root, ≤ 4096 chars; dedup + last-N truncation; selection falls
back to `openPaths[0]` when outside root. Runtime switch
(`resetForRuntimeSwitch(runtimeKey)`) snapshots the current map and swaps in the target runtime's
snapshot.

Semantics:

- `setSelectedPath(root, path)` also **append-opens** the path (tab row is the open set; tree
  selection is the same mechanism; outside-root paths allowed via explicit `allowOutsideRoot`).
- `effectiveSelectedPath` = selectedPath if still open, else first open path; a sync effect keeps
  the store in this state (clears a stale selection).
- `removeOpenPath(root, path)`: removes one path (case-insensitive comparison on Windows drive
  paths); if it was selected, selection falls to `openPaths[0] ?? null`.
- `removeOpenPathsByPrefix`: used by rename/delete/missing-file to drop a subtree's tabs.
- `expandPaths` / `toggleExpandedPath` / `collapseAllExpandedPaths` manage tree expansion, always
  clamped inside the root.
- Tab row UI (desktop): horizontally scrollable pill row with per-file `FileTypeIcon`, overflow
  fade gradients at both edges, active tab in `--interactive-selection` styling, per-tab close
  button (aria `"Close {name}"`). Mobile: dropdown of open files with scrolling filenames +
  inline close affordance; `"Open files"` aria; empty state `"Select a file"`.
- Closing the active file with unsaved edits opens the discard dialog (below) and remembers the
  next tab (`getNextOpenFile` = the adjacent tab, preferring the next).
- Stale tabs are pruned on mount: every open path of the current root is stat'd; non-file stats or
  missing files remove the tab(s) (`FilesView.tsx:1632-1657`).

## 2.7 Unsaved-changes guard

Modal dialog — intentionally has **no cancel path**; dismissing is blocked. Strings:
title `"Unsaved changes"`, description `"Save your edits before continuing?"`, buttons
`"Save changes"` (success-tinted) and `"Discard"` (destructive). Flows:

- Selecting another file with dirty draft → dialog, remember `pendingSelectFileRef`.
- Closing the active dirty tab → dialog with `pendingClosePathRef`.
- **Save and continue**: `saveDraft()`; only on success proceeds (one-shot
  `skipDirtyOnceRef` suppresses the guard for the very next selection).
- **Discard and continue**: reverts the draft to the originally loaded content and proceeds.

## 2.8 Outside-workspace files and grants

Context-panel file surfaces can open paths outside the workspace (desktop editor panel only,
`mode === 'editor-only'`):

- `resolveOutsideFileReadOptions(path, root, enabled)` (src: `lib/outsideFileGrants.ts`) returns
  `{ allowOutsideWorkspace, outsideFileGrant? }` — true only when `enabled`, a root exists, and the
  path is outside it.
- The grant comes from the desktop bridge: `requestExistingFileAccess(normalizedPath)` returns
  `{ success, path, outsideFileGrant, expiresAt }`. Grants are cached per normalized path +
  runtime until `expiresAt - 5000` (renewal buffer). Only the `local` runtime obtains desktop
  grants. Both the granted path and the requested path (if they differ after normalization) are
  cached. Concurrent requests are deduplicated.
- Read options ride every read/stat/raw request as `allowOutsideWorkspace` and `outsideFileGrant`
  params (server decides authorization; doc 03 fs routes). If a new grant replaces a previous one,
  the view bumps a revision to force re-resolution.
- Reading still enforces server-side verification — the UI may never write outside workspaces
  (`canEdit` is false for outside files).

## 2.9 Markdown-image grants consumer behavior

Markdown preview images in chat reuse the outside-file grant path: a workspace-external image is
fetched through the authenticated `/api/fs/raw` asset route with a **path-bound** `outsideFileGrant`
only when the server verified the exact source in the owning assistant message and the real file
lives in the harness's dedicated temp directory (HARNESS PORTS: the harness owns that temp dir;
doc 05 owns the gallery). Code-review surfaces inherit only the same
`getOutsideFileGrant`/`resolveOutsideFileReadOptions` plumbing described in §2.8.

## 2.9a Sidebar tree deltas and the search intake contract

`SidebarFilesTree` (sidebar host) is a second consumer of the same loading machinery. Deltas from
the FilesView drawer tree:

- **Bounded module cache between mounts**: a sidebar root/runtime change remounts the scoped tree;
  an in-flight read continues only if its scope still matches ("request cancellation for collapsed
  paths stops queued batches, while already-started reads may populate the same-scope cache").
  The FilesView drawer tree keeps snapshots purely in component state and clears on scope change.
- It reacts to the **sidebar root** (project root) rather than the context-panel's session
  directory; its own toggle set (hidden, gitignored) is shared via the same `lib` toggles.
- Its row menus use the `sidebarFilesTree.*` i18n group; the shared strings include
  `"Collapse all folders"` (`sidebarFilesTree.actions.collapseAllTitle`) and drop targets
  (`"Upload to {path}"`, drag-and-drop file upload with conflict dialog
  `"Replace existing files?"`/`"Replace"`) that FilesView's drawer does not implement. The exact
  upload behavior is the sidebar's own surface; implement it when users drag files onto the tree.
- **Search intake contract** (shared with FilesView): the query goes to
  `useFileSearchStore.searchFiles(directory, query, limit = 150, { includeHidden,
  respectGitignore, type: 'file' })`. Implementers must support: workspace-scoped fuzzy/substring
  file-name search honoring the two filter flags, a hard `limit`, a per-hit payload
  `{ path, name, relativePath, extension }`, cancellability (new query supersedes), and
  `relativePath` for display. The FilesView consumes only `type: 'file'` results and additionally
  post-filters gitignored paths itself.

---

# 3. Editor spec (text surface + CodeMirror 6 config)

The editor is the same `CodeMirrorEditor` widget across FilesView and PlanView. Widget-level
extensions (src: `components/ui/CodeMirrorEditor.tsx:373-404`): `history()`,
`keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap])`, a search compartment
(`enableSearch` → `search({ top: true })` + `searchKeymap`), custom `lineNumbers` gutter with
DOM event handlers, a highlight-lines decoration layer, and a block-widget slot system for
inline comments (`BlockWidgetDef: { id, afterLine, content }`). **No** autocomplete, lint or
custom keymaps beyond the above.

## 3.1 CodeMirror 6 configuration table (FilesView editor, src: `FilesView.tsx:3016-3056`)

| Config | Value | Notes |
|---|---|---|
| Base packages | `@codemirror/view`, `@codemirror/state`, `@codemirror/language`, `@codemirror/commands` (history), `@codemirror/search` | No autocomplete/lint packages |
| Theme | `createFlexokiCodeMirrorTheme(currentTheme, { fontSize: editorFontSize })`; when Shiki supplies token colors: `{ syntaxColors: false, fontSize }` | Flexoki theme + CSS var tokens; details doc 14 |
| Language (static) | `@codemirror/lang-javascript` (ts/tsx/mts/cts, js/jsx/mjs/cjs with jsx flags), `lang-json` (json, jsonc, json5, jsonl, ndjson, geojson), `lang-css` (css, scss, sass, less), `lang-html` (html, htm, xml, drawio, dio), `lang-markdown` (+ fenced-code resolver + markdown highlight style), `lang-python` (py, pyw, pyi), legacy `StreamLanguage(shell)` (sh, bash, zsh, fish, env; makefile/gnumakefile special-cased) | src: `lib/codemirror/languageByExtension.ts:88-166` |
| Language (dynamic) | `loadLanguageByExtension(path)` → `LanguageDescription.matchFilename(@codemirror/language-data)` lazy import; loaded when the static map returns null (async, cancellable) | src: same file 168-183 |
| Markdown fenced code | `codeBlockLanguageResolver(infoString)`: bash/zsh/shell/console→shell; json/js/jsx/ts/tsx/html/css/py/md; heex/eex/leex→html; else language-data match | same file 20-64 |
| Markdown highlight style | headings bold(600) + heading color token, strong 600, emphasis italic, strike-through, links underlined `--markdown-link`, monospace `--surface-muted` bg, quote italic token, list tint token | same file 76-86 |
| Shiki token colors | `shikiHighlightExtension({ language, themeName, theme })` — full-document tokenization in the shared **markdown Shiki worker**, projected as mark decorations; decorations map through edits while typing; re-tokenize after idle **180 ms** (`RETOKENIZE_IDLE_MS`); decorations interned by color+fontStyle (italic=1, bold=2, underline=4 bitmask) | src: `lib/codemirror/shikiHighlight.ts:17,27-100` |
| Line wrapping | `EditorView.lineWrapping` when wrapLines toggle on (default **on**) | FilesView state |
| Vim mode | `vimMode={fileEditorKeymap === 'vim'}` → `@replit/codemirror-vim` + `drawSelection()` + bottom status panel (reuses package's updater; class `cm-vim-panel`) | src: `lib/codemirror/vimModeExtension.ts` |
| Read-only | `readOnly={!canEdit}` — readOnly is property-driven, the editor stays mounted | |
| Line-number gutter handlers | `domEventHandlers: { mousedown, mouseover, mouseup }` implementing click/shift-click/drag line-range selection for inline comments (§10.2); returns `true` (handled) or `false` | src: `FilesView.tsx:4097-4174` |
| Mobile keyboard avoidance | update-listener + `visualViewport` resize/scroll + document `selectionchange`; keeps the caret ≥ 20 px above the keyboard by scrolling the editor DOM by the overlap | src: `FilesView.tsx:2943-2996` |
| Search UI | `enableSearch` always true; `searchOpen` two-way binding opens/closes the CodeMirror search panel | `FilesView.tsx:4088-4090` |

## 3.2 Editor surface capabilities inventory

| Capability | Where | Contract |
|---|---|---|
| Editable/readable list | FilesView (text files inside workspace), PlanView (plan docs) | Read-only for: images, PDFs, other binaries, outside-workspace files, JSON tree view, markdown/html preview, Draw.io preview |
| Line wrap toggle | Editor toolbar | `filesView.editor.enableLineWrap` / `disableLineWrap` |
| Find in file | `mod+f` (`find_in_file`, non-customizable) | opens CodeMirror search panel; in markdown preview opens preview find (§4.5) |
| Go to line | `alt+g` (`open_go_to_line`) or toolbar button (edit mode, desktop, non-dialog targets only) | inline variant in the docked toolbar |
| Save | `mod+s` (`save_file`, non-customizable) or Save-now button | fires only when the event target is inside the editor wrapper |
| Copy contents / Copy path | toolbar buttons | toasts on success; check mark for 1200 ms |
| Save/Download file | toolbar button (when download supported) | |
| Fullscreen | toolbar (full mode, desktop) | separate virtualizer + scroller + per-surface scroll restore |
| Open in desktop app | dropdown listing `OpenInAppsStore.availableApps` (desktop only) | tries file → directory → parent directory; `"Refresh Apps"` when cache stale |
| TTS read aloud | markdown preview (+ plans) when setting enabled | `"Read file aloud"` / `"Stop speaking"` |
| Comment selection | gutter + preview menu | see §10 |
| Editor font size / keymap | settings (doc 12 scope) | `useUIStore.editorFontSize`, `fileEditorKeymap: 'vim' \| 'default'` |

## 3.3 Text load pipeline (numbered flow: open file in editor)

`loadSelectedFile` (src: `FilesView.tsx:1847-1996`) — every step is guarded by a load id
(`activeFileLoadIdRef`), the runtime key, the `[runtimeKey, root]` scope, and "the selected tab is
still this path":

1. Bump load id; clear error/desktop image; `loadedFilePath = null`; `contentDetectedBinary=false`;
   `fileLoading = true`; show page content on mobile.
2. Pre-resolve outside-file read options (grant priming).
3. Classification: `isImageFile` (incl. SVG? SVG is its own branch), `isPdfFile`, `isBinaryFile`
   (extension-based known binaries incl. PDFs and images-minus-SVG).
4. **Images (non-SVG)**: no text read. Desktop: binary read via `files.readFileBinary(path, options)`
   → data URL; web: fetch `/api/fs/raw` (authenticated asset + grant params) → blob object URL.
   Sets `loadedFilePath` and shows the image pane. Object URLs revoked on replacement/unmount.
5. **PDF**: no text read; iframe preview via
   `getRuntimeUrlResolver().authenticatedAsset('/api/fs/raw', { path, allowOutsideWorkspace,
   outsideFileGrant, directory })`; the asset URL demands a fresh runtime URL token
   (`useAssetAuthRefresh`): acquire (`acquireRuntimeUrlAuthToken`) + `refreshRuntimeUrlAuthToken`,
   re-render on token replacement (nonce remounts the iframe), release consumer on unmount.
6. **Other binaries**: no read; `loadedFilePath` set; preview pane shows the cannot-preview
   (unsupported) state with a "Save file" download button.
7. **Text**: `readFile(path)` → `/api/fs/read` (RuntimeAPIs.files.readFile with
   `{ directory: root, allowOutsideWorkspace?, outsideFileGrant?, fresh? }`; fallback
   `runtimeFetch('/api/fs/read?path=...&directory=...')`).
8. `looksLikeBinaryText(content)` — content-level binary sniff (src: `lib/toolHelpers`; used
   alongside `isBinaryFile`, `isImageFile`, `isPdfFile`, `getImageMimeType`) → if binary content in
   a text-looking file: mark `contentDetectedBinary` and show the unsupported state (never a
   corrupt editor).
9. `prepareFileEditorContent(content)`: normalize `\r\n`/`\r` → `\n`, and **detect the dominant
   line ending** (`crlf > lf` counts `'\r\n'`, else `'\n'`). The full normalized text is stored as
   both the draft and the dirty baseline (docs invariant: preview limits must never truncate the
   draft/baseline).
10. Initial view mode: `initialFileTextMode(editorContent, perPathMode)`: per-path preference first
    (in-memory map), else **`'view'` when > `LARGE_FILE_CHAR_THRESHOLD` (200,000 chars)** else
    `'edit'`.
11. Stat baseline: `readFileStat(path)` → `files.statFile` → `{ path, size, mtimeMs }` is stored
    (`lastLoadedFileStatRef`). Falsy stat (unsupported runtime) disables external-change deltas.
12. Markdown/HTML (and JSON/Draw.io) always start in `edit` except per-path preference; `view`
    defaults come from the settings flag `settingsDefaultFileViewerPreview` and the persisted
    localStorage keys (`openchamber:files:md-viewer-mode`, `html-viewer-mode`, `json-viewer-mode`:
    `preview`/`edit`/`tree`/`text`). Draw.io has no localStorage key — plain
    `settingsDefaultFileViewerPreview` default.
13. Failure branches: read errors reveal `fileError` in the pane; "directory" read errors
    (EISDIR) select nothing, clear the viewer, clear the search, then **expand the path's ancestors
    in the tree** and load them (treats the target as a directory); not-found errors remove the
    tab(s) by prefix and keep the viewer empty.
14. The pending-navigation effect (below) takes over when the load was triggered by a chat/tool
    reference instead of a click.

## 3.4 Position restore (FilePositionEditor)

`fileEditorPositions: Map<positionKey, { scroll: EditorView.scrollSnapshot(), anchor, head }>`
keyed by `JSON.stringify([runtimeKey, root, path])` (fullscreen suffix `:fullscreen`).
On editor destroy (before DOM removal) the view's selection main head/anchor and scroll snapshot
are saved; map capped at **100** entries (FIFO). On mount, clamped positions are re-applied.
(src: `FilesView.tsx:656-707`.)

## 3.5 Poll, external changes, and edit-conflict handling (numbered flow)

src: `FilesView.tsx:2115-2203` + `fileContentPoller.ts` + `fileStatChange.ts`:

1. Qualification: only the visible, loaded, selected **text** file polls (excluded: binary,
   image, drawn-from-content binary, PDF, image, drawio uses XML refs — handled by its own save
   path).
2. **Stat poll every 2000 ms** (skipped while `document.hidden`): `readFileStat` → compare via
   `hasFileStatChanged(prev, latest)`: differs when `size` differs **or** both mtimes exist and
   `|latest.mtimeMs − prev.mtimeMs| ≥ 1 ms` (sub-millisecond jitter ignored).
3. First observation with no prior baseline: store, no action.
4. Unchanged: no-op.
5. Changed and `latestStat.size ≤ MAX_CONTENT_POLL_BYTES (200,000)` and file is text: run the
   content poller:
   a. `readFile(path, { fresh: true })` — bypasses content cache AND HTTP cache (`cache:
   'no-store'`).
   b. If dirty (draft ≠ baseline, or Draw.io XML edits) → **do nothing** (baseline retained so the
   next tick retries after save).
   c. Compare to loaded baseline; equal → **return true ("observed")**, which retires the change
   (stat baseline updated). Unequal →
   d. **Second confirm read** (guards against applying a half-written file); equal again →
   `applyLoadedTextContent` (swap content in place, preserving line-ending discipline); stat
   baseline updated only after a successful observed read. Failed reads never update the baseline.
6. Changed but too large (or binary-ish content): if dirty → wait; else clear `loadedFilePath`,
   which re-runs the full load pipeline once.
7. An external write that turns text into binary mid-poll sets `loadedFilePath = null` again
   (binary guards take over).

## 3.6 File-content invalidation events

`lib/fileContentInvalidation.ts`: broadcast `{ runtimeKey, paths[] }` (deduped, trimmed).
Emitters: har tool write paths, and any feature that rewrites files the editor may hold open (e.g.
plan writes, scheduled-loop sync). Consumer (FilesView, src: `FilesView.tsx:2092-2110`): ignore
when runtimeKey mismatches, path not selected, or **draft is dirty**; otherwise invalidate
`lastLoadedFileStatRef`, clear `loadedFilePath`, bump `fileContentRevision` → reload through the
load pipeline. `fileContentRevision` is also a dependency of the asset (image/PDF) resolution
effects, so raw-asset URLs refresh too.

## 3.7 Autosave cycle (numbered flow)

src: `FilesView.tsx:1659-1793` + `lib/fileEditorAutosave.ts`:

1. `isDirty = draftContent !== fileContent` (baseline equality, not stat).
2. `Auto-save enabled` toggle lives in `useUIStore.autoSaveEnabled` (toolbar button: `"Auto-save
   on"` when on, `"Manual save"` when off; icons file-check-fill/file-check).
3. Scheduling gate `shouldScheduleFileAutosave(gate)`: requires autoSaveEnabled AND isDirty AND
   canWrite AND not saving AND not loading AND not non-editable binary AND
   `loadedFilePath === selectedFilePath`.
4. Debounce **1500 ms** (`AUTO_SAVE_DELAY = 1500`) restarted by every edit. Timer cleared
   whenever the gate goes false or the toggle is disabled (status resets to idle).
5. `saveDraft()` gate `shouldAllowFileDraftSave(gate)`: no selected path → false; clean draft →
   **true (no-op success)** so Ctrl+S/dialog are never stranded; loading/incomplete load/binary →
   false; and the special O_TRUNC race guard — a draft that is `''` while the baseline is not
   (i.e., the file was read during a concurrent write) is refused with a console warning.
6. Write: `serializeEditorContent(draftContent, loadedFileLineEnding)` restores the detected CRLF,
   then `files.writeFile(path, content)` (server fs write route, doc 03). Failure toasts
   `"Failed to write file"`/`"Save failed"`.
7. Post-save bookkeeping: `fileContent = draftContent` (dirty cleared);
   `lastLoadedFileContentRef`/revision updated; stat re-read (silently, so the poller does not see
   the write as an external change); `sessionEvents.requestGitRefresh({ directory: root, paths:
   [relativePath] })` when inside the root (git status + diff caches for that path, §11); if the
   path matches `/(^|/)\.agents/loops/<id>.md$/i`, also `syncScheduledTaskLoops(project.id)` so the
   scheduled-loop editor refreshes.
8. Status indicators: while writing `"Saving..."`; on success `"Saved"` in status-success color for
   **2000 ms** then idle. Both show only when auto-save is enabled and the file is clean.
9. Manual `mod+s` inside the editor: cancels the pending autosave timer, saves immediately (same
   statuses). Looks/aria: `"Save now ({shortcut}) - auto-saves after 1.5s"` (auto mode) or
   `"Save now ({shortcut})"` (manual mode); aria `"Save ({shortcut})"`.
10. Draw.io autosave is a separate 1500 ms cycle (§4.4).

## 3.8 Pending file navigation (tool/chat → editor) — HARNESS PORT

`useUIStore.pendingFileNavigation = { directory, path, line, column }` is set by surfaces that
receive session outputs referencing files (tool results, review payloads) — the **harness emits the
reference**, FilesView performs navigation (src: `FilesView.tsx:2750-2894`):

1. Target normalized; navigation key `{path}:{line}:{column}` tracks retry attempts.
2. If the path is not the selected file → `handleSelectFile(toFileNode(path))` (tab open + load).
   While the discard dialog is open, navigation waits.
3. Wait until `fileLoading === false && loadedFilePath === targetPath`.
4. Error/image/PDF/unsupported-binary targets clear the navigation request (nothing to open).
5. Force `textViewMode = 'edit'`.
6. Wait for the CodeMirror view to exist AND be **synced with the draft** (length equality +
   128-char sample of head and tail) — retried via `requestAnimationFrame` + ready-nonce.
7. Compute position: line clamped to `[1, doc.lines]`; column clamped to `[1, lineLength+1]`.
   Dispatch `{ selection: { anchor }, effects: EditorView.scrollIntoView(pos, { y: 'center' }) }`,
   focus the editor; one more rAF repetition (attempts bookkeeping prevents loops).
8. Clear `pendingFileNavigation`. While any of this is pending, the editor is masked behind the
   overlay `"Opening file at change..."`.
9. A separate `pendingFileFocusPath` only focuses the editor (best-effort; never steals selection
   back from a user tab switch; cleared once loaded or if the target can't focus).

Sibling control: `openContextFileAtLine(directory, absolutePath, line, column)` (UI store) is the
public entry other surfaces use (diff "open in editor", github/linear context, chat pills).

## 3.9 Go-to-line dialog (`GoToLineDialog`)

- Trigger `alt+g` or toolbar; only when `canEdit` and edit mode and not mobile.
- Two variants: `overlay` (floating panel top-left, default) and `inline` (compact input + Go
  button in the editor toolbar row, used by FilesView).
- Live behavior: typing a line number **immediately moves the caret** to that line (clamped
  `1..doc.lines`, keeping the caret's original character offset), centering it. Invalid input
  restores the original cursor. `Enter` commits (closes + focuses editor). `Escape` or outside
  pointer-down closes **without buffering state** (restores the initial selection if not
  committed). Helper text strings: `"Line number"` placeholder, helper
  `goToLineDialog.helper.currentLineRange` (`"Line {current} of {max}"` family), Go button `"Line"`
  → `goToLineDialog.actions.go` = `"Go"`. Disabled state when the editor view is unavailable.

## 3.10 Large-file behavior

- `LARGE_FILE_CHAR_THRESHOLD = 200_000` chars: selects **initial preview** (`'view'`), never
  removes edit rights. Users can switch a large file back into editing through the normal view
  controls (`PreviewToggleButton`: `textViewMode === 'view'` renders as preview).
- Preview for large text uses pierre `PierreFile` fed with the **complete draft** + Virtualizer
  (viewport-only DOM) + the shared Shiki worker pool; the file key carries a content cache key
  `makeFileContentCacheKey(draft)` = `"{length}:{fnv1a-ish hash}"` (whole content hashed, so
  same-length middle edits invalidate), and a `'pending'` suffix until the worker pool is ready
  (forces remount with the pool-backed highlighter).
- Polling content read is limited to 200,000 bytes; beyond that a stat change forces a full reload.
- Editor `overflow-anchor: none` while large preview is active to keep scroll anchored to content.
- Markdown preview over **500 KiB** shows clamp-on warning banner
  `"This file is large ({sizeKb}KB). Preview may be limited."` (rendering still happens).
- Context-panel open guard (doc-referenced): `MAX_OPEN_FILE_LINES = 20_000` lines
  (src: `lib/fileOpenLimits.ts`) — used by `validateContextFileOpen` (§5.12) and the chat file

 attachments path to refuse opening files over 20k lines in the editor (failure message
  `contextFileOpen.failure.tooLarge` localized with the limit; reasons `too-large | missing |
  unreadable | binary`).

---

# 4. Preview surface variants (inside FilesView)

All render inside the same viewer pane; each preview has its own scroll-restore key
(`${filePositionKey}:<mode>` plus `:fullscreen`).

## 4.1 Image

Desktop: data URL from `readFileBinary`; web: blob object URL from `/api/fs/raw`. SVG: rendered
from the UTF-8 text via `data:{mime};utf8,<encoded>`. Centered, `max-h-[70vh]` (fullscreen:
`max-h-full`), rounded border, alt fallback `"Image"`.

## 4.2 PDF

Auth-gated iframe (asset token) at `/api/fs/raw` with grant params; remounts on token refresh.

## 4.3 HTML

- Auth-token iframe against `getRuntimeUrlResolver().authenticatedAsset(`/api/fs/serve${encodedPath}`)`
  (path segments URL-encoded). On the VS Code runtime (no server asset transport): `srcDoc` with an
  injected `<base href="fileDirectoryPath">`. Sandbox: `"allow-scripts allow-same-origin
  allow-forms"`. Loading state `"common.loading"` until the token is ready; iframe title
  `"HTML Preview"`.

## 4.4 Draw.io

- Preview mode mounts `DiagramEditor` (drawio embed) keyed by `path:remountNonce`.
- Edits stream into `diagramXmlRef`; preview autosave (when enabled): debounce 1500 ms →
  `writeFile(xml)` → mark `diagramSaved` for **1500 ms** ✓; baseline XML refs updated.
- Toggle preview→edit: adopts current XML refs into the text draft; edit→preview: flushes the draft
  into XML refs and re-mounts the editor after a **two-rAF** delay (prevents stale iframes), guarded
  against losing selection.
- The text poller additionally treats `diagramXmlRef !== diagramSavedXmlRef` as unsaved.

## 4.5 Markdown

- Preview = `SimpleMarkdownRenderer` (doc 05 markdown contract: sanitized, no app-wide CSS,
  frontmatter stripped, no file-reference links) inside a tabIndex=-1 focusable scroll container
  (so `mod+f` can scope to it). ErrorBoundary fallback: `"Preview unavailable"` /
  `"Switch to edit mode to fix the issue."` with a switch-back button pair.
- Mode state persisted per type in localStorage `openchamber:files:md-viewer-mode`
  (`'preview' | 'edit'`), default from `settingsDefaultFileViewerPreview`. Changing that setting
  via the settings event `openchamber:file-viewer-preview-mode-changed { enabled }` rewrites per-
  path modes and localStorage for all open files.
- The find bar (below) is a **sibling**, never a child, of the scroll container so its own labels
  are not walked by the search.
- Comment menu (`FilePreviewCommentMenu`) rides the container (§10.4).

**MarkdownPreviewSearch** (src: `views/MarkdownPreviewSearch.tsx` + `markdownPreviewFind.ts`):

- Case-insensitive, overlapping-free `indexOf` scanning (standard find semantics: "aaa" in "aaaa"
  → one range). Applied via TreeWalker over text nodes; skips `svg, script, style` subtrees.
- Highlights: `<mark data-md-find class="rounded-[2px] bg-status-warning/30 ...">`; the current
  match gets a stronger class (`bg-status-warning/60`) and `scrollIntoView({ block: 'nearest' })`.
- Debounce **120 ms**; a MutationObserver re-applies highlights when the markdown renderer re-morphs
  (theme/content changes), ignoring mutations the widget itself produced, keeping the current match
  index (`keepIndex`).
- Bar UI: search input (placeholder `"Find in preview"`), `N/M` counter (aria
  `"{current} of {total}"`; zero-match shows `"No matches"`), prev/next buttons
  (`"Previous match"`/`"Next match"`), close (`"Close search"`). Enter = next, Shift+Enter =
  previous, Escape closes and restores prior focus. Opening again re-focuses + reselects
  (`focusNonce`).
- `mod+f` behavior: desktop only; only when the event target is *inside* the preview container;
  otherwise the editor find opens.

## 4.6 JSON

- `jsonViewMode: 'tree' | 'text'` (localStorage `openchamber:files:json-viewer-mode`; default from
  the preview setting → `tree` else `text`). Tree = `JsonTreeView` (expand depth 2, internal
  scroll) under an ErrorBoundary with fallback `"JSON viewer unavailable"` /
  `"Switch to text mode to view raw content."`. Toolbar toggle labels: `"Switch to Tree View"` /
  `"Switch to Text View"`.

## 4.7 Generic code preview (PierreFile / Shiki)

`renderShikiFileView` (src: `FilesView.tsx:3245-3284`): non-large files render
`<PierreFile file={{ name, contents, lang }} options={{ disableFileHeader: true,
overflow: wrap ? 'wrap' : 'scroll', theme: { light, dark }, themeType, onPostRender: restoreScroll }}>`
at full height; large files wrap in pierre `VirtualizerContext` + `WorkerPoolContext` (worker pool
from `DiffWorkerProvider`, doc 14) as described in §3.10. Language = `getLanguageFromExtension`
(tile mapping lives in doc 14/toolHelpers; both editor and preview must agree).

---

# 5. Diff system

## 5.1 Data model

Core types (src: `views/DiffView.tsx:80-115`, `views/PierreDiffViewer.tsx:52-63`):

```
GitStatus file entry: { path, index, working_dir, diffStats?{insertions,deletions}, renamed? }
FileEntry      = file entry + { insertions, deletions, isNew }
DiffData       = { original, modified, isBinary?, patch?, fileDiff?: FileDiffMetadata,
                   contextMode?: 'patch' | 'full' }
FileDiffMetadata (from @pierre/diffs) — parsed unified-diff model: deletionLines[], additionLines[],
                 hunks[] (with per-hunk line arrays), file header options
GitComparisonFile = { path, status, previousPath?, insertions, deletions, patch? }
```

Patch handling (src: `lib/diff/patchFileDiff.ts`):

- `isBinaryPatch(patch)`: matches `Binary files ... differ` or `GIT binary patch`.
- `fileDiffFromPatch(file, patch, contextLines=3) → FileDiffMetadata`: LRU cache of **64**
  entries keyed `file\0contextLines\0patch`. Full-file reconstruction is attempted for single-hunk
  patches starting at line 1 (build before/after contents including `\ No newline at end of file`),
  else falls back to `parsePatchFiles` with a synthesized `Index:/---/+++` header when the patch
  lacks one.
- `splitPatchIntoHunks(patch)` — each hunk keeps the file header (everything before the first
  `@@`) + one hunk, LF-terminated, `git apply`-able standalone. `extractHunkPatch(patch, i)` picks
  one. `getPatchHunkAnchors(patch)` — for each hunk, an annotation anchored at the **last changed
  row** (`side: 'additions' | 'deletions'`, lineNumber advanced over `+`/`-`/` ` rows).
- `haveMatchingPatchVersions(display, action)`: both headers must contain full 40/64-hex
  `index <old>..<new>` lines that match exactly — abbreviated hashes or change-counts are not
  identity (partial staging changes totals).

## 5.2 PierreDiffViewer (the diff renderer)

Props (src: `views/PierreDiffViewer.tsx:52-63`):

| Prop | Contract |
|---|---|
| `original`, `modified` | full file contents (both sides) when no pre-parsed `fileDiff` |
| `fileDiff?: FileDiffMetadata` | pre-parsed diff (preferred; enables patch-mode rendering without full file contents) |
| `language` | Shiki language id |
| `fileName` | used for labels, annotations identity, cache keys |
| `renderSideBySide` | `diffStyle: 'split' | 'unified'` |
| `wrapLines` | `overflow: 'wrap' | 'scroll'` |
| `layout` | `'fill'` (own scroller; the default, wraps `ScrollableOverlay` carrying `data-diff-virtual-root`/`-content` shared virtualizer roots) or `'inline'` (grows inside an outer scroller) |
| `enableComments` | line selection + comments (default true) |
| `hunkActions?: { anchors: PatchHunkAnchor[], render: (index) => ReactNode }` | renders action capsules per hunk via React portals into Pierre annotation nodes |

Options passed to pierre `PierreFileDiff`/`VirtualizedFileDiff` (src: `:1018-1045`):
`theme {light,dark}` + `themeType`; `diffIndicators: 'none'`; `hunkSeparators: 'line-info-basic'`;
`lineDiffType: 'none'` (word-diff off globally); large-content thresholds — when either side
exceeds **500,000 bytes** (`LARGE_CONTENT_BYTES`) set `maxLineDiffLength: 0`,
`maxLineLengthForHighlighting: 1`, `tokenizeMaxLineLength: 1` (degraded), else `1000`;
`collapsedContextThreshold: 0`; `expansionLineCount: 20`; `disableFileHeader: true`; line-selection
and gutter "+" callbacks when comments enabled; `unsafeCSS` injects the app's shadow-DOM css
(fonts pinned to `--font-mono`/`--text-code`, mobile touch targets, expand-arrow glyph CSS
`\2191/\2193/\2195`, separator height 24 px, hunk action offsets).

Rendering lifecycle: instances are created imperatively; on option/content/virtualizer/worker-pool
change the instance is reset (`cleanUp` + container clear); on option-only changes
`setOptions` + `forceRender`. Content cache keys are sampled (`length + {} head 200 / tail 200`
FNV-1a-32) to avoid全 hashing. A shared `Virtualizer` per `[data-diff-virtual-root]` host is
acquired/ref-counted (`virtualizerCache` WeakMap); metrics `lineHeight: 24, hunkSeparatorHeight:
24, spacing: 0`. Theme swap fast-path: base diff CSS vars (`--shiki-light/-dark`, `--diffs-bg/fg`,
addition/deletion/modified overrides from `terminal.ansiGreen/Red/Blue` of the resolved TextMate
theme) applied in a layout effect before async re-tokenization. `waitForDiffReady` (MutationObserver
on the `diffs-container` shadow root until `[data-line]` exists, two rAF) then a scroll-position
preservation (`preserveScrollPosition` min-height + scroll-parent delta compensation) and virtualizer
waker (double rAF + synthetic scroll + resize + rerender).

Comments integration: `useInlineCommentController({ source: 'diff' ... })`; annotations built by
`buildPierreLineAnnotations` (drafts, editing draft, selection); line click / content drag /
gutter "+" produce `SelectedLineRange { start, end, side: 'additions' | 'deletions' }`; mobile
tap-to-extend joins same-side ranges. Selection applies to the pierre instance
(`setSelectedLines`) with re-entrancy guards. Comment overlays render as React portals
(`PierreDiffCommentOverlays`) positioned over annotation rows.

Hunk action overlays: annotation metadata `{ type: 'hunk-action', index }` anchors
`PatchHunkAnchor[]`; post-render (`captureHunkTargets`) measures mounted rows and floats each
capsule over the hunk's last-changed row (`--oc-hunk-action-offset`), clamped inside the code
column; portals render `HunkActions`.

## 5.3 DiffView scopes (ChangeScopeSelector)

Scope values: `'all'` | `'working'` | `'staged'` | `'turn'` | `'branch'` | `'commit'` | `'pr'`
(type `PendingDiffScope`). Labels: `"Changed"`, `"Staged"`, `"Last turn"`, `"Branch"`,
`"Commit"` (`commitComparison.mode`), `"Pull Requests"` (`session.githubIntegration.tabs.
pullRequests`); selector aria `"Select change mode"`; each shows `{Label}: {count}` on the
trigger. Counts: working = `isWorkingStatusFile` (any `working_dir` or index `?`); staged =
`isStagedStatusFile` (index truthy and ≠ `?`); turn = last user message's `summary.diffs` length
(HARNESS PORT: user message summary diffs snapshot the working tree between turn start/end, doc
05); branch/commit/pr = comparison file counts.

- `"turn"` diff data comes from the message summary: `{file, status, before, after, patch,
  additions, deletions}[]` → `statusToGitCode` (added→A, deleted→D, else M) and either patch-
  derived FileDiff or full before/after strings. Read-only (no hunk actions), per-entry
  `initialDiffData`.
- `"branch"`: available only when the current branch differs from the repository's default branch
  (default from `branches.defaultBranches[trackingRemote] ?? defaultBranches.origin` — never
  guessed to `main`). Coercion rules (src: `views/branchDiffScope.ts`): a persisted `branch`
  scope collapses to `'working'` only on **confirmed** unavailability — runtime without branch
  scope (VS Code), status settled without a branch (detached HEAD), default known and equal to
  current, or bounded metadata retries exhausted (`useBoundedDirectoryRetry(...,
  maxAttempts = BRANCH_METADATA_MAX_ATTEMPTS = 3)`). While metadata is loading a persisted branch
  scope survives. Base selection: `useBranchComparisonBase` (server `/api/git/branch-base`
  detection or per (directory, branch) override in `useGitBaseBranchStore`); per-range file fetches
  via `getGitRangeFiles` (`/api/git/range-files?includeWorkingTree=true`) and per-file diffs via
  `getGitRangeDiff` (`/api/git/range-diff?...&includeWorkingTree=true`).
- `"commit"`: `useCommitComparison` fetches the 50 newest commits of the branch (`getGitLog(maxCount:
  50, to: refs/heads/<branch> | HEAD)`), stores the selected commit in `useCommitSelectionStore`
  (key `JSON[runtime, directory, branch]`, bounded 100). Files via `/api/git/commit-files`-shaped
  `getCommitFiles`; per-file diffs via `getGitCommitDiff({ hash, path, previousPath, contextLines })`.
- `"pr"` (not in VS Code): `usePullRequestComparison` keeps the selected PR in
  `usePullRequestSelectionStore` (key `JSON[runtime, directory, branch]`; handoff support for
  walkthrough auto-selection) and pre-selects the branch's own PR via the GitHub PR-status store.
  List via `RuntimeAPIs.github.prsList(directory, { page, query })` with 350 ms debounced search,
  pagination, load-more merging keyed `owner/repo#number`. Diff content: single
  `/api/walkthrough/pr-diff` snapshot (doc 03 §5.30/13) parsed once
  (`fetchPullRequestDiff` — 30 s timeout, `text/plain` required, `diff --git` split per file into
  `{path, previousPath, status: A|D|R|C|M, insertions, deletions, patch}`); served from
  `PullRequestSnapshotCache` (owner-retained cache: **8 completed snapshots**, **32 MiB text
  target**, keeps one oversized PR complete; eviction drops only cache ownership, never mounted
  content or in-flight requests; `invalidate(scope)` on confirmed push).

## 5.4 Stacked view mechanics

### 5.4.1 `MultiFileDiffEntry` props (per changed file)

| Prop | Contract |
|---|---|
| `visible` | gate for loading/effects (retention contract) |
| `directory` | effective repository |
| `file: FileEntry` | path + index/working_dir + insertions/deletions + isNew |
| `layout: 'inline' \| 'side-by-side'` | per file (§5.5) |
| `wrapLines` | global toggle |
| `isSelected` | selection criteria (sidebar highlight) |
| `isExpanded` / `isMounted` | expansion and mount-window membership |
| `onSelect` / `onExpandedChange` | parent handlers (header click = toggle + select) |
| `registerSectionRef` | section node registration for scroll anchoring |
| `showOpenInEditorAction` / `isOpeningInEditor` / `onOpenInEditor(path, diffData)` | open-in-editor-at-change (§5.12) |
| `staged` | which side this entry renders (forces forced value by scope) |
| `loadFullFiles` | full context switch (PR scope always patch) |
| `initialDiffData` | turn-scope precomputed diff |
| `comparisonDiff: { status, data?, message? }` | branch/commit/pr entry result (loading/ready/error) |
| `onRetryComparisonDiff` | bump the range cache revision |
| `readOnlyActions` | hide stage/revert for branch/commit/pr |
| `hunkActionsEnabled` | only `all|working|staged` |

The local file list (sidebar `FileList`) shows the change-symbol badge, `+N −N`, and per-row
`FileTypeIcon`; its aria labels reuse the `diffView.change.*` words.

- File list sidebar (`≥ 1024 px`, non-mobile, when not hidden): counts + rows with
  `FileTypeIcon`, change-symbol badge, RTL-truncated path, `+N −N` totals; clicking selects,
  expands, and aligns.
- Expand/collapse-all button (`"Expand all"`/`"Collapse all"`); per-file sticky header
  (`top-0` above rows, grid header with chevron, symbol, dir/name path, totals, layout toggle,
  optional open-in-editor button).
- Default expansion on scope switch: `getStackedViewDefaultExpandedCount(n)` = n ≤ 6 → n,
  ≤ 12 → 6, ≤ 25 → 4, else 2 (`stackedDefaultCollapsedAll` forces 0). Expanded set and mount set
  are pruned to existing paths on list change; scope+directory change re-initializes.
- **Mount window**: only expanded sections within `[rootTop − 300 px, rootBottom + 300 px]`
  (`STACKED_DIFF_MOUNT_MARGIN = 300`) are mounted; syncing runs on scroll/resize via
  `requestAnimationFrame`. Collapsing unmounts the section.
- Large diff gate: expanded entry with `insertions + deletions > 500` (`LARGE_DIFF_CHANGED_LINES`)
  renders a gate card `"Large diff ({count} changed lines)"` + `"Rendering may be slow. You can
  still view the diff by clicking below."` + `"Render anyway"`; the gate is a one-shot local flag.
- Request timeout: `DIFF_REQUEST_TIMEOUT_MS = 15000`; errors render
  `"Failed to load diff"` + message + `"Retry"` (comparison sources retry through
  `useRangeKeyedCache` revision bump; local entries bump their nonce and clear the canonical
  patch).

## 5.5 Layout modes (unified vs side-by-side, incl. mobile)

- Per-file layout from `useUIStore.diffFileLayout[path]` override, else
  `diffLayoutPreference ('inline' | 'side-by-side' | 'auto')`; auto = side-by-side only when
  viewport ≥ `SIDE_BY_SIDE_MIN_WIDTH = 1100 px` and the file is not new; new files always inline.
- The header `DiffViewToggle` sets layout for **all listed files**
  (`handleHeaderLayoutChange`); each row's toggle sets only that path.
- Mobile Changes renders entries as inline (`layout='inline'`), full-width, with the same
  comment behavior; drill-down uses the same `useGitComparison` file authority (src comment:
  "File-list authority shared by the stacked desktop view and mobile drill-down").
- Line wrap toggle (`diffWrapLines`) applies to all rendered diffs.

## 5.6 Diff load pipelines (numbered flows)

**(a) Working/staged entry (MultiFileDiffEntry):**

1. Data sources in priority order: `comparisonDiff` (branch/commit/pr) → `initialDiffData` (turn)
   → local `stagedDiffData` | `localDiffData` → `useGitStore` diff cache (`getDiff`).
2. Request key `runtime::path::staged|unstaged::statusKey(staged flag + index/workdir/insertions/
   deletions)::contextMode::retryNonce`; metadata changes invalidate (previous snapshot cleared,
   error cleared, request key reset).
3. Fetch: image files use **`getGitFileDiff`** (`/api/git/file-diff`
   → `{ original, modified, path, isBinary }` data-url style content), text use
   `getGitDiff({ path, staged, contextLines })` (`/api/git/diff` → `{ diff }` patch). When
   "Load full files" is on (`loadFullFiles`, toggle button `"Load full files"`/`"Unload full
   files"`), `contextLines = FULL_CONTEXT_DIFF_LINES = 1_000_000` → `contextMode: 'full'`; default
   `contextLines = 3` → `'patch'` (patch rendered via `fileDiffFromPatch` with no original/modified
   text; patch mode is what comment/annotation line numbers anchor to).
4. Canonical patch for hunk actions (only when hunks enabled AND full context AND no patch cached):
   a second `getGitDiff(..., contextLines: 3)` runs in parallel; its version header must match the
   display response (`haveMatchingPatchVersions`) or the entry errors with
   `"This hunk is no longer available. Refresh the diff and try again."`. Canonical patch cached by
   scope key `[runtime, directory, path, staged, statusKey, nonce]`.
5. Store result: staged → local state; unstaged → also into the `useGitStore` diff cache
   (`setDiff`) so sibling entries share it (cache bounded: per directory **30 entries/20 MiB**,
   global **200 entries/20 MiB** LRU by fetchedAt; `setDiff` refuses single entries > 20 MiB;
   > 500 changed-line files are skipped by prefetch, loaded only on click).
6. Render: `renderSideBySide`/wrap from layout rules; hunk anchors → `HunkActions` overlays.

**(b) Comparison flows (branch/commit/pr):** the shared `useGitComparison` hook (described §5.3)
fetches the file list; `useRangeKeyedCache(rangeKey, pathsKey, fetchEntry, placeholder,
revision)` lazily fetches per expanded path (`loadComparisonDiff(filePath, contextLines)`) —
range switches clear all entries instantly, reservations release on failure, stale completions
from earlier ranges can never write into the new range; revision bumps refresh requested paths
while retaining completed same-range values. PR fetch is served from the snapshot cache patch
(no extra network for opening a file); commit paths use previousPath for rename diffs.

**(c) Push invalidation (PR mode):** `lib/gitPushEvents.notifyGitPush(directory, runtimeKey)` —
the HTTP git adapter emits only after a **successful** push, capturing the runtime at request
start; `useGitComparison` invalidates matching runtime/directory snapshot caches synchronously; a
visible comparison refreshes immediately, a hidden one waits until activation; old pre-push reads
cannot overwrite the new snapshot (generation counters). Explicit Refresh always re-reads.
Terminal/external pushes don't fire this — manual refresh is required. Local status polls never
invalidate PR snapshots.

**(d) Hunk application:** `handleHunkAction(hunkIndex, action)` (§5.10) extracts the standalone
hunk patch and calls `RuntimeAPIs.git.applyGitHunk`-shaped methods:
`stageGitHunk` / `unstageGitHunk` / `revertGitHunk` (route
`POST /api/git/apply-hunk` with `{ path, patch, action: 'stage'|'unstage'|'discard' }`; patch must
match exactly one 3-line-context hunk). Then local invalidate + refresh status + git refresh hint
for that path.

## 5.7 Hunk navigation and actions UI (`HunkActions`)

Per hunk (src: `views/git/HunkActions.tsx`): a floating rounded capsule at the hunk's last changed
row (right side): staged entries show `["unstage"]`; unstaged show `["discard", "stage"]`.
Icons: stage `add` (+), unstage/discard `arrow-go-back` (discard tinted `--status-error`, stage
`--status-success`); busy state shows `loader-4` spinner. Tooltips/aria: `"Stage hunk {index}"`,
`"Unstage hunk {index}"`, `"Discard hunk {index}"` (1-based). Disabled while loading/errors or
another hunk is in flight; one mutation at a time per entry (`mutationInFlightRef` +
`HunkBusyState`).

## 5.8 Scroll anchoring

- `diffScrollAnchor.ts`: `findDiffScrollAnchor(rootTop, sections[{path, top}])` → the section
  above (or nearest below when none above) the scroll root top plus its offset;
  `getRestoredDiffScrollTop(scrollTop, previousOffset, currentOffset, maxScroll)` clamps the
  projection.
- On status refresh of visible paths, the current anchor is captured pre-refresh
  (`pendingScrollAnchorRestoreRef`), and re-applied in a layout effect after
  `fileDiffRefreshNonce` changes — so a content refresh may not yank you.
- External navigation (`pendingDiffFile`) scrolls to the target with up to **20 rAF attempts**
  (`maxAttempts`), optionally pinning the target's header to the top after align
  (`pinSelectedFileHeaderToTopOnNavigate` for the rail use, `pinnedStackedTarget`).
- `alt+arrowup/arrowdown` (window-level, guarded off editable targets and dialogs) steps review
  selection to the adjacent changed file: select, expand, scroll (≤ 20 attempts), pin-on-navigate
  when requested.

## 5.9 Git refresh hints (DiffView + GitView)

`sessionEvents.onGitRefreshHint(({ directory, paths? }))` — dispatched by
`sessionEvents.requestGitRefresh` (emitters: file save, FS mutations, tool completion
`requestGitRefreshForToolTransition` for `bash|edit|write|apply_patch|patch` on part completion
transition — HARNESS PORT at the part-transition point; and `sessionEvents.requestGitRefresh` is
also called directly by saveDraft/DiffView hunk ops). `requestGitRefresh` also fires
`notifyGitStatusInvalidated(directory)` (store side, §11).

DiffView behavior (src: `DiffView.tsx:1467-1508`): while visible — capture scroll anchor, clear
the diff cache for hinted paths, bump each path's refresh nonce, refresh status silently. While
hidden — only the dirty **paths** (runtime+directory scoped) are recorded. On resume → replay for
recorded paths. GitView co-subscribes: clears matching paths from the diff cache + silent status
refresh.

## 5.10 Review / walkthrough hand-off from DiffView

- `"Review"` button (desktop, non-VS Code, when an active session exists and scope not in
  `turn|commit|pr`): opens `ReviewFlowDialog` (§10.6) then `startReviewFlow` (session-review flow:
  handoff message, result review session — details doc 12).
- `"Walkthrough"` button (desktop, non-VS Code, `walkthrough.action.open`): carries the current
  scope as a `WalkthroughSource` (`{kind: 'pr', source}` | `{kind:'commit', hash}` | `{kind:
  'branch', baseRef, headRef}` | `{kind:'working-tree', scope: 'staged'|'working'|'all'}`) into
  `useWalkthroughStore.requestSource(directory, source)` and opens the walkthrough surface.
- Full-local-file loading and working-tree mutations are unavailable for PR snapshots
  (`loadFullFiles` forced off for PR; `readOnlyActions` for branch/commit/pr; `hunkActionsEnabled`
  only for `all|working|staged`).

## 5.11 Binary and image diffs

- `diff.isBinary` (from `/api/git/file-diff` isBinary or `isBinaryPatch`) → placeholder card:
  `"Content of this file cannot be viewed."` (src: `DiffView(BinaryDiffPlaceholder)`).
- Image files (`isImageFile`): `InlineImageDiffViewer` — side-by-side (viewport ≥ threshold) or
  stacked; layout: `"Original"` over `hasOriginal`, `"Modified"` (or `"New"` when no original)
  over `hasModified`; images max-height 70vh, alt `"Original: {path}"`/`"Modified: {path}"`.

## 5.12 Open-in-editor-from-diff

Row action (`showOpenInEditorAction`, hidden for turn scope; icon edit, title
`"Open this file in editor at change"`, busy spinner while opening): computes the first changed
modified line — from the cached patch (`getFirstChangedModifiedLineFromPatch`) or from full
before/after text (`getFirstChangedModifiedLine`), else fetches `getGitDiff(contextLines 3)`, else
`getGitFileDiff`; validates with `validateContextFileOpen` (image/pdf/binary pass through for
preview; else `looksLikeBinaryText` wartch and `MAX_OPEN_FILE_LINES = 20_000` gate). On failure
toast one of `too-large`/`missing`/`unreadable`/`binary` messages. Then
`openContextFileAtLine(directory, absolutePath, line, 1)` → FilesView pending navigation (§3.8).

---

# 6. Git view (GitView)

Single-column workbench (src: `views/GitView.tsx`). Top-level resolution chain:

1. No directory → full-page message `"gitView.empty.selectSessionOrDirectory"`.
2. Worktree bootstrap pending/post-bootstrap refreshing → spinner + `"Worktree setup in
   progress..."` (`gitView.empty.worktreeSetupInProgress` + `worktreeSetupDescription`),
   with `"Retry discovery"` on refresh failure.
3. `isGitRepo === null` or repo-but-no-status → `"Checking repository..."`.
4. Root not a repo → `NestedRepoResolutionStates` (discovering / failed / unsupported / none found
   / auto-selecting; retry = `ensureNestedRepos(root, {force:true})`) + optional footer
   `"Worktree features unavailable"` when the attachment only allows degraded mode.
5. Repository: header, operation banners, changes + commit sections, dialogs.

## 6.1 Header (`GitHeader`)

Contains: nested-repo picker (when root ≠ repo and repos discovered), branch info + current branch
badge (`"Current"`), branch selector (local `"Local branches"` / remote `"Remote branches"`, search
`"Search branches..."`, create-new input `"Create new branch..."`, rename flow for local branches,
detached-HEAD label `"Detached HEAD"`, unpushed badge `"1 commit not pushed"`/`"{count} commits
not pushed"`, recent branches section), sync cluster (Fetch / Pull / Push / Sync — tooltips
`"Fetch from remote"`, `"Pull changes"`, `"Pull changes ({count} behind)"`, `"Push changes"`,
`"Push changes ({count} ahead)"`, `"Sync Changes ({behind} down, {ahead} up)"`; a disabled sync
when local changes exist `"Commit or stash your changes before syncing"`; more-actions menu for
remotes incl. per-remote fetch `"Fetch from {name}"` and remove-remote), identity cluster (active
git identity profile chip + switcher with stored identity profiles; auto-apply of the default
identity to a repo lacking a local identity), PR chip (branch↔PR association via
`useGitHubPrStatusStore` with checks summary; opens the PR surface), and menu buttons to open
**History**, **Graph**, **Stashes**, **Update branch**, **Re-integrate commits** (the last two
offered under the worktree/branch workflow predicates: Integrate commits only when the worktree
tracks `origin/*`).

## 6.2 In-progress operations

`InProgressOperationBanner` shows when status reports `mergeInProgress` or `rebaseInProgress`:
conflict count, buttons Continue / Abort / "Resolve with AI" (opens the conflict dialog with the
status-derived conflict file list).

## 6.3 Changes panel (`ChangesPanel` + `changesTree`)

- Groups: `"Staged"` (accent) and `"Changes"` (unstaged). Each group is a **directory tree**:
  nodes built by `buildChangesTree` (per path segments; directories sorted by path; files under
  directories sorted by path; each directory node aggregates descendant files), flattened with
  `expandedDirectories`, indent **14 px/level** (`TREE_INDENT_PX`).
- Row actions (exact strings): group button `"Stage all changes"` (unstaged, symbol `+`) /
  `"Unstage all changes"` (staged, symbol `-`); per-file aria `"Stage {path}"` / `"Unstage
  {path}"`; per-directory aria `"Stage all changes in {path}"` / `"Unstage all changes in
  {path}"`; ordering: staged first then visible then baseline-first-20 for prefetch.
- Directory rows: expand/collapse aria `"Expand directory {path}"`/`"Collapse directory {path}"`,
  aggregate stage/unstage and `"Revert folder"` (`"Revert folder changes?"` dialog with count
  description), and `"Revert changes in {path}"`.
- File rows: symbolic change badge (M/A/D/R/C/U with colors: A/`?`→success, D→error, M→warning,
  R/C→info; title/aria the localized words `"Modified file"` etc. from `diffView.change.*`),
  path, +/− counts from status.diffStats, click → open the file's diff in the context panel
  (`openContextDiff(root, path, staged)`; mobile: `navigateToDiff`), a per-file diff view button,
  a revert button (single `"Revert changes"`; confirm dialog), and selection checkboxes for
  batch operations (`"Select {path}"`, `"Select all files"`, `"Clear file selection"`).
- `"Revert all"` with dialog `"Revert all changes?"` / `"Revert {count} changed files? This cannot
  be undone."` — calls `revertGitFile` per path with `scope: 'all'`, collects partial failures and
  reports success/partial/failed toasts (`Revert...` busy). Reverting while staged touches the
  index (bump + reconcile).
- Diff preview: hovering/selection shows the file diff inline (right side of split pane; resizable
  via `"Resize staged and unstaged changes"` handle) reusing the GitStore diff cache.

## 6.4 Stage/unstage mutation queue (optimistic)

`gitIndexMutationQueue` (src: `views/git/gitIndexMutationQueue.ts`): enqueue(stage|unstage batch)
→ optimistic status move in `useGitStore.moveStatusPathsOptimistically` (index↔workdir rewrite,
per git status convention `index/working_dir` codes; conflict codes preserved) with rollback
closure → network call `stageGitFiles` (single `/api/git/stage` with `{ paths }` or fallback
per-file) / `unstageGitFiles` → on complete bump `indexRevision`, schedule reconcile; on error
restore previous status + toast `"Failed to stage file"`/`"Failed to unstage file"` (fallback
strings `gitView.toast.stageFileFailed`/`unstageFileFailed`). Flush scheduled on a zero-timeout.
GIT_RECONCILE_DELAY_MS = **15000** — after any index mutation a silent status fetch reconciles
authoritative state.

## 6.5 Commit section (`CommitSection` + `CommitInput`)

- Section title `"Title"` is `"Commit"` (`gitView.commit.title`); commit disabled with
  `"Stage files to enable commit."` hint (and `"Select files in Changes to enable commit."` when
  the panel lost its file selection); message required (`"Enter a commit message"` toast);
  placeholder `"Commit message"`.
- Message textarea (auto-sized), generated highlights box (`AIHighlightsBox`, title
  `"Highlights"`) with an insert button appending bulleted lines below the subject and clearing
  the box (`gitView.commit.aiHighlights.insertTooltip`/`insertAria` carry the localized
  insert label), Generate button labeled `"Generate"` (aria `"Generate commit message"`):
  `generateSessionCommitMessage(directory, sortedStagedPaths)` (server small-model route, doc 03)
  → subject (+gitmoji decoration when the setting is on — conventional prefix or first-word
  keyword mapping table feat/fix/docs/style/refactor/perf/test/build/ci/chore/revert/wip... →
  `:emoji:` codes) and body highlights; failure toast `"Failed to generate commit message"`.
- Gitmoji picker (setting `settingsGitmojiEnabled`, trigger button `"Add gitmoji"`): dialog with
  search (ranking via `rankByQuery`, no cmdk filtering) inserting `:code: ` prefix.
- Buttons: `"Commit"` and `"Commit & sync"` (busy `"Committing..."` / `"Syncing..."`). The push
  part of Commit & sync: fetch → optional rebase pull when behind and clean (else
  `"Commit or stash before syncing"`), push when ahead, fireworks celebration on success. Busy
  spinner; `"Commit created"` toast; message + highlights cleared.
- Identity: per-repo identity auto-apply (§6.1) and manual profile selection; the current identity
  meta chip shows the resolved profile (local config fallback synthesized as `local-config`).

## 6.6 Empty state (`GitEmptyState`)

`"Working tree clean"` + `"All changes have been committed"`, pull affordance when behind
(`"Pull {count} commit(s)"`), stashes button (`"Stashes"`).

## 6.7 Branch workflows dialogs

- **Update branch** (`isUpdateBranchDialogOpen`; `BranchIntegrationSection mode='bare'`): title
  `"Update branch"`, description `"Bring the latest changes into {branch}."`; target selection
  defaults to `updateTargetBranch` (base branch or its remote-tracking counterpart); two operation
  cards: **Merge** (`"Create a merge commit and preserve branch history."`) and **Rebase**
  (`"Replay your commits on top of the selected branch."`); operation log list (`OperationLogEntry
  { message, status: 'running'|'done'|'error', timestamp }`); dialog stays open while an operation
  runs. Merge flow: resolve integration target (existing remote-tracking or inferred
  `remote/branch`) → optional fetch (`Fetching {remote}/{branch}...` log lines) →
  `git.merge(directory, { branch })`; conflict → `ConflictDialog` + persisted state; uncommitted
  changes error → `StashDialog` (auto-stash, retry, optional restore). Same shape for rebase
  (onto). Resolution helper rejects unknown slip-ups (uncommitted-changes error matcher list).
- **Conflict dialog** (`ConflictDialog`): title `"{operation} conflicts detected"`; conflicted
  files list; details fetch (server git conflict-details); actions: **Resolve in current session**
  (sends resolution prompt to the chat with conflict file context), **Resolve in new session**,
  `Abort {operation}`, `Continue later`. State persists per session in localStorage key
  `openchamber:{sessionId}` (payload `{ directory, conflictFiles, operation }`) and restores only
  when the stored directory matches the effective repo.
- **Dirty branch switch** (`DirtyBranchSwitchDialog`): checkout over dirty tree is blocked; dialog
  `"Uncommitted changes"` + `"Switching to {branch} is paused so your {count} changed files are not
  lost. Commit them, or revert them first."`; actions `"Commit and switch"` (optionally `"Push
  after commit"`; failed push aborts the switch with `"Committed, but the push failed — the branch
  was not switched."`) and `"Revert and switch"` (revert all; if not clean after revert →
  `"Some changes could not be reverted, so the branch was not switched."`); message generation
  available. Local-only commit toast: `"Committed to {branch}. The commit is local only — it has
  not been pushed."`.
- **Stash-and-retry dialog** (`StashDialog`): `"Uncommitted Changes"`, steps `"Stash your
  uncommitted changes"` → perform merge/rebase → `"Restore your stashed changes"`; includes
  untracked; restore optional.
- **Re-integrate commits** (`IntegrateCommitsSection`): move the worktree branch's commits onto a
  target branch via the integrate API family (`/api/git/integrate/plan|run|conflict-details|
  cherry-pick-status|continue|abort`); shows `"Commits to move"`, preview counts, `"Move commits"`,
  conflict handling similar to conflict dialog, refresh key.
- **Update branch availability gates**: worktree attachment blocking reasons
  (`getMutationBlockingReasons`) block create/rename/checkout with localized reasons (attention/
  missing/invalid worktree) — toasts `"Cannot create branch: {reason}"` etc.

## 6.8 History & graph

`HistorySection` inside a large dialog (`max-w-5xl, h-[90vh]`), modes:

- `history`: commits of the current branch's log (maxCount selector `25/50/100 commits`,
  `Load more`), rows with graph segments reducing to a rail, subject/author/date, actions per
  commit: `Copy SHA`, `Checkout` (confirm `"Check out this commit as detached HEAD?"`), `Cherry-pick`
  (`"Cherry-pick this commit onto the current branch?"`), `Revert` (`"Stage a revert of this
  commit?"`), `Merge into current`, `Rebase onto this`, `Reset...` (soft/mixed/hard with
  descriptions: `"Soft — keep staged"` / `"Mixed — unstage changes"` / `"Hard — discard all
  changes"`), `Create branch here`. Expand a commit → file list (`getCommitFiles`) + per-file
  diffs (large diff gating like DiffView, binary notices `"Binary file — no diff available"`).
- `graph`: full-repo log (`getGitLog(directory, { maxCount: graphLogMaxCount, all: true })`,
  default 100) with computed lane graph (`gitGraph.ts` + `GitGraphSegment`), same per-commit actions
  (conflicts from cherry-pick/revert escalate a manual-resolution toast: `"Conflict"` +
  `"Conflicts in: {files}. Resolve manually and commit..."`).
- A **branch divider** (`historyBranchDivider`) inserts `"{branch}"`-labeled boundary between the
  current branch's commits and the shared history (computed by fetching base→HEAD log and finding
  the first non-branch commit).
- Commit file diff rows label rename/binary cases; errors per file retry inline
  (`"Failed to load diff. Click to retry."`).

## 6.9 Stashes (`StashesDialog`)

List of stashes (`{ ref, message, time, hash }` via `/api/git/stashes`), file counts endpoint,
actions `"Apply"`, `"Pop"`, `"Drop"` (confirm `"Drop {ref}?"`), `"Stash current changes"` /
`"Stash {count} files"`; description `"Save, restore, and clean up Git stashes for this
repository."`, empty list `"No stashes yet."`, search emptiness `"No matching stashes."`, hint
`"Untracked files are included automatically."`.

## 6.10 Diff prefetching

On status availability: ordered priority list (staged first, visible rows, baseline first 20) →
`prefetchDiffs(directory, git, paths, { maxFiles: 40 })` after **120 ms**; worker pool of
`DIFF_PREFETCH_CONCURRENCY = 2` with `DIFF_PREFETCH_TIMEOUT_MS = 15000`; files > 500 changed
lines skipped (on-demand only); hidden tab → no prefetch; generations guard staleness.

## 6.11 PR chip store (`useGitHubPrStatusStore`)

Per `{directory, branch}` entries: target PR resolution, checks summary (state machine
`success/failure/pending/unknown` per `summarizeCheckRuns` — counts success/failure/pending/
inProgress/queued, smallest startedAt), auto-refresh cadence **35 s** (`PR_CHECKS_AUTO_REFRESH_MS`)
while visible, action-triggered refreshes at **+2 s and +5 s** (`PR_ACTION_REFRESH_DELAYS_MS`),
manual refresh min spin **600 ms**. `getFreshestPrStatusForBranch` picks the newest qualifying
entry for the branch.

---

# 7. Worktrees UI

- `WorktreesView` (src: `views/WorktreesView.tsx`): full-page overlay for a project, opened from
  the sidebar project menu. Contains a leading `"New Worktree"` button
  (`sessions.sidebar.project.actions.newWorktree`; opens the app-level New Worktree dialog) and
  `WorktreeSectionContent projectRef sections='list-only'` — the shared worktree list renderer
  (worktree domain internals live in the worktree docs; here: it lists per-worktree cards with
  branch, path, status and actions driven by worktree metadata).
- Ordering: `useWorktreeOrderStore` (localStorage persistence name `mobile-worktree-order`) stores
  per-project ordered path arrays; `orderWorktrees(orderedPaths, worktrees)` stable-sorts — known
  paths first in stored order, unknown paths appended in incoming (alphabetical) order.
- Creation flows (src: `lib/worktreeSessionCreator.ts`):
  - `createWorktreeDraft({ initialPrompt?, title? })` — instant flow: opens a New-session draft
    immediately with `pendingWorktreeRequestId` (draft lock), generates a branch name
    (`generateBranchName()`), creates the worktree with defaults
    (`createWorktreeWithDefaults(projectRef, { mode:'new', branchName, worktreeName, setupCommands,
    returnAfterDirectoryCreated: true })`), resolves the pending request to the path, sets
    `bootstrapPendingDirectory`; on failure rejects the pending request and toasts
    `"Failed to create worktree"`.
  - `createWorktreeSessionForNewBranch(projectDirectory, branchName, startPoint?, options
    { kind: 'pr'|'standard', worktreeName, setUpstream..., createdFromBranch, returnAfterDirectoryCreated })`
    — used by PlanView "Implement in worktree" and PR flows; creates worktree, waits for setup
    bootstrap when the project requires it (`getWorktreeSetupWaitEnabled`), creates the session in
    the new directory (rollback deletes the worktree + local branch if the session fails),
    initializes session metadata (directory, worktree metadata incl. `createdFromBranch`, default
    agent/model/variant selection).
  - Single-flight guard `isCreatingWorktreeSession` prevents concurrent flows.
- GitView/PlanView read worktree metadata (`useDetectedWorktreeMetadata`, session worktree
  attachment) to derive base-branch hints (`rootBranchHint` from `getRootBranch(projectRoot)`),
  `"Re-integrate commits"` availability (tracking must start with `origin/`), and blocking reasons
  for branch mutations.

## 7.1 Worktree branch diff scoping (numbered flow)

1. Worktree directories are git worktrees of one repository; each has its own status/branch —
   `useGitStore` keys all git data by directory, so a worktree's status/diff/log are separate
   buckets.
2. Base branch for "what does this worktree change" comes from the worktree metadata
   (`createdFromBranch`, detected via the attachment/probe) with `rootBranchHint` (root's current
   branch) and remote default as fallbacks (`deriveBaseBranch` in `git/baseBranch.ts` — order:
   created-from branch → root branch hint → remote default → current branch → HEAD).
3. The PR flows create worktrees with upstream remotes like `pr-<owner>-<repo>` for forks; those
   are excluded from Re-integrate (tracking must be `origin/*`).
4. Worktree switches (session → different worktree) change the effective directory; FilesView and
   GitView reset per-directory state (`resetForRuntimeSwitch` covers runtime, directory effects
   reset via `setActiveDirectory` + component scope refs), while `useFilesViewTabsStore` keeps
   per-root tab sets (worktree path IS the root), so open files survive within a worktree but the
   tabs shown belong to that worktree's directory scope.

---

# 8. Plan view + persistence

PlanView is the plan-mode surface (feature flag `planModeEnabled`); it also opens **saved project
plans** (`savedProjectPlan: { projectRef, planId }`) from the context tabs — project plans work
even when plan mode is off. (src: `views/PlanView.tsx`.)

## 8.1 Document resolution (numbered flow)

1. Flush any outgoing document (save queue). Reset bookkeeping.
2. **Saved project plan**: await `saveQueue.pendingFor(key)` + `reset(key)` (a re-open while its
   own write is still in flight must read post-write state), then `fetchProjectPlan(projectRef,
   planId)` (server project-context routes, doc 03 §5.15). Missing plan → load error
   `"Could not load this plan"`-state (`Plan not found` internal), viewer stays empty and
   unsaveable.
3. **File plan (`targetPath`)**: read via `RuntimeAPIs.files.readFile` (fallback
   `/api/fs/read?optional=true` with `cache:'no-store'`, and registered-adapter fallback).
4. **Session plan (no target)**: candidate paths —
   `{sessionDirectory}/.opencode/plans/{created}-{slug}.md` (repo path) then
   `~/.opencode/plans/{created}-{slug}.md` (home path, `~` resolved against `useDirectoryStore.
   homeDirectory`); first existing wins; read it.
5. Editor content = full text; per-document key `JSON(['plan-file', runtimeKey, path])` or
   `JSON(['saved-plan', runtimeKey, projectContextId, planId])`.

Managed-chat exception: plans stored under the chats owner (`CHAT_DRAFT_PROJECT_ID`) cannot send
(Improve/Implement disabled — no session directory to create a session in).

## 8.2 Save queue (`lib/planSaveQueue.ts`)

`createPlanSaveQueue().schedule(key, revision, write)` — per-key serialized chains, dedup by
revision watermark (`revision <= lastRevision` returns the current chain; a failed write clears
the watermark only when it is still the latest, letting the caller retry the exact revision).
`pendingFor(key)` awaits all settled writes; `reset(key)` forgets the watermark after a fresh
load. Document switch/unmount flush (`scheduleSave`) captures `{key, target, content, revision,
runtimeKey, write}`; a queued write that finds the runtime switched **drops itself** (never writes
across connections). Save errors surface as `"Save failed"` under the title.

## 8.3 Autosave timing

Content change → 350 ms debounce → `scheduleSave()`; unmount/switch flushes immediately
(synchronously captured). Buffer tracking is synchronous (`docRef.current.content = next;
editRevision += 1`) so a same-batch unmount cannot flush a stale buffer. `savedRevision` only
advances after the write of that exact revision settles; plan writes go through `files.writeFile`
or the saved-plan store (`useProjectContextStore.savePlan`) — a rejection means the plan no longer
exists.

## 8.4 UI

- Header: parsed title (first heading from `parsePlanMarkdown`, default `"Plan"`), file label
  (display path basename or `"plan"`; display path uses cwd-relative or `~/`-compressed forms),
  load/save error lines (truncated, title = full).
- Actions: **Improve** and **Implement** dropdowns (`"Improve"`/`"Implement"`,
  `"Send to new session"` / `"Send to new worktree session"` (disabled without a git repo
  project)), PreviewToggleButton (persisted localStorage `openchamber:plan:md-viewer-mode`),
  TTS (`"Read plan aloud"`/`"Stop speaking"`), Copy (`"Copy plan contents"`).
- Send flow (`TodoSendDialog` + `run as goal` allowed): visible prompt from magic prompts
  `plan.improve.visible|plan.implement.visible` with `{plan_title}`;
  instructions part (synthetic) from the matching `*.instructions` prompts — for saved plans
  without a file path, the synthetic part additionally carries the **full plan contents** with the
  explicit note that the plan lives in OpenChamber project knowledge. Target resolution: saved
  plans send to their own project; new sessions (or `createWorktreeSessionForNewBranch` with a
  generated branch name for worktree target) with model/agent/variant selection applied to the new
  session; session goal arm store armed for `runAsGoal` with the composed objective ("Implement the
plan "title" end-to-end..." + full plan text). Goal-review behavior: doc 12.
- Editor: same CodeMirror widget; extensions = flexoki theme + `languageByExtension` (markdown
  default) + Shiki token colors only for code files (Shiki disabled for markdown — lezer markdown
  highlighting keeps bold headings), line wrapping always on. Inline comments (source `plan`,
  language `markdown`) with gutter drag selection identical to FilesView.

## 8.5 Plan persistence contract (for reimplementation)

Plan documents are plain markdown; the **session plan file path is `<sessionDirectory>/.opencode/
plans/<epoch-creation-ms>-<session-slug>.md`** (，“.opencode” is the harness config dir that the
plan surface co-opts — the path is owned by this UI, not the harness). Saved project plans live
behind theproject-context API (doc 03). Both lose nothing on tab close: the queue covers
debounce-window edits and close-time flushes, ordered by key.

## 8.6 Walkthrough step navigation (UI level; server/generation internals: doc 13)

- Toolbar action labels: `"Generate walkthrough"` / `"Regenerate"` / `"Cancel"` / `"Refresh"`;
  step navigation `"Next step"` / `"Previous step"`.
- Stage progress (`useWalkthroughStageProgress`): assembly stages `collecting → asking →
  assembling` (+ retry ≡ asking), each held on screen **≥ 450 ms** (`MIN_STEP_MS`) including the
  final done state; a restart falls back to the earlier step immediately; fresh runs reset after
  450 ms.
- TOC (`WalkthroughToc`): per-chapter sections (chapter icons bug/tools/compass/flask/file/settings,
  localized titles); per-stop rows with numbered pill (visited → success check), stale marker, and
  up to 3 changed-file paths (+`walkthrough.toc.moreFiles` count); active row `aria-current="step"`
  and `scrollIntoView({ block: 'nearest' })` on activation.
- The stream/auto-scroll and diff-render sharing (`WalkthroughStream`, `WalkthroughStages`,
  `WalkthroughHunkRun`, `stopElementId`) are doc 13's contract; the UI-level guarantee for this
  doc: step selection is id-stable (`stopId`), visited set is view-local, and FilesView/DiffView do
  not need to share state with it beyond the shared selection stores (PR selection handoff and
  commit selection) noted in §5.3.

---

# 9. PR / issue review surfaces (UI level; routes in doc 03)

## 9.1 PullRequestView

Resolves repository context identically to GitView (nested repo resolution, worktree metadata,
remotes with a per-directory runtime-scoped cache of the last fetched remotes + remote URL) then
renders `PullRequestSection { directory, branch, baseBranch, trackingBranch, remotes,
remoteBranches }` under the ScrollShadow scroll. Empty/no-branch states: icon + `"Pull request"`-
titled empty state with create hint. Base branch derivation matches GitView (deriveBaseBranch with
the same inputs).

## 9.2 PullRequestSection behavior inventory (src: `views/git/PullRequestSection.tsx`)

Statuses/polling: checks refresh every **35 s**; action-driven refreshes at +2 s/+5 s; manual
refresh min-spin 600 ms; PR status chip header. Segments (radio-like): `"Overview"`, `"Checks"`,
`"Comments"`.

- **Overview / create**: title/description fields (`"Pull request title"`, `"Describe the
  change..."`, body placeholder `"What changed and why?"`), draft toggle, base-branch select
  (`"Select base branch"`; toasts `"Select a base branch"`, `"Base branch must differ from current
  branch"`), additional-context box (`"Additional context"`, optional, `"Any constraints, rollout
  notes, or reviewer context..."`); generated description button (small model; failure toast
  `"Failed to generate pull request description"`). Actions: `"Create PR"`, `"Edit PR"`,
  `"Save PR"`, `"Mark ready"` (draft), `"Merge PR"` with method radio `"Create a merge commit"` /
  `"Rebase and merge"` / `"Squash and merge"`, `"Open on GitHub"`, `"Hide"`, `"Repository"`,
  `"Refresh PR status"`, `"Open settings"`. Merge guards: draft (`"Draft PR must be marked ready
  before merge."`), mergeability (`"Not mergeable"`), permission (`"You do not have permission to
  merge this pull request."`); toasts `"Pull request created"/"updated"/"merged"/"was not merged"`.
- **Checks**: aggregated summary chip (state from `summarizeCheckRuns`), failure list with
  step details (`"Steps"`, `"Status"`/`"Conclusion"`/`"Started"`/`"Completed"` labels,
  `"No check details available"`), `"Attach failed checks"` → chat context (toasts
  `"No failed checks found"`/`"Failed to load check details"`), open-checks link.
- **Comments**: review comments list (`"Review comment"`/`"General comment"` types with author,
  `"Unknown author"` fallback, formatted timestamps), per-comment `"Attach comment to chat
  context"`, bulk `"Attach all to chat"`, empty state `"No comments found"`,
  `"Attach comments"` send flow requires an active session (toast `"No active chat session"`).
- History states: `"PR #{number} was merged into {base}."` / `"PR #{number} was closed."`
- Connection guards: `"GitHub is not connected"`, `"Pull request status unavailable"`.

The GitHub store layer (pulls/search/context/checks routes `github.prsList` / `prContext` /
checks endpoints, doc 03 §5.23) backs all of this; `usePrContextStore` caches PR context per
`JSON[runtime, directory, number]` with **30 s TTL**, max **20** entries, detail-inclusive fetched
results satisfying detail-free requests, and `invalidate(directory, number?)` on push/mutations.

## 9.3 LinearIssuesView (entry-point level)

- Filter header: status filter items (`All/Backlog/Todo/Started/In Review/Completed/Canceled/
  Duplicate` via `contextPanel.linear.filter.status.*`), priority filter (`All/Urgent/High/Medium/
  Low/None`), team filter (per-runtime persisted via `applyLinearIssueListFiltersForRuntime`; the
  special value `LINEAR_ISSUE_LIST_ALL_TEAMS`), assignee filter, search (debounce 350 ms; accepts
  issue identifiers `ABC-123` or linear.app issue URLs — extracted to the identifier).
- Compact layoutthreshold: below **520 px** panel width the search + non-status filters collapse
  to icon-only triggers (status keeps its label).
- Workspace switcher (urlKey/name label), auth gate (status from `useLinearAuthStore`; settings
  entry when disconnected).
- List: paginated cursor loading (`isLoadingMore`, `hasMore`), rows with priority badge, state
  (workflow rank: triage < backlog < unstarted < started < completed < canceled, then position,
  then name), identifier, title, assignee, label chips (label color at 18% background mix),
  relative time (`formatDateTimeForPreference` honoring the user's time-format preference).
- Detail: issue view with `SimpleMarkdownRenderer` description (images clamped
  `[&_img]:max-w-full`), comment thread (same timestamp formatting as PR comments), workflow state
  updates, priority updates, team metadata; actions: **Start session** (`startLinearIssueSession`
  — new session seeded with the issue context; `"Create in worktree"` toggle), open externally
  (`openExternalUrl`), attach-to-chat equivalents per comment; focus deep-link param
  (`linearIssueFocus` opens the issue directly).
- Linear routes/backend in doc 03 §5.24; the integration's send-to-session prompt shape is doc 12's
  context.

---

# 10. Inline comments and the review flow

## 10.1 Draft store (`useInlineCommentDraftStore`)

Draft: `{ id, sessionKey, source, fileLabel, startLine, endLine, side?: 'original'|'modified',
code, language, text, terminalId?, createdAt }`. Sources: `diff | plan | file | preview-annotation |
terminal | pr-comment | pr-check | chat-quote | file-quote`. Key =
`JSON([runtimeKey, normalizedDirectory, sessionKey])` where sessionKey is the active session id or
`'draft'` while a new-session draft is open. Persistence limits: **50 sessions**, **20 drafts per
session**, **1 MiB** serialized envelope with byte-indexed LRU eviction (touchedAt ordered);
envelope zod-validated on hydration; v2→v3 migration moves terminal ids and drops removed sources.

Actions: `addDraft` (returns id or null; external caller may pin the id — used by the VS Code
bridge), `updateDraft`, `removeDraft`, `clearDrafts`, `getDrafts/consumeDrafts/restoreDrafts`
(consume/restore power the composer-send path: the chat composer reads and clears drafts for the
target on send), `getDraftCount/hasDrafts`, `clearSessionDrafts`.

## 10.2 Inline comment lifecycle (numbered flow, CodeMirror surfaces: FilesView + PlanView)

1. **Selection**: gutter mousedown starts a drag (line numbers); gutter mousedown with shift
   extends; mouseover with button held extends; mouseup (document-level) finalizes; mobile
   tap-to-extend merges the tapped line into the existing range. The same range highlights editor
   lines (`highlightLines`). Clicking the exact same single line clears the range.
2. **Input widget**: `buildCodeMirrorCommentWidgets` renders, per draft: a card (`InlineCommentCard`,
   `data-comment-card="true"`) after its end line, or an input (`InlineCommentInput`,
   `data-comment-input="true"`) for the draft being edited; plus a new-comment input block
   (`newWidgetId`, e.g. `'files-new-comment-input'`/`'plan-new-comment-input'`) after the
   selection's end line when a selection exists, nothing is being edited, and no drag is active.
3. Placeholder: `"Add a comment... ({shortcut} to save)"` (desktop; IME-safe variant without the
   hint on short surfaces); range label `"Lines {start}-{end}"`; buttons `"Save"` / `"Cancel"`.
4. **Save** (`useInlineCommentController.saveComment(text, range?)`): requires a target session
   (toast `"Select a session to save comment"` when none); text trimmed; range normalized
   (start≤end) and store-mapped (`side` from 'original'/'modified' where applicable); code
   extracted for the range in the surface's language; creates or updates the draft; resets the
   editor; on creation focuses the chat input (`focusChatInput`, rAF) so the user can type the
   accompanying message.
5. **Edit**: `startEdit(draft)` restores text + range; delete via card menu
   (`"Delete comment"`); `"Edit comment"` reopens the input underneath.
6. **Outside click** cancels only when the comment text is empty (toasts, cards, gutter elements,
   and sonner toasters are ignored as targets).
7. **Send**: the composer's send collects the session drafts (`consumeDrafts`) and appends them as
   context parts (`openchamberContext` metadata — doc 05's `UserContextPart` renders them back;
   the persisted store is the transport). The card text never leaves without an explicit send;
   storage is local (persists across reloads, runtime-scoped).

## 10.3 Pierre diff overlays (`comments/PierreDiffComment*`)

Same lifecycle on diffs: selection originates from line click / gutter "+" / content drag
(§5.2); annotation nodes get portal-mounted input/card overlays; saving uses the same controller
with `side` ('additions'→'modified', 'deletions'→'original'). The store range side disambiguates
old/new comments in unified view.

## 10.4 Markdown preview comments (`FilePreviewCommentMenu`)

A small menu on the rendered markdown preview lets the user turn a text selection into a
`file-quote`/`preview-annotation` draft (container content + line info resolved from the
fileContent text), landing it in the same shared drafts flow.

## 10.5 Add selection to chat (`lib/addSelectionToChat.ts`)

- Trigger: shortcut `mod+l` (`add_selection_to_chat`) with selection-toolbar registry
  (`registerActiveSelectionToolbar` — a surface that shows its own "add to chat" UI suspends
  global shortcuts and registers `addToChat`/`dismiss`; the shortcut invokes the last registered
  one).
- Capture priority: focused CodeMirror selection (`.cm-editor.cm-focused`, non-composer) → active
  text control selection (textarea/input types text,search,url,tel,password; selection collapsed
  after capture) → DOM selection (`rangeToMarkdown`).
- Formatting: code selections wrapped as fenced code with language; control/DOM selections as
  blockquote/markdown per their helpers; the captured markdown is appended to the composer's
  pending input (`useInputStore.setPendingInputText(markdown, 'append')`), focus moves to the chat
  composer. With nothing selected the shortcut just focuses the composer.

## 10.6 Review flow (`lib/reviewFlow.ts` + `ReviewFlowDialog`)

Trigger: DiffView `"Review"` button → dialog (`"Review changes"`, description `"Start a separate
review session for the current changes."`, options `"Generate handoff"` and `"Run automatic review
loop"`, actions `"Review"`/`"Starting..."`/`"Cancel"`; info line about starting it from the
implementing session).

1. Wait for sync connection (`waitForConnectionOrThrow`).
2. **Handoff** (default on): send a visible prompt `session.reviewHandoff.visible` + synthetic
   instructions `session.reviewHandoff.instructions` to the original session; wait for the first
   completed assistant text after start (**timeout 180 s**, poll **400 ms**; completion via
   `finish`/`time.completed`).
3. Create or reuse a review session: the original session's metadata
   (`openchamber.reviewSessionID` + review marker) is the link; else create a session titled
   `"Review: {original title}"` marked as a review session and link it back (rollback deletes the
   orphan review session if linking fails). Non-auto flows open the review session as a context
   chat tab (mode `chat`, dedupe `session:{id}`).
4. Send the review prompt (`session.reviewSession.visible` with `{handoff}`) to the review
   session with the caller's model/agent/variant.
5. **Auto-review loop** (option): poll loop between the two sessions — reviewer status
   `waiting_for_reviewer` → reviewer's latest completed text forwarded into the original session
   (prompt `session.reviewFeedbackToImplementer.visible` with `{review_feedback}`); implementer
   phase forwards back into the review session
   (`session.implementationResponseToReviewer.visible` with `{implementation_response}`);
   reviewer instructions append the synthetic contract: end the response with exactly
   `FINAL_REVIEW_STATUS: no_remaining_findings` when no issues remain; loop caps at **15
   iterations**; forward claims are single-flight keyed `runtime:original:phase:parent:message`;
   runtime switch stops the run (`"Auto-review stopped because the runtime changed."`); run states
   `running|waiting...|complete|stopped|error` live in `useAutoReviewStore`, UI in doc 12.
6. Non-auto flows stop after sending the review prompt and opening the panel; the user manually
   uses the transfer buttons (`getReviewTransferDirection` → `review-to-original` /
   `original-to-review`) which send the manual prompts above.

---

# 11. Caching and invalidation trigger tables

## 11.1 Git status/diff/log/branches (useGitStore)

Cache (per `directory`, runtime-scoped): status, branches, log (maxCount state), identity, per-file
diff cache (LRU 30/20 MiB per dir; 200 entries/20 MiB global), `indexRevision` bumps.

| Item | Stale after | Trigger to refresh |
|---|---|---|
| Repo probe (`checkIsGitRepository`) | 60 s (`REPO_CHECK_STALE_THRESHOLD`) | next status fetch |
| Status (`/api/git/status`) | 5 s (`STATUS_STALE_THRESHOLD`) | `ensureStatus`/`fetchAll` age checks; git refresh hints; mutation queue completion + 15 s reconcile; worktree bootstrap completion |
| Light status (mode=light) | treated as status; diffStats merged from previous full status | same |
| Branches | 30 s | `ensureAll`; stale-while-revalidate branch cache (localStorage `oc.gitBranchCache.v2`, ≤ 8 runtimes × ≤ 50 directories) seeds instant paint |
| Log | 10 s | `ensureAll`, explicit refresh, log-size change |
| Identity | 60 s | `ensureAll` |
| Per-file diff cache | content change: removed paths or changed `index/working_dir`/diffStats drop that path on next status fetch | `clearDiffCache(paths)` from git refresh hints; `fileDiffRefreshNonce` per entry |
| Index revision | always bumped by mutations | consumers re-key to re-read status |

Status request in-flight join: same mode + same `statusMutationRevision` only. Mutations
(`moveStatusPathsOptimistically`, `restoreStatus`, `bumpIndexRevision`) and
`notifyGitStatusInvalidated` (from `sessionEvents.requestGitRefresh` and git adapters) bump the
mutation revision so a pre-mutation in-flight response can neither be joined nor committed after a
refresh.

## 11.2 File content (FilesView)

| Cache | Invalidate when |
|---|---|
| Draft + baseline | selection change; runtime/root change; content-invalidation event (non-dirty); successful save (baseline := draft) |
| Stat snapshot (`lastLoadedFileStatRef`) | successful save re-stat; observed external change; failed read **not**; file load |
| Editor scroll/selection snapshot | unmount only (kept in the 100-entry map) |
| Preview scroll positions | per position key, 100-entry LRU; line-anchored while possible |
| Open-file tab staleness stat probe | on mount |
| Directory snapshots | scope change (runtime/root/hidden/gitignored); explicit refresh after mutations; 8 s poller; refresh-on-resume |
| Outside grants | expiry (−5 s renewal buffer); runtime switch |
| Pierre content cacheKey | content length/hash change; worker pool readiness |

## 11.3 Diffs — comparison sources

| Source | Authority | Invalidation |
|---|---|---|
| Working/staged (store cache) | `useGitStore.diffCache` | git refresh hint paths; status-derived path change; LRU |
| Branch range | `useGitComparison` (range key `JSON[runtime, dir, source]`) | branch-base revision (`[runtime, statusFetchedAt]`); manual refresh; runtime change; entry retries |
| Commit range | same hook | `commitSelectionKey` change (branch/checkout); manual refresh |
| PR snapshot | `PullRequestSnapshotCache` (8 snapshots / 32 MiB) | confirmed push (`notifyGitPush`) synchronously; manual refresh (force); snapshot revision bumps invalidate **atomically** — including edits with unchanged file names/line counts |
| Turn snapshot | last user message `summary.diffs` (HARNESS PORT) | every new turn (message list change) |

## 11.4 Invalidator → consumer map (summary)

| Event | notifyGitStatusInvalidated | git refresh hint | fileContentInvalidation | gitPushEvents | others |
|---|---|---|---|---|---|
| File save (editor) | yes | yes (`paths:[relative]`) | — | — | stat re-read; drawio/loop follow-ups |
| FS tree mutations (create/rename/delete) | — | yes (parent refresh inside FilesView) | — | — | DirectoryRequests force |
| Harness tool completes (`bash`/`edit`/`write`/`apply_patch`/`patch`, HARNESS PORT) | yes | yes | (emitters may) | — | tool cards in doc 05 |
| Successful HTTP git push | — | — | — | notify (runtime captured pre-push) | PR snapshot invalidate |
| Hunk apply / stage / commit / merge / rebase / stash | yes (via adapters) | yes (paths) | implicit via status drop | — | 15 s reconcile |
| Worktree bootstrap complete | status force refresh | — | — | — | pending snapshot release |
| Runtime switch | store reset (`resetForRuntimeSwitch`, request generations cleared) | scope refs | runtime mismatch ignores | scope key includes runtime | branch cache reread |

---

# 12. States catalog

## 12.1 FilesView

| State | Trigger | Render |
|---|---|---|
| Empty | no selected file | `"Pick a file from the tree."` |
| Loading | fileLoading or asset-auth loading | spinner + `"Loading..."` (suppressed in desktop editor-only) |
| Error | fileError | error text in `--status-error` |
| Image/PDF/Binary | type gate | image pane / PDF iframe / cannot-preview center block (`"Cannot preview binary file"`, `"This file is binary and cannot be edited in OpenChamber. Download it to open with another app."`, Save file button) |
| Opening-at-change | pending navigation in flight | editor masked by overlay `"Opening file at change..."` |
| Dirty | draft ≠ baseline | "Saving..." → "Saved" cycle or Save-now pill; guard dialog on navigation |
| Tree states | searching / error / empty | `"Searching..."`, per-dir error + Refresh, root error card + Retry, `"Loading..."` |

## 12.2 DiffView

`"Select a session directory to view diffs"` (no directory); `"Loading repository status..."`;
`"Not a git repository. Use the Git tab to initialize or change directories."`;
per-scope pickers; branch "Detecting base branch..." / `"No base branch"` / `"...Failed to load
branch changes"` / `"Loading branch changes..."` / `"No changes on this branch relative to {base}"`;
commit: `"No commits found"`, loading, `"No changes in this commit"`; PR: `"Select pull request"`,
loading, retry; working: `"Working tree clean, no changes to display"`; turn:
`"No last turn changes to display"`; entry-level: loading diff, failed-to-load + Retry, large-diff
gate + `"Render anyway"`, patch/hunk unavailable toast `"This hunk is no longer available. Refresh
the diff and try again."`, unsupported runtime `"Staging individual hunks is not supported in this
runtime."`, image diff, binary placeholder.

## 12.3 GitView

Directory-less; worktree setup in progress (spinner/description/retry); `"Checking
repository..."`; nested-repo resolution states (discovering/failed/unsupported/none); clean
empty-state; busy flags for stage/unstage queue (`hasPendingIndexMutation` disables Commit), sync
action busy, commit action busy, generating message, reverting/spinner per path, identity applying;
conflict banner + dialog; dirty-switch gate; merge/rebase in-progress banner.

## 12.4 PlanView

Loading (`"Loading..."`); load error; save error; document-less (no content) when the plan mode is
disabled and no target; Send dialog busy; managed-chat disabled send buttons.

## 12.5 PR/Linear

PR: disconnected (`"GitHub is not connected"`), status unavailable, checking, loading
description, no description, not connected list etc. Linear: auth-unknown/checking, disconnected
(settings entry), loading list, list error, empty query results, loading detail, updating detail,
starting session, compact icon-only filters.

---

# 13. Build checklist

1. Retained context tabs: every review view gates effectful work on `visible`; keeps caches across
   hides; replays buffered path-scoped refresh hints on reveal.
2. FilesView: tree via DirectoryRequests (coalescing + scope invalidation), 8 s expansion poller,
   visibility resume freshness pass, dot/badge status index, search overlay, exact dialogs/menus,
   tabs store with runtime snapshots + limits, position restore map, unsaved-guard dialog,
   text/binary/image/pdf/html/json/markdown/drawio panes, per-type persisted view modes,
   large-file preview with full-draft virtualization, 1500 ms autosave with schedule/save gates and
   line-ending preservation, 2 s stat poll + double-read confirm swap, content-invalidation
   subscription, mod+s/mod+f/alt+g behaviors, pending navigation with sampled sync
   wait + retry, outside-workspace grants, mobile keyboard avoidance.
3. DiffView: scope selector + counts; branch scope availability/coercion + bounded metadata retry;
   range-keyed comparison cache; stacked defaults (6/4/2), mount window ±300 px, large-diff gate
   (>500), 15 s timeouts; canonical patch matching for hunk actions (version-header rule); PR
   snapshot cache (8/32 MiB, push invalidation); layout rules (1100 px side-by-side, per-file
   override, new files inline); Alt+Arrow navigation; open-in-editor-at-change (20k line guard).
4. PierreDiffViewer model: options table (§5.2), shadow-DOM CSS, virtualizer sharing + metrics
   (24/24/0), theme fast-path vars, selection/comment overlays, hunk action portals + offsets.
5. GitView: header cluster (branches/remotes/sync/identity/PR chip), 15 s reconcile + optimistic
   index queue with rollback; changes tree with per-file/directory/all actions and revert dialogs;
   commit section with generation/gitmoji/highlights; update-branch and re-integrate dialogs with
   operation logs; conflict dialog with per-session persistence; stash-and-retry; dirty-switch
   gate; history + graph dialogs with per-commit actions and resets; stashes dialog.
6. Worktrees: list view + ordering store + creation flows (instant draft, plan worktree, PR
   worktree) with bootstrap waits and role-back on session failure; base-branch derivation chain.
7. PlanView: resolution order (saved → file target → session paths `.opencode/plans/`), save
   queue (350 ms debounce + flush + revision dedup + runtime guard), Improve/Implement send dialogs
   incl. inline-plan-substance handling and goal arm.
8. PR/Linear surfaces: PR section segments (overview/checks/comments) with the exact action labels
   and guards; checks summary + 35 s auto-refresh; PR context cache semantics (30 s TTL, 20
   entries, detail-satisfaction rules); Linear issues list filters/compact breakpoints, ordering,
   detail actions incl. start-session.
9. Inline comments: draft store persistence limits and consumer/restore contract; CodeMirror
   widgets identical to Pierre overlays; add-selection-to-chat capture chain; review-flow numbered
   pipeline with handoff timeouts and the auto-review loop protocol (final marker string).
10. Buffers/limits sanity: every fine-print constant in Appendix A must be reproduced where users
    can observe them.
11. i18n key parity for every quoted string above; missing keys must not render raw keys on
    review surfaces.
12. Harness ports interfaces to implement on the replacement harness: message parts (tool
    state/output, user message `summary.diffs`, `openchamberContext` metadata render-back),
    sessions API (create/get/delete/send-message with model/agent/variant), file-reference outputs
    for pending file navigation and file pills, temp-directory rules for markdown-image grants, and
    the "openchamber plugin tool" neutrality in doc 05. Everything else (fs, git, projects,
    github, linear, walkthrough, plan storage) is OpenChamber server contract (doc 03).
13. Appendix B keyboard bindings registered through the shortcut registry (customizable settings
    surface is doc 12): `save_file`, `find_in_file`, `open_go_to_line`, `add_selection_to_chat`
    must react to the effective (possibly re-bound) combo, not hard-coded keys — the editor
    handlers above check the event target scope and read the effective combo via
    `getEffectiveShortcutCombo` for display strings.

---

# 14. Appendix A: consolidated constants and timings

All numbers observed by users or that gate observable behavior. Source columns abbreviate
FilesView/DiffView/GitView unless noted.

| Constant | Value | Used by |
|---|---|---|
| `LARGE_FILE_CHAR_THRESHOLD` | 200,000 chars | initial preview mode; pierre preview virtualization; cache key |
| `MAX_CONTENT_POLL_BYTES` | 200,000 bytes | stat-poll content swap limit; beyond → full reload |
| `MAX_OPEN_FILE_LINES` | 20,000 lines | context file open guard (too-large refusal), open-at-change validation |
| Markdown preview size warning | 500 KiB (`512,000` bytes) | clamp warning banner |
| `AUTO_SAVE_DELAY` | 1,500 ms | FilesView text autosave; Draw.io preview autosave |
| "Saved" status linger | 2,000 ms (TTS/plan copies: 1,200 ms; Draw.io check: 1,500 ms) | transient indicators |
| Stat poll interval | 2,000 ms | open-file external-change polling |
| Directory poll interval | 8,000 ms | expanded-tree refresh (visible only) |
| Search debounces | 200 ms (tree) / 120 ms (preview find) / 350 ms (PR list, Linear, branch compare) | various |
| Plan autosave debounce | 350 ms + close/switch flush | PlanView save queue |
| Shiki re-tokenize idle | 180 ms | CodeMirror shikiHighlight |
| Pierre large content | 500,000 bytes | degraded highlighting thresholds |
| `EXPANSION_LINE_COUNT` (pierre) | 20 lines | hunk expansion |
| Diff request timeout | 15,000 ms | working/staged entries + diff prefetch |
| `PATCH_DIFF_CACHE_LIMIT` | 64 entries | `fileDiffFromPatch` LRU |
| `LARGE_DIFF_CHANGED_LINES` | 500 | large-diff gate |
| `STACKED_DIFF_MOUNT_MARGIN` | ±300 px | mount window |
| Default expanded count | n≤6→n; ≤12→6; ≤25→4; else 2 | stacked scope change |
| `SIDE_BY_SIDE_MIN_WIDTH` | 1,100 px | auto layout threshold |
| Full-context context lines | 1,000,000 (`FULL_CONTEXT_DIFF_LINES`) / default 3 | display requests |
| Store diff cache | 30 entries/20 MiB per directory; 200 entries/20 MiB global | useGitStore LRU |
| Prefetch caps | max 40 (focused) / 25 (status-driven); baseline first 20; >500 changed lines skipped; threshold check 120 ms; concurrency 2; timeout 15 s | GitView/DiffView prefetch |
| Git stale windows | repo probe 60 s; status 5 s; branches 30 s; log 10 s; identity 60 s | useGitStore |
| Branch cache (localStorage `oc.gitBranchCache.v2`) | ≤ 8 runtimes × ≤ 50 directories | stale-while-revalidate seeds |
| Reconcile delay after index mutation | 15,000 ms | GitView scheduleGitReconcile |
| Nested-repo discovery | per (runtime, root) single flight; selection cached ≤ 8 runtimes × ≤ 50 roots | useGitStore |
| `useGitBaseBranchStore` | per (directory, branch) overrides | branch scope base |
| Editor positions LRU | 100 entries | FilesView + preview scroll maps |
| Tabs store | 20 roots; 50 open paths; 500 expanded paths; 4,096 char paths; 90-day root TTL; 8 runtime snapshots | files-view-tabs-store |
| Commit selection store | map bound 100, LRU on select | shared commits |
| PR context cache | 30 s TTL, ≤ 20 entries, detail-inclusive satisfies plain | usePrContextStore |
| PR snapshot cache | ≤ 8 completed snapshots, ≤ 32 MiB text | PullRequestSnapshotCache |
| PR checks auto-refresh | 35,000 ms; action refreshes +2 s/+5 s; min spin 600 ms | PullRequestSection |
| PR list page | paged via `prsList(page, query)`; search debounce 350 ms | usePullRequestComparison |
| Commit picker history | 50 commits | useCommitComparison |
| Graph log default | 100 entries (size selectable) | Graph dialog |
| Visible commit counts | 25/50/100 | History dialog |
| Reviews | handoff timeout 180 s; poll 400 ms; auto-review poll 300 ms; max 15 iterations; final marker `FINAL_REVIEW_STATUS: no_remaining_findings` | reviewFlow |
| Walkthrough stage cadence | 450 ms per stage incl. final | useWalkthroughStageProgress |
| Inline comment drafts | 50 sessions; 20 drafts/session; 1 MiB persisted | inlineCommentDraftStore |
| Worktree branch name | generated (`generateBranchName`) | creators |
| Outside grants | expiry −5,000 ms renewal buffer | outsideFileGrants |
| Linear compact breakpoint | 520 px | LinearIssuesView |
| Editor-only tree suppression | mode 'editor-only' non-mobile | FilesView |
| Scroll attempts (diff nav) | 20 rAF tries | DiffView alignment |
| Mobile caret clearance | 20 px above keyboard overlap | FilesView nudge |
| HTML preview sandbox | allow-scripts allow-same-origin allow-forms | FilesView iframe |
| GoToLine retry | rAF per keystroke state; Escape/outside restores | GoToLineDialog |
| Status merge/rebase conflict codes | index/working_dir `U` (and `AA`/`DD`) counted as conflicts | GitView |

# 15. Appendix B: keyboard shortcuts on these surfaces

Registered ids (default binding; `mod` = Cmd on macOS / Ctrl otherwise). All below are from the
shortcut config (`lib/shortcuts/config.ts`):

| Id | Default | Scope | Behavior here |
|---|---|---|---|
| `save_file` | `mod+s` | editor wrapper focus | cancels pending autosave; saves immediately; display strings embed the effective combo |
| `find_in_file` | `mod+f` | editor or preview container | opens CodeMirror search; in markdown preview mode opens the preview find bar (desktop only) |
| `open_go_to_line` | `alt+g` | edit mode, editor focus, non-dialog | opens the inline Go-to-line panel |
| `add_selection_to_chat` | `mod+l` | any non-composer selection, or none | appends capture (§10.5) to composer and focuses it; with no selection just focuses |
| (window-level, not registry) | `alt+arrowdown`/`alt+arrowup` | DiffView visible | step review selection to next/previous changed file |

Display convention: shortcut labels are rendered via `formatShortcutForDisplay(getEffectiveShortcutCombo(id))`
so re-bound shortcuts show correctly (e.g. Save-now tooltips).

---

*End of document 06. Cross-references: doc 03 (routes), doc 05 (chat parts/tool cards + gallery),
doc 10 (VS Code deltas), doc 12 (goal + multi-run review UI + settings), doc 13 (walkthrough +
preview chrome), doc 14 (theme/icons/Shiki/codemirror tokens).*
