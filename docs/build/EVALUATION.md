# Evaluation Log — working / broken on this system

Running ledger of what has been VERIFIED on the build host (as opposed to what
unit tests assert in-process). Entries are dated; re-verification supersedes.

## 2026-09-30 - P12 source-installed Electron artifacts (workspace and installed 20260930-27)

**Verified working**

| Surface | Evidence |
|---|---|
| Artifacts-only package | `pnpm --filter @notnative/electron package -- --no-nsis` completed for `20260930-27`; Vite/CSS gate, server bundle, tray assets, settings registry, and Windows x64 `node-pty` runtime staged. |
| Build freshness | The workspace stamp covers 903 source/config files and 54 artifacts; the installed tree covers 904 because it also contains the installer-generated `install-mode.txt`. `electron-build-stamp.mjs check` passed in both trees. `install.ps1` rebuilds when this stamp is absent, stale, or mismatched. |
| Static gates | UI/web typechecks, Electron syntax checks, quality gates, version pairing, repository graph, and PowerShell parser check passed. Tests were not run. |
| NNA registration | Read-only `nna nnd package status` reports a valid registered package at `%LOCALAPPDATA%\NotNativeDesktop`, version `20260930-27`; the installed `VERSION` file agrees. |
| Installed launch and HTTP health | `install.ps1` completed successfully. `%APPDATA%\NotNativeDesktop\logs\main.log` records Electron loading the installed server bundle, binding port `61776`, and navigating to its loopback URL. The live `/health` response returned `ok` with version `20260930.0.27`; `/`, JavaScript, and CSS returned HTTP 200. |
| Browser rendering | The served UI rendered in the browser acceptance session. This verifies the installed server and web assets, but does not establish native Electron-window rendering. |

**Not yet verified on this host**

| Item | State |
|---|---|
| Native GUI walkthrough | CUA reported `apps=[]`, so no native application window was available for visual acceptance. |
| Launch-at-login interaction | The v27 UI and IPC are installed, but the native settings control could not be toggled or inspected without a visible Electron window. |
| NSIS installer | Disabled by `electron-package.mjs` until the NNA-aware installer can register or validate NNA and the NND package. |
| Remaining P12b surfaces | Deep-link pairing and updater work remain open; the broader P12b parity list in NOTES 09 §A is still incomplete. |

## 2026-09-26 - the snippet UI half at P9-4e-ii

**Verified working**

