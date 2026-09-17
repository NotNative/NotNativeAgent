# NOTES 06 — Review surfaces (from docs/planning/06)

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
- Deferred beyond P6 core: §9 PR/Linear (needs GitHub/Linear server
  families + auth = P11), §5.3 branch/commit/pr scopes (range routes P6-2+
  if cheap; PR snapshot P11), §8.6 walkthrough (P10/doc 13), §10.6 review
  flow (P8/doc 12), Formatters §Appendix B editor keys already registered
  in P5-5 config (`save_file`/`find_in_file`/`open_go_to_line`/`add_
  selection_to_chat`).

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
discard guard has NO cancel path (§2.7).
