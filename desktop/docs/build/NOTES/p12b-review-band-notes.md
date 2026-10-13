# P12B — SLICE-B review-band working notes

> **Historical implementation note — 2026-10-01:** Retained for contracts and dated evidence.
> Current scope, ownership, remaining work, and acceptance are defined by
> [PLAN](../PLAN.md) and the [execution audit](../EXECUTION/01-architecture-audit.md).
> Old mock-only, auto-accept, lifecycle, and deferral instructions are superseded.
> A recorded test pass is limited to its stated version and surface.


Working notes for SLICE-B (`review-band`). Contract sources: SECTION-4-slice-plan.md
(SLICE-B, line 75+), planning/06 (§2/§5/§6/§11/§13), SECTION-3 §3.5/§3.6,
SECTION-2 §2.5, engine-support.ts:76–85. OC reference read-only (cleanroom).

## Slots (one heading per area — filled as work lands)

### §11/§13#1 refresh hints (files-buffered model, reimplemented cleanroom)

- `packages/ui/src/lib/git/refresh-hints.ts` — publish/subscribe bus
  (`publishReviewRefresh(directory, paths, reason)`, `subscribeReviewRefresh`),
  `ReviewRefreshBuffer` (union paths, ordered reasons, `null` paths wins,
  128-path cap overflow ⇒ pathless), `useReviewRefreshHints(directory, visible,
  replay)` (hidden → buffer; reveal → one merged replay via macrotask; visible
  → coalesced single replay), `__resetReviewRefreshForTests()`.
- Publishers: FilesView.tsx (`publishWorkspaceHint`): file-save
  (FilesView.tsx:101), create/rename/delete fs-mutation (FilesView.tsx dialog
  commits); GitView.tsx stage/unstage/discard/commit publish `git-mutation`
  (GitView.tsx:176/206/216); DiffView model publishes after hunk + stage ops
  (diff-view-model.ts `stageEntries`/`runHunkAction`).
- Subscribers: DiffView model (`useDiffStatusFeed` → hint = store
  `clearDiffCache` + local diff wipe + `invalidateStatus`+restat,
  diff-view-model.ts:100–137); GitView (hint → invalidateStatus + light restat
  + branch refetch, GitView.tsx:99–107); FileTree (restat + in-place
  force-refresh of affected parent directories via
  `parentDirsForHint`/`dirKeyForRelative`, file-tree-git-status.ts:89–120).
- Tests: `src/lib/git/__tests__/refresh-hints.test.tsx` (4): bus
  publish/unsubscribe; buffer merge/cap/foreign-dir; hidden buffering +
  reveal replay merge; visible burst coalesces to ONE replay.

### FileTree status dots + badges + visible cadence

- `packages/ui/src/lib/git/file-tree-status.ts` — `buildFileTreeStatusIndex`
  (git-added A/? → success, git-deleted D → error, git-modified M → warning;
  FolderBadge {modified, added} aggregated per ancestor via
  `treeAncestorDirsOf`), `treeStatusColor`, `EMPTY_STATUS_INDEX`.
- `packages/ui/src/components/files/file-tree-git-status.ts` — `useGitTreeStatus`:
  15 s light-status cadence while visible && !document.hidden
  (GIT_STATUS_POLL_INTERVAL_MS from lib/files/edit-support.ts:20
  `GIT_STATUS_POLL_INTERVAL_MS = 15_000`), published snapshot →
  `useGitStore.applyStatus` so DiffView/GitView reuse it; hint replay restat +
  parent-dir force refresh.
- FileTree.tsx: dot color precedence open-tab (info) > git status;
  `data-testid="file-status-dot"`, FolderBadge spans (M/+); FileNode carries
  `relativePath` (workspace-relative POSIX via lib/files/workspace-paths.ts —
  `workspaceRelativePath`/`parentDirOfPath`/`normalizeSeparators`).
- Untracked recovery: server porcelain route erases `?` (0x3F → ' '), so
  `packages/ui/src/lib/git/api.ts` `normalizeStatusFiles` re-marks ' '/' ' +
  staged!==true rows to index:'?', working_dir:'?' (api.ts:214–228);
  `isStagedStatusFile` (index X significant) / `isWorkingStatusFile` (Y
  significant OR index '?').
- Tests: `src/lib/git/__tests__/git-status.test.ts` (5): index precedence,
  badges (root {modified:2, added:1}, src, src/deep; windows separators),
  colors, untracked recovery, grouped per-scope membership (MM in both).
  `src/lib/files/__tests__/workspace-paths.test.ts` (2).

### Diff band (scope stacks, gate, hunks, anchoring, cadence, hints)

