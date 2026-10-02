# NOTES 06 — Review surfaces (from docs/planning/06)

> **Historical implementation note — 2026-10-01:** Retained for contracts and dated evidence.
> Current scope, ownership, remaining work, and acceptance are defined by
> [PLAN](../PLAN.md) and the [execution audit](../EXECUTION/01-architecture-audit.md).
> Old mock-only, auto-accept, lifecycle, and deferral instructions are superseded.
> A recorded test pass is limited to its stated version and surface.


Doc read in full (1,693 lines). P6 sliced as below; nothing relaxes the
contracts — this file records slice maps, harness-port dispositions (they
land with PA0020), and deltas for the multi-session build.

## A. Slice map vs doc-06 build checklist (§13)

- **P6-1 (this slice)** — §2+§3 core: fs read/stat/raw server routes
  (doc 03 §5.14 subset), DirectoryRequests tree loading (§2.1: coalescing,
  force, scope clear), 8 s expansion poller + resume freshness pass, search
  (§2.3 via /api/fs/search, 200 ms debounce), row menus + create/rename/
  delete dialogs (§2.4/§2.5 exact strings), open-file tabs store (§2.6
  shape + limits + runtime snapshots), text editor v1 (§3: load pipeline,
  line-ending discipline + CRLF restore, binary sniff, autosave 1,500 ms
  with schedule/save gates + O_TRUNC guard, stat poll 2,000 ms +
  double-read confirm swap, unsaved-guard dialog, Go-to-line v1 inline,
  mod+s/save-now, image/unsupported panes via /api/fs/raw with
  `file-viewer-preview` settings key). Inline comments/PDF/HTML/JSON/
  drawio/markdown-preview→P6-3/v2.
- **P6-2** — §5+§6 core: diff data model (§5.1 patch handling incl. LRU 64,
  hunk split, anchors, version-match rule), /api/git/diff + /api/git/
  file-diff + /api/git/apply-hunk + stage/unstage (+ /api/git status full
  family reconciliation), first-party diff renderer behind the documented
  MODEL (unified + side-by-side, hunk actions stage/unstage/discard, large
  gate >500, mount-window decisions scoped to list), DiffView scope
  selector subset **all|working|staged** (turn = PA0020; branch/commit/pr =
  need /api/git/range-* routes + PR snapshot = P11), GitView changes tree +
  stage/unstage optimistic queue (§6.4) + commit (§6.5 sans AI generation =
  PA; gitmoji = P9) + clean empty state.
- **P6-3** — §3.4 positions map + §8 PlanView (save queue 350 ms + flush +
  revision dedup + runtime guard) + §10.1 inline-comment draft store +
  §10.2 lifecycle on CodeMirror-replacement editor + §10.5
  add-selection-to-chat + §7 Worktree list/version (creation flows =
  worktree domain → P6-3 if budget, else P8 with PA).
  Delivered 20260917-8: §3.4 sticky position map (textarea-host v1),
  §8.2/§8.3 save queue (per-key serialized chains, revision watermark
  dedup, failed-write clears while-latest, live-runtime drop, pendingFor),
  §8.1 fresh load awaits pendingFor before reading, §8.4 PlanView with
  close/switch flush, §8.5 session-plan path v1, §10.1 draft store (50
  sessions / 20 drafts / 1 MiB byte-LRU, consume/restore with pinned id),
  §10.5 capture chain (composer excluded) + composer append/focus wiring;
  §7 WorktreesView list + ordering. NOT in this slice → E-06-9..13.
