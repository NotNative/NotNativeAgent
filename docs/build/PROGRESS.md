# Progress Log

Goal: full cleanroom build of NotNativeDesktop per docs/planning (see `PLAN.md`).

| Phase | Doc(s) | Status |
|---|---|---|
| P0 scaffold + shell | 01 | ✅ done 2026-07-21 (typecheck ×3 · vitest 6/6 · vite build · prod-serve + echo-loop smoke) |
| P1 harness seam | 02 | ✅ done 2026-07-22 (typecheck ×3 · vitest 11/11 incl. in-process contract tests · vite build · live smoke: LF-8 event sequence, Last-Event-ID replay, messageID echo, permission 404-settled) |
| P2 sync engine | 04 | 🔶 done 2026-09-16 (typecheck ×3 · vitest 84/84 across 12 suites · gates+smoke · adversarial sub-agent review: P0+P1 fixed in-slice, residuals registered) |
| P3 chat UI | 05 | 🔶 P3a+P3b+P3c done 2026-09-16 (P3a: chat spine; P3b: model picker/starters/timeline/prompt-rail/BTW fork/focus mode; P3c: work-status panel §E.9 subset + §E.3/§E.4 recap+suggestion band; P3b+P3c adversarial review: P0×2 + P1×9 fixed; 122 vitest · tsc ×3 · gates+smoke · P3d/P4+ per NOTES 05 §A + review register) |
| P4 server/API | 03 | 🔶 P4-1..3 done 2026-09-16 (P4-1: fs read+git status/check pre-proxy w/ containment; P4-2: settings/themes/projects-config/context + git log/branches; P4-3: fs write family (mkdir/write/delete/rename atomic+root-refusal) + session-folders §5.22 (last-writer-wins, 413, sync write queue); P4-1 review escaped-fixes landed, P4-2 review P1×4 fixed, P4-3 review QUEUED; web 23/23 · UI 122 · gates+smoke) |
| P5 themes/settings | 14 | 🔶 P5-1..6 core done 2026-09-17 (themes, settings registry/persistence, i18n, shortcuts, settings window/pages/search/recorder); NNA-backed capability pages remain in progress. |
| P6 review | 06 | ✅ done 2026-09-17 (P6-1 fs domain + FilesView core; P6-2 diff + git view; P6-3 plan/comments/worktrees core; P6-3b inline comment lifecycle + live worktrees; per-slice adversarial reviews fixed; 359 UI · 48 web · gates+smoke+graph) |
| P7 terminal | 07 | ✅ done 2026-09-17 (P7-1 server core: WS codec v3, sanitizer, theme responses, shells, node-pty, runtime, command plane; P7-2 client: Transport/store/observer/TerminalView v1; adversarial reviews fixed; 389 UI · 94 web · gates+smoke+graph) |
| P8 remote/security | 08 | ✅ done 2026-09-20 (all 15 checklist steps delivered + reviewed: P8-1a-d auth/creds/gate/passkeys · P8-2a-c + P8-3a relay primitives/host · P8-4a/c pairing+tunnels · P8-5a relay client face · P8-5b pairing/auth UX wired · P8-5c CLI connect-url · P8-6 SSH contract faces · P8-7 reverse-proxy posture · P8-8 §12 invariants sweep (42 rows, E-08-1..69); ui 608/64 · web 511/36 · typecheck ×4 · gates+graph+smoke; deferred rows in NOTES/08 §D/§B) |
| P9 autonomy | 12 | 🔶 in progress 2026-09-20 (P9-1 message-queue server runtime delivered + reviewed: §D.1-5 store/limits/delivery loop/holds/routes + slash expansion + knowledge seam + feed reconcile; E-09-1..14; next: goals runtime (B), scheduled tasks (C), + the D.6-D.8 UI store per NOTES/12 §A/§J) |
| P10 knowledge/context | 15 | pending |
| P11 preview | 13 | 🔶 Windows dev-server discovery + browser empty-state list delivered 2026-09-26; inspection, annotation, tunnels, walkthrough pending |
| P12 Electron | 09 | pending |
| (deferred) VS Code | 10 | long-term deferred |
| (deferred) Mobile | 11 | long-term deferred |

## Log

- 2026-09-26 · **Goal ID collision hardening.** A full web run observed one
  duplicate among 200 same-timestamp goal IDs because the implementation
  truncated eight random bytes to six hexadecimal digits (24 bits). Goal IDs
  now retain all 16 hexadecimal digits (64 bits); NNA accepts the longer
  opaque IDs, and persisted legacy IDs still parse. Adversarial review found
  no compatibility defect and updated the doc-12 example.

- 2026-09-26 · **P11-2 loopback preview readiness probe.** The auth-gated
  `POST /api/system/probe-url` route now accepts only credential-free loopback
  HTTP(S) URLs, bounds the GET to 1500 ms, does not follow redirects, and
  reports a gateway 5xx as an answering server rather than a transport
  failure. Adversarial review found no concrete defect. The iframe has not
  yet adopted startup waiting; that remains with P11's browser lifecycle.

- 2026-09-26 · **P11-1 live dev-server discovery.** The browser empty state
  offers actual Windows TCP listeners from a bounded `netstat` scan through an
  authenticated NND route, with 3 s success cache and honest 503 failures.
  It excludes app/NNA-owned and known infrastructure ports, refreshes while
  visible, and requires an explicit click to navigate. Remote/LAN viewers do
  not receive host-local `localhost` suggestions until the preview tunnel is
  built. Adversarial review fixed five concrete discovery/UX failures;
  non-Windows discovery and Chromium inspection remain later P11 slices.

- 2026-09-26 · **Node source-launch and release gate repair.** The root
  `start`, dev launcher, smoke command, web-package `start`, and CLI detached
  auto-start now opt into Node's TypeScript transformation for the server's
  parameter properties. The release gate launches its smoke child the same
  way; `smoke:test` and the CLI auto-start regression pass. Adversarial review
  found the two missed launch paths before this slice was sealed.

- 2026-09-26 · **P9 live goal gate recovery.** A profile settings write now
  wakes or stops the NNA goal runtime without requiring an unrelated session
  event. A separate exchange generation keeps the runtime's own goal CAS
  events from cancelling a valid audit, while disable/delete/busy transitions
  fence further writes and continuation sends. Only a known local pre-send
  refusal receives exact-revision CAS recovery and a resume marker; uncertain
  remote send outcomes are never retried automatically. Adversarial review
  traced and fixed the pre-slot and post-slot liveness races. The guarded
  callback passes the real NND↔NNA SSE smoke; web 930/930 and typecheck ×3.

- 2026-09-26 · **P9 event-driven autonomous-goal smoke.** An isolated real
  NNA child now drives the production NND event feed and goal safety timer
  through the complete audit/continuation loop. The probe verifies the live
  idle SSE event, two independent provider audits, one continuation, and the
  persisted complete verdict. Adversarial review tightened the probe so it
  cannot pass using requests from an earlier direct-loop test or a reconnect.

- 2026-09-26 · **P9 live autonomous-goal loop smoke.** The cross-repo
  source fixture now drives the production NND goal tick and audit exchange
  over a real NNA child with an isolated provider: an initial turn is audited,
  a CAS consumes one continuation slot, the continuation runs, and a second
  audit persists `complete` with provider/model attribution. This proves the
  core loop under controlled conditions; the event-timer/bootstrap path and
  external-provider behavior remain separate validation work.

- 2026-09-26 · **P9 snippet delete race hardening.** On Windows, a
  concurrent delete or file-sharing probe can raise `EPERM` between the
  existence check and unlink. The snippet store now re-probes and retries
  once: an already-gone target returns the not-found result, while a
  still-present permission failure remains an error. Adversarial review
  found no additional concrete defect. Focused route tests cover gone,
  transient, and persistent sharing violations.

- 2026-09-26 · **P9 goal audit bridge and long scheduled-objective fitting.**
  The authenticated NND↔NNA source smoke now exercises a real completed turn,
  its final provider affinity, the independent goal-audit route, and a stale
  revision refusal. The smoke runner enables Node type transformation for
  the existing TypeScript server entrypoint. Scheduled long objectives pass
  through the B.6.3 fit contract: bounded small-model distillation when a
  port is supplied, otherwise a 4,000-character head/tail excerpt with a
  visible trim marker; the full prompt remains in the chat message. The
  production distillation port is not yet bound, and a full autonomous
  audit-to-continuation run remains to be verified. Adversarial review fixed
  whitespace-only distillation output and found no defect in the smoke seam.

- 2026-09-26 · **P9-4e-ii the snippet UI half.** The composer's `#`
  picker rides the shared roster now: `snippets-source.ts` replaces the
  empty map (wholesale-visible loads, never-rejecting refresh that
  keeps the roster on refusals and hostile 200 bodies), the composer
  refreshes once per mount and inserts over the latest text, and the
  scheduled editor's `#` source rides the same roster (E-09-28 (d)
  parity held). The settings window gained a real Snippets page (the
  placeholder path is gone for the slug): roster management over the
  P9-4e-i family with the byte-equal name guard, inline text edits,
  deletes, and a refresh button, every change republishing the shared
  roster so composer stays in sync without a reload. The audit carried
  the E-09-28 (i) flag home and reproduced the composer's mention-merge
  guard as a per-render no-op (the token counter re-initialized every
  render — late responses compared 1 against themselves and the
  checker never fired); fixed with a cross-render ref, the span+kind
  guard at editor parity, and a pickerRef clear on insert, plus three
  red-then-green composer pins (late-token stall, kind swap, dead-entry
  resurrection). A hostile 200 without the roster array folded into an
  unhandled rejection (fulfilment-handler throws bypass the sibling
  catch) — guarded at the source and folded to the alert line on the
  page. Registered: the textRef render-currency posture, the one-Composer
  refresh count, snapshot-at-open on both picker surfaces, the row
  lifecycle constraints, and the unscape-checked-200 consumer rule.
  Composer pins 5/5, page 9/9, source 4/4, editor 19/19, window 26/26;
  UI 102 files/932, web 66/913 re-verified, typechecks clean, gates
  426 files, graph 426 modules. E-09-30..35. Next: the B.6.3 distill,
  then the P9 wrap.

- 2026-09-26 · **P9-4e-i the snippet config-entity family.** The server
  half of the snippet macro resolver landed: the `snippet-store.ts`
  (`<data-dir>/config/snippets/<name>.json`, names `[\w-]{1,64}`,
  `scope: 'global'` default, tmp+rename writes, corrupt-file skipping;
  expansion `#([\w-]+)` keep-unknown), the route family per doc 03
  §5.x verbatim (list/create/read/patch/delete plus the `POST /expand`
  route registered before the `:name` POST so the reserved word never
  shadows creation), mounted before the harness proxy, and the typed
  client `lib/snippets-api.ts` mirroring the ok-stamp envelope. The
  audit reproduced and fixed three Windows-grounded defects: case
  folding made a cross-case URL retitle (destroy) a stored snippet's
  identity (fixed: lookups resolve the stored entry's own case, never
  retitle, responses carry the stored name), reserved device names
  (`aux`, `com1`...) would have crashed stores on enforcement volumes
  (fixed: a platform-independent 400 before any store access), and a
  lost-race DELETE surfaced ENOENT (fixed: folds to the 404 arm).
  Registered: exact-case expansion keys, PATCH null-is-not-absent,
  single-decode traversal answers, content-type-agnostic bounded
  reader, `#([\w-]+)` parity with the composer's expansion. Routes
  19/19 (11 slice + 8 audit), client 4/4, web 66 files/913, UI 99
  files/913, typechecks both clean, gates 423 files, graph current.
  E-09-29 registers the slice. Next: P9-4e-ii — the composer picker
  source fed from the family plus the settings management page —
  then the B.6.3 distill.

- 2026-09-26 · **P9-4d-ii the editor dialog.** The scheduled-task editor
  is complete: the dialog shell (name, the schedule half with the client
  preview and §J.1 preference, save through upsert with create seeding
  the first catalog pair and PUTting with no state key, edit riding
  id/state/loopFile/unknowns, variant surviving only a kept pair, goal
  off dropping both goal fields), the execution half (catalog-fed model
  select with the unlisted-pair prepend, agent select, the prompt
  textarea riding the composer's autocomplete primitives with the
  latest-document insert rule, goal budget, auto-accept), and the
  tasks-dialog entry points gated on services ('+ new', per-row task
  edit, nested editor, list refresh after save; the list hook returns
  refresh now). The audit reproduced the '@' swap hole (a mid-pending
  '# ma' retyping could have repopulated the picker from a stale
  mention search and bound a kind-mismatched insert; fixed with the
  span+kind merge guard) and registered the snapshot governance (open
  snapshot + user edits, last-writer-wins, no optimistic concurrency),
  the raw-prompt storage, and the services store no-throw reality;
  carried a flagged composer follow-up (same hole without the kind
  check). Editor suite 18/18, dialog 20/20, UI 98 files / 909 tests,
  typecheck, gates (420 files), graph (420 modules). E-09-28 registers
  the slice. Next: the snippet macro resolver, then B.6.3 distill.

- 2026-09-26 · **P9-4d-i the schedule editor half.** The editor's
  schedule machinery: `schedule-form.ts` pure helpers (30-minute pill
  catalogue, preference-rendered pill labels, locale-first-day weekday
  chips over Intl weekInfo, zone choices, kind-seeded drafts, cron shape
  heuristics + example chips, never-emptying membership toggles, the
  schedule summary moved from the dialog, preview lines pairing the
  viewer stamp with the wall time inside the schedule zone) and
  `scheduled-task-schedule-editor.tsx` (kind tabs reseeding in the same
  zone, the zone select with the unlisted-zone option, pills/chips,
  once date/time inputs, the cron input with client-shape hint against
  example chips, and the sequence-guarded debounced next-runs preview
  riding the E-09-26 route). The audit reproduced the once-date seed
  showing zone-today at +14 offsets (fixed: zone-local wall tomorrow
  via the en-CA formatter) and pinned the browsers' weekInfo reality on
  all shipped locales, preview generation drops (stale + post-unmount),
  the unlisted-zone option collapse, and the preview-still-fires rule
  for client-failing cron shapes. Editor suite 21/21, dialog 20/20, UI
  97 files / 891 tests, typecheck, gates (418 files), graph (418
  modules). E-09-27 registers the machinery. Next: P9-4d-ii the
  execution half + dialog integration + Edit button + autocompletes.