- `packages/ui/src/components/diff/diff-view-model.ts` (headless model) +
  `packages/ui/src/components/diff/DiffView.tsx` (JSX ≤300 lines each):
  scope chips all|working|staged (`diff-scope-*`, aria-pressed, §5.5);
  entries keyed PER SCOPE `${path}|${staged?'staged':'unstaged'}` so one file
  (e.g. "MM") renders in both stacks with its own patch; staged stack first;
  §5.4 default expansion 6/6/4/2 first paint (diff-view-model.ts
  `defaultExpanded` + `useDiffPieces`); §5.6.c large gate
  >500 lines (`LARGE_DIFF_CHANGED_LINES`, diff-model.ts) with explicit
  "Render anyway" per `path|scope` key (`diff-large-gate`,
  `diff-render-anyway`); §5.6.d hunk actions scope-aware (unstaged →
  stage|discard; staged → unstage|discard; `diff-hunk-{kind}-{index}`) riding
  `POST /api/git/apply-hunk` with exactly ONE hunk (server contract guarantees
  at packages/web/src/server/routes/git-diff.ts:211–214) after
  `haveMatchingPatchVersions` (FULL index-hex blob match, diff-model.ts);
  §6.4 optimistic stage queue with rollback (`moveStatusPathsOptimistically`
  → REST → `keep index revision` + store cache drop + 15 s reconcile + full
  restat + hint publish); §6.3 15 s light cadence while visible; §5.8 anchor
  capture/restore across refreshes (lib/git/diff-scroll-anchor.ts
  `findDiffScrollAnchor`/`getRestoredDiffScrollTop`; 2 rAF restore,
  DiffView.tsx `useAnchorRestore`/`captureAnchor`).
- parsePatch now carries the `@@` hunk range header (lib/git/diff-model.ts
  `parsePatch`: hunkHeader = the '@@ -o,n +p,q @@' line; file headers skipped)
  so per-hunk headings render the true range.
- Tests: `src/components/diff/__tests__/diff-view.test.tsx` (5): per-scope
  both-stacks render (distinct staged/working patches); scope selector
  filtering; >500 gate + render-anyway; scope-aware hunk buttons + single-hunk
  apply-hunk body assertions + `git-mutation` hint; visible hint replay
  re-fetch. `src/lib/git/__tests__/diff-scroll-anchor.test.ts` (4).
  `src/lib/git/__tests__/diff-model.test.ts` (5, pre-existing + retain).

### Git band (cadence, dialogs, hint publish)

- `packages/ui/src/components/git/GitView.tsx` — `visible` prop; reveal = light
  restat + branch fetch; 15 s light cadence (skip document.hidden); hidden→
  visible full sweep via `ensureAll`; optimistic stage/unstage with rollback;
  revert confirm dialog → `POST /api/git/discard` (paths[]); commit gate =
  disabled button until message + staged files; Commit/Commit & sync; §6.8
  dialogs via `Packages/ui/src/components/git/git-dialogs.tsx`:
  `git-history-dialog` (read-only /api/git/log; 25/50/100 maxCount chips +
  Load more + per-commit Copy SHA), `git-branches-dialog` (read /api/git/
  branches; local/remote groups + Current marker; checkout/merge/stash are
  DEFERRED — no mutate routes exist server-side).
- Both-scope grouping: `useGitStore.groupedStatusFiles` per-scope significance
  (store.ts:178–205 region — staged = index X significant; working = Y
  significant OR index '?'), so an "MM" file appears in both sections.
- Store additions: `applyStatus(directory, status, mode)` (tree publishes its
  light snapshot; store.ts) and `invalidateStatus(directory)` (drops ONLY the
  status entry, keeps diff caches — used by hint replays).
- Tests: `src/components/git/__tests__/git-view.test.tsx` (6): sections +
  stage/unstage POST bodies + hints; discard confirm flow; commit gate
  (disabled until message + staged) + POST body + toast; history dialog rows
  + branch dialog groups/'Current'; hint replay restat; 15 s cadence with
  fake timers (advanceTimersByTimeAsync 15.5 s → second status fetch).

### Terminal (real PTY wiring via the terminal lib; view unchanged — already real)

- `packages/ui/src/lib/api/terminal-adapter.ts` — `createRealTerminalApi()`:
  RuntimeAPIs.terminal over lib/server-api REST (createTerminalSession
  mapping TERMINAL SLICE create contract; `status` mapped running/exited/
  error; terminal-mode command passthrough {cwd, command}) +
  `getTerminalTransport().subscribe` projected through `wireFrameToStreamEvent`
  (snapshot w/ exitCode+signal, restarted → blank snapshot, output prefers
  replay-safe `r`, exit, reconnecting; hello/pong suppressed; `error` frames
  → handlers.onError), `sendInput` → transport write frame `{t:'write',s,d}`,
  `resize` → POST /terminal/:id/resize, `close` → DELETE, `listShells` →
  /api/terminal/shells.