- **P6-3b (delivered 20260917-9)** — §10.2 comment lifecycle v1 on the
  textarea hosts: controller path (session-target gate + exact
  "Select a session to save comment" toast, range normalization, code
  extraction from the SNAPSHOT frozen at begin, create focuses the composer
  through the focus channel; update/delete; outside mousedown cancels only
  while the input text is empty), input + card widgets with the doc labels
  ("Lines {start}-{end}" 1-based display, placeholder with the save
  shortcut, Edit/Delete comment), source 'plan' (markdown) on PlanView and
  source 'file' on FilesView; the RENDER rail is a line-list approximation
  until the CodeMirror slot widgets (E20/E-06-11) and modern §10.3 Pierre
  diff overlays stay registered. §7 delivered live: worktree topology
  family v1 (doc 03 5.13 #61/63/66: list/create/remove, managed root =
  dataDir/git-worktrees/<slug>/<name>, primary-run removal with Windows
  transient retry + prune fallbacks, dirty refusal without --force,
  create's name slug-sanitized), WorktreesView dialog + remove + order
  persistence. MainLayout: plan pane + worktrees overlay toggles;
  ShellShortcuts wires add_selection_to_chat (mod+l) to the capture
  chain (§10.5); the §10.5 selection-toolbar registry and §10.4
  FilePreviewCommentMenu remain registered (P11/E-06 distances).
- Deferred beyond P6 core: §9 PR/Linear (needs GitHub/Linear server
  families + auth = P11), §5.3 branch/commit/pr scopes (range routes P6-2+
  if cheap; PR snapshot P11), §8.6 walkthrough (P10/doc 13), §10.6 review
  flow (P8/doc 12), Formatters §Appendix B editor keys already registered
  in P5-5 config (`save_file`/`find_in_file`/`open_go_to_line`/`add_
  selection_to_chat`).
- **E-06-4** (registered P6-2 review): outside-workspace grant params
  (`?allowOutsideWorkspace&outsideFileGrant` on stat/read/raw + fs/serve)
  are DESKTOP-runtime grants (§2.8); the web build issues none and the
  server 403s grant attempts — grant plumbing lands with P12/doc 08.
- **E-06-5** (registered P6-2 review): the web RuntimeAPIs adapter exposes
  the scoped Files and 13 existing Git operations through their shared server
  clients. Shared UI consumers use runtime-neutral facades backed by the
  registered adapter; Files and Git transport code stays behind the web
  adapter, and Git status derivation remains pure.
- **E-06-6** (registered P6-2 review): sidebar tree deltas of §2.9a
  (uploads, marquee names, drag-drop) + gitignored heuristics ride P6-3/the
  sidebar surface; `search` remains bounds-limited (depth 3 / 100 dirs
  server walk, registered vs §2.3's 150-limit).
- **E-06-7** (registered P6-2): sidebar surfaces "Collapse all folders" +
  upload-to-path drop targets (§2.9a) and § + row-menu reveal/download
  actions (§2.4 tail: Copy Path, Save/Download, Reveal) land with the
  sidebar surface; en keys already registered.
- **E-06-8** (registered P6-2): the untracked-file diff (empty `git diff`
  output) needs the content path (`git show :/`-style or --no-index) —
  defer with the image diff (§5.11) builder.
- **E-06-9** (registered P6-3): session-plan resolution v1 = deterministic
  FNV-1a epoch per directory (`planEpochFor`) as the `<created>-ms` slug
  stand-in; real session create-ms resolution, `.opencode/plans`
  discovery of EXISTING candidates, and saved-project-plan routes land
  with the session domain (P9).
- **E-06-10** (registered P6-3): §10.4 Improve/Implement send dialogs and
  the §10.1 consumeDrafts→send path ride the P8 send family; the composer
  fill channel already carries `append`.
- **E-06-11** (registered P6-3): §10.2 comment-dialog lifecycle + §10.3
  slot widgets on the editor host = P6-3b (textarea-host v1; CodeMirror
  swap = E20). File-editor captures fall back to no language until
  languageByExtension exists (E20 surface). The mod+l binding is
  registered in the P5-5 config; the dispatcher→captureToChat wiring and
  MainLayout toggles land with P6-3b.
- **E-06-12** (registered P6-3): §7 worktree creation/repair dialog flows,
  `git worktree` server family, and WorktreesView→MainLayout wiring =
  P6-3b; ordering store persists `mobile-worktree-order` (doc §7 key).
- **E-06-13** (registered P6-3 review): the draft envelope uses
  shape-validation until zod clears the PA dependency registry; the swap
  is mechanical (validated `parseEnvelope` boundary already isolated).
- **E-06-14** (registered P6-3b review): `env.ts` `ENV.dataDir` evaluates
  eagerly at import — server tests that touch the managed roots MUST set
  `NOTNATIVE_DATA_DIR` before the first (dynamic) import of route code;
  codify the dynamic-import rule or make dataDir per-call lazy before more
  server suites land.
- **E-06-15** (registered P6-3b review): plan-host CRLF — strip `\r` from
  draft `code` at the E20 CodeMirror swap; plan reads must not normalize
  endings (the save path preserves it, P6-3 core).
- **E-06-16** (registered P6-3b review): decide the `deleteLocalBranch`
  failure contract (error field in the #66 `{success}` envelope) together
  with the #62 validate family.
- **E-06-17** (registered P6-3b review): i18n sweep for pre-existing
  editor literals ("Wrap: on/off", "Auto-save on/Manual save", "Unsaved",
  worktree aria arrows, plain "X" close, header titles).
- **E-06-18** (registered P6-3b review): self-removal guard/confirm for the
  worktree the app itself points at (uses /api/git/worktree-type #67) when
  per-card worktree metadata lands.

## B. Brand seam + harness port mapping

- `openchamber:*` storage keys → `notnative:*` (viewer-mode keys:
  `notnative:files:md-viewer-mode` etc. when P6-3 previews land).
- HARNESS PORTS in this doc: file references → pending file navigation
  (§3.8), tool-transition git refresh (§5.9), turn summary.diffs (§5.3),
  commit-message generation + PR autocomplete (P11/PA), harness temp-dir
  markdown-image grants (§2.9). All sit behind interfaces; the mock
  harness implements none of them yet (PA phase).
- `/api/fs/raw` asset auth uses the runtime token (the URL-token lifecycles
  from P4-1) — raw responses honor `?download=` + `no-store` + nosniff.

## C. First-party renderer swap (delta E19) + editor swap (E20)

- §5.2 PierreDiffViewer and §3.10 PierreFile/Shiki/code preview: P6 renders
  behind the DOCUMENTED MODEL with a first-party renderer (data model,
  headers, hunks, separators) — the doc itself allows the renderer
  substitution (index §5.2 / §M());
- CodeMirror 6 (+ vim, MOD+keymaps config, language pack, shiki token
  colors) is replaced in v1 by a controlled textarea host that implements
  the SAME surrounding contracts: slot widget area for inline comments
  (P6-3), save gates, GO-to-line (textarea selection mapping), read-only
  property, position RESTORE map (§3.4). Swap to CodeMirror lands as E20
  when the dependency is approved; every gate is isolated to one host
  module.
- E21: sidebar tree deltas of §2.9a (uploads, collapse-all) register with
  the sidebar surface work; gitignore heuristics = status-driven (P6-2),
  not `.gitignore` parsing (registered approximation).

## D. Constants pinned this slice (§Appendix A)

Directory poll 8 s; tree search debounce 200 ms; tabs store limits (20
roots / 50 open / 500 expanded / 4,096 chars / 90-day TTL / 8 snapshots);
AUTO_SAVE_DELAY 1,500 ms; "Saved" linger 2,000 ms; stat poll 2,000 ms;
MAX_CONTENT_POLL_BYTES 200,000; LARGE_FILE_CHAR_THRESHOLD 200,000; empty
read-retry schedule 50/100/150 ms; positions LRU 100 (P6-3). Tab close
discard guard has NO cancel path (§2.7). P6-3 pins: PLAN_AUTOSAVE_DEBOUNCE
350 ms; inline drafts 50 sessions / 20 per session / 1 MiB envelope
(byte-indexed); worktree order key `mobile-worktree-order`; drafts storage
key `notnative.inlineComments.v3`; comment slots freeze content at begin
(v1; E20 swap keeps the contract); worktree managed root =
`<dataDir>/git-worktrees/<project-slug>/<name>` with name slugs capped at
60 chars; P6-3b removal retry = 4 x ~1 s (Windows transient), no --force.