- 2026-09-26 · **P9-4c-i the schedule preview machinery.** The editor
  surface needs "what will this schedule arm" before the task exists:
  `POST /api/openchamber/scheduled-tasks/preview` iterates the armer's
  own `computeNextRunAt` over a draft schedule (cursor = last + 1, the
  same claim-cursor shape the runtime uses, same 5 s due-slack), so
  previewed = armed by construction. Invalid drafts answer 200 with the
  collected prefix (the UI will render "unavailable"); only body/schedule
  shape errors are 400s; `count` clamps to 1..4 (default 4); `from` is
  honored only inside the year-9999 epoch window and folds to now beyond
  it. The audit reproduced two 500 classes on the pristine slice (hostile
  non-array `times`/`weekdays` escaping the compute branches; extreme
  finite `from` hitting Intl RangeError at the JS Date-range edge) and
  fixed both at the sanctioned layers (next-run branch guards; the
  route's `PREVIEW_EPOCH_MAX` fold), added the true-bytes daily pin the
  invariants-only test could not provide, and decided the client
  passes options through unclamped (server = sole validation authority).
  `previewNextRuns` in the typed client rides the E-09-24 envelope rule.
  Web 65 files / 894 tests (preview suite 10/10), UI 96 files / 870
  (client 20/20), typechecks, gates (416 files), graph (416 modules).
  E-09-26 registers the posture. Next: P9-4d the editor dialog.

- 2026-09-26 · **P9-4b the scheduled-tasks dialog.** The §H surface came
  alive in `components/scheduled`: the dialog (project selector riding
  the active directory's project, schedule summaries
  `daily/weekly/once/cron (+ tz)`, viewer-zone next/last run stamps,
  lastStatus badges), the toggle/delete split by ownership (loop tasks
  mutate their `.agents/loops` file through the PATCH route, plain tasks
  upsert; the loop delete confirms in-row because it removes the file
  and reconcile prunes the task), run-now with outcome-differentiated
  toasts (including the 200 `ok:false` errored-run body), and the
  loop-file editor handoff into FilesView. The C.10 control fanout got
  its first UI consumer: a `scheduled-task-ran` frame refreshes the open
  project's list through `useTaskRanFanout`. The hook keeps a
  view-ownership guard so slow loads of a previous project or frames
  through cancelled-but-pending subscriptions paint nothing stale
  (audit-reproduced), and the editor handoff targets the ACTIVE editor
  root, never the selected worktree (audit-reproduced). Shell wiring:
  `nnd:scheduled-tasks-open` + `nnd:files-open` window events, a
  `◷ tasks` header button, the dialog mount, and the FilesView
  tab-selection bridge in MainLayout. 20/20 dialog pins (96 files /
  865 tests UI-wide), typecheck, gates (416 source files), graph (416
  modules). E-09-25 registers the posture. Next: P9-4c the editor dialog
  (kind tabs, time pills, weekday chips, cron preview, IANA zone select,
  model/agent, prompt autocompletes, goal + auto-accept toggles).
- 2026-09-26 · **P9-4a scheduled-task UI data plane.** The typed §5.16
  client landed in `packages/ui/src/lib/scheduled-tasks-api.ts` — list/
  upsert/delete, loop-file PATCH/DELETE, manual run, scheduler status,
  plus `parseTaskRunEvent` for the C.10 control fanout — with the §C.1
  wire types mirrored locally and every failure folded into
  `{ok:false,status,error}` preserving the server's message. 20 tests
  (15 client + 5 through the REAL runtimeFetch transport) pin URL/method/
  body bytes incl. `%3A`/`%2F` id encodings (empirically verified
  against the real Hono router), the bare-task PUT vs `{task}` PATCH
  envelope asymmetry, the body-owned `ok:false` of an
  errored-but-completed 200 run (the audit caught a stamp that would
  have shown failed runs as successes), and the state-optional create
  input. E-09-24 registers the seam. UI suite 845/845 (95 files),
  typecheck, gates (413 source files), graph (413 modules). Next:
  P9-4b the ScheduledTasksDialog + entry point + live refresh, then
  P9-4c the editor dialog.
- 2026-09-26 · **P9 loop files + the scheduled-task route surface.** C.8
  `.agents/loops` files now drive tasks: `scheduled/loops.ts` (cron-only
  frontmatter, `enabled` defaulting FALSE, model split on the first
  slash, user/project scope shadowing with nearest-ancestor preference,
  the enabled-fence rewrite) and the locked `reconcileLoopTasks` in
  `task-config.ts` (revive/adopt/rename/keep-last-good/prune, run before
  every store read in `syncProject`). The doc 03 §5.16 route family
  landed in `routes/scheduled-tasks.ts` — list, upsert, delete, loop-file
  PATCH/DELETE (the file mutations), run-now, scheduler status — with
  loop-ownership gates on the general task routes, the 400/409 run-now
  mapping, and the `{running, queued, tasks}` status snapshot;
  `scheduled-service.ts` grew the optional `loopsFor`/`reconcileLoops`
  runtime ports over the harness tree. `routes/projects.ts`'s per-project
  config PUT no longer clobbers the managed `scheduledTasks` key. E-09-23 registers the NND mappings (project 400/404 semantics,
  id-legal names, zone/agent leniency, adoption-vs-rename identity,
  remove-as-orphan-prune, run-now mapping, status shape) and the settings
  config PUT now rides the per-project write lock with `scheduledTasks`
  preserved (C.9 discipline widened to the settings family; the P4-2
  todos PUT got the same lock). 29-test loops+routes suites plus a
  20-test audit regression file green; web 884/884 (64 files), typecheck,
  gates, graph (412 modules); adversarial review reproduced and fixed 6
  defect classes (adopted-id re-key churn on every sync, discovery-blind
  upsert gates on the id and file axes, unlocked config/todos
  read-modify-writes that could revert store patches, CRLF-to-LF churn in
  the enabled rewrite, plus the outright missing todos lock) with pins.
  Next: UI listeners + the API client + the scheduled dialogs
  (ScheduledTasksDialog/ScheduledTaskEditorDialog/scheduledTasksApi),
  snippet macro resolution, the B.6.3 distill call.
- 2026-09-26 · **P9 scheduled-task run pipeline on NNA.** The scheduled
  runtime's injected `runPipeline` port now has the real C.6 adapter behind
  it: `scheduled-pipeline.ts` (session create with the slot-zone wall-clock
  title, running event, B.7 goal planting with fresh-revision tolerance,
  slash resolution riding the queue's B.8 helpers, plain prompt parts in
  the knowledge -> prompt -> goal-intro order, warn-only auxiliary
  failures), `nna-scheduled-ports.ts` (production harness ports over
  `harnessRequest` + the 10 s/250 ms ready poll on `GET /command`), and
  `scheduled-service.ts` (lazy singleton over the P9-3a store ports,
  project enumeration, C.10 fanout as `notnative:scheduled-task-ran` with
  the `sessionId` wire name, boot + dispose wiring). Run errors stay with
  the runtime (missing worktree, blank session id, rejected dispatch);
  everything auxiliary degrades with a warning. 18-test pipeline suite
  green; web 835/835 (61 files), typecheck, gates (410 modules), graph;
  adversarial review reproduced and fixed 4 defects (blank knowledge
  recorded delivered though nothing sent, silent objective-store
  refusal, unattributed objective-file warn, intro budget sentence
  disagreeing with the payload's budget range). Next: P9-3d loop files
  + routes/SSE + manual-run 400/409 mapping + the settings-route
  `scheduledTasks` clobber fix.
- 2026-09-25 · **P9 scheduled-task runtime, claiming, completion.** The
  execution machine over the P9-3a store now actually runs tasks: the
  injected-pipeline runtime (`scheduled-ports` contracts, `scheduled-state`
  memory/timers/queue/slots, `scheduled-run` claim+watchdog+completion as
  standalone functions, `scheduled-claims` patch builders,
  `scheduled-runtime` composition) syncs projects on start (one unreadable
  project logs and skips, vanished projects shed timers), arms due timers
  carrying their exact slot (past slots never re-armed; overflow re-arms
  recursively at the setTimeout cap), and drives the FIFO queue under
  global 4 / per-project 2 slots. A due task CLAIMS its occurrence in the
  shared config (`patchIf`, 5 s slack on `lastScheduledFor`) before any
  dispatch — a sibling claim adopts the winner's task and re-arms from its
  slot; the claim itself advances `nextRunAt` so a mid-run crash cannot
  double-fire. The watchdog races the pipeline at 30 min default (timeout
  records the error, the session keeps running; a pipeline rejection is an
  error run, never silence). Completion consumes one-time tasks, writes the
  terminal patch with exactly one retry (double failure falls back to the
  in-memory terminal state + re-arm), and emits the C.7 event. Manual
  `runNow` refuses busy/capacity, never claims, runs paused tasks. 23-test
  runtime suite green; web 817/817 (60 files), ui 825/825 (93 files),
  typecheck, gates, graph; adversarial review reproduced and fixed 5
  defects (sync pipeline throw misclassified as claim failure, unguarded
  event emit, stop() timer resurrection via an inert latch, refused-claim
  memory adoption, fail-closed adopt normalization). Next: P9-3c wires the
  NNA harness behind `runPipeline` (C.6/C.10); P9-3d loop files +
  routes/SSE + the settings route's `scheduledTasks` clobber fix.
- 2026-09-25 · **P9 scheduled-task storage core.** The scheduled-tasks slice
  starts: the per-project task document (daily/weekly/once/cron schedules,
  execution with goal settings, runtime state) is stored in the existing
  project config JSON with unknown fields preserved verbatim at every level.
  Next-occurrence computation validates IANA zones through Intl (spring-
  forward gaps skip, fall-back repeats resolve to their first instant) and
  iterates cron with the newly registered cron-parser dependency, sharing the
  same call a future UI preview will use. Every write is an atomic whole-
  document rewrite under an in-process chain plus a cross-process `{pid, at}`
  file lock; state patches swap only the state object onto the raw stored
  record so a version-skewed sibling cannot strip fields; malformed configs
  are quarantined aside rather than overwritten. Adversarial review confirmed
  and fixed three defects before seal: a file-descriptor leak on every lock
  acquire, a state patch whose explicit `updatedAt: undefined` cleared the
  required field instead of falling back to now, and a dead cleanup comparison
  in the in-process chain map. It also registered the Lord Howe 30-minute
  fold resolving to the second occurrence, and the read-error/malformed
  conflation that quarantines unreadable-but-valid configs. Verification:
  794 web tests, 825 UI tests, typecheck, quality gates, 401-module graph.

- 2026-09-25 · **P9 goal continuation dispatch (send arming).** The goal loop
  now sends prompts: after a `continue` verdict or a skip-audit kick
  (aborted-turn re-kick, Resume), the exchange dispatches the verbatim
  continuation prompt as its last action — fresh re-read, loop-field
  coherence vs the persisted candidate, the 20-cap check (beyond: settle
  `blocked`/continuation limit, no send), a conversation-tail re-check
  against the tick's `tailId` (a newer message or an open reply refuses),
  one slot-consumption CAS (`turnsUsed+1`, `statusReason` cleared so a later
  cancel pauses a resumed goal), then a parts-only `prompt_async` submit.
  The body carries no model/agent/variant because NNA refuses per-prompt
  route overrides — its session-configured route governs (E-09-19). Refused
  or failed sends write nothing (no streak, no retry): the loop stays quiet
  and the next exchange re-decides from evidence. The UI auto-continuation
  label now states the live contract. Before: `continue` verdicts persisted
  accounting without ever continuing. Verification: 768 web tests, 825 UI
  tests, typecheck, quality gates, 396-module graph.

- 2026-09-25 · **P9 goal evaluator exchange (audit, no dispatch).** The
  safety runner's `ready` candidates are now consumed by an independent
  auditor exchange through NNA's authenticated, receipt-affinity-bound
  `goal-audit` route: NNA binds the call to the audited turn's final
  provider route (profile + model) and answers raw text; NND parses the
  bounded verdict, records the evaluation-route attribution, and settles or
  streaks through the id- and revision-guarded goal CAS. Verdicts follow
  doc 12 T3-T5: `complete` settles verified by audit, three consecutive
  `blocked` settle with the audit note, and the second consecutive audit
  failure/unavailability settles `progress audit unavailable` with the
  unadvanced cursor so the same turn is re-presented. Races (goal changed,
  stale evidence, busy seat) drop without streak writes; a pre-audit
  coherence guard refuses a tick whose candidate no longer matches the
  durable goal, so a user Pause/reactivate/budget edit inside the window
  can only refuse the loop, never be overwritten. `turnsUsed` stays
  untouched: sent continuations must consume the 20-cap slot at dispatch
  time (queued, E-09-18). Unattended prompts remain off; the
  auto-continuation-disabled label stays accurate. Adversarial review
  caught a mid-window goal edit surviving every runtime guard into the
  verdict write (a user's budget raise/reactivate would have been silently
  reverted); fixed with the pre-audit drop and regression coverage.
  Verification: 751 web tests, 824 UI tests, typecheck, quality gates,
  395-module graph, and the cross-repo source smoke now also proves the
  live audit wire (attributed receipt, raw audit answer on the same
  provider route, stale-revision conflict). Version: NND 20260925-73.

- 2026-09-25 · **P9 goal evaluator affinity.** NNA terminal records and
  owner-scoped goal evidence now retain bounded, non-secret provider profile
  and model IDs for the final route actually used by a turn, including
  fallbacks. This gives the forthcoming independent evaluator a same-provider
  target; missing legacy attribution must fail closed rather than pick a
  different default route. Adversarial review tightened both sides of the
  optional affinity contract to reject malformed IDs; NNA full check
  1566 pass/3 skip, NND web 725/725 and check passed. Versions:
  NNA 20260925-50, NND 20260925-72.

- 2026-09-25 · **P9 live goal safety runner.** A safety-only event runner now
  shares NND's existing NNA event feed and starts with the server when the
  NNA harness is selected. The profile setting gates all work, including
  existing in-flight ticks before they can start a CAS write. Startup/feed
  reconnect reconciles active goals; idle/update events arm quiet ticks;
  pause/delete/busy clears them. Adversarial review fixed Resume timer
  preemption and stale in-flight event races. It does not audit completion or
  send prompts; the UI's auto-continuation-disabled label remains accurate.
  Verification: 724 web tests, full typecheck/quality gates and 394-module
  graph pass.

- 2026-09-25 · **P9 NNA goal safety ports.** The tested production adapter now
  maps the pre-audit tick to authenticated NNA session/status/children/messages,
  owner-scoped evidence, revision-guarded goal writes and generation-keyed
  local objective reads. Review found NNA ignored the requested message-tail
  limit, so its harness route now validates and honors `?limit=1..200` without
  changing omitted-limit behavior. It is not booted yet; unattended dispatch
  remains off. Verification: 713 web tests, full typecheck/quality gates and
  393-module graph pass; NNA full suite 1,565 pass / 3 skip / 0 fail.

- 2026-09-25 · **P9 pre-audit NNA safety tick.** A testable server tick now
  waits for authoritative root/child idleness, an available objective and
  safe receipt evidence; it can CAS-settle hard stops after re-reading goal
  identity and revision. Adversarial review fixed a stalled Resume after a
  cancelled turn with no assistant output and objective unavailability
  suppressing hard stops. It does not yet send unattended prompts. Event
  timers, production adapter, NNA auditor and dispatch remain pending.
  Verification: 710 web tests, full typecheck/quality gates and 392-module
  graph pass.

- 2026-09-25 · **P9 goal audit contract.** NND now bounds and escapes the
  objective/latest-assistant prompt sent to a future independent evaluator,
  and parses a bounded JSON verdict with note/script safeguards. Adversarial
  review caught a mismatched-language note allowed by script present only
  beyond the prompt-visible text; fixed with regression coverage. NNA's
  session-scoped small-model port and the server tick remain pending; the
  contract alone does not turn on autonomous continuation. Verification:
  703 web tests, full typecheck/quality gates and 391-module graph pass.

- 2026-09-25 · **P9 NNA-native goal receipt decisions.** The web server now
  has a pure receipt-ordered decision core for token accounting, cancellation,
  failed/unknown outcomes, budget exhaustion and the 20-continuation cap.
  It refuses malformed or incomplete evidence rather than guessing token
  usage or skipping a lost cursor. The adversarial review fixed masked
  interruptions within receipt batches, a stalled explicit Resume and a
  missed committed-token floor. Verification: 698 web tests, server typecheck,
  390-module graph and full quality gates green. The event/tick runner, CAS persistence,
  evaluator and continuation dispatch remain pending; the UI still correctly
  says auto-continuation is not yet enabled.

- 2026-09-25 · **P9 NNA-native goal evidence.** NNA now projects a bounded,
  owner-scoped ordered window of safe turn receipts for goal accounting, with
  request ID, outcome, accounted token count and measurement class. NND seeds
  new goals' accounting cursor from the latest receipt, excluding pre-goal
  turns. The audit added a busy-turn arming guard and CAS ingress fence,
  complete truncation signals, valid request-ID parity and usage fallback.
  This replaces the incompatible OpenCode snapshot/lexicographic-ID
  assumptions for the NNA default. The tick that consumes the receipts is
  still pending; unknown usage and truncated windows must be handled there.

- 2026-09-25 · **P9 session-goal controls (pre-loop).** Root-session chat now has a
  goal strip and explicit manage panel behind `sessionGoalEnabled`: view the
  objective, status, progress note and token usage; set/edit a bounded objective
  and optional budget; pause, resume, mark complete, or clear. File-first
  objective staging uses the immutable key returned by NND, followed by NNA's
  id-and-revision CAS. A failed file stage falls back to inline objective text;
  stale metadata conflicts remove only the losing staged generation. The panel
  follows live NNA goal revisions. Adversarial review fixed stale status,
  delayed file reads overwriting edits, false post-CAS reload failures, and
  silent turn-stop failures. The panel explicitly labels auto-continuation as
  not yet enabled. Runtime ticks, send
  arming, schedules, and broad remote orphan-file quota remain pending.

- 2026-09-25 · **P9 objective-file API.** NND now has authenticated
  `PUT/GET/DELETE /api/goals/objective/:sessionId`, backed by atomic writes in its data
  directory. Session IDs and immutable generation keys are validated before filesystem
  access; content is trimmed and bounded to 5,000 characters, missing deletes are harmless,
  and a symlinked objective is refused on read. The key is stored in NNA goal metadata,
  preventing stale file-first edits from changing the winning objective. This enables live
  objective edits for the forthcoming autonomous tick;
  goal arming and the tick runtime are still pending.

- 2026-09-25 · **P9 goal persistence seam, NNA-native.** NNA now validates and
  durably stores one bounded goal per owned NND session, projects it as
  `metadata.nnd.goal`, and exposes a narrowly authorized, identity-and-revision-guarded goal
  route through NND's managed bridge. The NND goal core and write helper use
  this namespace and route shape rather than upstream generic metadata
  replacement. Integration and source smoke cover write/read/clear and
  restart recovery, same-id write conflicts, and failed-persistence rollback.
  An adversarial review caught the same-goal lost-update race and added the
  server-owned durable revision. This is the storage prerequisite, not the autonomous
  goal loop: objective files, audit ticks, controls, and schedules remain.

- 2026-09-25 · **Subagent route configuration from Agents Settings.** NNA
  exposes a separately authorized, validated saved subagent provider/model
  route. Agents Settings distinguishes saved from running routing, lets the
  operator select a provider profile and model, and requires explicit
  activation before new sessions adopt the change. Existing sessions retain
  their engines. This is configuration only: NNA still governs whether each
  session may delegate. The cross-repo smoke saves, activates, and restores
  the subagent route before exercising delegated work.

- 2026-09-25 · **NNA-native provider profile create/edit in Settings.** NND
  receives only `provider.profile.write` for profile creation and edits;
  existing `provider.manage` clients remain compatible, while the narrower
  principal cannot delete profiles. The form submits endpoint, model, display
  name, and an optional credential environment-variable name, never credential
  values. It does not display saved endpoint paths or credential bindings, and
  leaving the optional edit fields blank preserves their NNA-managed values.
  Saving changes does not silently activate them for new sessions. The
  adversarial review fixed stale Add-form values after a successful create;
  regressions cover duplicate avoidance and Secret Broker binding preservation.

- 2026-09-25 · **In-process provider-route activation for future sessions.**
  NNA can explicitly adopt saved provider profiles and role routes for
  sessions created afterward without restarting the managed child or
  interrupting current turns. Existing sessions retain their original engine
  config and NNA checks prompts against each session's own route. Settings
  exposes a separate apply action when any saved provider routing differs;
  activation never silently follows a save. Cross-repository smoke exercises
  save, apply, and restoration. The adversarial review identified a cached
  composer-default regression and a stale-specialist-profile risk. The fixes
  refresh the default, preserve each existing session route, and adopt all
  provider routing atomically for future sessions.

- 2026-09-25 · **NNA-native Agents catalog.** The Agents Settings page now
  reads built-in delegation role IDs and the configured running subagent route
  from NNA through an authenticated, read-only projection. It does not expose
  role instructions, endpoints, credentials, or imply that a role is granted
  in every session; NNA still decides invocation authority per session.
  Cross-repository smoke confirms the live projection.

- 2026-09-25 · **Primary-model override in provider Settings.** The route
  control now displays the actual configured model (which may differ from the
  profile default), accepts an explicit model ID override, and disables blank
  or no-op saves. It continues to report saved-versus-running drift and never
  restarts or switches an active NNA session. Adversarial review found no
  confirmed defect; focused and full UI tests pass.

- 2026-09-25 · **NNA-owned primary provider selection.** Settings can now
  explicitly choose a configured profile's default model as the saved primary
  route. A narrow `provider.route.manage` grant permits this one action without
  granting profile creation, edit, or deletion. NNA validates and persists the
  route, returns both saved and running identities, and NND says that restart
  is required before new sessions use it; existing sessions are not switched.
  Cross-repository smoke exercises route change and restore. Adversarial review
  fixed a compatibility regression so legacy read-only provider stores retain
  inventory access without the new mutation method.

- 2026-09-25 · **Configured versus running provider route.** NNA's provider
  inventory now includes the running NND engine route and configured primary
  route alongside manifest-backed profiles, read from one configuration
  snapshot. Settings labels them separately, honors primary-route model
  overrides, and warns only when the actual route identities diverge; a
  restart is required for the running process to adopt manifest changes.
  Cross-repository source smoke verifies the running-route projection.

- 2026-09-25 · **Provider diagnostics in Settings.** NND now offers explicit
  per-profile model discovery and configured-model catalog checks through NNA's
  authenticated provider endpoints. The managed principal gains only
  `provider.discover` and `provider.test`, not mutation authority; credentials
  and network I/O stay in NNA. Results say catalog membership, not inference
  health, and are cleared on profile refresh so a stale success cannot follow
  changed configuration. Source smoke covers both actions through the managed
  NND↔NNA adapter.

- 2026-09-25 · **NNA-native Skills visibility and runtime roots.** NND-owned
  NNA sessions now discover NNA's bundled/user skills and trusted-project
  skills from the same roots as the integrated operator. Settings shows a
  read-only, on-demand discovery catalog for newly created sessions; existing
  sessions may retain their earlier catalog. The projection excludes skill
  bodies and source paths, and discovery errors are path-free. Cross-repository
  smoke verifies the catalog while the adversarial review pinned catalog
  changes between sessions and the disclosure failure case.

- 2026-09-25 · **NNA-backed MCP inventory.** NNA now projects an authenticated,
  read-only configured-server inventory (`id`, transport, enabled, trusted) from
  its resolved process configuration. NND's MCP Settings page names this as
  configuration, not live connection health, and distinguishes denial from an
  empty inventory. Destinations, commands, headers, and credentials stay inside
  NNA. Cross-repository source smoke asserts the allowlist through the managed
  adapter; live health, testing, and management remain future capability work.

- 2026-09-25 · **Provider capability center, read-only first slice.** Settings
  now reads NNA's public provider-profile inventory through the authenticated
  harness seam and identifies the active route, model, and endpoint origin. It shows
  denial/unavailability distinctly from an empty inventory and never renders
  credential bindings. The managed NND principal receives `provider.read` only;
  profile writes and provider probing remain NNA-side future work.

- 2026-09-25 · **Authored session attention in the navigator.** NNA now
  projects a completed needs-input turn as session attention, independently
  from the idle transport state. Root attention is reconstructed from its
  durable Activity on restart; completed child attention survives the child
  snapshot. A new root turn clears the projection as soon as it starts.
  NND shows only validated NNA attention/phase badges in root and child rows,
  replacing the prior inert blocked-badge stub.

- 2026-09-25 · **Context rail evidence clarity.** Context now distinguishes
  no selected session, no NNA projection yet, and sections the operator hid.
  It summarizes the latest NNA-authored tool Activity for the selected
  session as an event, without calling a completed tool active or guessing
  from transcript text.

- 2026-09-25 · **Activity-to-Changes file evidence.** Successful NNA
  filesystem mutations now project a bounded workspace-bound review path
  into live and durable parent/child Activity. The rail offers a Changes jump
  only while that original workspace is selected. NND refreshes Git status
  for the jump and opens a read-only preview only if the path remains changed;
  an unavailable check and an absent change are distinguished. Nested
  workspaces translate paths against the Git root without granting Git file
  routes access to sibling paths. Shell edits and other unclassified changes
  still have no inferred file link.

- 2026-09-25 · **Changes file preview.** A filename in Git/Changes now opens
  a read-only, scoped diff preview in the current pane. Stage/Unstage stays
  on its explicit button, so inspection cannot mutate the index. The preview
  uses the existing diff parser, bounds large patches, and ignores a stale
  response after file or project selection changes. Adversarial review fixed
  stale project rows and added a bounded, read-only patch for untracked files.
  This is a local review
  surface, not yet a direct Activity-to-changed-file navigation link.

- 2026-09-25 · **Expandable tool Activity evidence.** NNA now projects a
  bounded, redacted allowlist from authored tool-status events into live
  Activity and saved parent/child snapshots: file-path targets for an explicit
  path-only tool allowlist, plus effect, reason code, elapsed time, and exit
  code when present. Shell commands, process arguments, search queries,
  delegated task text, raw tool arguments, and output remain excluded.
  NND validates the structured detail and lets the operator
  expand a tool row without losing the live log position. The tool row is
  still not a link to a separate durable tool receipt; that stronger
  correlation/navigation remains future work.

- 2026-09-25 · **Activity attention hierarchy.** A governed `needs_input`
  turn now emits a distinct `attention` Activity state instead of looking
  completed. The rail gives authored attention and failures stronger visual
  weight and a dedicated "Needs input" filter, while completed progress
  stays quiet. The state survives NNA's bounded saved snapshot and NND's
  live/snapshot merge.

- 2026-09-25 · **Activity turn evidence navigation.** NNA now attaches the
  submitted prompt's durable message ID to parent-turn Activity frames and
  retains that bounded reference in authenticated snapshots. NND validates
  the optional reference through live and restored records and offers
  "View prompt" only when the exact message is loaded in the active session.
  Adversarial review found and fixed the prior Activity-ID bound that silently
  dropped valid turns with long session and request IDs.
  Tool, notice, and child-turn rows still need typed links to their own
  authoritative evidence; this slice does not infer those targets from log
  text or temporary streaming IDs.

- 2026-09-25 · **Desktop window-state restoration.** Electron's main window
  now saves normal geometry and display mode on a short debounce, flushes it
  before hide/quit, and restores within a visible display work area after a
  monitor change. Port and geometry share the existing shell-local prefs
  without clobbering each other; writes replace the file atomically. The shell
  package explicitly includes its local runtime modules. Pure tests cover
  removed monitors, invalid state, size limits, mode precedence, and an
  interrupted preferences replace. The unsigned NSIS build passed; app.asar
  contains each imported shell module, and the packaged terminal smokes pass.
  Installed-GUI geometry remains unverified visually.

- 2026-09-25 · **Operator rail panel configuration.** The docked rail now
  exposes local panel order and visibility controls. Preferences are isolated
  by runtime and directory, malformed saved values are repaired, and the last
  visible panel cannot be hidden. Hiding the selected panel moves to another
  visible surface without discarding the mounted Notes/Browser/Terminal pane.

- 2026-09-25 · **Bounded harness event replay.** NNA's authenticated event
  stream now includes SSE cursor IDs and retains a count- and byte-bounded
  in-memory replay suffix. NND ignores the non-replayable connection receipt
  as a cursor and always reconciles snapshots on SSE reconnect.
  Reconnects replay only post-cursor events visible to the same principal and
  full workspace grant. NND's existing proxy forwards `Last-Event-ID` and its
  snapshot reconciliation remains the fallback for expired or restarted
  cursors. Durable cursor storage and explicit gap signaling are still open.

- 2026-09-25 · **Reconnect phase reconciliation.** NND now compares a
  candidate session GET against live-event revisions, tombstones, and the
  latest description before applying it, so a delayed read cannot roll a
  phase backward or revive a deleted child. Bootstrap now captures its
  revision baseline before the list requests and preserves live updates and
  deletions over stale results. Accepted descriptions replace the full record,
  allowing NNA corrections to remove metadata. This remains snapshot recovery,
  not full SSE cursor replay.

- 2026-09-25 · **Live delegated turn phases.** NNA-owned child sessions now
  project validated semantic phases through their own session metadata and
  live update events. The Subagents row uses the child's phase only while its
  own transport status is active; permission/question evidence retains
  precedence. Adversarial review ensured completed snapshots report idle
  after restart instead of regressing to unknown live status.
  The source smoke holds a real delegated provider call and verifies the
  child-specific `waiting_provider` projection through NND, including idle
  restoration. NNA full suite, NND UI/web suites, typechecks, and quality
  gates pass.

- 2026-09-25 · **NNA-authored turn phase in Context.** NND-created engines now
  emit their semantic phase from NNA, and the authenticated session projection
  carries the validated phase into the Work rail. The source smoke observes a
  real `waiting_provider` frame during a governed turn. Generic busy/idle
  remains replica bookkeeping; this does not claim the complete replayable
  13-state wire contract. Adversarial review fixed stale idle recency and
  mid-stream/tool phase lag. NNA full suite, NND UI/web suites, typechecks,
  quality gates, and cross-repo source smoke pass.

- 2026-09-25 · **Canonical NNA goal/tasks in Context.** NNA now projects its
  durable conversation-work revision, goal, and ordered task statuses into
  authenticated session metadata and emits a live session update after a
  committed work change. NND reads that projection in the Work rail rather
  than the OpenCode-compatible todo cache; an absent or malformed snapshot
  never invents a goal, and a temporarily missing config cannot revive stale
  todos when a canonical snapshot is present. Evidence and staged completion
  stay inside NNA. Adversarial review fixed the config-arrival race; NNA,
  NND UI/web, typecheck, quality gates, and cross-repo source smoke pass.

- 2026-09-25 · **Completed child Activity recovery.** NNA now saves recent,
  sanitized child Activity with each completed child transcript snapshot when
  its NND catalog is durable. NND reopens the log after NNA restarts; the
  source smoke proves the authenticated wire read. Older child snapshots
  without Activity reopen with an empty log. This remains bounded operational
  history, not a governance audit or SSE replay cursor.

- 2026-09-25 · **Completed child transcript recovery.** NNA now keeps a
  bounded, display-only snapshot of each completed delegated session when
  the NND session catalog is durable. After NNA restarts, NND's existing
  child-session list and transcript view can reopen that history under the
  original parent and complete owner grant. A restored child is not busy and
  has no steering capability. The source smoke now restarts a durable NNA
  process and verifies these wire behaviors; NNA also restores authenticated
  authority origins for the parent.

- 2026-09-25 · **Authenticated Activity snapshots.** NNA now retains a bounded
  sanitized per-session Activity view and serves it through an owner-scoped
  read route; root snapshots survive an NNA restart when its session catalog is
  durable. NND merges saved rows when Activity opens and during reconnect,
  retaining a newer live correction if an older read finishes late. A failed
  read does not clear visible evidence. The source smoke checks completed root
  and child Activity through the NND proxy. This is recent operational history,
  not a full audit ledger or SSE cursor replay.

- 2026-09-25 · **Single-project General Notes draft lease.** An unsaved
  General Notes draft now survives in-app project switches in memory. A second
  project's General Notes remains read-only until the first draft is saved or
  explicitly discarded; no navigation-triggered write occurs. Save failures
  retain the draft. If the original project's read fails on return, Save
  remains disabled and Retry load can recover without overwriting ambiguous
  file state. This protects in-app switches, not process crashes or reloads.

- 2026-09-25 · **Per-session NNA configured routes.** NNA now projects only
  provider/model IDs from each engine's configured route into authenticated
  session metadata. Child sessions carry their distinct delegated route even
  after completion. The Context rail prefers this per-session identity over
  the root-only `/config` fallback; it never treats a configured route as
  proof of the provider/model that answered a particular turn. The cross-repo
  smoke uses separate primary and delegated provider IDs and checks both.

- 2026-09-25 · **Configured model in Context.** Root NNA sessions now show
  the same configured primary model identity as the composer, or an explicit
  unavailable label when NNA configuration omits it. Delegated child Context
  does not borrow that root model label because NNA may route subagents to a
  different model; the selected session must exist before the row appears.

- 2026-09-25 · **Notes pane continuity.** Once opened, General Notes and
  Todos retain in-memory drafts across their tabs and other operator surfaces;
  no save is issued just for navigation. A hidden plan editor deactivates and
  reloads when reopened. The subsequent single-project draft lease protects
  General Notes across project switches without retaining mounted project panes.

- 2026-09-25 · **Notes read-safety.** General Notes, project Todos, and the
  plan editor now treat only an explicit file-service `not-found` response as
  a new blank document. Access failures, missing API routes, and malformed
  todo data remain read-only instead of exposing a blank editor that could
  overwrite an existing project file. Focused UI regressions cover denied and
  ambiguous reads; the plan editor disables edits/saves until a valid load.

- 2026-09-25 · **NNA governance in Context.** NNA now publishes only its
  review-posture enum and classified governance-record health/counts in
  authenticated session metadata. The Context rail shows those NNA-owned
  values plus pending permission/question counts, while malformed or absent
  data stays absent. No raw decision, evidence, argument, or credential is
  projected into the GUI.

- 2026-09-25 · **Resizable operator dock.** Desktop right-side surfaces now
  have a labeled title and a draggable, keyboard-operable resize boundary.
  Width is restored per non-transient runtime, project directory, and surface;
  compact mode remains full-width and does not inherit a desktop pixel width.
  The dock preserves a usable chat column by clamping its maximum width.

- 2026-09-25 · **Activity live-tail rail.** The session Activity surface now
  keeps authored evidence in arrival order, offers All/Turns/Tools/Notices/
  Failures filters, and follows the latest row only while the reader remains
  at the bottom. Scrolling into history holds position and reveals a counted
  Jump to live action when new rows arrive. Harness-authored redactions and
  corrections still replace evidence by stable id; no transcript text is
  inferred into the log.

- 2026-09-25 · **Live delegated status in Context.** Subagent rows now
  subscribe to the global live-status projection. Pending permission and
  question evidence outrank a concurrent busy status. An explicit idle record
  is labelled “Idle”; a child without any live-status evidence is
  labelled “No live status,” never “Done” by inference. Locally optimistic
  prompt status now reaches the global index immediately. UI regressions cover
  status arrival and blocker transitions.

- 2026-09-25 · **Cross-project terminal lease.** The app shell now owns one
  10-minute terminal keepalive across all visited project directories. Terminal
  panels retain only their visible observer/stream; navigating from project A
  to B no longer drops A's reaper protection. Hidden panels still make no
  5-second listing requests. A focused regression test covers the switch and
  removal of exited sessions from subsequent touches.

- 2026-09-25 · **Compact operator surfaces.** Below the desktop-width
  side-by-side threshold, chat now offers an explicit Surfaces door to
  foreground Context, Activity, Changes, Notes, Browser, or Terminal. The
  selected pane remains the rail's single surface; Return to chat restores
  keyboard focus to the opener. A width increase keeps chat visible through
  the `xl` layout rule instead of leaving it concealed by compact state. An
  audit fixed both resize focus directions and keeps the terminal controller
  mounted in composer focus mode. Hidden terminal panes pause their active
  stream and 5-second observer. The app-level keepalive owner followed in the
  next slice.

- 2026-09-25 · **NNA configured-model composer boundary.** The authenticated
  NNA bridge projects its configured primary provider/model identifiers without
  connection or credential metadata. NND shows that route, hides unsupported
  agent and auto-accept controls, and disables per-prompt model selection for
  NNA sessions; NNA rejects mismatched model or agent submissions. If config
  bootstrap fails, the composer blocks instead of falling back to mock.
  Cross-repo source smoke and focused composer/route tests cover the path;
  governed per-turn overrides remain planned NNA engine work.

- 2026-09-25 · **Production GUI layout restored.** A live 1280×800 browser
  inspection found that Vite shipped the design tokens but no Tailwind
  utilities from `packages/ui/src`: the session UI collapsed into a text
  column. The web stylesheet now explicitly registers web and shared-UI
  sources. Rebuilt CSS grew from 12.27 KiB to 50.85 KiB; the desktop-width
  session/sidebar/operator-rail layout renders correctly. The browser probe
  opened Activity, sent a mock prompt, and observed turn-start, assistant
  output, and turn-complete evidence. A CSS utility gate now runs after web,
  Electron, and release builds, and rejects the previous broken artifact.
  This validates the mock browser door, not the native app window or real NNA.

- 2026-09-25 · **Packaged terminal command plane acceptance.** The unpacked
  Windows x64 Electron executable now boots its packaged server bundle with
  isolated mock-harness data, answers `/health`, creates a real terminal via
  HTTP, and delivers the expected snapshot, output, and clean exit over the
  terminal WebSocket. NSIS packaging runs this bounded probe after the native
  PTY probe. GUI rendering and actual installed-app behavior remain to test.

- 2026-09-25 · **Packaged terminal native acceptance.** The unpacked Windows
  x64 executable now passes a bounded real `node-pty` command spawn/output/
  exit probe under Electron-run-as-Node; the NSIS build runs this gate after
  artifact verification. This closes the missing-native-
  runtime/ABI check for that packaged artifact. The full packaged HTTP/UI
  terminal route and non-Windows artifacts remain unverified.

- 2026-09-25 · **Installable shell artifact integrity.** The packaging
  pipeline now stages the external `node-pty` runtime and native binaries
  beside the server bundle for both script-install and NSIS paths. An
  isolated Node and Electron-run-as-Node probes check that the staged package
  and all Windows native addons load; the NSIS gate checks their presence
  again in `win-unpacked` because electron-builder's generic extra-resource
  copy otherwise excludes nested `node_modules`;
  the artifact digest includes the native tree. NSIS reporting now selects
  the exact version just built, so an older installer cannot be reported as
  the new release. A live packaged Electron terminal-create test is still
  outstanding.

- 2026-09-25 · **Live child-steering source loop.** The isolated provider
  holds a real delegated child turn open while the smoke reads NNA's
  child-specific capability through NND, submits an explicit steer, and
  observes both the steered user text and provider acknowledgment in the
  child's retained transcript. After the turn completes, the capability
  disappears and a late steer is rejected. This proves the NNA/NND wire
  authority transition; it is not yet a human GUI interaction test.

- 2026-09-25 · **Real delegated-session source loop.** The cross-repository
  smoke now makes the local provider fixture request NNA's `tool_search`,
  then `agent_run`. A constrained fixture reviewer approves only the exact
  task named in authenticated operator intent. The smoke checks that NNA
  creates a child session, NND lists it under the parent, and the completed
  child's assistant transcript remains readable through NND while its
  steering grant is absent. This covers one completed child; restart
  recovery now has an NNA host gate and a cross-repository restart gate, while
  multiple concurrent children still need a cross-repository gate.

- 2026-09-25 · **Governed source prompt loop.** The cross-repository smoke
  now starts a tiny loopback OpenAI-compatible fixture, submits a prompt via
  NND `/api/session/:id/prompt_async`, verifies NNA actually called the
  fixture, verifies the provider received the intended user text, waits for
  a normally completed NNA turn, and finds the marker in an assistant
  transcript part returned through NND. No external provider, credential, or
  model cost is involved. This proves the basic source harness turn and
  projection, not a complete interactive browser session.

- 2026-09-25 · **Live bridge events and cancellation.** The source smoke now
  subscribes through NND to NNA's real `/global/event` stream, observes the
  connection opener and the matching `session.created` frame, and closes the
  stream. NND's adapter binds the downstream request abort signal to the
  upstream fetch for the stream lifetime, so a closed browser request need
  not leave an NNA subscriber behind. Focused cancellation tests cover both
  a request waiting for headers and one already streaming.

- 2026-09-25 · **Real source bridge smoke.** `npm run integration:smoke --
  <path-to-NNA-source>` starts a source NNA child with an isolated temporary
  data root, sends NND API requests through the real adapter, and checks
  authenticated health (including a 401 negative control), root-list filtering,
  the empty child endpoint, session create/rename/delete,
  transcript read, and the browser-origin write gate. It uses an isolated
  local provider fixture for both the basic prompt loop and one delegated
  child transcript. This validates the two
  current source trees without changing the older installed NNA in the user
  profile; packaged installation and UI interaction remain separate gates.

- 2026-09-25 · **Unsafe browser-write guard.** The NND server now rejects
  unsafe HTTP requests from opaque and foreign browser origins before auth,
  NND routes, and the NNA proxy. Same-origin and reverse-proxy requests remain
  admitted, as do non-browser calls without Origin. A valid device bearer may
  cross origins for `/api/*`; an arbitrary Authorization header does not grant
  an exception. Vite's dev proxy preserves HTTP Origin and stamps the
  browser-visible Host for same-origin dev writes; only WS upgrades rewrite
  Origin for the existing WS gate. This closes the open-auth simple-request path from an
  untrusted preview guest; it does not make the guest page trusted.

- 2026-09-25 · **Manual Browser preview (P11 subset).** The operator rail now
  accepts user-entered HTTP(S) addresses, defaults loopback dev servers to
  HTTP, and offers back/forward/reload/external-open controls. The embedded
  page is an opaque-origin sandboxed iframe without a privileged bridge;
  NND's own listener and credential-bearing URLs are rejected, and NND's
  HTML refuses framing even after a guest redirect. The wider pane retains
  its history while another rail surface is
  selected. Browser inspection, annotation, capture, dev-server discovery,
  Electron guest partition, and NNA-granted agent control remain P11 work;
  some sites cannot render in an iframe. The preview sandbox itself is not
  a CSRF boundary; the separate server-side unsafe-write gate is required.

- 2026-09-25 · **Broad-suite validation repair.** The auth route test now
  establishes its temporary data home before server modules capture `ENV`,
  avoiding writes into the operator's profile during tests. The mock-tool SSE
  assertion waits for the terminal frame instead of racing the REST response.
  Neither change alters production route or event ordering.

- 2026-09-25 · **NNA-estimated Context rail.** NNA emits numeric context
  measurements for desktop-owned engines and projects the latest estimate into
  authorized session metadata. The rail shows estimated use, known limit, and
  percentage without treating them as billed usage or inventing a zero when
  evidence is absent. Source context text is never projected. Durable replay
  across NNA restart remains separate work.

- 2026-09-25 · **Live subagent transcripts and list contracts.** NNA streams
  bounded child text and tool lifecycle evidence under the child session ID,
  reconciles the preview to the completed transcript, and supports late-open
  reads. Root/child list filters and parent-scoped child reads match NND's
  client. The list is bounded but has no cursor yet.

- 2026-09-25 · **NNA-governed subagent transcript steering.** NNA now lists
  active and recently completed child sessions under their parent and serves a
  bounded child transcript view. The NND transcript remains read-only by
  default. A child-specific capability probe reveals an explicit steering
  toggle only while NNA grants it; submission rechecks the grant and confirms
  the engine accepted the steer. An unaccepted or uncertain response leaves
  the draft in place. Child discovery and activity replay across NNA service
  restart remain open work.

- 2026-09-25 · **NNA-backed session controls.** The managed local principal
  now carries separate NNA grants for title update, turn abort, and session
  removal. NNA owns the matching authenticated routes and durable title
  update. Removing a desktop session closes its engine and removes the
  catalog entry while retaining the NNA journal for recoverable inspection;
  it is not secure erase. Archive/fork/revert still need NNA contracts.

- 2026-09-25 · **NNA workspace-aware boot restoration.** NND now uses the
  authoritative session directory when reopening a saved session whose
  governed NNA workspace changed. It creates that directory's child store
  and updates the saved pointer. Boot-open waits for an authoritative list;
  failure or timeout cannot reopen a stale cached session. The seeded welcome
  fallback is limited to the exact root session in the boot directory.
  Focused boot tests and UI typecheck pass. The broader Vitest run currently
  has unrelated web-suite failures in mock tool event ordering, auth settings,
  and relay cleanup; these also reproduce in isolation.

- 2026-09-25 · **NNA-first product default and installed-runtime discovery.**
  NND now defaults to NNA in product boot; its source dev launcher still
  explicitly selects the deterministic mock unless overridden. On Windows,
  managed mode reads a validated NotNativeAgent installation descriptor and
  invokes its recorded Node runtime plus installed CLI with `nnd serve`, avoiding PATH and
  `.cmd` shell ambiguity. Portable installs retain an explicit-command/PATH
  route. Readiness accepts only NNA's exact `http://127.0.0.1:<nonzero-port>`
  protocol origin. Audits also fixed async web-entry handling, post-readiness
  stdout draining, spawn-error sanitization, and child cleanup if later NND
  boot fails. Focused launch/adapter tests: 19/19; server typecheck and entry
  syntax checks green.

- 2026-09-25 · **Managed NNA local-child MVP.** With
  `NOTNATIVE_HARNESS=nna`, NND now defaults to spawning `nna nnd
  serve`, accepts only one bounded `protocol: "1.0"` loopback readiness record,
  keeps its endpoint/token server-only, and mints a fresh NNA principal per
  request. Attach mode remains explicit (`NOTNATIVE_NNA_MODE=attach`). An
  unexpected child exit becomes a visible 502 harness-down response rather
  than an empty session list; NND disposal owns child termination. Electron
  awaits asynchronous NND startup before its health probe. Adversarial audit
  fixed that Electron Promise/handle fault and rejected non-base64url tokens
  that would fail during HTTP header construction. Focused adapter/launcher
  tests: 13/13; server typecheck and Electron syntax check green.

- 2026-09-24 · **Architecture and upstream-alignment audit.** User direction
  confirmed that NND is an NNA-installed GUI web-service integration package;
  Electron renders that web surface, while NNA remains the engine, governance,
  lifecycle, and listener-policy authority. ADR 0020, PLAN, DECISIONS, and the
  planning index now make the loopback-default/explicit-LAN rule and local-contract
  ownership explicit. A product-level v2.0.1 OpenChamber delta audit is recorded in
  NOTES/16 without copying source, assets, or dependencies; it creates an
  NNA-first evaluation backlog rather than a parity commitment.

- 2026-09-24 · **Targeted GUI scan.** A no-copy, feature-level inspection of the
  local OpenChamber GUI layout and maintained component documentation produced
  NOTES/17: NND's seven-surface GUI north star (workspace shell, navigator,
  conversation, NNA context rail, review band, capability center, and desktop
  doors), mapped to the NNA projections each surface needs. GUI-PLAN now links
  this product-shape companion; W-ids and implementation sequencing remain in
  the existing inventory and slice plan.

- 2026-09-24 · **Right-side workspace decision.** User direction expanded the
  GUI north star with a persistent docked workspace rail: Context, an NNA
  projection/evidence Activity log, Changes, project Notes (general notes/todos/plans),
  Browser, and Terminal. NOTES/17 defines the safety boundary (NNA-authoritative
  events, no default private reasoning or secrets) and pane behavior. GUI-PLAN adds
  W-116 and a future `operator-rail` slice before autonomy/capability expansion.

- 2026-09-24 · **Delegated-session transcript decision.** Subagents are now
  explicitly first-class child sessions in the GUI plan: nested live rows in the
  session navigator, demand-loaded replayable transcripts, parent-return navigation,
  and read-only-by-default action policy. W-117 and the `operator-rail` slice record
  the NNA contract requirements for correlation, replay, redaction, and authority.
  The child transcript additionally has an opt-in, hidden-until-authorized **Steer
  subagent** toggle that reveals its steering composer without granting authority.

- 2026-07-21 · Read 00-INDEX + 01 in full. Scoping decisions recorded (harness=NNA
  later + mock now; web spine → Electron; defer 10/11; stack per DECISIONS.md).
  Writing P0 scaffold.
- 2026-07-21 · **P0 done.** Monorepo (pnpm·Node24-native-TS·Hono·Vite7·Tailwind4·
  zustand5), runtime lib (globals, url/auth/fetch-bridge+HP-6 coalescing, endpoint
  switch, surface stamp, splash, startupTrace, chunkRecovery), harness seam + mock
  harness (echo loop, SSE /api/event), control SSE, auth-session/url-token stubs,
  App boot state machine (10× retry → recovery screen), MainLayout skeleton
  (sidebar/header/chat/rail), vitest 6/6, production bundle served by the Node
  server. Verified: /health, /auth/*, /api/session echo POST→reply, / + assets 200.
  Known limits: agent sandbox cannot spawn esbuild → dev-loop (`pnpm dev`) is a
  user-terminal step; browser visual check pending user eyes at http://127.0.0.1:3902.
- 2026-07-22 · **P1 done.** Doc 02 read in full (1484 lines) → `NOTES/02-harness-contract.md`.
  Mock harness rewritten as contract implementation (`server/harness/mock/{index,store,sim,
  events,fixtures}.ts`): bare-payload wire (D12), §6 shapes via new `ui/lib/nna/types.ts`,
  LF-8 turn simulation (transcription deltas → durable part), §5.1 envelope + ring replay
  w/ Last-Event-ID, v1+v2 permissions, questions, todos, fork/abort/revert/summarize/share,
  providers/models/agents/commands/tools-ids/path/project, `x-nnd-directory` header transport.
  Server proxy adds session-list sanitation (§3.2 keep-list). UI SDK facade (`nna/client.ts`)
  grows to the §3.4 catalog with §3.5a directory transport + ascendingId message ids; events
  client unwraps envelopes; sessions store keeps authoritative status map; ChatView busy
  pill; control stream standardized to `notnative:*` data frames. New in-process contract
  tests (messageID echo, 204+events, replay, abort-mid-part, permission 404-settled).
  Also: P0 mojibake repaired; harness naming centralized (`server/lib/harnessNaming.ts`).

- 2026-09-16 · **P2 done (resumed + completed by new agent).** Interrupted build
  repaired: sync-engine corruption (stray parens, missing view-store, bogus
  allSettled-concurrency) + repo-wide NUL/mojibake sweep (15 files; box-drawing
  comment dividers). Brand unified nna→nnd paths (`lib/nnd`), VITE_NND_URL.
  Engine split to POWER10 caps: pipeline-queues/attempts, transcript/blocking
  reducers, bootstrap(+directory/enrichment), engine-{instance,recovery,
  materialization,watchdog,message-poll,side-effects,actions,support}, view-store.
  84 vitest tests per NOTES §J.2 hinges (queues: 4 coalescing keys + barriers +
  frames + caps; reducer: freshness/chronology/terminal-part/dedupe/no-op/
  tombstone; routing precedence; child-store scheduler+eviction; loader
  inflight/expansion/tail/generations; optimistic taxonomy; ordering/timing;
  signature merge; batch primitive publication). Quality suite added
  (quality-gates POWER10 hard caps TS-aware, controlled-language NND-CTL with
  32-term registry + report, repository-graph, bump-version, release-gates,
  in-process smoke) wired to `pnpm run check`.
  Adversarial review dispositions (sub-agent): FIXED — runtime-reset scheduler
  brick (manager.reset, §11.2), primitive field publication in batches
  (sessionRevision/Total/deletedRevision), mergeBootstrapLists closed hierarchy,
  global bootstrap at start, eviction sweep interval, signature guard reads
  post-fetch state (no resurrect/loss), archive echo carries the stripped record
  (global cached bucket + status retirement), pipeline interrupt/heartbeat
  classification + real disconnect reasons. REGISTERED for later phases:
  control-frame normalization seam (P2-2), routing scan/info.directory (P2-3),
  streaming reconcile hooks + bounds (P2-4), per-dir watchdog cooldowns +
  discovery insert (P2-5), recovery runtime guards (P2-6), lifecycle action
  completeness (P2-7), optimistic revert-branch + ownership dirs (P2-8), loader
  complete-flag/deletion-merge (P2-9), bootstrap pagination + project.current
  abort rule (P2-10), covered-snapshot settle + ordering tie-break (P2-11),
  minor churn/bounds items (P2-12) — full list in NOTES/04 §"Review register".

- 2026-09-16 · **ADR 0020 accepted (both repos), design freeze.** Ecosystem framing
  locked: NNA = root headless-first harness (TUI native, GUI-less core, add-on
  activation contract; NNO today, NND as second package); NND = GUI integration
  package + standalone remote client (client-only mode needs the NND web service
  installed in the target NNA); NNO = business layer above; delegated contexts spawn
  per consumer with run-as entitlement; loopback default + token handshake; network
  exposure = explicit opt-in gate; NNA projection (13-state) = sole turn-state
  authority; surfaces own their sessions/config; governance owns decisions (mode
  ladder is settable, not decidable, client-side); lifecycle split (NNA core owns
  commands, NND-local owns tray/shell face). NND registry grew four terms
  (integration package, engine context, projection frame, shell). PLAN.md re-scoped:
  P4 → NND web-service package routes (not a standalone server), P11 promoted to
  client core, P12 = shell delivery vehicle; ecosystem phases PA/PB/PC appended.
  NNA-side stub written: NotNativeAgent/docs/architecture/0020-ecosystem-integration.md
  (add-on contract, package activations, concerns incl. NNA harness-surface gap and
  console ADR 0018/0019 reconciliation registered, integration robustness noted as
  future NNA work). No product code changed; gates stay green (84/84, tsc ×3).

- 2026-09-16 · **P3a done (chat spine).** Doc 05 read in full (1957 lines) →
  NOTES/05 staging. Built under packages/ui/src/chat/: prompt-language
  (4-key tokenizer+triggers+shell transitions+§H.7 instruction exact),
  keyboard-policy (§B.5 exact), send-planner (§B.9/§F.4 taxonomy: local
  command/queue/steer/blocked-authority + §B.9 error mapping), turns
  projection renderable gate + §E.1 status derivation tool-phrase table,
  drafts (identity, tombstones, §B.10 client-held queue), input-history
  (§H.4 recall+overlays), composer v2 split to fit POWER10 matrix (real
  idle-flush queue, shell mode → runShell action, reactive catalog,
  draft-restore on failure returns column to draft), transcript (tail
  dedupe, synthetic filtering, skill/reasoning/tool/subtask/unknown-safe,
  §E.1 chip, §F cards incl. Alt+Enter/Alt+Shift+Enter/Alt+Backspace newest-
  wins), sidebar (§F.10 lifecycle ordering — engine-level tie-break fix
  applied), session tabs (left-neighbor close, digit keys renderable-only,
  no tombstones), engine mount (App rewired; P1 interim session store
  retired from the wire path; runShell/abort actions via routing).
  Adversarial review: P0-1 openSession no longer denies pending requests
  (§F.4/GUI-POWER10 #2); P1×11 fixed in-slice (tail dup, real queue,
  draft-failure restore, picker sources, shell no-op, reactive catalog,
  card keyboard, sidebar updated-sort, tab neighbor/tombstone, POWER10
  split, synthetic leak). P2-residuals recorded (§I error card, subtenants
  subtree scope, Other… input, retry tick, unbounded maps list, §E.9 panel).
  105 tests incl. 21 new chat gates; engine +2 (P2-4 partial reconcile,
  P2-11 tie-break) verified.

- 2026-09-16 · **P3b done (chat depth).** model-catalog (3-layer
  provider→model→variant layers, favorites persisted per runtime, effort
  cycle Default→variants both directions, §A.2 collision display labels),
  ModelPicker popover (search, Favorites+provider groups, current marker,
  star toggle, Left/Right effort within row), starters §H.5 (two groups,
  insert rule commands 'text ' vs skills sha 'text
', hover X remove), composer P3b props (expanded/focus mode, /btw →
  runShell-style fork via actions.fork + banner, model selection round-trip),
  timeline dialog §A.7 (newest-first, search, revert/fork/scroll actions,
  no-text placeholder), prompt rail §A.8 (≥2 prompts teleport instant),
  engine actions: rename (PATCH title), fork (returns new session id),
  revert (to-message), MainLayout /timeline via 'nnd:timeline-open' event,
  /undo //redo → last user message revert. Deferred with halo: BTW peek
  panel + promote/destroy (fork-open only in P3b), AI rename small-model
  service (P4+), starters DnD reorder + shared marker (P5 settings),
  model tooltip metadata (P5). 113 tests (+8 catalog/starters gates).

- 2026-09-16 · **P3c done (work-status §E.9 subset + §E.3/§E.4).** work-status
  selectors + panel-gate (§E.9 identity rule: computed only while
  sessionStatusReady + idle + completed turn; committed stats SURVIVE the next
  active turn — review caught the broken wiring), panel (presence-collapsed
  sections Session/Project/Turn stats/Subagents/Tasks, catalog-resolved
  context limit, §G no-borrow rule honored, no fabricated 0% on tokenless
  totals, no cost-only row), recapFor v2: metadata.nnd.assist + `generatedAt`
  60s quiet window + anchor freshness; §E.4 suggestion chip in the composer
  band FILLS the composer (never sends) via the nnd:composer-fill channel
  (shared with /undo). Adversarial review fixed: P0-1 fork children now
  REGISTER + ENQUEUE ensure-session-messages materialization (they were
  skeleton-forever), P0-2 /undo vs /redo split (keep-point truncate +
  composer refill vs unrevert+refetch) with 'nnd:composer-fill'; P1×9:
  expanded keyboard policy wired, model selection reaches promptAsync, shell
  on draft no longer creates a prompt session, timeline anchors
  (id=message-*) + replaceState hash + error toasts + Escape, panel committed
  stats wired, context% suppresses tokenless totals + catalog limit, recap
  branded + quiet + suggestion surface. Register: §I cards, picker metadata
  tooltips, starters add-dialog + DnD, BTW peek/promote, §E.9 MCP/Pinned/
  context-sources rows + equalizer persistence,subscription, cycleVariant per-row variant, transient-runtimeKey guard for
  persistence namespaces, POWER10 span-heuristic blindness to TSX (tracked
  in gates backlog). 122 tests (+9).
  subscription, cycleVariant per-row variant, transient-runtimeKey guard for
  persistence namespaces, POWER10 span-heuristic blindness to TSX (tracked in
  gates backlog). 122 tests (+9).

- 2026-09-16 · **P4-1 done (server surface first layer).** /api/fs list,
  search (NND extension — bounded server walk for the remote-first mention
  picker), git-dirs + /api/git check/status(light) mounted BEFORE the /api
  harness proxy (Hono order). Workspace containment DEVICE-AWARE (relative()
  returns absolute strings cross-drive on Windows) + realpath root gates;
  adversarial review: P0-1 cross-device enumeration and P0-2 junction escapes
  (proven route-level on this host) FIXED; P1: git-dirs scope-bound +
  root-excluded, search .git boundary, git unborn-branch parse ("No" → name),
  composer mention source /api/fs/search with monotonic token + query-match
  staleness guards. Web package gains its own vitest suite (workspace-
  resolution note: pnpm install needed CI=true + --no-frozen-lockfile).
  Registered: symlink transparency deviation (links listed but boolean-
  neutralized unless target realpath stays in scope), gitignore
  approximation, plans-dir lazy-empty case, parse light/drop of merge/rebase
  states (P4-2 with full §5.13 files), rename `old -> new` path shape.

- 2026-09-16 · **P4-3 done (fs write family + session-folders).** /api/fs
  mkdir/write/delete/rename (P4-3): all four handlers workspace-bound with
  the SAME device-aware + realpath containment as the read routes; write is
  atomic tmp+rename; rename relies on single-?directory-scope (both targets
  containment-checked); delete refuses the scope root; mkdir rejects
  allowOutsideWorkspace outright (§5.14 grant rule). /api/session-folders
  §5.22: last-writer-wins by updatedAt (`ignored:true`), 4MiB cap after
  parse (413), malformed stored snapshots → 500 with documented strings,
  single-flight write queue, atomic rename. Refactored to sub-functions to
  clear the 60-line function gate that fired mid-slice. Review: QUEUED
  (context budget) — first next-session item before P5; risk areas: write
  no-op check missing (registered P5), content-no-op false-positive on
  registerFile-gated routes, session-folders corruption semantics.
  23/23 web tests (+7).

- 2026-09-16 · **P5-1 done (theme token system core).** design-system.css
  authored from doc 14 §B.1 table verbatim (light `:root` + dark `.dark`
  shadcn-style aliases in oklch, shell/environment tokens, glass clusters per
  variant) + generated-token SEED (surface/interactive/status/pr/chat/tools/
  loading clusters condensed to base variables — runtime themes overwrite
  whole blocks via the css generator at doc-14 E.6) + §B.2 radius scale
  (0.25/0.4375/0.5625/0.75rem) + fonts/motion + §B.3 semantic typography
  (web/desktop column) + §B.2 `@theme inline` utility mappings. web index.css
  re-imports the sheet; body now uses token variables (no more hardcoded
  hex). ThemeProvider: Delta D8 RESOLVED — `system` mode follows matchMedia
  both directions; `.dark`/`.light` root classes drive the block switch.
  Tests read the CSS as a fixture (both-variant coverage, seed presence,
  typography values) + jsdom provider tests (classes persist, system
  follows). 130 UI tests (+8). Registered: 38 preset themes + custom theme
  import format (E.6) + settings registry snapshot gate (P5-2), VS Code
  webview typography column (P10), i18n catalog + shortcuts (P5-3).

- 2026-09-17 · **P5-2 done (theme system per doc 14 §E).** lib/theme/: types  (Theme/E.6 interchange shape), color (hex canonicalization + darken/
  lighten/mix/contrast), validation (isValidTheme §E.6 subset + diagnostics),
  pr-colors (withPrColors, partial-pr merge), derive (seed→FULL-schema
  expansion, no half-mapped tokens), presets/ (brand pair, flexoki, 14 pair
  families, 6 singles ⇒ 38 built-ins per NOTES/14 C.1 resolution),
  themes.ts (registration order, app-light/app-dark alias map, defaults),
  css-generator + css-blocks (single `nnd-theme-variables` element, dual
  scope emission :root+.dark / :root+:root:not(.dark), !important alias
  block, ALL §B.1 runtime clusters, camelCase→kebab syntax tokens, config
  fonts/transitions, typography re-emission), storage (runtimeKey-scoped
  `notnative.theme.v2:*`, legacy seed mapping incl. single-theme ids, splash
  mirror incl. branded `notnative.themeMode`, all-or-null parse), custom.ts
  (GET /api/config/themes, client re-validation, withPrColors wrap).
  ThemeProvider: mode+light/dark PAIR, system matchMedia both ways (D8),
  transition suppression (2 frames, nnd-theme-switching), browser chrome
  (body bg + plain/media theme-color metas in place), write intent rides the
  SETTER (adoption/OS flips never write — flip-flop tests pinned), reload
  w/ 500 ms spinner floor. Adversarial review (sub-agent): P0 splash-mirror
  split fixed (+index.html system resolution), P1×5 (custom pr wrap,
  flip-flop tests, color math table, exact derivation values, meta in-place)
  + P2 nits (alias dedupe, non-hex edge filters, seed persist, meta patch,
  NOTES declarations). 181 UI tests (+14). web 23/23 · gates+smoke+graph.

- 2026-09-17 · **P5-3 done (settings registry + snapshot gate + persistence).**
  lib/settings/: parsers (bool/str/trim/int/num/oneof/list/set/record/
  modelRef caps), registry.ts = SINGLE TABLE with 186 fields (§F.5 inventory
  + F.4 LOCAL_DEVICE_KEYS + DESKTOP_SHELL_KEYS as first-class; deferred
  groups registered in NOTES/14 §D with their phases), autoSaveKeys() derived.
  scripts/registry-snapshot.mjs (root script registry:snapshot) → checked-in
  `packages/web/src/server/lib/settings-registry.json`; staleness gate test
  re-renders and fails on drift (§F.6 procedure enforced). Server:
  settings-gate.ts (snapshot-only key gate: unknown/computed/local/device/
  owner dropped; secret accepted-never-returned; ?surface= query param with
  header fallback) + settings-store.ts (§F.3 split store: preferences.json
  `{version:1,fields}`, settings.json rollback mirror w/ legacy keys kept,
  seed-once, unparseable-preferences discipline, atomic 0600 writes,
  kind→surfaces[kind]→base GET resolution, kind values never on base) +
  routes rewired: /api/config/settings registry-gated, /api/notnative/
  settings UNIFIED onto the same store (two-store drift from P0/P4 retired).
  Client engine: lib/settings/persistence.ts — cached GET (2s TTL + HP-6
  in-flight dedupe), updateDesktopSettings (filter → echo suppression →
  pending merge → 200 ms debounce → keepalive PUT), lifecycle flushes,
  save-state module (6 s error reset, notnative:settings-save-state),
  settings-synced event ({bootstrap, adoptTheme grades}) consumed by
  ThemeProvider for §E.3 bootstrap theme adoption (wired; adoption triggers
  when a server doc actually carries theme fields — no writer does yet, so
  inert by design until P5-4+ theme writes). fs-write no-op
  (identical content → unchanged:true, no mtime churn). P4-2 settings tests
  updated to registry semantics; new suites: ui registry/parse/persistence
  (200 total), web p5-3 settings + fs no-op (31 total). gates+smoke+graph.

- 2026-09-17 · **P5-5 done (shortcuts engine, doc 14 §I).** lib/shortcuts/:
  config (§I.1 table mirrored 1:1, 36 bindings incl. literal ctrl+/[, prefix
  families, internals), bindings (chord grammar: aliases cmd/meta→mod,
  option→alt, two-chord cap, empty-token rejection, bare-prefix ≥1-of-mod|
  ctrl incl. mod+alt per §I.1; mac ⌃⌥⇧⌘ vs Ctrl/Alt/Shift named display +
  named-key labels; §I.2 conflict rule; browser-risk feedback; authority
  rules), schema (lookups + effectiveShortcutCombo override→default +
  overrideIsPermitted), registry (first-bound wins + NEXT-IN-LINE
  re-acquire on removal; nested suspend), dispatcher (armed mod+k FAMILY
  with sibling candidates, 3000ms lazy expiry + boundary pins, Escape
  consumed only while armed, mismatch clears w/o passthrough, digit
  prefixes before normal chords, editable policy w/ AltGraph yield,
  IME-composition rules incl. armed-second eligibility w/ preventDefault
  decision pinned, mac/non-mac mod≡Ctrl aliasing, capture-phase second-key
  listener), hooks (single window router, symmetric install/uninstall,
  per-component useKeybind(s)). recorderConflict shaped for §I.3
  (exact/prefix/none + replaceable + overrides-aware). Adversarial review
  (sub-agent): P0 bare-prefix router crash fixed; P1×5 fixed (router
  teardown closure, capture listener, AltGraph, arming editable gate,
  registry re-acquire, recorderConflict API, vacuous IME test rewritten,
  mac-ctrl pin); P2 pins (expiry boundaries, display labels, corrupt
  tokens, key whitelist). Deferred to the settings-UI slice: recorder
  page + main-app router wiring + §I.4/§I.5 ownership; §J formatters with
  first Intl consumers. 250 UI tests (+30). web 33/33 · gates+smoke+graph.

- 2026-09-17 · **P5-6 done (settings UI core).** components/settings/:
  primitives (§A.3 blocks + settingsItem anchors incl. section anchors),
  page-tree registry (§G.2: 6 built pages + landing notes for the rest —
  never a silent gap), SettingsWindow (§G.1 chrome + §G.6 search jump w/
  per-control highlight + close-refusal while recording + registry
  suspension §I.2), pages appearance/chat/sessions/notifications/general/
  shortcuts (§G.4/§G.5 subsets bound to the P5-3 registry through the
  settings store; recorder dialog §I.3 w/ risk + conflict feedback and
  confirm-stays-local), lib/shortcuts/recorder.ts (pure §I.3 machine),
  lib/settings/{store,apply,font-options} (§F.3 apply step + §B.3/§B.4
  appliers bound at app boot), lib/format/time.ts (§J), ShellShortcuts
  (§I.2 router install mac-aware + open_settings/cycle_theme), theme pair
  writes to the registry on user intent (§G.4), MainLayout gear + ?settings=
  deep link. Adversarial review (sub-agent): P0×2 fixed (jsdom
  scrollIntoView crash + jump assertions; cycle_theme invalid hook), P1×8
  fixed (boot bind, anchor orphans + §G.6 resolution gate test,
  customize-only rows, theme registry writes, mojibake sweep + new
  quality-gate scan, isMac plumb, suspension + prefix invalidation,
  opencodeBinary allowEmpty), P2 cluster (recorder pins, cornerRadius/goal
  caps, single-sourced slugs). Registered deferrals E12–E18 (Base-UI dialog
  upgrade, page i18n key sweep, deep-link history, notification permission
  gating, voice/about slugs, recorder-dialog test file, control-form
  deltas). 280 UI tests · web 33/33 · gates+smoke+graph.

- 2026-09-17 · **P6 done (review surfaces, doc 06).** Four slices committed 2026-09-17
  (commits f195bbb, 652f774, f5e76d5, 1322c66): P6-1 fs domain + FilesView core
  (stat/read/raw routes, tabs store, FileTree dialogs, editor load/autosave/image/binary),
  P6-2 diff + git view (diff-model, first-party DiffViewer, git-router, GitView),
  P6-3 plan + comments + worktrees core (PlanSaveQueue, draft store, capture chain,
  WorktreesView), P6-3b inline comment lifecycle v1 + live worktrees + shell wiring.
  Adversarial sub-agent reviews fixed per slice (P0 clusters incl. transport throw,
  file-diff containment, cross-device enumeration-adjacent worktree paths, composer
  data losses); registered E-06-4..18 in NOTES/06. 359 UI · 48 web · gates+smoke+graph.

- 2026-09-17 · **P7 done (terminal, doc 07).** Two slices committed 2026-09-17
  (commits 8be1140, 758cfe6): P7-1 server core (WS codec v3, history sanitizer,
  theme-response answering, shells family, node-pty ConPTY backend, TerminalRuntime
  create/restart/kill lifecycle, idempotent command plane, loopback-gated upgrader),
  P7-2 client (TerminalTransport, terminal store + observer, TerminalView v1 with
  line-buffer renderer, MainLayout pane). Adversarial reviews fixed (incl. real ConPTY
  end-to-end gates); registered E-07-3..23 in NOTES/07. 389 UI · web 94 ·
  gates+smoke+graph.

- 2026-09-18 · **P8-1a delivered (doc 08 steps 1-2), resumed by new agent.** Pairing
  v2 payload contract (strict encoder, link head `openchamber://connect?v=2&p=`,
  16384 triple cap, v1 rejected) + remote-client credential store (hash-only, dedupe-
  replace, bearer auth, sticky relay, 60 s lastUsed throttle, revoke/purge) + 18 tests
  (`p8-1-auth-core.test.ts`). Adversarial review pass fixed P0x4 + P1 cluster; registered
  E-08-1..10 in NOTES/08. Ledger reconciled this session: P6/P7 rows + log entries
  added; phase renumbering adopted (doc 08 = P8; PLAN.md P11→P8, autonomy/knowledge/
  preview shift to P9/P10/P11) to match working slice numbering.

- 2026-09-18 · **P8-1b delivered (doc 08 step 3) with adversarial sub-agent
  review.** Hand-rolled HS256 (secret env → jwt-secret file 0600 → memory,
  atomic persistence + rotation), scrypt password verifier, per-IP login
  rate limit (10/5min → 15min lock, strict no-IP budget, env overrides),
  login flow (trustDevice 7d, desktop-only client-token mint tied to the
  cookie TTL, Cache-Control no-store), bearer-first session/bearer/URL-token
  authentication, URL-token mint/allowlist/60 s TTL bound to the parent JWT
  or `client:<id>`, global /api gate after the /auth routes (Hono order
  proven by script), cookie-only /api/auth/reset rotation, terminal upgrade
  gate slot (E-07-3). Review fixed P1×2 (secret-file persistence, 64 KiB
  bounded login body) + P2×4 + gate caps; registered E-08-11..16 in
  NOTES/08. 149 web (+37 p8-1-auth-ui) · 389 UI · gates+smoke+graph+version.

- 2026-09-18 · **P8-1c delivered (doc 08 step 4: scope classifier + tunnel
  gate).** §2.9 classify (tunnel host match / local names with private
  sockets / no-tunnel local / unknown-public same as tunnel; Host header
  falls back to the URL hostname — undici constructed requests carry none),
  newest-only bootstrap tokens w/ clamped TTLs + null-disables, one-time
  redeem, in-memory tunnel sessions (Lax cookie, lastSeenAt refresh), the
  /connect?t= route (rate limit 20/5min per IP + 5 no-IP + 10min lock,
  302 → /, no-store), stop/replace artifact revocation ('tunnel-revoked'),
  tunnel-scope locks on /auth (login/reset 403, url-token mint bearer-only,
  session row per §2.9 with E-08-18 bearer precedence), apiTunnelGate
  (device credentials pass at any scope; anonymous path needs the tunnel
  cookie), composed terminal upgrade predicate. Registered E-08-17/18 in
  NOTES/08. 162 web (+13 p8-1-tunnel) · 389 UI · typecheck green.

- 2026-09-18 · **P8-1c review fixed (sub-agent).** P1 `::ffff:` mapped
  sockets now classify private (desktop LAN was tunnel-locked under an
  IPv6 listener) + P2 redeem order (mint-before-consume) + P2 gate cap
  extraction; 7 new tests (mapped sockets, cookie-header garbage,
  mint/consume postcondition, ui-cookie fail-closed, open-mode url-token
  rejection, connect Set-Cookie matrix, rate-block record churn). 169 web
  · 389 UI · gates+graph green.

- 2026-09-18 · **P8-1d delivered (doc 08 step 5: passkeys server family).**
  @simplewebauthn/server v14 added; WebAuthnCeremony seam (real adapter +
  injectable fixtures), disabled-unless-password posture, HMAC passphrase
  binding store (`ui-passkeys.json` strict-read + atomic rewrite) that
  clears on password/secret change, per-rpID scoping + origin derivation,
  5-min one-shot challenge bookkeeping pinned to the ceremony's own
  challenge, session-cookie-only registration + excludeCredentials,
  anonymous authentication over the login rate limiter issuing the exact
  password-login cookie/mint/tail (trustDevice + desktop mint), revoke by
  id AND rpID, GET/DELETE /api/passkeys management, tunnel-scope 403
  family, and the auth-reset passkey purge (E-08-3 complete). Registered
  E-08-20..22 in NOTES/08. Adversarial review (sub-agent) fixed P0×2 —
  expected-origin ports (rpID drops the port, origin keeps it; scheme-
  default 80/443 suppressed) verified against the REAL adapter, and the
  granted session cookie was being dropped by the passkey finalize —
  driven now by a route-level E2E with a server-built synthetic P-256
  authenticator (real CBOR/COSE) — plus P1×2 (corrupt userID regeneration,
  transports allowlist/caps) and the machinery split for file caps.
  184 web (+15 p8-1-passkeys) · 389 UI · typecheck+gates green.

- 2026-09-18 · **P8-2a delivered (doc 08 relay steps 6/7: identity + Layer 2
  + Layer 3 primitives).** RelayIdentityStore (strict regeneration gate,
  serverId formula, ECDSA IEEE-P1363 URL auth verified through WebCrypto
  as the worker would, ws/wss query rows), E2EE derivation chain
  (ECDH→HKDF→two AES-GCM keys, IV prefix+BE counter, fail-closed decrypt
  incl. replay/regression/version/GCM, 64 KiB cap), handshake grammar
  (reduced JWKs, capability flags), tunnel codec byte contract (types
  1-13, 5B header, odd stream ids, fragmentation with the 16 MiB
  assembler bound, empty-body single chunk, payload shape guards).
  Registered E-08-23 in NOTES/08. 195 web (+11 p8-2-relay-primitives) ·
  389 UI · typecheck green.

- 2026-09-18 · **P8-2a review fixed (sub-agent).** P1×2 (chunk-size cap
  enforcement at MAX_TUNNEL_PAYLOAD_BYTES; BigInt-stepped wire counter
  with a 2^53 exactness gate — Number() collapse probe-verified) + P2×4
  (final-chunk assembler bound hole, 256-group pending flood cap, guard
  strictness registered E-08-24, concurrent-mint singleflight) + test
  junk replaced with real negative verification rows. All byte/parameter
  contracts probe-proven (serverId order, P1363 sig, IV offsets, WHATWG
  ws/wss rows). 201 web (+6) · 389 UI · gates+graph green; E-08-25
  registered (a-e pending bounds/bigint/singleflight+LWW/fresh-ts/
  outbound-cap deferrals).

- 2026-09-18 · **P8-2b delivered + reviewed (doc 08 §3.3/3.4/3.11 host
  side).** Host control machine (outbound authenticated control socket,
  30s ping / +10s pong grace, exponential reconnect 1s×2 cap 30s,
  nonzero close → lastError, owner-guarded opens/closes; the inverted-
  ternary reconnect wedge found and fixed), data legs (open timeout w/
  clear-on-open, host-handshake responder integration, recv/send chain
  discipline, 90s idle reaper swept at 30s), established-frame ROUTING
  fix (duplicate hello re-answers the SAME ready; a different fingerprint
  closes 1008; other text closes 1011 — the broker previously dead-routed
  the responder), no-listener crash guard on CONNECTING teardown (P1),
  one-close-decision guards, and a loopback fake worker (worker-parity
  auth verify, 4001 replacement, upgrade gate, verbatim forwarding) as a
  test-only prosthesis. E-08-26a–g + broker timing constants registered.
  9 gates in p8-2-relay-host.test.ts · 210 web (+9) · 389 UI ·
- 2026-09-18 · **P8-2c delivered + reviewed (doc 08 §3.5-3.9, Layer 3 host side).**
  Batch container codec + OutboundFrameBatcher (150ms/24KiB/32 defaults,
  payload-types-only buffering, setup-first flush, leading-edge instant,
  caps-on-received, enqueue-serialization w/ the self-deadlock found),
  downstream scheduler (credit window 64KiB→1MiB fixed accounting,
  DeliveryAck 8B BE strict boundary validation, stream-zero outside the
  ledger, queue caps, cancel semantics; adaptive heuristics deferred
  E-08-27), host dispatcher (§3.9: allowlists + synthetic-json 403/400,
  header hygiene + relay-connection/origin injection, buffered bodies
  only-at-StreamEnd w/ zero-frame/deadline guards, >512KiB live web
  ReadableStream duplex, response chunking, WS sub-streams w/ fragments +
  clamped closes + 1008 refusals, duplicate-stream aborts, Ping→Pong,
  detached lifecycle pump). Review fixed P1×3 (batch dead-lock, window
  ledger dead-loop, undici live-body rejection) + P2×5. 18 suite tests.
   228 web (+18) · 389 UI · typecheck + gates + graph (250 modules) green.
   typecheck+gates green.
- 2026-09-18 · **P8-3a delivered + reviewed (doc 08 §3.12/3.13/3.15 + §3.5-3.9
  assembly, checklist step 8 tail).** Relay host service lifecycle (demand
  reconcile via allSettled any-wins/throw-aborts; relay-config.json machine
  store E-08-28; 60s demand poll + 30s claim watcher), machine claim
  (relay-host.lock tryClaim/forceClaim/release w/ synthetic-liveness probe,
  ESRCH stale claimable, EPERM alive, corrupt==no-claim, write-failure
  pre-lock posture via tri-state outcome E-08-29), standby takeover
  (foreign claimant stand-down + 120s grace, boot instant reclaim),
  passive hold-out env (NOTNATIVE_RELAY_HOST off/on + ELECTRON_DEV with
  the on-override), enable/disable/status §3.15 routes (16KiB bounded
  reader, ws/wss normalization w/ default fallback, relayUrlLocked), the
  §3.13 relay candidate (getPairingCandidate + ensureEnabledForPairing
  force-claim), /health serverId E-08-2 (shared identity singleton +
  fail-soft peek), and the PRODUCTION leg mux (leg-host: mixed-mode L2
  demux E-08-30 — §3.7 wires tag or bare frame, dispatcher entry —
  fragment assembler, dispatcher, batcher offerEncoded, loopback-adapters
  RealLoopbackSocket `ws` production dial w/ origin+relay-connection
  injection; broker terminateLeg + negotiated capabilities on
  onLegEstablished; /health batch-window env consumption). Review fixed
  P0×2 (dispatcher 511-line cap -> request-body.ts extract; the REAL
  0x01 batch-tag collision — a bare HttpRequest frame byte was misread as
  the [0x01] container tag and 1011'd every spec-compliant client leg;
  shipped the parse-validated demux rule: 0x01 is a container only when an
  exact multi-segment run of buffered-type frames parses, bare fallback
  otherwise) + P1×3 (claim write-failure stood hosts DOWN — tri-state
  claimed/contended/write-failed E-08-31; disable() killed the poll/
  watcher de-lifecycling the service; unhandled-rejection surface on the
  direct carrier paths) + P2×3 (dead env helper consumed by leg batches,
  bounded enable body, batcher timer unref).   45 suite tests across three
  files (lock+config 17, service+routes+health 22, production wire 6: HTTP
  E2E incl. a bare-frame leg, WS upstream both ways + closes, replay
  closes 1011). 273 web (+45) · 389 UI · gates+smoke+graph (257) ·
  version 20260918-8 sealed (a1e4f83 + ledger 36a764f).
- 2026-09-18 · **P8-4a delivered + reviewed (doc 08 step 9 server half + E-08-13
  family; adversarial ses_f48d0a552ffejimD2JyQP6KHkP).** Pairing session
  store (client-pairing-sessions.json 0600, one-time secret via create/
  redeem replies only, mint retry-safe tail, sweep retention inactive+TTL,
  sync store posture E-08-32) + the /api/client-auth route family: redeem
  anonymous pre-gate (10/5 min sliding window keyed raw-socket:pairingId,
  success clears bucket, one generic error for every failure class incl.
  429 + Retry-After), gated authority family (manage = UI session |
  desktop-local | open; plain tokens self-only; pairing reads
  manage-gated), pairing sessions create/list/cancel (§5.5 candidate
  math: serverUrl primary 10, request-origin extra 20 when
  different+not-loopback, https->tunnel type, empty label -> unset,
  loopback fallback refused w/ 400 'No usable pairing candidate',
  wildcards rejected, includeRelay true -> ensureEnabledForPairing
  force-claim + 503 when unavailable, default -> legacy
  getPairingCandidate, false -> never; dedupe), §3.13 candidates refresh
  (socket local-address first, interface scan, relay last, serverId
  rides, never URL-token-authorized pinned by test) + transports view
  (LAN from server bind: concrete non-loopback passthrough, wildcard
  LAN-IPv4 scan, loopback -> null), and the §3.12 reconcile call sites
  (create/cancel/redeem/revoke/purge fire-and-forget; index.ts demand
  joins hasActiveRelaySession() beside hasActiveRelayClients()). Shared
  bounded-body reader extracted (lib/http/read-bounded.ts). Review fixed
  P0 (auth-family singletons defaulted dataDir '' — stock boot 500'd
  pairing create and split-brained the identity dir; now ENV.dataDir) +
  P1×2 (redeem IO faults were masked as the attacker-facing generic 400
  after minting — typed InvalidPairingSessionError vs PairingStoreFault,
  consume-on-confirm stamp rollback, faults 500 without charging the
  bucket; GET pairing reads were any-bearer — manage authority now) +
  P2 cluster (registrar split, empty-label unset posture, cancel-of-used
  404 E-08-33g, 0700 dirs, wildcard serverUrl rejection, reconcile on
  ensure-failure exits). 42 tests (store 15: formats/TTL/hash-only/
  one-generic-error matrix/label precedence/retry-safe/sweep/persistence/
  corrupt-reset/ENV-default/save-fault rollback; routes 27 across two
  files w/ a shared harness: rate keying incl. socket-split buckets +
  clear-on-success + fault-no-record, wire byte-equality of auth error
  classes, exact 201/200 shapes, no-store, loopback exclusion, origin
  extra dedupe, cancel 404-already-gone/used, authority matrix, drain
   jars, authority matrix, drain
   fixtures, password-mode rows + URL-token refusal). Web 315 (+42) · UI
   389 · gates+smoke+graph (261) pending final seal.

- 2026-09-18 · **P8-4c delivered + reviewed (doc 08 step 10: tunnels).**
  Capability registry + §4.2 normalize/validate (fallbacks vs unsupported,
  intent matching, ~ home-containment, host/token rules, 400/422/500
  mapping); §4.3 drivers — cloudflared quick (temp HOME/USERPROFILE on
  win32, URL both-streams, 30 s kill+cleanup+exact text), managed-remote
  (--token-file 0o600 temp never argv, stdout drained not logged, ready/
  fatal sets + 6 s liveness + 20 s hard fail, cleanup on exit/stop),
  managed-local (guarded reads ≤256 KiB, yaml/JSON ingress hostname,
  --config only when requested), ngrok quick (env→config-check authtoken
  remediation, API 5 s gate, JSON+4040 harvest https-first, summarize);
  §4.4 profile store (cloudflare-managed-remote-tunnels.json 0600
  promise-locked, sanitize+dedupe id/hostname, upsert conflict removal +
  corrupt heal, legacy named-tunnels migration, token-free views);
  §4.7 service (mutex one-controller, same-config reuse vs replacement
  with tunnelId persistence, failure path detach-without-revoke, stop
  retained w/o controller, lazy dead-controller resync, §4.4 token
  chain) + §4.6 routes (check/providers/doctor+CLI flag/status/token
  upsert/start connectUrl/stop) + seven §11.2 settings keys (canonical
  registry + snapshot, token secret) + TTL wire-up + §4.7 startup env
  tunnel (NOTNATIVE_TUNNEL_*) + shutdown dispose. Adversarial review
  (ses_f4859e55bffevrAmsmKa493OW0) fixed
  P1×2 (tunnel-scope visitors could start/stop tunnels + write run-token
  profiles — operator guard E-08-37; TTL wire junk disabled expiry) +
  P2 cluster (USERPROFILE/APPDATA quick isolation, rmSync retries+guarded
  stop, /connect socket-key limiter, yaml parse echo, doctor mode 400,
  settings PUT bounded, ngrok listener dedupe, spawnSync timeouts,
  .bat/.cmd launch exclusion, buildRequest type-junk 400s) — deltas
  E-08-34..40. 44 tests (core 15, profile-store 12, providers 22, ngrok
  12, service 11, routes 14 across three helpers) + settings-store seed
  fix E-08-40. Web 401 (+44 net w/ scratch removal) · UI 389 ·
  gates+smoke+graph (276) — seal 20260918-10.
- 2026-09-19 · **P8-5a delivered + reviewed (doc 08 step 7 tail + the
  client half of steps 11-12: relay client face).** The ui-side relay
  mirror (`packages/ui/src/lib/relay/` — browser-safe Uint8Array +
  globalThis crypto, dual-compile with the server tsconfig): Layer 2
  E2EE (crypto.ts, hello/ready grammar, fail-closed counters), client
  initiator (handshake.ts), Uint8Array Layer 3 codec with the
  [0x00]/[0x01] mixed-mode container demux + fragment assembler
  (tunnel-codec.ts), §3.8 ack ledger (16 KiB inline + 10 ms tail,
  keepalives excluded, per-handshake reset — tunnel-acks.ts), ambiguous
  transport tagging, §3.10 fetch lanes (streamed bodies, probe
  content-types, abort/body-cancel/StreamAbort semantics, 204/205/304
  null bodies), WS surface (native shape, readyState only via real
  frames, 1006/1012 close mapping, send-before-open exact text),
  tunnel-client state machine (inbound-driven keepalive w/ options,
  §3.11 backoff base ×2^cycles cap 30 s/60 s offline-hidden, queued
  connect attempts, terminal close retention, closed-generation
  watermark, lane/listener releases, fail-closed send errors), client
  outbound §3.7 batching (negotiated, setup/keepalive flush-first,
  batchWindowMs honored). Runtime integration: runtime-tunnel singleton
  (byte-equal descriptor reuse incl. grant + canonical JWK, terminal
  reuse refused, adopt joins status fan-out), runtime-switch activates
  BEFORE the §6.0 mint, runtime-fetch routes through the tunnel with
  coalescing, runtime-auth mint rides the tunnel + §2.6 mint-failure
  clears the token, runtime-socket sanctioned op. Host side: E-08-27
  heuristics LIVE in downstream.ts (grow on blocked-head latch +
  near-best RTT ≤ minRtt+50, halve > minRtt+100 floor 64 KiB cap 1 MiB,
  once per checkpoint = acked + POST-adjust window, stream-zero-first
  rounds, `now` seam) + scheduler.sendNow (terminal rows bypass the
  queue but stay ledger-accounted — the review caught every mirrored
  WsClose/StreamAbort row failing the channel 1011). Adversarial sub-agent
  review (ses_f46d2dbf9ffeh137n5voMf8NWt): P0×1 + P1×7 fixed in-slice
  (P0-1 accounting seam E-08-41; P0-2 backoff off-by-one; P1 lanes
  leak, adopt status-blindness, WS local-close echo, body-read settle,
  mint clears, downstream test gap, terminal reuse) + P2 cluster
  (timer detaches, watermark, Request inputs, >16 MiB guard,
  bodyless-status belt, stream-zero-first rounds, dead-code trims) —
  deltas E-08-41..49. Tests: ui 428/53 (+39: relay-primitives 21,
  fake-broker tunnel-client 14, runtime-tunnel 4) + web 413/31 (+13:
  p8-5a E2E 6 — the REAL client over the production host-service leg
  incl. the >64 KiB ack-driven response, WS codes + post-close fetch,
  leg replacement; p8-5a-downstream-window 6 deterministic suites).
   Typecheck both tsconfigs · gates+smoke+graph (294) — seal 20260919-1.

- 2026-09-20 · **P8-5b delivered + reviewed (doc 08 §2.5/2.8/5.8/6.1/6.6-6.7 +
  app wiring).** Client faces: connection-payload (both §5.1 parsers +
  16384 cap + v2-only), pairing-client (§5.6/5.7 candidate racing w/
  identity-gated direct probes + relay-last throwaway tunnel + scope
  forms incl. the relay-consent mapping), pairing-qr (§5.8 1024px L),
  pairing-watch (§6.1 close reasons), passkeys client lib (§2.5
  ceremonies w/ transport-tolerant status-0 degrade), runtime-auth-expiry
  (§2.8 classifier + 15 s confirm probe + focus watch + send-guard
  predicate), and the §6.6/6.7 components (SessionAuthGate stages +
  AuthExpiredBanner + pairing dialog family). App wiring: gate above
  App in the provider tree (locked visitors never boot the app), banner
  under the MainLayout header, composer send guard (button + Enter),
  splash released on the gate's first answered probe, trust-device key
  rebranded 'notnative.uiAuth.trustDevice'. Adversarial sub-agent review
  (ses_f3ee2b0a7ffe67K6YxJaLot3Yj) fixed P0×1 (passkey ceremonies wedged
  the gate on transport failure) + P1×3 (relay consent dropped from the
  create body; tunnel-lock re-entry cleared the expiry store; dialog
  rendered while open:false) + P2×1 (ghost ThemeSystemProvider comment);
  registered E-08-50..52 (no ThemeSystemProvider layer; sequential
  probe/support assembly; relay-consent includeRelay:true with the
  anywhere-preflight refusal). Web-parity harnesses pinned the payload
  byte-parity + route shapes. ui 577 tests (+149 vs the P8-5a seal) ·
  web 438 (+25) ·
  typecheck ×4 · gates green — seal 20260920-1.

- 2026-09-20 · **P8-5c delivered + reviewed (doc 08 §5.9 connect-url + the
  doc 03 CLI framework seed).** packages/web/src/cli/: shared parser
  (long/inline/short/-no-x aliases, usage exit 2), output engine (S10
  modes, --json-over--quiet, decorations TTY-gated, warnings reach
  piped stdout), instances (probe + detached auto-start with real log
  fds + 30 s readiness + kill-on-timeout + instance record), connect-url
  (exact §5.9 resolution order, direct+optional relay candidates with
  the shared identity lazy-mint, pairing session written DIRECTLY to
  the on-disk store, link via the shared ui encoder, [RELAY_STARTING]/
  [LAN_UNREACHABLE] advisories, qrcode-terminal --qr, S5.9 --json
  shape, --quiet link-only), dispatch/help/roster + bin entry
  (`notnative`, exit codes 0..5). Adversarial review
  (ses_f3e4ff5b2ffelKEKfunoIX2JMs) fixed P0×1 + P1×5 + P2×4: P0 the
  pairing store was a boot singleton — CLI-created sessions were
  invisible to a live server (every CLI link would fail redeem);
  every store op now refreshes from disk (last-writer-wins posture)
  + pid-stamped tmp names; P1 --lan flag missing, dispatch refused
  flags-only/positionals, help pages split, orphaned child killed on
  readiness timeout + record removal + exit 5, quiet warnings to
  stderr; P2 HTTPS case-sensitivity, port junk parsing, address token
  guards. Registered E-08-53..57. Live smoke: auto-start +
  discovery-drop-in both verified against real servers. web 483 tests
  (+29) · ui 577 (+0) · typecheck ×4 · gates green — seal 20260920-2.

- 2026-09-20 · **P8-6 delivered + reviewed (doc 08 §7 SSH machines, the
  UI-ownable half).** The §7.2 instance contract ships as
  lib/desktopSsh.ts (strict normalizer + sshCommand parser with
  program-word exclusion + value-flag vocabulary, timeout bounds
  E-08-58, remote-LAN password rule, plaintext-store confirm rule,
  random-port retry helper, sshRuntimeKey 'ssh:<id>' E-08-61),
  lib/desktopSshImport.ts (~/.ssh/config alias rows + bridge-guarded
  read, E-08-63), and lib/desktopSshStore.ts (the §7.3 store: bridge
  seam only — the UI never spawns ssh (§7.4), pushed statuses keyed
  by id w/ strictly-older pushes dropped + equal-stamp replacing
  (E-08-59), in-place upserts, trigger-honest bridge-less posture
  (E-08-64), secret mirror verbatim with no echo paths (E-08-60)).
  Electron internals (master channel, installers, bundle upload,
  forward lifecycle, host-key prompts) are doc 09/P12 as the slice
  states; the Remote Instances UI page mounts with P12. Adversarial
  review (ses_f3e23db48ffewK6wydq4mPWhyV) fixed P1×5 + P2×4 (program
  word, -q boolean, listener survives config failure, silent
  bridge-less failures, untraceable create refusal; row-order jump,
  status port rule, stale statuses on setBridge, guard bypassed).
  Registered E-08-58..64. ui 599 tests (+22) · web 483 (+0) ·
  typecheck ×4 · gates green — seal 20260920-3.

- 2026-09-20 · **P8-7 delivered + reviewed (doc 08 §9 reverse-proxy
  posture).** lib/http/request-security.ts (origin consumption: HOST
  equality only — protocol never compares, candidates Host /
  x-forwarded-host / publicOrigin + packaged-client origins
  case-folded; absent Origin passes; bare-host regex with the IPv6
  bracket arm + default-port canonicalization), wired into the
  terminal WS upgrade (destroy on disallowed Origin; doubled-Origin
  joins and fails closed), plus doc 08 §9 hygiene: X-Robots-Tag
  noindex,nofollow middleware + /robots.txt disallow-all + an onError
  belt, and the dev vite proxy now sends origin:=apiTarget (E-08-66,
  §3.9 dialer parity) so the §9 gate does not kill dev terminals.
  SSE header rows pinned through a live stream body. Cookie Secure,
  passkey rpID, redeem raw-socket limiter, compression-one-layer
  (still doc 03/P4) were already sealed by their owning suites.
  Adversarial review (ses_f3e09f794ffe7LZlAYllgOdVxZ) fixed P1×3 + P2×2
  (IPv6 origins never matched; dev proxy would have killed every dev
  terminal WS; doubled-Origin fail-open; unstamped hono-default 500s;
  case-sensitive packaged origins). Registered E-08-65/66. web 503
  tests (+13) · ui 599 (+0) · typecheck ×4 · gates green — seal
  20260920-4.

- 2026-09-20 · **P8-8 delivered — P8 PHASE COMPLETE (doc 08 §12
  invariants sweep, checklist step 15).** The audit ran all 42 §12.1-12.5
  rows: 30 already pinned by their owning suites, 9 new pins, 2
  gap-fixed, 3 registered; the matrix lives in NOTES/08 §D.
  New sweep suite p8-8-invariants-sweep (static no-leak rows: no
  Authorization/cookie logging in server src; 0o600 on every secret
  store except the E-08-29 host-lane; no-store helper discipline;
  tunnel bodies token-free; ui runtime/relay never persist) + runtime
  rows (duplicate host dials; failChannel payloads). GAP-FIXED:
  decodeTunnelFrame foreign numerals now CodecError in both mirrors
  (E-08-69); redactSensitiveUrl landed as lib/redact-url.ts (E-08-67,
  wiring P12). Registered E-08-67..69; §6.4/6.5 identity-gated probe
  cluster rides P12 (E-08-68). web 511 tests (+8) · ui 608 (+9) ·
  typecheck ×4 · gates+graph (326)+smoke — seal 20260920-5.

- 2026-09-20 · **P9-1 delivered + reviewed (doc 12 message-queue server
  runtime, checklist step 7 — §D.1-§D.5).** packages/web/src/server/queue/
  (9 modules): D.1 item contract (parse matrix 400s, 200k content cap,
  attachment coercion, context metadata required, 103/100 previews),
  D.2 store (message-queue.json v1, monotone revision per mutation,
  pid-tmp atomic writes, corrupt rename-aside + write-disable-on-read-
  failure re-enabled by the reconcile beat, 20/50-session limits —
  newest-kept / oldest-evicted-never-in-flight), D.3 delivery loop
  (500 ms idle quiet timer, abort-hold 2 s, per-ITEM backoff
  2 s×2→60 s cap, LIVE idle verification (status-map absent + the
  2-message tail complete), head re-read, §D.3.6 exact part order w/
  the composer-parity slash expansion ($ARGUMENTS/$1..$N
  last-absorbs/append), command-vs-prompt routing (command route only
  sans context), onPromptSent hooks, broadcast-first behavioral),
  D.4 in-memory TTL holds (auto-release backstop wakes survive the
  holder's death — review P1), D.5 route family (snapshot/enqueue/
  take/takeAll/full-permutation order/item+session delete/hold;
  409 in-flight; every reply carries directory incl. emptied queues)
  + `notnative:message-queue.updated` broadcast on the control stream,
  alphabetical reconcileAll + startup load-then-reconcile.
  Adversarial review (ses_f3d3abec2ffeaO2aJ2zinI31je) fixed P1×3 + P2×2:
  P1 held queues strand forever when the asserting UI dies (schedule
  the expiry's own wake), P1 write-disable re-enable was dead code
  (reconcile probes now), P1 delete replies could drop the directory
  (memory-only entries); P2 take-over-empty bumped revisions, P2
  abort stamps never vacuumed. Registered E-09-1..14 (brand rows,
  knowledge seam, quiet-coalescing earliest-arm, catalog load
  degrades to prose, feed stop posture, legacy id/createdAt parse).
  Builder agent (ses_f3dba4e26ffePW1CAscFFAL7t8 + fixer
  ses_f3d56f27dffeTQu3hrCWPtTDSj; adversarial ses_f3d3abec2ffeaO2aJ2zinI31je).
  web 585 tests (+74 across 5 suites) · ui 608 (+0) · typecheck ×4 ·
  gates green — seal 20260920-6.

- 2026-09-21 · **Build-path repair + build gate (assessment slice).** Full independent
  verification of 20260921-2: typecheck ×4 green · ui 608/608 · web 586/586 ·
  gates+smoke+graph green · seal manifest honest (release:check green pre-edit).
  The only real failure: `pnpm build`. `packages/web/src/index.css` imported
  `../ui/src/styles/design-system.css` — resolves to the nonexistent
  `packages/web/ui/…`; the line was BORN wrong at P5-1 (2026-09-16, verified in
  commit 3f70fc6) and rotted unnoticed because no seal since P1 actually ran
  `vite build` (release-gates only spawns quality-gates + smoke; D7: the builder
  sandbox could not spawn esbuild). Fix: `../../ui/src/styles/design-system.css`
  (the vite JS alias `@notnative/ui` does not apply to Tailwind's CSS resolver).
  Gate hole closed: `scripts/release-gates.js` now runs the web production build
  via the web package's own vite CLI (dist stays manifest-excluded). The seal
  machinery proved honest both directions: it flagged the pre-fix mismatch and
  required this re-seal. Adversarial sub-agent audit ran before the seal.
  Sealed as 20260921-3. New `docs/build/EVALUATION.md` seeded with the
  verified-working / known-broken matrix this assessment produced.

- 2026-09-22 · **P12a installable shell — FIRST INSTALL ON THIS SYSTEM.**
  Electron v1 subset (doc 09 + NOTES/09 D-09-1..15): in-process server (never
  sidecar), port stored→57123→ephemeral via test-bind before bundle import,
  env set pre-import, loopback-only, splash→health→navigate boot chain,
  preload allowlist + sender framing, NSIS oneClick perMachine unsigned.
  Pipeline `scripts/electron-package.mjs`: vite → stage web-dist → esbuild
  server (node-pty the lone external; createRequire banner + bundle audits)
  → sibling-data staging → electron-builder → installer + sha256. First
  packaged boots exposed three packaged-only defects no source-checkout gate
  could see: selfDir() file-vs-directory (boot died "bundle missing
  app.asar\main.mjs\…"), ESM bundle without require for CJS deps (ws →
  "Dynamic require of events"), runtime settings-registry.json unstaged
  (ENOENT). All fixed + regression-guarded in the pipeline. Version surface
  unified (NOTNATIVE_APP_VERSION, D-09-12). Independent verification on
  hardware: silent /S install (and silent uninstall — dir gone), boot chain
  in main.log, /health 200 version=20260921.0.3, / 200, /assets 200, port
  persisted; terminal-create degrades to a clean JSON error (node-pty
  unshipped by design, D-09-5 — P12b ships it). App left RUNNING on :57123
  for user evaluation. Adversarial audit: auditor stalled after the 3-defect
  proof chain; orchestrator completed probes (pty shape live-probed, IPC
  framing, port TOCTOU, dual-instance dataDir, version surfaces) — five
  residuals registered in NOTES/09 §B2, none release-blocking. Builder
  agent stalled mid-verify and was takeover-released; both its fixes and the
  orchestrator's landed green. web 586/586 · ui 608/608 · typecheck · gates
  + graph (336 modules) · installer sha256 53de3fa76c9ec36d66fb502c0dae7602
  a0d3a46505400b551573f37566c4075d. Sealed as 20260921-3.

- 2026-09-22 · **P9-2a PARTIAL — goals core layer committed; goal rounds exhausted.**
  Session-goal runtime arrives in two steps; this commit ships the foundation
  and an exact resume map. ON DISK + SEALED (20260921-4): `goals/goal-constants.ts`
  (§B.2 all twelve constants verbatim, settle reasons, notification titles),
  `goals/goal-payload.ts` (§B.1 schema, tolerant-bounded parse, clamps,
  objective-file id shape validated BEFORE fs, `${ts36}${rand6}` goal ids),
  `goals/goal-metadata.ts` (namespace-preserving read-modify-merge for
  PATCH /session/{id}, goal-only removal that keeps sibling keys, §B.5.1
  id-guard), `goals/goal-state.ts` (T1–T17 as pure payload transforms —
  arm/pause/resume/reactivate/settle/continue, refusal-as-null contract,
  settle always resets both streaks). Tests: builder's p9-2a-goal-payload
  suite + orchestrator's p9-2a-goals-core (25 tests incl. the constant pin,
  hostile-input clamps, fs-shape guard, T17 refusal, 20-continue counter
  alignment, resume-fresh-tolerance). One defect found by the new tests and
  fixed: armGoal accepted an objectiveless goal the parser would later
  disown. web 644/644 (43 files) · typecheck · gates+graph(340) · smoke ·
  build green; NOT UI-touched.
  RESUME (P9-2b, next session): tick runtime B.5 (quiet windows, gates in
  evaluation order, accounting B.5.4), evaluator exchange + small-model
  module (doc 02 §7.4 + injectable provider seam + deterministic mock),
  mock session-metadata persistence (store has only time.*), routes
  (arm/pause/resume/clear + objective PUT/GET/DELETE) into app.ts,
  createSessionGoal + B.6 prompts, deferred-by-order items: T9/B.5.6
  length-recovery, truncation derivation edges, SSE, notifications. Then
  P9-3 scheduled tasks (doc 12 §C 606–935; §J items 3–6; hinges: two
  processes ≠ double-run, DST cron equality, once→enabled:false), P9-4 UI
  batch (queue D.6–D.8 + goal controls B.8 + task dialog), P9-5 multi-run/
  fusion (E) + F.1, P10 doc 15 (§M checklist, 1928), P11 doc 13 (§L, 1013),
  P12b (tray, openchamber://connect verbatim, updater, node-pty shipping,
  stale-dist build-stamp), P13 integration verify. The P12a installer remains
  installed and running on this machine.

- 2026-09-22 · **P12b-1 tray + scripted source install (user directive pivot).**
  User: the packaged NSIS flow is not intuitive; the GUI is nearly empty.
  Deliverable 1 landed: repo-root `install.ps1` (row-bot action-pattern
  parity) copies source → `%LOCALAPPDATA%\NotNativeDesktop`, pnpm-installs,
  repairs electron postinstall, runs `electron-package.mjs --no-nsis`
  (artifacts only), stamps the scripted-install identity marker, and creates
  Desktop + Start Menu shortcuts; `install.sh` written for POSIX parity
  (UNVERIFIED on this host — no bash/WSL distro; registered). Tray slice in
  `packages/electron/tray.mjs` mirrors the reference launcher: status
  feedback (starting/running/stopped icon+tooltip), menu [Open App (default)
  | Open Web UI in Browser | status | Quit], close-hides-to-tray (service
  outlives window), Quit = dispose→quit→8s watchdog, boot-failure stays
  alive in stopped state when trayed. Icons generated dependency-free
  (`scripts/electron-tray-icon.mjs` raw PNG encoder). IPC invoke face
  extracted to `ipc-face.mjs` (file cap). Scripted install gets product
  identity via `install-mode.txt` (userData `%APPDATA%\NotNativeDesktop`,
  AUMID without `.dev`) — repo checkout and installed copy co-exist. Version
  surface fix: unpackaged `app.getVersion()` returns the ELECTRON version
  (probed: /health said 44.4.3) — main now reads the root manifest
  (probed: /health 20260921.0.6). Live evidence: full scripted install
  executed (exit 0: copy/pnpm/build green/2 shortcuts), launched VIA the
  desktop shortcut, boot chain in `%APPDATA%\NotNativeDesktop\logs\main.log`
  (port fallback 57123→61776 while repo-dev instance held 57123, tray line,
  server ready, window navigated), /health 200 + /assets 200. Pipeline
  failures en route and fixed: PS parser mojibake (em dash → pure ASCII),
  and the big one — vite/pnpm stderr under $ErrorActionPreference=Stop
  aborted install.ps1 twice (NativeCommandError); native calls now route
  stderr to log files via a Continue-region helper (Invoke-Native), exit
  codes authoritative. D-09-16/17 registered. NOTE: running app predates
  main.mjs version fix → installed copy patched in place (single-file copy),
  full tree refresh lands with the next reinstall. Deviation registered:
  this infra slice is behaviorally verified; the adversarial audit agent
  fires on the committed tree next round (fixes land as follow-up).

- 2026-09-22 · **P12b-2 GUI-PLAN sweep delivered + SLICE-A `chat-alive` wiring
  (user directive #2 begins).** Sweep agent delivered GUI-PLAN.md (index) +
  Sections 1–4: wanted feature inventory W-01…W-113 with doc cites,
  file:line-verified current state (top reason the GUI looks empty: boot never
  opens a session — the restore pair had zero call sites), OpenChamber port
  map, and the ordered slice plan A→G. SLICE-A implemented in-session:
  `openInitialSession` (engine-instance.ts) priority chain — existing
  selection wins; validated last-active pointer (exists in the authoritative
  list AND same directory); non-archived seeded welcome demo; else honest
  empty draft — executed after the initial resync resolves; boot-open also
  enqueues the message tail load (`'boot-open'` added to
  MaterializationReason) so the transcript doesn't skeleton forever (found:
  NOTHING loaded session messages on sidebar click either — events/child
  pivots were the only enqueue sources). Restore pair fully wired:
  onSelectSession + MainLayout open/openDraft call
  persistLastActiveSession. Welcome mock copy refreshed. Tests
  sync/__tests__/parts-boot-open.test.ts 7/7; ui 615/615 (65 files,
  worker-capped under memory pressure); typecheck ×4 green (cross+server
  clean, ui+web-ui green after reason-union fix). Live: artifacts rebuilt,
  redeployed to the installed tree (dist + assets + version source),
  relaunched via shortcut; /health `20260922.0.1`; boot chain green; bundle
  contains the boot-open reason. GUI-PLAN marked SLICE-A task-1 landed.
  NOTE: `desktopUiPassword` is now set on this machine (sweep observed
  04:48Z) — the installed app boots to the auth gate by design.

- 2026-09-22 · **P12b-3 SLICE-B `review-band` + installer audit fixes + web-only
  runner + hidden boot (seal 20260922-3).** Builder delivered SLICE-B 7/7
  guarantees: Files tree with git status dots/badges + 15 s visible-gated
  cadence + hint-driven restat; Diff per-scope stacks with >500-line gate +
  scope-aware single-hunk apply (version-locked against the server contract) +
  §5.8 scroll anchoring; Git stage/unstage/discard/commit optimistic with
  rollback; worktrees verified; Terminal seam un-stubbed
  (`createRealTerminalApi` over the PTY transport singleton, web RuntimeAPIs);
  review panes bound to the ACTIVE harness directory (`'/'` literal removed);
  refresh-hints bus + buffered hidden-window replay wired through Files/Diff/
  Git/FileTree (+ store applyStatus/invalidateStatus). ui 646/646 (73 files),
  web 644/644, tsc ×4 zero, gates 350 files, graph 350 modules; builder
  deferred §6.7 checkout/merge/stash routes, untracked-diff render, retained
  hidden panes, hunk kbd nav, i18n sweep, shared poller (all in the notes
  file). Adversarial audit of P12b-1 landed its approved fix set: honest tray
  stopped label, terminal boot-failure page (no splash forever; Open App no
  longer re-splashes), crashed-renderer reload, running-service guards +
  graceful purge reporting, robocopy stdout diagnostics, -SkipBuild
  completeness + staleness warning, artifacts integrity oracle
  (deterministic digests, live-verified), artifacts-mode skips dead
  web-dist staging, install.sh parity set (static-only), NOTES/09 D-09-12/16
  corrected + D-09-18 registered. Web-only runner scripts/web-serve.mjs
  (user-requested preview without the desktop window); auth-gate copy
  registered i18n-side (useOptionalI18n + GATE_KEY + drift test). New:
  `--hidden` electron boot (tray-only first paint; boot FAILURE still shows
  its page deliberately). SLICE-A loop live-proven on the wire (23 deltas,
  status transitions, abort → MessageAbortedError → idle) against the
  web-only preview at :58080.

- 2026-09-22 · **P12b-4 SLICE-C `session-product-b` (seal 20260922-4).** User
  confirmed the whole loop in their own testing ("double-click → tray →
  window → backend connects — so it's a start") → GUI depth continues.
  Builder landed all 5 slice tasks: tool cards
  (chat/tool-cards.tsx + markdown-lite.tsx hardened dependency-free
  renderer) with running/settled/error states, JSON view modes, live bash
  output pane; mock tool-demo lifecycle (`tool`/`bash`/`fail` triggers, full
  event chain inside doc-02 shapes); sidebar product — folders store +
  collapsible zones + archive/restore + REAL session rename (stale P4 toast
  deleted); blocking cards per doc 05 §F (bash/edit/write/webfetch bodies,
  Alt-stack reply semantics, question tabs + Summary with [[label]]/custom
  Other rule, honest 404); server-owned message queue UI
  (useMessageQueueStore: revision-gated snapshots, optimistic add with
  restore, full-permutation reorder, take-for-input, clear + follow-up
  steering setting) with composer QueueChipsRow + broadcast wiring; timeline
  fork-from-any-turn (fill-not-send, ESC-first close) + reactive prompt rail
  with hover preview. Truth: ui 683/683 (79 files, +37 confirmed twice),
  web 648/648 (44 files, mock tool-trigger tests), tsc ×4 zero, gates 357
  files, graph current. Deferred in notes: §6.7 server auto-accept runtime,
  queued attachments envelope, hold/take-all chips, rail windowing,
  timeline-dialog dedicated test file. Install channel: build-step stdout
  now captured (build-out.log) so artifact integrity digests surface during
  installs; failure diagnosis is tail-first.
- 2026-09-22 · **P12b-5 SLICE-A acceptance closed — the installed app now
  boots ALIVE (user report: "all I see is … No session selected").** User's
  installed copy ran a 09:54 UI bundle (installer robocopy had skipped fresh
  web dist) — but TWO real defects were hiding underneath and are now fixed
  with observation-verified acceptance (fresh headless profile, prod server,
  CDP drive): (1) sidebar lifecycle ordering STRIPPED session records down to
  {id,parentID,time} before sorting, so every row rendered "Untitled
  Session" and row-open lost its directory — orderSessionsByLifecycle is now
  generic/identity-preserving and the wrapper returns the ORIGINAL
  objects (session-ordering.ts, chat/session-sidebar.tsx:257); (2) boot-open
  raced its decision: `recovery.resyncDirectory('initial')` short-circuits
  on a fresh boot (zero reconnect candidates), so the .then fired against an
  EMPTY list and the Welcome fallback never matched — new
  sync/boot-open-readiness.ts `awaitAuthoritativeList()` waits for
  `sessionListSource === 'authoritative'` (bootstrapDirectory sets status
  'complete' BEFORE phase 3), failure, or a 6 s cap before
  openInitialSession runs (engine-instance parts rewired). Verified live
  end-to-end on the mock harness: boot auto-opens the seeded welcome session
  (real title, real directory), full transcript renders, and the session
  tab strip shows the open tab; unthrottled window streams the typed turn with the busy chip
  ("mock-smart is preparing"/"weighing options…") and deltas settle in <1 s;
  mid-flight `stop` button exists and clicking it settles the turn with the
  doc-05 aborted error face ("The running turn was aborted"); reload restores
  the same session with history via the persisted pointer. Truth: ui
  689/689 (80 files, +6: readiness ×5 + ordering identity ×1), web 648/648,
  tsc ui+web targets green, gates 358 files, graph rebuilt current,
  smoke:test passed (ses_kx05yrgx). Mock welcomeSeed copy already honest
  (mock status + NNA next + demo triggers) — left unchanged. Registered
  defect observation (non-blocking): mock harness answers 400 to the §9.4
  `/api/global/event/ws` upgrade, pipeline falls back to SSE per design
  (WS_FALLBACK_WINDOW_MS) — NNA adapter owns the real WS bridge (D16).

## Delta/Delayed register

| # | Item | Phase landing | Note |
|---|---|---|---|
| D1 | Mock harness semantics | P1 (doc 02) | P0 ships `/health`,`/auth/*`,`/api` proxy + control SSE only |
| D2 | Real auth (password/passkey) | P11 (doc 08) | P0 ships allow-all session + url-token mint |
| D3 | PWA manifest endpoint, SW update UX | P4 | P0 uses fallback manifest |
| D4 | GitHub/Linear/push integrations | P3/P4 | API members stubbed behind RuntimeAPIs optional fields |
| D5 | Terminal/git/files RuntimeAPIs bodies | P6/P7 | throwing stubs with typed contracts now |
| D6 | Electron globals/boot outcome | P12 | types now, behavior later |
| D7 | dev loop (`pnpm dev`) verification | user terminal | agent sandbox blocks esbuild/vite spawns; prod-build path verified instead |
| D8 | `system` theme variant via matchMedia | P5 (doc 14) | system currently renders dark |
| D9 | PWA manifest link + install/push hooks | P4/P11 | server endpoint exists; HTML prelude simplified |
| D10 | mobile surface | long-term | renders desktop tree + console warning |
| D11 | control-stream consumers | P2 (doc 04) | subscribed in App, handlers minimal |
| D12 | bare harness payloads | P1 | `{data,error,response}` synthesized in UI facade; v2 surface keeps `{data}` on the wire |
| D13 | seam renames | P1 | `x-nnd-directory`, stdout line `notnativeagent server listening on <URL>`, `NNA_*` env, `notnative:*` control events — coordinated pass pending NNA |
| D14 | mock scope boundary | P1 | mock = §12.1 + early §12.2 items; lifecycle/spawn/Basic-auth (P-01/03/22) belong to the future NNA adapter, not the mock |
| D15 | wire-name duplication | P1 | `server/lib/harnessNaming.ts` mirrors `ui/lib/nna/constants.ts`; both files change together |
| D16 | WS event bridges | P2 (doc 04) | P1 ships SSE only; §9.4 WS frame vocabulary recorded in NOTES/02 |
| E1 | typographyWatcher static-sheet substitution | P5-1 done | identical values; rem-root scaling (applyTypography) lands P5-3 |
| E2 | non-EN locales partial catalogs w/ en fallback | P5-4 | per-locale parity = authoring work; resolve chain per doc 14 §H.2 |
| E3 | 38 preset palettes self-authored seeds | P5-2 done | originals untranscribed (doc gap §M); NOTES/14 C.1/E.2 interpretation recorded |
| E4 | iframe theme sync + VS Code adapter | defer (P10/P12) | no embedded/vscode surface until those phases |
| E5 | custom-theme import UX (Appearance→Reload) | P5-3 | GET /api/config/themes + client gate live; page comes with settings UI |
| E6 | shiki/terminal/diff theme consumers | P6/P7 | §E.8 conversion contracts recorded in NOTES/14 |
