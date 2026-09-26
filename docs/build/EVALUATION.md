# Evaluation Log — working / broken on this system

Running ledger of what has been VERIFIED on the build host (as opposed to what
unit tests assert in-process). Entries are dated; re-verification supersedes.

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
| Cross-repo source smoke (real NNA child + fixture provider) | `node scripts/nna-source-smoke.mjs <NNA source>` exit 0; the added `probeGoalAudit` proves an armed goal under a REAL attributed provider turn, NNA's evidence-bound audit route through NND's authenticated proxy (`{text, providerID: primary, modelID: test}` with a verdict payload), and the stale-revision refusal (`400 nnd_goal_audit_conflict`) |
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