| Surface | Evidence |
|---|---|
| Shared roster | source 4/4: successful loads publish and notify; refusals AND rejected requests keep the current roster (same instance); each load replaces the map wholesale |
| Composer `#` | pins 5/5 over the real transport: the mount refresh publishes the server roster; `#si` lists server snippets and picking inserts `#sig ` (trailing space); a failed load keeps 'No matches' silently; a late response from a PRIOR token publishes nothing (counter crossing renders); a `#ma` retyped over a pending `@ma` merges no file results (span+kind guard); an insert clears the picker entry so no late response resurrects it |
| Composer inserts over the latest text | picking after typing replaces in the TYPED document (`send #si` + pick → `send #sig `), the pin that reproduced the stale-render-snapshot hole before the ref read |
| Settings page | page 9/9: roster render; refused list folds to the alert line and Refresh recovers; create rides the client and republishes the shared roster (list call count 3); an invalid name answers the byte-equal pattern string without a request; 409 keeps the form with the verbatim toast; edit PATCHes by stored name; a record folded away under an edit answers 404 verbatim and keeps the row drafting; delete leaves the row after the reload; a malformed 200 folds to the alert line |
| Editor parity | `# rides the shared snippet roster at composer parity` (editor 19/19): the same insert semantics and trailing space |
| Adversarial review | 3 defect classes reproduced red and fixed (the per-render token-counter no-op carried from E-09-28 (i), the hostile-200 unhandled rejection, the page's silent blank on malformed 200); probed-and-clean: textRef render-currency trace, one-Composer topology, byte-equal name patterns, settings-window 26/26 loop renders the real page, delete-mid-edit unreachability |

**Not yet verified on this host**

| Item | State |
|---|---|
| Snippet import/export | not in scope; the family remains single-name files |
| B.6.3 distill | the autonomy-chapter distill ride is the next slice |
| `#` keyboard navigation | clickable picker only on all surfaces (registered composer concern) |

## 2026-09-26 - the snippet config-entity family at P9-4e-i

**Verified working**

| Surface | Evidence |
|---|---|
| Route family | routes 19/19: fresh list `{snippets: []}`; create answers `{success:true, snippet}` with the `global` scope default and reads/list round-trips sorted; duplicate create 409 `snippet exists`; patch merges over the stored record with the route name authoritative (a body `name: 'sneaky'` cannot retitle); unknown patch 404; delete round-trips then 404s |
| Expansion | `POST /expand` replaces known tokens and keeps unknown bytes (`x #sig y #nope #sig` → `x sig-text y #nope sig-text`), riding the same `#([\w-]+)` rule as the composer's `expandPrompt`; the reserved `expand` word never shadows the expansion route and never creates; GET-by-name `expand` stays addressable |
| Validation | names outside `[\w-]{1,64}` answer the registered 400 across GET/POST/PATCH/DELETE; create validates text string + non-empty + scope string; malformed/non-object/oversize bodies fold to one 400; a corrupt stored file is skipped by the list, not fatal |
| Storage safety | a case-variant URL folds on the volume: create 409s, lookups answer the stored entry's own case and never retitle (readdir spellings asserted); reserved device names (`aux`, `com1`...) 400 before any store access; a lost-race DELETE folds ENOENT to the 404 arm; traversal/`%2F` names answer the plain pattern 400 and write nothing outside the family |
| Client envelope | client 4/4 over the real runtimeFetch pipeline: 200 stamps `ok: true` beside the config `success: true`; the 409/pattern strings stay verbatim; a 500 without a JSON body folds to the generic `snippet request failed (500)`; `expandSnippet` POSTs `{text}` |
| Adversarial review | 3 defect classes reproduced red and fixed (case-identity rewrite, reserved names, lost-race delete); probed-and-clean: mount order before the harness proxy, no pre-existing `/api/config` registration, THIS build tolerates device-name writes (registered against enforcement volumes), PATCH-merge intactness on 400s |

**Not yet verified on this host**

| Item | State |
|---|---|
| Composer picker source | the family exists server-side; the composer still seeds the empty local map — the real-roster wiring is P9-4e-ii |
| Settings management page | snippet create/edit/delete UI rides P9-4e-ii |
| Server-side expansion consumer | `/expand` has no UI consumer yet; the composer's local expansion at send time stays the operative path until P9-4e-ii decides |

## 2026-09-26 - the editor dialog at P9-4d-ii

**Verified working**

| Surface | Evidence |
|---|---|
| Editor shell | suite 18/18: create seeds the first catalog pair and blocks an empty-name save inline; create PUT carries NO state key and the seeded pair; edit prefill pins name/pair/agent/goal budget/prompt; edit PUT preserves id, state, loopFile, unknown ride-through fields, and flips enabled; goal off drops goalEnabled + goalTokenBudget; variant survives the kept pair only and drops on a provider/model change (both directions) |
| Prompt autocompletes | '/' lists the command registry and inserts `/timeline ` with the composer's trailing-space convention; '@' merges fsSearch file paths into the agent-name picker and inserts `@maintenance.rs `; the picker Escape closes only the picker (the editor stays); the fsSearch swap guard covers span AND kind (audit D1: a mid-pending '# ma' swap publishes nothing and binds no cross-kind insert); stale fsSearch responses after further typing publish nothing (token precision); dialog re-renders never re-arm the preview |
| Save flow | success = toast + onSaved + list refresh from the tasks-dialog integration; failure = toast with the REAL registered loop-gate 400 text (E-09-23 h) and the editor stays open; in-flight save resolving after unmount is silent (console.error spy clean) and its toast still fires |
| Entry points | services present: '+ new' and per-row `task` chips open the nested editor prefilled, save closes it and refetches the list; Escape in the nested editor closes only the editor and the tasks overlay stays; services absent: no entry points render |
| Adversarial review | 1 defect class reproduced red and fixed (the '@' merge kind guard); probed-and-clean: PUT body night/rider field rules, adjacent-typing staleness (unreachable - every mention input bumps the token), insert at tokenStart 0/end, overlay layering (same containing block, no transform trap), seed-path inertness post-adoption, no-catalog placeholder pick no-op |

**Not yet verified on this host**

| Item | State |
|---|---|
| Snippet macro resolver | `#snippet` expansion sources stay empty at composer parity; the resolver (doc 05 §B.3/§H.3 machinery) is the next slice |
| B.6.3 distill | the autonomy chapter distill ride lands after the resolver |

## 2026-09-26 - schedule editor machinery at P9-4d-i

**Verified working**

| Surface | Evidence |
|---|---|
| Pure machinery | scheduler-editor suite 21/21: pill labels per preference (24h `09:00`; 12h `9:00 AM`-family with the §J.1 numeric hour convention; auto = locale default: en 12h, de-DE 24h; out-of-range renders verbatim); weekday chip order walks the locale first day (`[1..6,0]` for Monday, `[0..6]` for Sunday tags) with JS-0=Sunday labels; weekInfo probed on every shipped BCP47ByLocale tag (all carry data - the Monday fallback is unreachable); membership toggles hold the last required entry and sort fresh copies (stored unsorted drafts re-sort across the toggle); cron shape 5-6 fields with the 200-char cap; zone choices duplicate-free with local + UTC first |
| Editor behavior | kind tabs reseed the new kind in the SAME zone; pill/weekday/chip toggles push sorted onChange; once date/time round-trip; cron input flags a failing shape client-side while the preview STILL fires for it (server = validity authority); zone select renders the unlisted stored zone as a first option that collapses on switch-away and reappears on switch-back |
| Preview generations | sequence-guarded: two rapid zone switches → two preview calls in order, only the 2nd paints; a stale deferred resolve drops; post-unmount resolves are silent (console.error spy clean, React 19 no-op); ok:false → "preview unavailable" note with slots cleared, a later generation restores both; preview slots render the viewer stamp AND the schedule-zone wall time |
| Adversarial review | 1 defect class reproduced red and fixed (once-date seeded the UTC-calendar tomorrow - Pacific/Kiritimati showed zone-today, Pacific/Honolulu the day-after-tomorrow; fixed to the zone-local wall date via en-CA over now+24h, unusable zone folds the seed only); probed-and-clean: pill mid-day boundary labels, toggleMember copy-vs-mutate, in-place draft mutation absence (drafts replaced whole), ZoneSelect value-independence, 6-field cron shape dead-ends rendering as the registered empty preview |

**Not yet verified on this host**

| Item | State |
|---|---|
| Execution half (P9-4d-ii) | name/model/agent selectors, prompt textarea with `@file` / slash / `#snippet` autocompletes, "Run as goal" + goal token budget, "Auto-accept permissions", enabled toggle - plus the editor dialog shell hosting both halves and the tasks-dialog Edit button |
| Save flow | upsert of a NEW task (PUT) and of an EDITED task (state-carrying PUT via the E-09-24 ScheduledTaskInput rule) lands with P9-4d-ii |

## 2026-09-26 - schedule preview route at P9-4c-i

**Verified working**

| Surface | Evidence |
|---|---|
| Preview route | `POST /api/openchamber/scheduled-tasks/preview` 10/10: true epoch bytes (daily 09:00 UTC from a fixed 08:00Z start = `[09:00Z, +1d, +2d, +3d]`), weekly weekday filter (`[1,3]` from a Monday start → Mon/Wed/Mon), consumed once → empty prefix, invalid zone/cron → 200 `{slots:[]}`, hostile field shapes → 200 empty prefix (non-array times/weekdays, string weekdays, non-string cron, junk zone), `from` outside `[0, year-9999]` folds to now, count clamps 1..4 (default 4), shape 400s (non-object body, missing schedule, string/array schedule) |
| Arming consistency | the loop's cursor `last + 1` equals the runtime claim cursor `Math.max(now, scheduledFor + 1)` and both ride `computeNextRunAt` with the same 5 s slack - previewed = armed by construction, divergence only from the runtime's overdue policy inside a long run (planned §C.2 semantics: previews the schedule, not the runtime timing) |
| Typed client | `previewNextRuns` 4 pins: wire body `{schedule, count, from}` with omitted options stringifying as the bare `{schedule}` object, 200 empty-prefix stays `ok:true` (invalid draft is not an error), registered 400 fold, and options pass through unclamped (JSON.stringify renders NaN/±Infinity as null before the router folds them to now) |
| Adversarial review | 2 defect classes reproduced red on the pristine slice and fixed (hostile non-array `times`/`weekdays` → TypeErrors escaping the compute branches, guarded in next-run.ts; extreme finite `from` → Intl RangeError at the Date-range edge, folded via `PREVIEW_EPOCH_MAX` in the route); 1 test-honesty gap closed (invariants-only daily test would have passed a wrong-shape handler - true bytes now pinned); probed-and-clean: route mount posture (same app, before the harness proxy, after browserWriteGate/apiAuthGate like its siblings), `__proto__` JSON keys, bounded scan costs (~1 s worst case), abort-signal absence for the debounced editor |

**Not yet verified on this host**

| Item | State |
|---|---|
| Editor dialog (P9-4d) | kind tabs, time pills (24h/12h locale-aware), weekday chips (locale week start), date calendar, cron input + example chips wired to this preview, IANA zone select (`Intl.supportedValuesOf('timeZone')`), model/agent selectors, prompt autocompletes (`@file` / slash / `#snippet`), goal + budget, auto-accept, and the enabled toggle |
| Edit-button integration | the tasks row Edit button + selection handoff land with P9-4d |

## 2026-09-26 - scheduled-tasks dialog at P9-4b

**Verified working**

| Surface | Evidence |
|---|---|
| UI suite | vitest 865/865 (96 files) - the dialog file 20/20: default project selection by active directory (case-insensitive worktree match), the no-store 404 rendered as empty, the toggle split (plain → PUT full task, loop → `PATCH .../loop-file` even for disabling), run-now toasts by outcome (200 `ok:true` success / HTTP 409 refusal string / 200 `ok:false` "ended with error"), plain delete immediate vs loop delete two-step confirm, the editor handoff dispatching `nnd:files-open` with `{directory: active root, path: '.agents/loops/daily.md'}` across Windows separators, a C.10 frame refreshing only the open project, Escape close + project switch reload, stale-load and cancelled-subscription pins (a delayed previous-project load paints nothing; a frame through a cancelled-but-pending subscription loads nothing; the previous subscription's closer runs), and an under-another-project file never enabling the edit button |
| Live wiring | `useTaskRanFanout` subscribes `subscribeControlEvents` per open project (first UI consumer of the control stream), resolve-gated on teardown; the wiring hook removes both window listeners on unmount |
| Adversarial review | 2 defect classes reproduced on pristine code and fixed with guards (view-ownership boundary `viewIdRef`; handoff basis switched from the selected worktree to the active directory), plus the function-cap split fallout settled (fanout hook 23 lines, hook ~48, all spans ≤ 60); probed-and-clean list registered in E-09-25 (root-key separator equivalence, runtime-key seam, Windows case reachability, toggle field preservation, gone-file 404 repaint, loop-delete prune, stale closures, Escape convention, weekday 0=Sunday) |
| Typecheck + gates + graph | tsc clean; quality gates green for 416 production files (raw-block function cap enforced); repository graph current for 416 modules |

**Not yet verified on this host**

| Item | State |
|---|---|
| Editor dialog | P9-4c: kind tabs, time pills, weekday chips, cron validation + next-4 preview, IANA zone select, model/agent selectors, prompt autocompletes (`@file` / `/command` / `#snippet`), goal budget + auto-accept + enabled toggles |
| Editor handoff on a live app | the unit pins assert the event payload; the FilesView/browser end-to-end click-through lands with P9-4c's manual pass |

## 2026-09-26 - scheduled-task UI client at P9-4a

**Verified working**

| Surface | Evidence |
|---|---|
| UI suite | vitest 845/845 (95 files) - includes the new client suite 15/15 (route bytes for the §5.16 family incl. `%3A`/`%2F` encodings asserted literally, error folding at 400/404/409/500 with JSON and non-JSON bodies, the bare-task PUT fold, the `{task}` PATCH fold, run-now strict-equal with the body-owned `ok:false` of an errored-but-completed 200 run, the status snapshot recovery, parseTaskRunEvent accept/reject) and the transport suite 5/5 (the SAME claims end-to-end through the real runtimeFetch with only the native fetch stubbed - the server's loop-gate and refusal strings survive verbatim) |
| Router reality check | a temporary probe against the real Hono app proved the encoded forms reach the route params decoded (`l%6Fop` -> 404 unknown project, the discriminating case), `%2F` stays in one segment -> registered 400, and `%3A` decodes into find-by-id (probe deleted; pins live in the client tests) |
| Transport read | runtime-fetch carries no error-body pre-consumption (auth layer reads status only; the coalescer clones and is route-allowlisted; the relay lane rebuilds a Response from decrypted chunks) - registered in E-09-24(e) |
| Typecheck + gates + graph | tsc over all UI tsconfigs clean; controlled-language gates green (413 source files); function cap 60, file cap 500 - green; repository graph rebuilt at 413 modules |

**Not yet verified on this host**

| Item | State |
|---|---|
| Dialogs | P9-4b (list dialog + entry point + live refresh) and P9-4c (editor); the client seam they call is already pinned |
| Live refresh | subscribeControlEvents has no consumer yet; the wiring rides the P9-4b dialog with the C.10 event name from the client module |

## 2026-09-26 - scheduled loop files + task routes at P9-3d

**Verified working**

| Surface | Evidence |
|---|---|
| Web server/contract suite | vitest 884/884 (64 files; the audit round added its own 19-test regression file, later extended with a 20th pin) - includes `p9-3d-scheduled-loops.test.ts` 18/18 (the C.8 format table: quotes/agent/zone, enabled-default-FALSE, model split on the first slash, all enumerated parse failures + the usable-name degradation, zone fallback with UI-only keys ignored, deterministic ids, adoption carry of unknown fields/execution extras/state, the enabled-fence rewrite append/replace/null, worktree-root walk + gitless fs-root walk, user<project and farthest<nearest shadowing, parse-failed named files vs nameless vanish, reconcile create/rename/adopt/prune/keep-last-good/duplicate/no-op-write) and `p9-3d-scheduled-routes.test.ts` 11/11 (the §5.16 family over a real store + runtime: list 200/400/404, upsert + body/protection guards + loop gates by id AND by discovered name, delete plain/orphan/live-loop-file/unknown, loop-file PATCH writing `enabled: true` into the file and the task through the sync's reconcile, loop-file DELETE pruning the task while sibling keys survive, run-now 200/400/409 with busy and capacity axes plus the pipeline-failure-is-a-200-run axis, the status snapshot sorted soonest-first, and the config-PUT non-clobber with an incoming `scheduledTasks` copy dropped) and `p9-3d-audit-repro.test.ts` 20/20 (the fixed-defect pins, below) |
| Typecheck | tsc over all tsconfigs - clean (twice: pre-audit and after the audit's handler extraction) |
| Quality gates + graph | controlled-language gates green (412 source files); function cap 60, file cap 500 - green; repository graph rebuilt at 412 modules |
| Writer discipline | TWO routes now ride the per-project write lock: the settings-family config PUT (locked read-modify-write, replaces every key verbatim except the managed `scheduledTasks` key which rides through, incoming copies dropped) and the P4-2 todos PUT (locked RMW, closed in-slice after the audit flagged it); a locked reader defers instead of writing around the lock (both pinned); the store key survives the settings route both when present and absent from the PUT body |
| Adversarial review | sub-agent audit reproduced and fixed 5 defect classes with 19 regression tests: (1) an adopted task with a non-derived id was re-keyed to the deterministic loop id on EVERY reconcile (id churn + no-op doc rewrites) - re-key now fires only when the file owns the entry AND its name changed or a derived id is stale, with a byte-level no-op pin; (2)-(3) the upsert gate was blind on the id axis and the loopFile axis relative to DISCOVERY (a loop-shaped id or a foreign-named file pointer passed, then the sync's reconcile silently re-owned the task) - the gate now asks discovery by id and by file path while the file exists; (4) the config PUT was an unlocked read-modify-write and could revert a concurrent store patch (lost update) - now locked, and the todos PUT got the same lock; (5) the loop-file enabled rewrite converted CRLF to LF (whole-file churn; the append path would have grafted an LF line into a CRLF fence) - the rewrite now preserves the file's dominant line ending. Also hardened: a vacuous adoption rewrite assertion became a byte-identical doc compare; run-now against a never-started singleton answers 500 with an empty status shape. Verified-not-defective highlights: reconcile under the C.5 lock never nests with a held lock, malformed-doc rename-aside mirrors the upsert path, orphan timers/memory are shed by the route-triggered sync after a rename, loop-file DELETE is ENOENT-tolerant (200 then 404), the `*.md`-named-directory edge is excluded without failing the scan, over-cap and binary bodies all answer one 400 |

**Not yet verified on this host**

| Item | State |
|---|---|
| Real .agents/loops run | discovery + reconcile verified against temp directories and the real store lock; a live repo's loop file driving a real NNA session is a smoke-probe step after the P9-4 UI |
| UI listeners + dialogs | ScheduledTasksDialog/ScheduledTaskEditorDialog/scheduledTasksApi are P9-4; the routes + SSE control-bus fanout they consume are already live |
| Harness-resolved loopsFor | the route-layer loop scan rides the harness worktree resolution in production; route tests inject it (the adapter call chain itself is covered by the queue-family tests) |

## 2026-09-26 - scheduled run pipeline on NNA at P9-3c (harness side)

**Verified working**

| Surface | Evidence |
|---|---|
| Web server/contract suite | vitest 835/835 (61 files) - includes `p9-3c-scheduled-pipeline.test.ts` 18/18: title stamp in the schedule zone + 120-char clip (unnormalized raw-name guard), plain dispatch body `{model, parts}` + running event fields, part ordering knowledge -> prompt -> goal intro with `recordDelivered` only after ok, goal-write guards (fresh revision 0 tolerance, existing goal expected_id/expected_revision, missing-revision fail-closed), tolerated goal write refusal dispatches WITHOUT the intro, objective-file-first beyond the 5000-char clamp with inline fallback, command route `{command, arguments, model}` + B.8 expansion on the goal objective, plain-path degradation (unmatched slash, skill entry, catalog read failure), knowledge lookup failure tolerance + blank knowledge delivering/recording NOTHING, proceed-on-failed ready poll / throwing emitter / unwired auto-accept warnings, four run-error axes (worktree, session id, prompt 503, command 409), B.6.1 intro wording incl. budget sentence + payload budget-range gate, C.10 payload shape on `notnative:scheduled-task-ran`, project-stem listing, real-store integration (sync persists the next slot; once consumption upsert) |
| Typecheck | tsc over all tsconfigs (ui, web ui/server/cross) - 0 errors |
| Quality gates + graph | controlled-language registry 36 terms x 410 source files, function cap 60, file cap 500 - green; repository graph rebuilt at 410 modules |
| Harness seam isolation | the pipeline reaches the harness only through `harnessRequest`-shaped injected ports (session create/prompt/command/catalog/read/goal-write/directory); the runtime still never imports the harness |
| Adversarial review | sub-agent audit reproduced and fixed 4 defects (blank/whitespace knowledge recorded DELIVERED though nothing was sent; an `ObjectiveInputError` swallowed without a warn on the objective-file fallback; the objective-file degradation warn unattributed to a session; the B.6.1 budget sentence claiming a 0 budget the goal payload nulls) with 3 regression tests and 1 hardened test; verified-not-defective: ready-wait ordering under the runtime watchdog, `sessionOf` fallbacks, `revisionOf` every path, both event emits' wire shape, singleton re-entrancy, directory-less catalog poll, command-route warn attribution, intro wording, naming-mirror single site |

**Not yet verified on this host**

| Item | State |
|---|---|
| Live NNA dispatch | all pipeline tests run against port fakes; a real NNA session created by a due task is a smoke-probe step after P9-3d routes |
| Snippet macros + distill | `expandSnippets` ships as identity; `{file}` macros and the B.6.3 small-model distill are future ports |
| Auto-accept runtime | `permissionAutoAccept` warns and prompts normally (A-6.7 still unwired) |

## 2026-09-25 - scheduled-task runtime at P9-3b (claims + watchdog + completion)

**Verified working**

| Surface | Evidence |
|---|---|
| Web server/contract suite | vitest 817/817 (60 files) - includes `p9-3b-scheduled-runtime.test.ts` 23/23: due-cron fire end-to-end (claim patch + pipeline call + completion patch with the carried sessionID + re-arm to the next slot + C.7 event), disabled/consumed arming skip, setTimeout-cap overflow re-arm, no re-enqueue while running, hold at both concurrency caps then drain after settle, sibling-claim adoption into memory with winner-slot re-arm (no dispatch), claim store failure record (conditional, never clobbers a winner) + re-arm + `claim-failed`, missing-`scheduledFor` skip, watchdog timeout without session abort, completion persist retry once then in-memory terminal + re-arm from memory (disk left at the claim state), one-time consumption (`enabled:false`, never re-fires), manual success on a paused task without claim/re-arm, manual busy + capacity refusals, start sync + vanished-project timer shed, stop clears timers/queue, post-stop settling run completes but arms nothing (inert latch), listProjects abort; review regressions: a synchronous pipeline throw lands as an error run on the scheduled AND manual paths (slots freed, slot re-armed, no `Scheduled claim failed` clobber), a throwing event emitter is warn-only, a refused claim adopts the winner's task into memory |
| Typecheck | tsc over all tsconfigs (ui, web ui/server/cross) - 0 errors |
| Quality gates + graph | controlled-language registry 36 terms x 407 source files, function cap 60 (forced the runtime monolith into ports/state/run/state-helpers modules), 500-line file cap - green; repository graph rebuilt at 407 modules |
| Version-skew invariant (unit-proven) | the claim and completion patches ride the P9-3a RAW-record state swap; a task with unknown schedule/execution fields flows through claim, pipeline injection, and completion without field loss |
| Adversarial review | sub-agent audit reproduced and fixed 5 defects (a synchronous pipeline throw misclassified an already-claimed run as `claim-failed` with a stale-snapshot re-arm clobber and no completion; an unguarded event emit poisoning a persisted run; `stop()` timer resurrection from a settling run, fixed with an inert latch cleared by `start()`; a refused claim re-arming without adopting the winner's record into memory; a fail-closed adopt normalization) with 5 regression tests; verified-not-defective: the overflow timer's stale closure (onDue re-reads memory), colon-ambiguous keys (project ids are pattern-constrained), counter release on settling runs, null-record refusal, computed-next-run poison tolerance |

**Not yet verified on this host**

| Item | State |
|---|---|
| Cross-process claim contention | still unit-proven only (fake store competition in-process); no two-real-process integration run exists |
| The NNA dispatch | the runtime drives an injected `runPipeline` fake; no harness session has been created by a scheduled run yet (P9-3c) |
| Suite-level flake (pre-existing) | the p8-5a relay client e2e occasionally fails at SUITE level in full parallel runs (child console attach, `AttachConsole failed`) while all 6 tests pass; solo runs green; two of five full runs today affected; unrelated to scheduled code |

## 2026-09-25 - scheduled-task storage core at P9-3a (NND unit, no harness)

**Verified working**

| Surface | Evidence |
|---|---|
| Web server/contract suite | vitest 794/794 (59 files) - includes `p9-3a-scheduled-storage.test.ts` 26/26: next-run matrix (daily push, weekly 15-day scan, once consumption, cron/tz incl. the Berlin offset pinned against a live probe, America/New_York spring-gap skip and fall-back first-instant), schema reject/normalize matrix (unknown-field preservation at all four levels, legacy single daily `time`, id immutability, goal-setting coupling, state clamps), locked store matrix (round-trip, chained upserts, state-patch swap/clear vs other config keys, predicate refusal, remove, malformed quarantine readback), config-lock matrix (stale steal, mid-hold foreign replacement, chain serialization, the fd-leak regression, the updatedAt explicit-undefined regression) |
| Typecheck | tsc over all tsconfigs (ui, web ui/server/cross) - 0 errors |
| Quality gates + graph | controlled-language registry, POWER10 caps, 401-module repository graph, dependency registry row for cron-parser (MIT) - green |
| Version-skew invariant (unit-proven) | a state patch on a task with unknown schedule/task fields persists them verbatim; an unknown schedule kind schedules nothing but stays on disk |
| Adversarial review | sub-agent audit confirmed and fixed 3 defects (per-acquire file-descriptor leak in the config lock; `updatedAt: undefined` in a state patch cleared the required field instead of falling back to now; dead cleanup comparison in the in-process chain map) with 2 regression tests; registered the Lord Howe 30-minute fold second-occurrence resolution, the read-error/malformed conflation, hand-edited duplicate ids, and the unbounded projectId regex as observed behaviors |

**Not yet verified on this host**

| Item | State |
|---|---|
| Cross-process claim contention | two REAL processes contending for one config lock is reasoned, not executed, on this host; the lock primitives are unit-proven (steal, mid-hold replacement, in-process chain) but no two-process integration test exists |
| Runtime scheduling | timers, claiming, the run pipeline, loop files, routes/SSE, and the UI are P9-3b..d work; nothing schedules yet |

## 2026-09-25 - goal continuation dispatch at P9-2d (NNA source harness)

**Verified working**

| Surface | Evidence |
|---|---|
| Web server/contract suite | vitest 768/768 - includes `p9-2d-goal-dispatch.test.ts` 17/17 (verbatim builder matrix incl. budget block and XML escaping, parts-only body shape, 9 dispatch-ladder cases: coherence drops, cap settle, tail/open-reply refusals, CAS refusal, 409-busy slot burn, transport faults, resume-label clearing; 5 exchange flows: continue dispatch ordering, skip-audit resume kick, settled/unavailable candidates never send, cap-before-send, read-fault catch) and widened p9-2c fixtures |
| UI suite | vitest 825/825 (93 files) - the goal strip/editor now renders the live auto-continuation contract; the stale "not enabled in this build" copy is gone |
| Typecheck | tsc over all tsconfigs (ui, web ui/server/cross) - 0 errors |
| Quality gates + graph | POWER10 caps, controlled-language registry, 396-module repository graph - green |
| Send-safety invariants (unit-proven) | every dispatch re-reads and CAS-guards against the persisted candidate before the send; the send is the exchange's last action; a refused/failed/409 send never writes a streak nor sends twice per tick; the cap re-check at dispatch cannot be bypassed by a between-window user reversion |

**Not yet verified on this host**

| Item | State |
|---|---|
| Live full-loop dispatch E2E | the cross-repo smoke still proves the audit wire only; an end-to-end "turn → audit → send → turn" probe needs the smoke fixture to answer a first `continue` then `complete` audit and is queued as its own slice |
| Real small-model auditor quality | unchanged: the smoke's auditor answer is fixture-provided; genuine provider verdict quality is untested on this host |
| Mid-goal route change behavior | the send omits model/agent (E-09-19), so NNA's configured route governs; a live route switch mid-goal is reasoned, not executed, on this host |

## 2026-09-25 - goal evaluator exchange at seal 20260925-73 (NNA source harness)

**Verified working**

| Surface | Evidence |
|---|---|
| Cross-repo source smoke (real NNA child + fixture provider) | `npm run integration:smoke -- <NNA source>` exit 0; `probeGoalAudit` checks an attributed audit and stale-revision refusal (`409 nnd_goal_audit_conflict`). `probeGoalAutonomousLoop` exercises production NND ports through completed turn → audit → CAS → continuation prompt → second turn → complete verdict. `probeGoalEventRuntime` additionally verifies the live NNA SSE idle event drives the production NND goal timer and guarded exchange to a persisted complete goal, with two scoped audit calls and one continuation. |
| Web server/contract suite | vitest 751/751 (57 files) - includes `p9-2c-goal-auditor.test.ts` 26/26 (apply/interpret matrices, 13 exchange orchestration cases, production-port wire shape, inline-consumer serialization) |
| UI suite | vitest 824/824 (93 files) |
| Typecheck | tsc over all tsconfigs (ui, web ui/server/cross) - 0 errors |
| Quality gates + graph | POWER10 caps, controlled-language registry, 395-module repository graph - green |
| Adversarial review | sub-agent audit found 1 confirmed defect (pre-audit window verdict write could revert a user goal edit that NNA's CAS accepted as unchanged) and applied the fix + regression test; speculative concerns documented as rejected |

**Not yet verified on this host**

| Item | State |
|---|---|
| Live unattended continuation dispatch | still absent by design (the P9 dispatch slice); the audit path settles/notes but never sends |
| Real small-model auditor quality | the smoke's auditor answer is fixture-provided; a genuine provider's verdict quality against doc 12's prompt is untested on this host |

## 2026-09-25 · production GUI browser acceptance (source server, mock harness)

The production web build initially loaded without shared-UI Tailwind utilities:
at a 1280×800 viewport, the sidebar, transcript, and rail collapsed into a
text column despite HTTP 200 and a green Vite build. After explicitly
registering `packages/web/src` and `packages/ui/src` as Tailwind sources,
the rebuilt CSS grew from 12.27 KiB to 50.85 KiB and the three-column
desktop layout rendered. In the local browser, Activity opened beside chat;
a mock prompt produced visible turn-start, assistant output, and turn-complete
evidence. The production CSS gate passes the corrected artifact and rejects
the previous packaged `web-dist` with all five required utilities missing.

This is a browser-door and mock-harness check, not a native Electron window
or real NNA acceptance. Native computer-use approval timed out before the
unpacked desktop app launched; no NND process was started by that attempt.

## 2026-09-21 · baseline at seal 20260921-2 (+ build fix → 20260921-3)

**Verified working**

| Surface | Evidence |
|---|---|
| Server boot + API + control SSE + mock harness echo loop | `scripts/smoke-test.js` in-process (session id returned) |
| Typecheck | `tsc --noEmit` ×4 tsconfigs (ui, web ui/server/cross) — 0 errors |
| UI unit/contract suite | vitest 608/608 (64 files) |
| Web server/contract suite | vitest 586/586 (41 files) — incl. relay wire E2E, terminal live ConPTY, worktree git flows |
| Quality gates | POWER10 caps + controlled-language registry (36 terms) + repository graph (335 modules) |
| Seal integrity | `release:check` green pre-edit; flagged the index.css edit honestly until re-seal |
| Production UI bundle | vite build green AFTER the 1-line css fix: 246 modules, `dist/assets/index-*.js` 681 kB (gzip 204 kB), css 12.3 kB |
| CLI | `notnative` bin + connect-url suite green (42 tests, incl. live auto-start smoke logged at P8-5c) |

**Known broken / not yet usable**

| Item | State |
|---|---|
| Production build (pre-fix) | broken since P5-1 (bad `@import` path); fixed 2026-09-21; release gates now run `vite build` so it cannot rot silently again |
| `pnpm dev` loop | never verified in an agent context (D7); after the css fix the tailwind import resolves in dev too — needs user-terminal confirmation |
| Installer / on-system presence | **superseded 2026-09-22 — see P12a section below** |
| NNA harness | NOT integrated — everything above runs against the mock harness (by design); the PA seam phase carries the real integration risk |

## 2026-09-22 · P12a — first real install on this system (20260921-3, pending seal)

**Verified working** (installed app, not source checkout)

| Surface | Evidence |
|---|---|
| NSIS installer build | `dist-electron/NotNativeDesktop-Setup-20260921.0.3-win-x64.exe` 106.8 MiB, sha256 `21171ffc32b0556e6c9ccaee65eaa7d1862c0d1ced0de78c89d66675fbc9ec1b` (printed by pipeline step 5) |
| Silent install | `/S` exit 0 → `%LOCALAPPDATA%\Programs\@notnativeelectron\` (exe, app.asar, `resources\web-dist`, loose `resources\dist-server\{server.mjs,settings-registry.json}`); uninstaller present and verified (silent removal, dir gone) |
| Boot chain | `main.log`: app start v20260921.0.3 packaged → import loose bundle → `server ready → 127.0.0.1:57123 (harness: mock)` → handle bound → `nnd-shell-prefs.json {port:57123}` → `navigating main window` |
| Health | `GET /health` → 200 `{"ok":true,"name":"NotNativeDesktop","version":"0.0.1","runtime":"desktop","serverId":"Otxht…"}` |
| Served UI | `/` → 200 2412 B; `/assets/index-BS88G5A8.js` → 200 |
| Process state | 4 NotNativeDesktop processes resident after successful boot (left running for user evaluation) |

**Found & fixed during first-boot hardening** (source-checkout gates could not see any of these; all were packaged-only):

| Defect | Failure seen | Fix |
|---|---|---|
| `selfDir()` returned main.mjs's file path, not its directory | packaged boot exit 1: `server bundle missing … app.asar\main.mjs\dist-server\server.mjs` | `path.dirname` in `main.mjs`; `resolveServerBundle` prefers loose `resources\dist-server` outside asar |
| ESM bundle has no `require` for CJS deps | import-time `Dynamic require of "events" is not supported` (ws) | esbuild banner `createRequire(import.meta.url)` + bundle-audit guard |
| Runtime JSON siblings not copied by esbuild | `ENOENT settings-registry.json` during `startServer` | `SIBLING_DATA` staging step in `electron-package.mjs` |

**Residuals / noted**: `/health` version surface is `0.0.1` (web package.json) while app version is `20260921.0.3` (extraMetadata) — audit verdict pending; install dir `@notnativeelectron` vs userData `NotNativeDesktop` naming drift; node-pty ships external (terminal-create failure shape pending audit); rebuild runs leave exit-1 from pwsh stderr-mangling (NativeCommandError) — pipeline oracle is `reportArtifacts`, not the shell exit code.

**Open debt (from registers, non-blocking)**: P3d chat leftovers; P4-3
adversarial review still QUEUED (fs write family + session-folders, risk rows
named in the P4-3 log entry); stale-dist serving after a failed build
(audit-proven: pre-write vite failures skip emptyOutDir cleanup and
`pnpm start` then serves the last-good UI silently — serve-time build-stamp
check = P12b candidate); E-06-4..18, E-07-3..23, E-08-1..69, E-09-1..14
rows; chunk size/code-split warnings in the vite build output.

## 2026-09-22 · P9-2a goals core layer (seal 20260921-5 → docs 20260921-6)

**Verified working (test-level only — nothing user-facing yet)**

| Surface | Evidence |
|---|---|
| Goal payload parse/clamps (§B.1) | vitest: hostile-input matrix — empty id / unknown status / objectiveless rejection, 5000/280/200 clamps, budget range 1..1e8 |
| Objective-file id-shape guard | `..`, short, slash-shaped ids refused BEFORE any filesystem use (pattern-pinned tests) |
| Metadata merge + id guard (§B.5.1) | namespace-preserving merge tests; goal-only removal keeps sibling keys; stale-write (id mismatch) refused |
| State machine T1–T17 | pure-transform suite: T17 arm-over-complete refusal, settle resets both streaks, resume second-life, exact-20 counter alignment with MAX_AUTO_TURNS |
| Suite truth | web 644/644 (43 files) · typecheck ×4 · gates+graph(340) · smoke · production build |

**Known broken / not usable from this layer (by design — P9-2b):** no tick
runtime, no small-model module/evaluator exchange, no goal routes (nothing can
arm a goal from UI or API yet), no mock session-metadata persistence, no SSE.
The installed desktop app (P12a) does NOT contain this layer's behavior beyond
dead code — it was packaged before goals landed; the next P12 packaging run
picks it up.

## 2026-09-22 · P12b-1 tray + scripted source install (seal 20260922-1)

**Verified working (live, on this machine)**

| Surface | Evidence |
|---|---|
| `install.ps1` full run | exit 0: robocopy copy → pnpm --frozen-lockfile → electron postinstall repair → `electron-package.mjs --no-nsis` (web dist + esbuild bundle + sibling JSON + tray icons) → Desktop + Start Menu shortcuts |
| Launch path | Started via the real Desktop `.lnk` (electron.exe + main.mjs, install dir) |
| Boot chain (installed) | `%APPDATA%\NotNativeDesktop\logs\main.log`: port fallback 57123→61776 (dev instance held 57123), `tray icon active (open web / open desktop / quit)`, server ready, window navigated |
| Health + assets | `/health` 200 (version `20260921.0.6` after the unpackaged-version fix; before the fix it reported the ELECTRON version `44.4.3`), `/assets/*.js` 200 |
| Co-existence | repo checkout instance (userData `… Dev`) and scripted install (userData `NotNativeDesktop`, `install-mode.txt` marker) ran simultaneously on different ports |
| Word-processor hardening | two install failures fixed: PS parser mojibake on em dash (pure-ASCII policy); `$ErrorActionPreference=Stop` aborted on vite/pnpm stderr → `Invoke-Native` routes native stderr to log files, exit code authoritative |

**Known broken / not yet usable**: `install.sh` written but NEVER executed
(no bash/WSL on this host — unverified); `-Uninstall` behavior with a running
service untested (auditor in flight); tray menu ACTIONS (browser open,
quit) implemented but clickable only by a human; NSIS installer still works
but no longer the primary path; installer audit finds slate empty until the
adversarial pass reports.

## 2026-09-22 · P12b-3 SLICE-B review-band + audit fixes (seal 20260922-3)

**Verified working (test-level + audit-level + live wire)**

| Surface | Evidence |
|---|---|
| Files tab real tree + status dots + hints | `file-tree-status.test.ts` 5 + `workspace-paths.test.ts` 2 + files-view 3; 15 s cadence fake-timer asserted |
| Diff scope stacks + >500 gate + hunk apply | `diff-view.test.tsx` 5 + `diff-scroll-anchor.test.ts` 4; server single-hunk contract honored after FULL blob match |
| Git stage/unstage/discard/commit | `git-view.test.tsx` 6 (optimistic rollback + cadence) |
| Terminal seam real | `terminal-adapter.test.ts` 3; stub replaced in createWebAPIs (web only) |
| Boot failure honesty (electron) | audit-verified: failure page replaces splash; Open App no longer re-splashes; live detection of the running instance |
| Artifacts integrity | `electron-package.mjs --no-nsis` prints 5 deterministic hashes (live-verified twice) |
| Streaming loop (SLICE-A) | wire capture: 23 text deltas + status transitions + abort → `MessageAbortedError` → idle |

**Known broken / not yet usable**: §6.7 checkout/merge/stash (no server
routes yet — GitView dialogs read-only), untracked-file diff render, retained
hidden panes, hunk keyboard nav, i18n sweep of new literals, shared status
poller (P6-3), install.sh STILL never executed (no POSIX host), tray retry
after failed boot, `--hidden` verified at code level only (launch flag read
before window creation; live check pending the next install run).

## 2026-09-22 · P12b-4 SLICE-C session product (seal 20260922-4)

**Verified working (test-level)**

| Surface | Evidence |
|---|---|
| Tool cards + markdown-lite | `tool-cards` 9 tests + hardened inert renderer; live bash output pane; mock trigger lifecycle tests (web +4) |
| Folders + real rename + archive | `useSessionFoldersStore` 6 + `session-rename-archive` 3 (PATCH {title}) |
| Blocking cards §F | `blocking-cards` 7 (bash body, Alt-stack, edit diff, question tabs/custom rule, 404 toast) |
| Server-owned queue UI | `useMessageQueueStore` 10 (revision gate, permutation PUT + restore-on-409, take-for-input, clear) |
| Timeline/rail | `prompt-rail` 2 (reactive, newest-first, hover preview) |
| Suite truth | ui 683/683 (79 files) · web 648/648 (44 files) · tsc ×4 0 · gates 357 · graph current |

**Known broken / not yet usable (carried after C)**: §6.7 server
auto-accept runtime; queued attachments (envelope sends `[]`); hold/take-all
chips; rail windowing; timeline-dialog dedicated test file; the SLICE-B
deferral list above; install.sh never executed; preview :58080 serves
pre-SLICE-C dist until the next redeploy (the desktop instance gets C at the
same redeploy).

## 2026-09-26 · Current shell artifact check (20260926-26)

`node scripts/electron-package.mjs --no-nsis` passed on Windows x64 with the
current UI and server sources. It produced the server bundle, verified the
staged native terminal runtime in Node and Electron-run-as-Node, and reported
the expected web-dist digest. This was an artifacts-only check: it did not
install, launch, or visually verify the current GUI build. An isolated mock
web preview loaded, but the in-app browser target failed during rail
interaction and could not be recovered; no NND render defect was confirmed.

## 2026-09-26 · Script-install upgrade and installed harness check

The first upgrade attempt stalled while `robocopy /E` traversed the repo's
top-level `.pnpm-store`; the installer now excludes that cache and caps copy
retries. Its path guard also rejects installing inside the source checkout and
uninstalling any overlapping source path before touching shortcuts or files.
An escalated retry completed the existing script-installed NND build and
verified its staged native terminal runtime; the installed `VERSION` was
`20260926-27` at that check. The partially copied package cache in the install
tree was intentionally left untouched.

The updated desktop shell launched, but its managed NNA child exited before
readiness. Directly invoking the installed NNA CLI returned
`interactive_terminal_required`: that installation is `20260924.0.5` and has
no `nna nnd serve` entry point, while source NNA is `20260926.0.1`. Source
integration smoke remains green; this is an installed-version mismatch, not
proof of a GUI render failure. Updating the installed NNA is pending explicit
user approval because its installer may stop NNA-managed services.