- `packages/web/src/api/createWebAPIs.ts:7,45` — the P0 `createStubTerminal`
  is REPLACED by `createRealTerminalApi()` (only the slice-named change;
  git/files Proxy stubs untouched). TerminalView.tsx itself was already real
  (create/subscribe/quick-keys/restart/kill all wire-backed) — its suite
  (components/terminal/__tests__/terminal-view.test.tsx, 2 tests) still passes
  unchanged.
- Tests: `src/lib/api/__tests__/terminal-adapter.test.ts` (3): frame
  projection table; createSession ok/!ok mapping; connect pipe + write frame
  shape + DELETE close.

### Active-directory binding + visibility-driven refresh (MainLayout)

- `packages/ui/src/components/MainLayout.tsx:117–147` — review panes resolve
  `defaultHarnessDirectory()` (packages/ui/src/sync/engine-support.ts:76–85)
  into `harnessDirectory` state when neither `view.activeDirectory` nor
  `global.path.directory` is set (and seeds the session store once); the
  literal `'/'` fallback is GONE (MainLayout.tsx:158 `activeDirectory =
  normalizeDirectoryInput(view.activeDirectory || globalHome(global) ||
  harnessDirectory)`). All panes (Files/Diff/Git/Plan/Terminal/Worktrees)
  receive that resolved directory.
- Visibility: panes are conditionally MOUNTED (ternary chain at
  MainLayout.tsx:250–275), so `visible === mounted`. GitView takes `visible`
  explicitly (defaults true); Files/Diff/Terminal keep the same pattern as
  before. Retained-with-hidden mounting (§5.9 remainder) stays DEFERRED —
  the hint buffer already supports hidden accumulation (util lib + tests).
- Worktrees dialog verified: `packages/ui/src/components/worktrees/
  WorktreesView.tsx` — live topology via listWorktrees/createWorktree/
  removeWorktree (lib/server-api.ts) → /api/git/worktrees routes (#63/#66),
  ordering store (doc §7), create dialog mode 'new'. No SLICE-B change was
  required (pre-existing real wiring; suite green).

### Gates + tallies (final, recorded 2026-09-22)

- ui vitest: 73 files / 646 tests passed (baseline 617/617 + 29 new SLICE-B
  tests; executor prints exit code 1 with all tests green — same artifact as
  the baseline run, act-warning/unhandled-rejection markers; zero failing
  tests in both runs).
- web vitest: 43 files / 644 tests passed (baseline 644/644; same exit-code
  artifact; one environmental StackOverflow crash during a concurrent
  memory-pressure run — clean rerun all green).
- tsc: packages/ui/tsconfig.json 0; packages/web tsconfig.ui.json 0;
  tsconfig.cross.json 0; tsconfig.server.json 0.
- node scripts/quality-gates.js → 0 (file ≤500: DiffView.tsx 245,
  diff-view-model.ts 343, FileTree.tsx 437, file-tree-git-status.ts 95,
  FilesView.tsx 479, GitView.tsx 336, git-dialogs.tsx 182,
  terminal-adapter.ts 104 — all under the cap; function ≤60 enforced
  across 350 production files, passing).
- node scripts/repository-graph.js regenerated docs/architecture/repository-
  graph.{json,md} (350 modules; `--check` 0).

### Deferred (explicit)

- GitView §6.7 checkout/merge/stash actions: server mutate routes do not
  exist; dialogs are read-only (file:line GitView.tsx header + git-dialogs.tsx
  doc comment). Next step: add POST /api/git/checkout family, then wire
  actions in the dialogs.
- Untracked-file diff render (E-06-8): no textual patch until first staging;
  DiffView shows the §5.6 "No textual diff" placeholder (DiffView.tsx
  `diff-no-hunks`).
- Review-pane retained-with-hidden mounting (history/back-swap semantics §5.9):
  panes unmount on switch today; hint buffering already supports hidden
  accumulation. Next step: keep mounted + hand `visible={pane==='x'}` to all
  panes.
- Hunk keyboard navigation (§5.7), side-by-side toggle exposure, i18n sweep
  for new English literals (E-06-17), PR chip/diff prefetch (§6.10),
  jerboa positions: unchanged from the slice plan ordering.
- Git status cadence keepdown: GitView light poll + DiffView light poll +
  FileTree light poll run concurrently while their panes are open (all skip
  document.hidden); a single shared poller is the P6-3 follow-up.
