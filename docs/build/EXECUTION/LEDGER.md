# Integration work ledger — NotNativeDesktop native NNA integration

Owner: lead implementation agent (this session).
Governing guides: [PLAN](../PLAN.md), [EXECUTION 01-05](../PLAN.md). Baseline:
NND `e425a25` / `20261001-42`; NNA `7363ad1c2f...` / `20261001-6`. Both trees
started clean (verified 2026-10-01). Status vocabulary follows guide 05:
`open`, `in-progress`, `blocked`, `implemented-unverified`, `verified`.

Ground rules (from the guides and both repositories' AGENTS/README):

- NNA stays independent; its TUI keeps tabs/sessions. NND is a separate optional
  package. NNA supervises the persistent NND service. Browser and desktop share
  NND's service and session collection. No auto-accept, no Full control, no TUI
  merge. NNA owns execution, governance, configuration authority, engine truth.
- Slice order: L1 first; independent inventories/tracing may run in parallel.
- Every slice: focused checks + `npm test`/`pnpm test`, adversarial review by a
  non-author, evidence update, graph/report refresh, version bump, verified
  commit (NNA dependencies commit before NND consumers).
- Distinguish `implemented-unverified` from `verified`. Mock success never closes parity.

## Grounded source facts (verified this session, 2026-10-01)

| Fact | Evidence |
|---|---|
| NNA has no `nna service` CLI; only `nna nnd serve` and `nna nnd package {activate,deactivate,status}` | `D:\ProjectRepo\NotNativeAgent\src\cli.js` dispatch + help text |
| `runNndIntegrationCommand` creates the engine host **before** the integration server; `readIntegrationManifest` throws on missing/invalid manifest; no setup-required state | `src\integration-cli.js` (`runActivatedIntegrationCommand`, `createIntegrationNndEngineHost`) |
| `nnd serve` emits one JSON ready frame to stdout; token in frame; no supervision, no singleton, no health module | `src\integration-cli.js`; no `service` case in `cli.js` |
| NNA activation contract: `nno-integration-activation.js` (NNO installed-manifest validation) vs `createNndLocalIntegrationActivation()` (unvalidated local activation; identity checked only when `NNA_NND_INSTALL_ROOT` is set via `assertRegisteredNndPackage`) | both files |
| `nnd-package.js` validates manifest `id: nnd-local`, ownership `nnd`, scope `local-gui`, protocol `1.0`, `VERSION = /^\d{8}-[1-9]\d{0,5}$/`, requires `packages/electron/dist-server/server.mjs` + `packages/web/dist/index.html`; registry `nnd-package.json` in config root | `src\nnd-package.js` |
| NND installed service entry exists but is only an NNA-launched child contract; sets `NOTNATIVE_NNA_MODE=managed`, `NNA_NND_INSTALL_ROOT`, disables browser bridge | `scripts\serve-installed.mjs` |
| Electron shell imports the server bundle **in-process** (`main.mjs` "Hard invariant: server runs IN-PROCESS"); tray `quitFromTray()` disposes the server handle; login item registers the **shell** (not a supervisor) | `packages\electron\main.mjs` |
| Shell uses stale `OPENCHAMBER_*` env names (e.g. `OPENCHAMBER_SERVER_URL`, `OPENCHAMBER_ELECTRON_LOAD_SERVER_UI`) alongside `NOTNATIVE_*` | `packages\electron\main.mjs` |
| Application port env: `NOTNATIVE_PORT`; dev ports 3902/5180/3000 per DECISIONS.md | `main.mjs`, `docs\build\DECISIONS.md` |

## Package ledger

| ID | Package | Depends | Status | Owner files | Evidence |
|---|---|---|---|---|---|
| L1 | Freeze activation contract | — | in-progress | NNA: `src\nnd-package.js`, `src\integration-cli.js`, new `src\nnd-service*.js` (proposed), `src\cli-options.js`/`cli.js`; NND: `scripts\serve-installed.mjs`, `install.ps1`, new service supervisor entry | this ledger row |
| L2 | NNA supervision/health/singleton | L1 | in-progress | NNA lifecycle modules; NND `serve-installed.mjs`, server wiring | — |
| L3 | Native principal and UI attachment | L1-L2 | in-progress | NNA `src\integration-principal.js`, service native/attach; NND native auth/harness | per-request native authority and atomic UI admission; device scope pending |
| L4 | Shell/browser migration to service attach | L2-L3 | in-progress | NND `electron\main.mjs`, native selection/client, tray/IPC, `server\index.ts`, `serve-installed.mjs` | actual Chromium attachment and shell-exit persistence verified below |
| L5 | Transactional installer/upgrade/rollback | L1-L4 | verified | NND `install.ps1`, package/stamp scripts, NNA registration, install guard/marker | fresh stage→activate→shells→stop→upgrade→rotate→rebind→rollback→guarded uninstall→mid-copy cancellation→recovery→reinstall→legacy-catalog migration green on disposable fixture (20261005-5); NNA incarnation identifier pinned, bound, and rechecked at every attach (20261005-6); legacy backend takeover drain — census-named owners, bounded voluntary-release wait, never-kill refusal with recovery instructions (NNA 20261005-13, ADR 0071) — green; incarnation-recheck journey re-certification green on the build console (2026-10-05, `20261005-7` → `20261005-8` → `20261005-7`), re-exercised through the fresh, upgrade, rollback, and reinstall attach legs; the earlier `stdin is not a tty` wall was environmental to the prior console session and did not reproduce |
| L6 | Installed acceptance + release identity | L1-L5, C/F | open | docs/build/PROGRESS, evidence records, V gates | — |
| C1 | Settings census + contract ledger | L1 | in-progress | NNA settings sources; NND `components/settings/*` mapping | manifest census rows and dashed CLI option literals enforced by `scripts/settings-coverage-gate.mjs` in release gates (needs `NNA_SOURCE_ROOT`; skip is a reported unverified gate, not a pass); census regenerated at NNA `20261005-13` (371 rows) with synced classifications, sensitivity, four route containers and ten option rows; positional subcommands, environment value provenance (reads are served since `20261006-3`) and non-manifest stores remain open census |
| C2 | Native resolution/concurrency (NNA) | C1, L2 | in-progress | NNA `integration-cli.js`, `startup-configuration.js`, `configuration-sources.js`, `runtime-config.js`, `provider\profile-store.js` | native `20261002-14` scoped user-manifest HTTP read/preview/save/repair verified; gateway settings family one-CAS read/preview/save/receipt at NNA `20261005-14` with adversarial re-audit; WebFetch trust family at NNA `20261005-15` audited PASS; WebSearch settings family at NNA `20261005-16` audited PASS; read-only environment observations at NNA `20261006-3`; read-only update-state observations and web-search alias reconciliation at NNA `20261006-4`; trusted-workspaces read and native grant/revoke at NNA `20261006-5`; compatibility-service wire identity settings (read/preview/save over the stored secret) at NNA `20261006-6`; remaining settings families open |
| C3 | NND settings transport/presentation | C2 | in-progress | NND `harness\nna.ts`, `ui\lib\nnd\client.ts`, settings `window.tsx`, `search.ts`, settings pages | finite native user-manifest preview/save and explicit repair UI; typed gateway settings family client with operation grammar and settings-page controls (`native-gateway.ts`, `native-gateway-timeout.tsx`) at `20261005-10`; typed WebFetch trust client and page (`web-fetch.ts`, `web-fetch-trust.tsx`) at `20261006-1`; typed WebSearch settings client and page (`web-search.ts`, `web-search-settings.tsx`) at `20261006-2`; typed environment observation client and read-only section (`environment.ts`, `native-environment.tsx`) at `20261006-3`; typed update-state client and read-only section (`update-state.ts`, `native-update-state.tsx`) plus web-search alias census reconciliation at `20261006-4`; typed trusted-workspaces client and grant/revoke section (`trust.ts`, `trust-workspaces.tsx`) at `20261006-5`; typed compatibility-service client and wired identity section (`compatibility.ts`, `compatibility-service.tsx`) at `20261006-6`; installed mutation acceptance and other settings families open |
| C4 | Providers/routes/engine controls | C3 | open | NND `pages\providers.tsx` etc. | — |
| C5 | MCP/skills/hooks/trust/project config | C3, C2 | open | NND `routes\mcp-config.ts`, `lib\mcp\*`, `stores\useMcpConfigStore.ts`, `pages\mcp.tsx` etc. | — |
| C6 | Non-manifest + TUI preferences page | C3, L | in-progress | settings pages; NNA TUI prefs contract | native TUI color, motion and key bindings page verified below; gateway settings family GUI operations shipped at `20261005-10` behind native `20261005-14`; WebFetch trust page shipped at `20261006-1` behind native `20261005-15`; WebSearch settings page shipped at `20261006-2` behind native `20261005-16`; read-only environment observations section shipped at `20261006-3` behind native `20261006-3`; read-only update-state section and web-search alias census reconciliation shipped at `20261006-4` behind native `20261006-4`; trusted-workspaces read and native grant/revoke section shipped at `20261006-5` behind native `20261006-5`; compatibility-service wire identity section shipped at `20261006-6` behind native `20261006-6`; installed journeys (application classes) and other external stores (compatibility service lifecycle actions, hooks, secrets metadata, managed_mcp_credentials, update install actions) remain open |
| C7 | Settings coverage/installed acceptance | C4-C6 | open | coverage report + installed probes | — |
| F1 | Projects/execution roots/session identity | L, C2 | open | NND routes/projects, git-worktrees, harness/nna-local, sync/session-actions, ui WorktreesView; NNA nnd-harness-routes, nnd-engine-host, nnd-session-description | — |
| F2 | Durable observations/recovery | L identity | open | NND sync/projection/activity; NNA nnd-projection, nnd-activity-snapshot, nnd-child-snapshot, nnd-session-registry, event-bus persistence | — |
| F3 | Composer/governed submission | F1-F2, C4 | open | NND chat/*, sync/session-actions, upload/question routes; NNA nnd-harness-routes, question broker | — |
| F4 | Session product/forks/BTW | F1-F3 | open | NND lib/nnd/client, sync/session-actions, chat/btw-*; NNA session host/catalog | — |
| F5 | Model helpers/route selection | C4, F1-F2 | open | NND small-model/lib walkthrough/goal-audit callers; NNA nnd-walkthrough, nnd-notification, nnd-goal-audit, provider scheduler | — |
| F6 | Files/review/plans/Git visibility | F1-F3, F5 | open | NND files/diff/git/plan components + lib/files/git/plan; server routes/git*, filesystem, GitHub/Linear | — |
| F7 | Terminal/preview/browser inspection | F1/F3, L | open | NND server/terminal, preview, components/terminal, lib/browser; NNA nnd-browser-tool | — |
| F8 | Knowledge/memory/skills/MCP context | F1-F3, C | open | NND server/session-knowledge, project-context, agent-tool, context; NNA skills/MCP/memory/console surfaces | — |
| F9 | Goals/schedules/queue/multi-run | F1-F5, F8, L | open | NND server/goals, scheduled, queue, session-orchestration, chat controls; NNA goal/ingress contracts | — |
| F10 | Workspace presentation/attention | F2-F9, C | open | NND rails, notifications, themes/i18n/shortcuts | — |

## Cross-repository contracts

The [activation contract](nnd-local-activation-contract.md) replaces the interrupted
agent's draft. Paired validators and review passed in NND 20261001-43 / NNA 20261001-7.
No existing supervisor, startup registration or installed acceptance is claimed.

## NND 20261004-4 — fresh prebuilt anchor integration

A successful fresh activation now proves native identity, active registration, and public attach,
then stages a complete launcher/selection anchor and binds the package root, version, selected NNA
identity, stage operation, activation operation, payload hash, and preflight candidate hash into
`nnd-anchor.json`. The installer then creates Desktop and Start Menu shortcuts. If shortcuts fail,
only the just-created fresh target is rolled back while the already-activated native owner remains
explicitly present. Existing targets continue to require explicit upgrade/rollback work; this slice
does not claim uninterrupted package handoff or durable generation-to-payload binding.
Focused activation/prebuilt suites passed 10/10, fresh anchor targeted tests passed 3/3, and
UI was 1,770/1,770 plus web 1,447/1,447 with typecheck, quality, graph/language, and release
gates green. Adversarial review closed the candidate-key identity race; remaining audit P2s are
accepted for follow-up.

## NND 20261004-5 — prebuilt uninstall slot binding

Uninstall now separates the public stable launcher anchor from the registered immutable slot.
It validates the selected NNA identity, anchor binding, bounded native slot path, and running
Electron executable before taking the native guard. It then confirms and deactivates the exact
registered slot, removes the anchor and shortcuts, and preserves the immutable slot, provenance,
and user data unless `-PurgeData` is requested. Foreign identities, malformed bindings, wrong
slot paths, and reparse-point ancestry fail closed without deletion.

Focused uninstall/recovery suites passed 21/21; full UI and web suites plus typecheck, quality,
graph, controlled-language, and release gates were exercised. Upgrade/rollback, migration, real
installed GUI acceptance, and durable package generation binding remain explicitly open.

## NNA 20261004-3 — bounded NND startup prerequisite

The selected NNA prerequisite commit `990e494d` aligns NND singleton lease operations with the
30-second private Windows helper deadline. The default operation budget is now 120 seconds to
admit the known three-helper discovery chain, while the helper remains at 30 seconds and the
explicit operation maximum stays at 300 seconds. An independent adversarial audit first refuted
the 60-second repair because three helpers could exceed it; the canonical NNA version advanced to
`20261004-3` after the 120-second repair and focused cancellation/default tests passed.

After the prerequisite, the real disposable NND source-installed acceptance passed installation,
authenticated local browser bootstrap, independent-browser isolation, separate desktop attach,
shared-service lifetime, and clean stop. NNA quality, the full source suite with the three
contention-prone originals rerun separately, graph/language gates, and focused lock/discovery cases
passed. NNA platform certification remains a separate release requirement. NND prebuilt acceptance,
upgrade/rollback, login startup, and real setup/provider journeys remain open.

## NND 20261005-5 — prebuilt migration acceptance green; L5 lifecycle closed

The journey now begins with a legacy-data reconciliation: the fixture
seeds an Electron-era session catalog (`nnd-contexts.json` with
`workspaceIds: ['local']`, one child snapshot, one bound journal) plus a
provider manifest, exactly like an existing operator's data root. The
installed CLI's `nnd service migrate` runs before any service takeover and
must rewrite the catalog to native workspace identity. Evidence asserted
in-harness: `{migrated:true, sessions:1, files:2}`; parent and child gain a
`ws_<24 hex>` id with every other byte preserved; the journal is
byte-identical before and after; the original catalog bytes are archived
whole under `runtime/nnd/migrations/<transaction_id>/0.before` before the
rewrite. The seeded dead provider endpoint is then removed (trial health
against a nonexistent model server is an unrelated scenario; NNA's unit
suite already proves admission basis `legacy_catalog_migration` and clean
migration recovery). The migrated catalog then survives the entire rest of
the journey: `Real exported prebuilt payload, migration, upgrade, rollback,
cancellation, reinstall, Chromium shells and uninstall passed (20261005-5
-> 20261005-6 -> 20261005-5)` on a clean box, with the same data root
carried through fresh activation, upgrade, rollback, cancellation recovery,
reinstall, and uninstall. Root-cause tooling note: the detached activation
owner reports only `nna: internal_failure`; a temporary `NNDEBUG=1` stack
patch (reverted) plus in-process replay pinned an earlier failure to the
trial-health check, not to migration. Every L5 mechanism the guides name
except the legacy Electron-owned backend process-ownership drain now has
disposable-fixture evidence. That takeover slice stays open: it needs a
built legacy installation, exact child-ownership discovery, graceful drain
verification, and queue/schedule reconciliation before it can be accepted
honestly. Its durable NNA installation-incarnation identifier prerequisite
(guide 02, line 275) closed in `20261005-6`; the drain protocol itself
remains a design slice (guide 02, lines 283-291).

## NND 20261005-6 — NNA installation-incarnation identifier closes the guide-02 pin prerequisite

ADR 0070 (sealed upstream as NNA `20261005-12`, commit `3f9f759c`) records
a random `incarnation_id` in the NNA install descriptor; in-place descriptor
rewrites preserve it, so only uninstall followed by reinstall replaces it,
and absence reports `null` rather than a fabricated value. NND now persists
the identifier wherever it already pins identity — the selection file
(`writeNnaSelection` self-derives it from the verified runtime), the
activation anchor binding — and rechecks it at every attach path:
`probeNativeAttach`, `attachNativeService`, `assertSelectedNndPackage`, the
stable launcher resolver (both reads, including its TOCTOU recheck), the
Electron main-process selection recheck, and the installer's
`Assert-NndSelectedPin`. A replaced NNA installation is now refused with
`native-selection-identity-changed` (installer: named refusal) instead of
being trusted by path identity alone; pre-ADR four-key pins and null
incarnations keep prior semantics and prove nothing about replacement. The
anchor rebind path additionally refuses to rebind a marked anchor whose
NNA incarnation was replaced. Regression evidence: NND
`native-service-client.test.mjs` proves pin mint, mismatch refusal, and
legacy-pin pass-through (13/13); the eleven installer/launcher suites pass
42/42 with one pre-existing environmental skip; uninstall binding validation
accepts both key shapes. NNA regression: descriptor acceptance, null
surface, and malformed-identifier refusal (identity suite 7/7); full NNA
suite 2,289 pass with the four known parallel-contention flakes, all green
in isolation. One gap is recorded rather than papered over: the disposable
journey re-certification did not complete on this box — every headless and
PTY relaunch died within minutes printing only `stdin is not a tty` from an
unidentifiable source, and a control run at clean `440770b` (before any of
these edits) reproduced the identical failure, so the wall is environmental,
not this change. L5 journey evidence for the incarnation recheck therefore
rests on the deterministic unit/fixture suites (client 13/13, installer
suites 42/42, uninstall binding both key shapes); the full journey must be
rerun on a healthy box before `20261005-6` is called journey-certified.

## NNA 20261005-13 — legacy backend takeover drain closes the last L5 mechanism

Guide 02 lines 283-291 name the final takeover pieces; ADR 0071
(`0071-legacy-backend-takeover-drain.md`) now binds them. The census
(`nnd-legacy-census.js`) reports named pid evidence for every legacy and
unverifiable owner in its verified native frame (comma-string pids, exact
count agreement asserted). The new drain (`nnd-legacy-takeover.js`,
`drainNndLegacyTakeover`) replaces the bare scan at both takeover gates —
migration (`nnd-migration.js`) and fresh-data admission
(`nnd-service-admission.js`) — inside the held data-root lease: it
re-probes until a fresh census is clean, waits a bounded sixty-second
window of voluntary release through the legacy process's own lifecycle
(no remote stop verb exists for a legacy console owner, and termination is
not shutdown, so the protocol never kills anything), and on expiry refuses
with `nnd_legacy_takeover_required` naming every observed pid plus the
exact recovery instruction to exit the legacy desktop or `nna nnd serve`
cleanly and rerun. A lease abort propagates its own reason instead of
masquerading as an unverified census. Quiescence is only ever believed as
a fresh zero census; no PID or port absence is evidence. The persisted
receipt frame stays the exact five keys, so admission and migration
staging are unchanged. Consumer records are never double-consumed:
takeover refuses while any owner is live, the dispatcher never opens the
legacy server's own queue/schedule directory, journal provenance re-
verifies before resume, and malformed legacy records fail the migration
closed. Evidence: new `test/nnd-legacy-takeover-drain.test.js` 3/3 against
real spawned `nnd serve` owners (refusal names the live pid and leaves it
running; voluntary release returns the exact receipt frame; lease abort
stops the wait promptly); census regression trio green; migration plus
admission 16/16 with every non-census refusal rejecting before the drain
loop (no test paid the window); failure-envelope 7/7 after registering
`nnd_legacy_takeover_required`; an end-to-end scratch probe drained 371
system processes around a released owner in 10.5 s. Graph 522 modules,
quality gates `QG_EXIT=0`, sealed at `a3bfcb85`. With this, every L5
mechanism the guides name has implementation and deterministic evidence;
the outstanding item is unchanged: the `20261005-6` journey
re-certification owed by the environmental console wall, not by the drain.

## NND 20261005-7 — incarnation-recheck journey re-certification green

The owed `20261005-6` journey re-certification is now green on the build
console (2026-10-05). `node scripts/installed-prebuilt-acceptance.mjs`
against the paired NNA `a3bfcb85` ran the real exported prebuilt payload
through legacy-catalog migration, stage, native activation, Chromium
browser and desktop shells, guarded stop, upgrade
(`20261005-7` → `20261005-8`), anchor rebind, rollback, mid-copy
cancellation with transaction recovery, reinstall against the retained
data root, and guarded uninstall: `Real exported prebuilt payload,
migration, upgrade, rollback, cancellation, reinstall, Chromium shells and
uninstall passed (20261005-7 -> 20261005-8 -> 20261005-7)`. The shells
attached at the fresh, upgrade, rollback, and reinstall legs, so the
attach-path incarnation recheck was observed by a real journey at every
leg that exercises it. The disposable fixture was removed on success, so
no operator installation, profile, startup entry, TUI state, or running
NNA was touched. The earlier `stdin is not a tty` wall was environmental
to the prior console session: a control run at clean `440770b`
reproduced it there, and this run completed end to end at unchanged
`20261005-7` sources, so the drain (`NNA 20261005-13`) and the recheck
(`20261005-6`) are journey-verified, not only deterministic. The two
failed-attempt fixtures preserved under the acceptance fixture root
(`nnd-accept-cb8bff7c1e`, `nnd-accept-801c7f59fe`) remain as historical
evidence of the pre-fix trial-health issue and the interrupted console.

## L-package status reconciliation (2026-10-05)

The package table rows for L1-L4 stay `in-progress` because some of their
acceptance lines are only exercised by later journeys, or belong to V2;
this section records what the real installer journeys have already
exercised (so the rows do not understate completion) and what remains.

- **L1 (activation contract)** — the contract is frozen and both
  repositories test the same paired contract; staging, activation,
  selection, guard, admission, recovery and uninstall cases ran through
  the real installer in the source and prebuilt journeys. Remaining for
  L1 itself: nothing above contract shape. Remaining for acceptance
  overall: an installed independent-TUI case with no NND installed is
  V2 evidence, not a contract gap.
- **L2 (supervision/health/singleton)** — data-root lease, singleton
  lock, protected discovery, and setup-first supervised hosting were
  composed and exercised end to end in every prebuilt journey leg
  (fresh, upgrade, rollback, reinstall), including guarded stop and
  restart-noting. Remaining: login/startup registration policy and
  reboot/login lifecycle acceptance, which V2 exercises.
- **L3 (principal and UI attachment)** — per-request native authority,
  one-use UI admission, cookie admission in Chromium, and the
  generation-bound attach with the NNA incarnation recheck are now
  journey-verified at every attach path. Remaining: principal renewal
  across a long-lived installed service (V2's reconnect windows) and
  the native device scope, tracked on this row.
- **L4 (client migration)** — browser and desktop attach to one
  supervised service and survive shell exit at every journey leg;
  reconnect catalog reconciliation and replay-gap semantics shipped
  (`20261002-16`, `NNA 20261002-31`/`NND 20261002-17`) and hold under install
  churn. Remaining: the full
  L4 acceptance matrix — governed turn surviving every client exit and
  PTY/scheduled-work survival — runs with F's turn journeys and V2.

## NND 20261005-9 — C1 settings-coverage gate enforces the classified census

C1 coverage is now enforced, not only censused.
`scripts/settings-coverage-gate.mjs` loads the NNA classified configuration
catalog from the paired source checkout (`NNA_SOURCE_ROOT`) and checks
`docs/build/EXECUTION/settings-coverage.json` in both directions. Every
catalog field needs a manifest census row; every manifest row needs a live
catalog field; row kinds must equal catalog classifications; an alias row
survives only a catalog-declared logical link with a matching kind; and dashed
CLI option literals in `src/cli.js` plus `src/cli-options.js` must match
invocation rows. Eight hermetic `node:test` cases cover the pass and every
rejection path. `scripts/release-gates.js` runs the gate when `NNA_SOURCE_ROOT`
names the paired checkout; without it the seal reports the skipped coverage
check as an unverified gate instead of passing it.

The census regenerated against NNA `20261005-13`: 223 catalog fields all
classified, 34 census kinds synced, 39 sensitivity values promoted only from
unverified, four new `routes.<role>` container rows, and ten new invocation
option rows (371 rows total). A mechanical head-versus-work comparison
confirmed no non-manifest family row changed and none was removed. The real
gate rejects a drifted, stale, or unclassified census copy live (exit 1 with
named violations) and fails closed on an unreadable census.

Two independent non-author adversarial reviews audited the slice; the
interrupted first review still delivered its findings and verdict before its
stop. Findings fixed and re-verified: await subprocess `close` before parsing
the catalog dump, bind the alias escape to declared logical links only, widen
the literal scan to template literals and the full dashed token class, drop a
dead duplicate guard, surface the gate's stdout on failure, resolve a relative
`NNA_SOURCE_ROOT` against the repository root, and bound the catalog dump with
a 60 second timeout. Focused and full release gates passed sealed and plain
with the coverage gate green at 223 of 223 rows and zero violations.

## NND 20261005-10 — gateway settings family goes native-first with a typed GUI client

NNA first (`20261005-14`): the whole classified gateway settings family
(enabled flag, Telegram token with dedicated replace/clear operations, token
environment name, workspace root, polling bounds, authorized user allowlist)
now moves through one CAS-protected transaction at
`/v1/nnd/configuration/gateway` with preview, per-save receipts, bounded
operation replay, and token-presence-only reads; the 20261003-25 flat
polling request stays a documented compatibility alias. Two rounds of
non-author adversarial audit: the first failed the slice on a real defect —
prototype-chain field lookups letting hostile names escape the grammar —
plus three honest-contract improvements (`Object.hasOwn` guards, honest
source codes on save, replay pre-read before the stale-revision 409, grant
audit payloads, generated-state catalog classifications); the delta re-audit
passed all six fixes. Gateway suites 23/23 and full NNA 2,308 tests with four
isolated-rerun platform-timing flakes.

NND consumed in this version: the typed client now models the family with a
client-side operation grammar and mirror projector, accepts only the
eight-field catalog (the legacy single-field catalog is rejected), and holds
the 8192-byte family bounds; the settings page offers the enabled flag,
token replace/clear (the value is never displayed), token environment name,
workspace root, polling bounds, and per-user authorize/revoke with one
preview before one revision-checked save and the retained uncertain-receipt
flow. An independent non-author audit failed the first consumer draft on two
real cross-contract defects — the local mirror missing NNA's lexicographic
allowlist normalization and the Telegram-id shape accepting what the native
validator rejects — plus a version-pin risk and a workspace read-bound nit,
while passing redaction, the state machine, its tests, and the census rows.
All four were fixed exactly as prescribed; each fix gained a pinning test,
and the delta re-audit verified every fix and re-ran the focused suite
13/13 itself (its two budget-open gates — typecheck and tree drift — were
closed in the same session: typecheck exit 0 post-fix, and
`git status` showed exactly the fifteen declared slice files). The fail-closed
non-null persisted-revision pairing was kept by choice. The census gateway
rows carry the native endpoints, paired
permissions, and the settings-page path, and the C1 gate re-verified the
census against the paired NNA catalog. Focused gateway tests 13/13, full UI
225/225 files (1,775 tests) and web 132/132 files, typechecks and version
seal below. The gateway rows' installed
journey (application class) stays open for C6/C7; the other external-store
families remain open.

## NNA 20261005-15 and NND 20261006-1 — WebFetch trust family goes native-first

NNA first (`20261005-15`): the WebFetch trust family — the authority grant of
exact credential-free HTTP(S) origins in `config/web-fetch.json` (at most 64
entries, canonicalized like every store write, each at most 300 characters) —
moves through one CAS-protected transaction at
`/v1/nnd/configuration/web-fetch` mirroring the 20261005-14 gateway
mechanics (preview, per-save receipts, replay pre-read before the
stale-revision conflict, bounded `last_128_operations` window). The
application class is honest `next_fetch`: the destination policy reloads the
store on every classification, so a saved grant is honored by the next web
fetch without a restart. An absent store reads and previews as sticky
defaults and the first trust save creates it exactly like the `webfetch
trust` CLI; a corrupt store fails closed; `revoke` of a listed origin keeps
the remainder sorted and `revoke` of an unlisted origin stays a valid no-op
save, both by CLI parity. Adversarial audit: two non-author reviews returned
PASS with no defects; their two risks were fixed before this consumer — an
unbounded origin length that could push the projected list past the family
response bound (now an explicit 300-character origin cap in the store with
the family response bound raised to 24,576 bytes so legal state is provably
inside it), and a catalog editability asymmetry with the gateway mirror (the
trust grant row now carries the same editability shape). Focused suites 13/13
after the fixes; the full NNA suite passed 2,308 of 2,321 tests (8 skipped)
with five load-sensitive platform-timing flakes, each proven green in
isolation on the final tree.

NND consumes in this version: the typed client mirrors the family read
surface including the absent-source sticky-default state and its absent CAS
base, canonicalizes origins client-side with the same 300-character cap, and
holds the family transport bounds; the settings page offers per-origin
add/revoke drafts with one preview of the sorted candidate before one
revision-checked save that can bootstrap from the absent store, and the
retained uncertain-receipt flow. The census web-fetch rows carry the native
endpoints, the paired permissions, and the settings-page path; the C1 gate
re-verified the census against the paired NNA catalog. Focused web-fetch
tests 14/14, full UI 227/227 files (1,789 tests) and web 132/132 files
(1,447 tests), typecheck clean. The trust rows' installed journey
(application class) stays unverified until a real grant is exercised on an
installed instance; the remaining C6 external-store families stay open.

## NNA 20261006-6 and NND 20261006-6 — compatibility service wiring identity read and changed natively

NNA (`20261006-6`): the seven compatibility_service rows gained a native settings
surface at `/v1/nnd/configuration/compatibility-service` — the same one-CAS
read/preview/save/operations shape the gateway, WebFetch, and WebSearch families
use, over `config/opencode.json`, the OpenCode wiring identity (login auto-start
plus the fixed hostname, port, and Basic auth username). A candidate is a full
document view (enabled, hostname, port, username) merged server-side over the
stored secret through keep/replace/clear, and the SAME `normalizeOpenCodeConfig`
the CLI and the wiring service use validates every merged document: exposed binds
without credentials refuse with `opencode_bind_exposed_requires_password`, and
host, port, username, and password grammar surface the domain's own codes. Secret
values never project — reads show a credential presence source only (the stored
secret or the `OPENCODE_SERVER_PASSWORD` environment override), a replace value is
validated without echoing, and receipts class application as `next_service_start`
because the wiring service reads the configuration at its next start. The six
`compatibility_service_action` rows (status/start/stop/enable/disable/run) are
left untouched for their own lifecycle slice.

NND consumes in this version: a typed compatibility client (exactly the seven
census catalog paths; receipts pinned to the requested operation; replace values
bound locally with the domain's codes) and a compatibility section staging the
full document view — a login auto-start checkbox, hostname/port/username inputs,
and a one-of-three password choice (keep, replace with a typed value, clear)
whose status row honestly reports where the secret comes from. The preview and
the saved receipt both carry "applies at the next service start"; honest refusals
(exposed bind without credentials, out-of-grammar drafts, an unreadable
configuration, or a moved revision) surface as sentences.

## NND 20261007-30 — the pre-C1 sweep reaches zero, and two of my own metrics turn out to have been flattering

**The sweep is done.** The last four pre-C1 "verified" pins close with this slice:
`browser_action` status and verify, `skills_action:list`, and the legacy provider
credential alias. Pins never re-examined since before C1: **0**, from 62 when the sweep
started.

**But that zero needs the same treatment last round's number got.** Eight of the rows
that left the bucket carry a "citation repair" label rather than a label for work done on
the row itself, and `probe-label-honesty.mjs` names them every round from now on:
`manifest:tool_concurrency`, the three `web_fetch_action` rows, the two `trust_action`
rows, and the two `session_review` rows. For those, what was read is the test that
renders the surface, not the panel. That is a real and checkable standard — every one of
those rows now has a proof a reader can walk — but it is a weaker standard than
re-rendering, and "0 re-examined" must never be read as "0 unverified by inspection".

**The bigger finding indicts the metric I announced last round.** I reported "verified
rows naming no test file: 0". That was true per *row*, and per-row was the wrong unit: a
row passed if any one of its citations named a file, so a precise NNA citation could
carry an unnamed NND one beside it. Measured per citation, **176 of 559 citations name no
file**, across 19 families including the ones I closed myself — `hooks` 18, `gateway` 16,
`compatibility_service` 14, `update_state` 14, `secret_action` 14, `environment` 14. The
zero was not a lie, but it was the most flattering true thing that could be said, which is
the thing a measurement exists to stop me doing.

**And counts rot.** Inspecting the four rows to name their files found numbers that no
longer matched the files: `nnd-skills-routes.test.js` was cited as 3/3 and holds five
tests; the browser pair cited "lib parser + page drills 2/2" where one file holds one test
and the other two. Merged phrases across two suites ("lib parser + page drills 3/3") were
right in total and unverifiable in every part. So the rule now, applied to all citations
written here: **name the file, quote the tests, assert no count** — a count is the one
part of a citation nobody maintains, and it quietly becomes false.

Census rows without a desktop surface: 37 (unchanged). Rows with an unverified desktop
surface: 13 (unchanged). Rows declaring an unverified application class: 60 (unchanged).
Pre-C1 pins never re-examined: 4 → 0, with the eight label-only exits named above.
Citations naming no file: 180 → 176 of 559.

## NND 20261007-29 — installation closes honestly, and last round's count needs a correction

**Correction first.** Last round reported pre-C1 "verified" pins never re-examined
falling 17 → 10. Seven rows left that bucket, but only two were examined as that number
implies. The count is kept by a field — `implementation_package` not beginning "C1 stage
2" — and the citation-repair patcher wrote a "C1 stage 2 citation repair" label onto five
action rows, which moved them out of the bucket by *labelling*. What that slice did was
read the tests that render those surfaces and name them; nobody re-read the panels.
Reading a test that renders a surface is weaker evidence than rendering it, and the drop
should have been reported as five labels and two examinations. It is corrected here
rather than edited away there, because that version is sealed and sealed content does
not change — the release gate enforces this, having caught me trying.

**The installation family, done properly.** Six rows closed, axes unchanged: the class
was already `not_applied`, which NNA writes on the response itself
(`nnd-installation-route.js:38`), and all six fields are classified `generated_state` by
the snapshot module's own `OBSERVED_DESCRIPTOR`. The desktop reads a descriptor the
admission authority re-verifies on every GET and changes nothing — product must equal a
constant, version and the two roots must match path grammars, `node_major` must be an
integer between 24 and 100, and any drift is a projection refusal rather than a blank
panel.

Two defects were live in that panel's tests. The citation read "packages/ui vitest
installation lib + panel drills", a suite phrase rather than a file, and **`install_root`
and `data_root` had never been asserted at all** — the panel renders both on adjacent
lines and nothing checked either. Those are the two fields an operator actually acts on
when an installation is wrong: the product name and the node version tell you what is
installed, the roots tell you what to go and fix. Both are asserted now.

That is why these six may carry the stage label and last round's five could not have
been described that way: the page was read, the gap found in it, the test widened, and
the widened test run.

Census rows without a desktop surface: 37 (unchanged). Rows with an unverified desktop
surface: 13 (unchanged). Rows declaring an unverified application class: 60 (unchanged).
Pre-C1 pins never re-examined: 10 → 4, six of them by this slice's own work.

## NND 20261007-28 — eight pin citations repaired, and a class word found that NNA never wrote

The eight rows left citing a suite description instead of a file are fixed. Seven now
name the test that proves their claim: the WebFetch trust and revoke operations ride a
save body asserted as `{op: 'trust'}` and `{op: 'revoke'}` entries, with NNA's own HTTP
test pinning `next_fetch` and a catalog whose operations are exactly `[trust, revoke]`;
the trust grant and revoke are POSTs asserted by name, with NNA's route test pinning
`project_configuration` on both verbs. Both citation diagnostics now read zero: no
verified row cites no test, and none cites a suite in place of a filename.

The remaining pair is the finding. `session_review` carried the application class
`idle_session`, and `idle_session` appears nowhere in NNA. Not a paraphrase of a word
NNA uses, nor a stale rename: `src/nnd-review-mode.js` declares no application class at
all. Its commit is a compare-and-set on `expected_revision` that writes `reviewMode`,
bumps `reviewRevision`, and sets `engine.reviewPosture` on the live context, with no
receipt and no timing word. The word was invented when the census was written, and it
had leaked into this project's own documentation as "idle-session policing", which is
what made it look sourced. The class returns to `unverified`, and the doc passage is
corrected in place rather than tidied away.

The effect itself is real — NNA's own test shows the posture blocks ingress immediately
and restores after restart — but a class word must come from NNA or it is this project's
opinion about another project's runtime. Unverified class therefore went 58 → **60**:
worse, and correct.

The blind spot is worth keeping. `probe-class-audit.mjs` compares pinned rows against
NNA's route metadata and reported 0 mismatches throughout, because this route has no
metadata to disagree with. An invented word on a route that declares nothing is invisible
to a check built to catch drift.

Census rows without a desktop surface: 37 (unchanged). Rows with an unverified desktop
surface: 13 (unchanged). Rows declaring an unverified application class: 58 → 60.
Verified rows citing no test: 0. Verified rows naming no test file: 8 → 0.

## NND 20261007-27 — the last uncited "verified" row closes, and the metric that found it hits zero

One row closed. It happens to be the one the sweep flagged by hand and never looked
at, and it was the last row in the file claiming a verified desktop surface while
citing no test whatsoever. That measurement is now **0 of 321** verified-surface rows.

The flag was right about the evidence and wrong about the surface. The reference roster
is genuinely rendered and genuinely asserted — reference, applied flag, count, staged
save, staged delete, and the token value absent from the document at every step. What
had never been checked was the application class: it sat at `unverified` because nobody
had matched the receipt's wording to the route. `next_server_spawn` is NNA's, declared on
the catalog field itself and enforced against any receipt carrying anything else, and
the sentence that carries it is now asserted too. Sensitivity stays `secret` as the
catalog sets it, and no token value ever renders.

The milestone should not hide its neighbour. Eight verified rows still cite a suite
*description* without naming a single test file — `web_fetch_action` ×3, `trust_action`
×2, `session_review` ×2, and `manifest:tool_concurrency`. Every one of them was recorded
as a pin of a surface verified somewhere else, never by work in its own slice. A
citation you cannot walk up to is closer to a claim than to a proof, so the count that
went to zero is not the count that matters most yet.

Census rows without a desktop surface: 37 (unchanged). Rows with an unverified desktop
surface: 13 (unchanged). Rows declaring an unverified application class: 59 → 58.
Verified rows citing no test: 1 → 0.

## NND 20261007-26 — five action rows close on evidence, and a fixture nobody ever ran

Five rows closed and, as with the lifecycle family, no headline axis moved: 37 rows
still have no surface, 13 still carry an unverified surface, 59 still declare an
unverified class. The classes were already NNA's — `update_check_recorded` stamped on
the check receipt, `registered_root` and `unregistered_root` on the registry receipts,
`not_applied` for the observation and for the installer that is refused outright
because the local CLI keeps that authority. The routes were verified when they shipped
and the page tests already drove every verb. The rows themselves carried the same
generic evidence line as the lifecycle family and not one citation.

One genuine gap came out of the fixtures. `packageReceipt()` had a parameter for the
unregistered case, written at ship time and never passed: nothing in the suite ever
showed an operator being told the registry holds nothing. That reading is asserted now
alongside the registered one, which is the shape of the bug worth having — the
behaviour was built, the claim looked fine, and the state went unexercised.

The reason to keep doing these slices despite the flat scoreboard is the one metric
they do move: verified rows that cite no test fell 6 → 1, leaving a single row, the
`managed_mcp_credentials` reference that the sweep flagged by hand and that has still
not been looked at.

Census rows without a desktop surface: 37 (unchanged). Rows with an unverified desktop
surface: 13 (unchanged). Rows declaring an unverified application class: 59
(unchanged). Verified rows citing no test: 6 → 1. Rows citing no specific test file:
60 → 55.

## NND 20261007-25 — six lifecycle actions close, and a slice that moves no number at all

Six rows closed and **nothing on the scoreboard moved**: no surface gained, no class
changed, no row opened. The class words were already correct, read from the receipt
NNA's lifecycle route writes — `not_applied` for the observation, `start_service` and
`stop_service` for the immediate verbs, `next_service_start` for the wiring flips, and
`run` refused outright because an HTTP handler cannot host a call that never returns.

What was missing was anything a reader could check. All six carried the evidence line
`route receipt application (mirrors the native 20261006-9 surface)`, which is true of
every action row in the file and therefore distinguishes none of them, and their
citation list was empty — a verified surface nobody had ever looked at. Reading the
page against the tests found two real gaps: `disable` had never been clicked in any
test, and the refusal of `run` was evidenced only by a request that did not happen,
not by the sentence explaining why no button exists. Both are asserted now, along
with the absence of a `Run` control.

This is the same failure as last round's bulk suite count, in a different costume. A
big number attached to a row proves nothing about that row; so does an evidence
sentence that would be true no matter which row you read it on. Proof has to be
capable of being wrong about something, and neither of these ever could be.

Census rows without a desktop surface: 37 (unchanged). Rows with an unverified desktop
surface: 13 (unchanged). Rows declaring an unverified application class: 59
(unchanged). The quality diagnostic did move: verified rows citing no test fell 12 → 6,
and rows citing no specific test file fell 73 → 60.

## NND 20261007-24 — compatibility wiring closes, one flag turns out true, and a count goes down

Seven rows closed, unverified classes 66 → 59, and the class is NNA's
`next_service_start` — declared on this document and repeated on the save receipt
with no restart verb, because the OpenCode wiring service reads the file when it
starts. The desktop composes a candidate and saves it with a revision check; it
starts nothing.

The flag on `updated_at` was right this time. The row had carried a verified surface
since before C1 while citing no test whatsoever, and the page simply never rendered
the stamp — a claim nobody had ever checked, in the family the sweep pointed at. It
was fixed by rendering: the status line now reads `last saved` with the real value,
or `not recorded` for an absent store, so the field is covered because it is
displayed rather than because a table says so.

The store counter moved the other way. It was pinned as verified and is now an
explicit unverified surface, because the page shows the wire identity a reader acts
on and a counter that is always 1 is not information. That is why unverified-surface
rows went 12 → 13 this round while six rows closed: an honest read of one's own work
has to be allowed to lower the number, or the number stops meaning anything. The
companion diagnostic also moved: rows claiming a verified GUI while citing no test
fell 19 → 12, leaving exactly the four families still on the residual list.

Census rows without a desktop surface: 37 (unchanged). Rows with an unverified
desktop surface: 12 → 13. Rows declaring an unverified application class: 66 → 59.

## NND 20261007-23 — seven secret actions close, and a citation that proves nothing is measured at scale

Seven rows closed, unverified classes 73 → 66. The five mutating verbs carry NNA's
`next_secret_use`: the broker writes an encrypted vault whose values reach a trusted
consumer at use time with exact-value redaction active, and the console never calls
the use endpoint, so it cannot manufacture the event that marks the effect. `list`
and `audit` are reads and say `not_applied` rather than borrowing an effect claim
they cannot support.

What this slice found while checking one row is the larger item. The seven pins'
only citation was `packages/ui vitest suite (245 files, 1,851 tests at
20261006-11)` — a real number, honestly reported, proving nothing about any
particular field. A suite-wide count attached to a row looks like evidence and
survives every skim, because nobody re-runs 1,851 tests to check one cell. So I
measured the pattern instead of finding it again by accident: **19 rows claim a
verified GUI and cite no test at all**, and 10 more cite a suite without naming a
file.

That number is reassuring in one specific way. The 19 fall entirely inside
`compatibility_service` (7), `compatibility_service_action` (6),
`nnd_package_action` (3), `update_action` (2) and `managed_mcp_credentials` (1) —
the same families the pre-C1 pin sweep already ranked as unexamined. Two
measurements built independently now point at one list, which is the kind of
agreement worth trusting, and it means no hidden pocket of uncited claims is left
outside the work I had already planned.

One flagged pin was also cleared honestly: `enable_disable` looked suspicious and
turned out to be genuinely driven, its status request asserted in the console test.
The sweep says where to look; it does not say what is there.

Census rows without a desktop surface: 37 (unchanged). Rows with an unverified
desktop surface: 12 (unchanged). Rows declaring an unverified application class:
73 → 66. New diagnostic, not a goal in itself: 19 verified rows still cite no test.

## NND 20261007-22 — six secrets rows close, and a page is caught promising more than it shows

Six more rows closed, unverified classes 79 → 73, but this slice found something
the census itself could never have found. The secrets page states plainly that the
roster shows each record's field names and public metadata. It did not. The line it
rendered printed a **count** of fields and no metadata whatsoever — so two census
rows were claimed against a surface that did not display them, and because the
pre-C1 pins cited no test, no check existed to notice the drift.

That is the sharpest argument yet for why an unevidenced pin is not merely
incomplete but actively dangerous: the table said "verified", the page's prose said
the same, and the two appeared to corroborate each other while both described work
nobody had checked. A coverage claim with a test behind it fails loudly when the
UI changes; one without can sit there for months, getting trusted more precisely
because the neighbouring sentence repeats it.

The fix went toward the truth rather than toward the metric. The row now really does
carry the field names and the metadata **names**, so the sentence above it stayed
true instead of being quietly shaved down to match a thinner page. Values remain
unrendered and are now asserted absent — a metadata key is safe to list, its
contents are not this surface's business — and a record without a scope says
`unscoped` instead of going quiet. All six take NNA's `next_secret_use`; nothing
here is editable, since creating, rotating, enabling and deleting belong to the
broker, and the sensitivity NNA set stays `secret`.

Census rows without a desktop surface: 37 (unchanged). Rows with an unverified
desktop surface: 12 (unchanged — the two rows that were not rendered are rendered
now, rather than being downgraded). Rows declaring an unverified application class:
79 → 73.

## NND 20261007-21 — workspace trust closes, and two louder claims are declined

`workspaces[*].root` is closed: every trusted root is a row asserted by its own
text, carrying the stamp that grant wrote and a revoke control, with a path field
that grants through the native surface and a receipt that repeats the **canonical**
root rather than the path an operator typed. The class is `project_configuration`
— read from NNA's route, not from the page fixture that happened to agree with it.
Trust is an authority grant whose effect is the project configuration that becomes
admissible; nothing in the desktop decides it, and that boundary is the reason the
row is worth stating precisely.

The rest of the slice is what did *not* get claimed. The trust stamp closed as
`not_applied`, because NNA writes it and no operator sets a timestamp; the native
catalog groups that field under the same `project_configuration` declaration as
the grant, and borrowing the louder label for a value nobody can set would make
the table read better and mean less. The store counter stays deliberately open
with an unverified surface: the page lists roots, not the counter, and printing a
value that is always 1 is decoration wearing coverage's clothes.

Census rows without a desktop surface: 37 (unchanged). Rows with an unverified
desktop surface: 14 → 12. Rows declaring an unverified application class: 82 → 79.

## NND 20261007-20 — nine hook-roster rows close, and the difference between a claim and a checked claim

Nine rows closed in one slice, moving unverified application classes from 91 to
82. The class is `next_hook_use`, NNA's own word for all nine fields, and nothing
here is editable from the desktop: the native catalog refuses every field with
the reason `hook_store_mutation_separate`, the page has a refresh control and no
save, and execution belongs to the hook runtime.

What this slice really exposed is a different failure from the last three. The
hooks pins were **not false** — the page does render all nine fields, name and
version and each subscription's event, phase, command, blocking flag, priority,
timeout and concurrency. They were **unevidenced**: the pins cited no test
whatsoever, and two of the nine values (priority and the concurrency ceiling)
were rendered but never asserted anywhere. So the claim was defensible and
uncheckable at the same time, which is precisely the state a coverage table must
not be allowed to sit in. Adding the missing assertions made the existing verdict
true rather than making it look true.

It is worth being precise about what the automated sweep can and cannot tell me.
Its heuristic said "plausible" for all nine hooks rows and it was right — but
"plausible" means only that the page mentions the field, and it took reading the
page and the test to learn that the gap was proof rather than truth. The sweep
finds places to look; it does not do the looking.

Census rows without a desktop surface: 37. Rows with an unverified desktop
surface: 14 (unchanged — these rows already had a surface, they lacked proof).
Rows declaring an unverified application class: 91 → 82.

## NND 20261007-19 — WebFetch trust closes, and the missing-stamp pattern is now unmistakable

One row closed, and it was the cleanest kind: `trusted_origins` is an authority
grant the page genuinely edits — the saved list, a draft list where each grant
carries its own revoke control, an add field that refuses everything except an
exact credential-free HTTP(S) origin before a request is even composed, then a
preview and a revision-checked save. The class is `next_fetch`, which NNA already
writes on every receipt, because the fetch tool reloads the store per request:
the application point is a fact about the tool, not a guess by the desktop.

The recurring part is what matters. This page, like the gateway and web-search
pages before it, was credited with a surface for its version counter and its
save stamp while rendering neither. That is now four families in a row, which
says something about how the pre-C1 pins were written: from the contract, not
from the page. Where a stamp is worth showing it gets shown — trust changes now
read `last saved: …`, and an absent store says `not recorded` instead of letting
an operator infer a time from the absence of data. Where the field is a counter
that must always be 1, the claim comes down rather than a number being padded.

Census rows without a desktop surface: 37. Rows with an unverified desktop
surface: 14, holding steady as one row closed and one false claim was withdrawn.
Rows declaring an unverified application class: 92 → 91.

The systematic sweep is shrinking where it is checked: nine suspicious pre-C1
pins became five — `compatibility_service:updated_at`,
`compatibility_service_action:run`, `session_review:expected_revision`,
`secret_action:enable_disable`, and one templated managed-MCP credential row.
Each gets settled with its own family rather than in a bulk edit, because a
coverage claim needs a page and a test behind it, not a patch script.

## NND 20261007-18 — the gateway family closes, and a pin is corrected downward for the second time running

Six gateway rows closed: the enabled flag, the Telegram token, its environment
name, the workspace root, the bounded polling timeout, and the authorized-user
allowlist. The token is the interesting one, because its protection is not a
display choice. The native projector refuses to emit the field at all — it
throws if the serialized view would contain a token key, and the suite confirms
it ignores private fields even when the service hands them back. The desktop
client refuses to model a token, the replace control is a password field that
starts empty rather than echoing, and the page test asserts the secret string
never appears in the rendered text. Presence is what the surface has, and
presence is what it shows.

Two pre-C1 pins needed correcting, which is the second slice in a row where a
"verified" claim did not survive contact with the page:

- `gateway:updated_at` was credited to this page and the page never rendered it.
  Rather than downgrade a claim that was easy to make true, the state line now
  shows the stamp, an absent stamp reads `last saved: not recorded` instead of a
  guess, and both cases are asserted. The row's note was also wrong in a
  revealing way: it was copied from the web-search family and described a
  `managed` field this family has never had.
- `gateway:version` was likewise pinned as verified and is not rendered, so its
  status moved **down**. It is a store-internal counter that the client rejects
  any value of other than one, and the page already shows the source revision,
  which is the stamp an operator can act on. Making the number agree with the
  evidence matters more than the number looking good, and an honest coverage
  table has to be allowed to say less sometimes.

The class is `restart_gateway`, the native catalog's own word, recorded beside
the fact that the read view answers `not_applied` and a saved receipt points at
a restart. Nothing takes effect while the service runs, and no installed restart
has been observed: that belongs to C7 and the L gates, and both the row notes and
this document say so. Sensitivity again follows NNA and nothing else — only the
token is declared secret, and the census does not invent classifications.

Census rows without a desktop surface: 37. Rows with an unverified desktop
surface: 17 → 12 as the family closed, then 12 → **14** as the sweep below
removed two more claims. Rows declaring an unverified application class: 98 → 92.

The slice then asked a wider question, because two slices in a row had found
false "verified" pins: how many of the 62 remaining pre-C1 pins would survive the
same test? An automated triage of every one — does the named page exist, does its
text mention the field at all — reported no missing pages and nine suspicious
rows. Two were in the web-search family, already declared closed, and both were
false: the page never renders its version counter or the `managed` flag that
marks a locally deployed SearXNG instance, and no test had ever claimed
otherwise. Their status moved down. The counter genuinely does not belong on
screen; the `managed` flag does carry information an operator would want, so
rendering it is written into the row as follow-up work rather than quietly
counted as coverage. The other seven candidates stay on the list to be checked
when their families come up, which is where they will be handled properly.

## NND 20261007-17 — web search closes five rows, and four false pins are removed

This slice moved the headline number **the wrong way on purpose**, because the
record was wrong: `web_search` closed five rows, and four `web_search_alias`
rows lost pins they never deserved, so rows without a desktop surface went from
33 to 37 while rows with an unverified surface fell from 26 to 17.

NNA is explicit about those four keys: the version-1 fields `provider`,
`endpoint` and `managed` "normalize into the version-2 profiles on load and are
not projected by this surface". The read view, the catalog and the desktop's own
typed client carry only the canonical spelling. A page cannot render a field the
native contract refuses to serve, so the earlier pins named a component that
cannot show the key. They are open now, with the reason attached.

What did close is worth stating plainly, because these rows carry the strongest
evidence in the census: the enabled flag, the profile list, and each profile's
identifier, display name and endpoint are rendered and edited through preview
and a native revision check, never a blind write. The suite already covered a
preview-then-save with the exact revision, a batch spanning add, disable,
promote and remove, an uncertain save retained across a reload, a terminal
receipt released so a fresh compare-and-save can start, recovery from an expired
handle, and a hostile batch refused without contacting NNA. What was missing was
the assertion that a row shows its three fields, so that exists now, and the
class is NNA's own `next_search` — the tool reloads the file per invocation, so
"the next search honors it" is a claim the receipt makes, not one the desktop
invents.

One row stays open by judgement rather than absence: `profiles[*].provider` has
exactly one legal value, enforced by NNA refusing anything else and by the client
refusing to parse it. Printing a constant on every row would be decoration, and
decoration is how a coverage table starts lying.

Census rows without a desktop surface: 33 → 37. Rows with an unverified desktop
surface: 26 → 17. Rows declaring an unverified application class: 103 → 98.

## NND 20261007-16 — the environment family closes on evidence, and a placeholder class becomes what NNA declares

Seven `environment` rows closed without needing a new surface: the panel, the
typed client, the native route and all three test suites already existed, and
what was missing was the record — no cited tests, no application evidence, and a
surface status nobody had ever confirmed. Row-level assertions now cover all
seven entries rather than five, and the reading is worth restating because it is
the interesting part: credential withholding on this surface is **enforced, not
merely labelled**. NNA's snapshot carries presence and no value for the two names
it lists as secrets, the desktop's typed client refuses one that arrives
*carrying* a value, and the page prints `set · value withheld`. An empty value
reads differently from an unset one, and the observation digest deliberately
covers public values plus presence only, so the panel cannot be turned into an
offline oracle for guessing credentials.

The slice also fixed a defect the reporting itself had hidden: three rows
(`browser_action:status`, `browser_action:verify`, `skills_action:list`) had a
classification statement written into the **sensitivity** field instead of the
application field, which already held its own value — in JSON reports it
rendered as `[object Object]` and quietly corrupted every sensitivity count.
They now classify as generated state, which is what the misplaced statement
asserted, and the sentence survives in the row notes. No field was invented and
nothing was deleted.

The class on these rows was `external_source_change` with no evidence — a
placeholder that said roughly what everyone assumed. It is now `restart_service`,
which is what NNA's own catalog declares for every observed name. That swap is
honest only with its limit attached, and the limit is written in both the row
notes and this document: a declared application point is not an observed one.
Whether a restarted installed service really picks up a changed environment is
still unobserved, and C7 and the L gates own that.

The sensitivity classifications were left alone, deliberately. Two rows are
credentials and the census agrees with NNA's own list of secret names; the other
five are ordinary process configuration that the surface prints in full, and the
census has no value for "unremarkable", so inventing one would add noise dressed
as rigour. Census rows with an unverified desktop surface: 33 → 26.

## NND 20261007-15 — the update-state family closes on evidence, and a provider write-path claim is corrected

This slice belongs to the residual lane: rows that already named a desktop
surface but carried no application class, no tests, and no work package. It
closed seven of the eight `update_state` rows, and the panel turned out to have
a real gap rather than a paperwork gap — it rendered five of the eight fields
the native surface serves and quietly dropped `latest_ref` and `latest_tag`, so
those two now have lines of their own. The eighth, the store `format`, stays
open deliberately: it is never displayed. The client refuses a record whose
format it does not understand, so a wrong format produces the honest error
sentence and no values at all, which is validation rather than a surface.
These rows are now classified as NNA classifies them — generated state, whose
effect is `next_update_check` and whose editability the catalog states as
unavailable — and the panel proves it: a catalog that suddenly offered
editability is drift, and the page renders nothing rather than trusting it.

**The correction, because an audit artifact that is wrong is worse than one
that is empty.** The previous slice recorded that NNA offers no provider writes
and that writing therefore belongs to a later work package. That is true of the
*configuration* contract and false of NNA. `POST /v1/provider-profiles` and
`PATCH /v1/provider-profiles/:id` exist, and the store behind them rewrites the
same manifest the configuration view reads, through the same `withProvider` and
`withUpdatedProvider` transforms, under the manifest lock, gated on
`provider.profile.write` or `provider.manage`. So seven provider fields have a
native write path today; `trust_zone` has none anywhere, and capability rows are
derived state with nothing writing them. Twenty-four rows had their notes
corrected and twenty-one had a stale permission clause removed. The cost of not
checking was not a wrong number but a wrong plan: a later lane would have been
scoped to build a route that already exists.

Two housekeeping facts: 208 census rows had `tests_run` stored as a string while
the rest of the file uses an array, and they are arrays now. And the residual
lane is measured on its own axes — after this slice, 33 rows still have a
desktop surface whose status was never verified, 103 declare an unverified
application class, and 33 rows have no desktop surface at all.

## NNA (test-only) and NND 20261007-14 — the manifest root closes, and containers get a written rule

The last value-bearing manifest rows closed 10 of 22, and the family is now
finished in the only sense available to it: **every remaining row in all three
families is structure, not a value.** That is no longer a per-slice judgement
— a container row stays open when NNA serves it with no printable value and no
application class, because its members carry the settings and each of those
has its own row and its own evidence. Two roots proved the rule from the
metadata side: `provider` and `mission` have no application class at all, so
they cannot be pinned even though their members are covered.

The root block also draws the line between seeing and changing. Only two of
its rows are offered for editing at all — `persistence` and the application
system prompt — and each refuses something honest: a saved persistence change
cannot land in a live session (`configuration_scope_change`), because
persistence is fixed for the session, and `workspace_root` is served verbatim
so the operator knows which installation is on screen while the contract
declines to move it. The three version stamps are the strangest rows here:
NNA's own metadata labels them `unverified`, because they record which
contract a manifest was written under rather than a value the engine applies,
and the census follows the metadata even when the metadata declines to claim.

Census rows without a verified GUI: 43 → 33. The remaining work in the
census is no longer mostly about the GUI. Counting the other axes shows what
is left: 40 rows still carry a pre-C1 `unverified` GUI status, 115 declare an
`unverified` application class, 147 name no implementation package, and 117
cite no test. That is the residual lane — hooks, web search, gateway, update
state, compatibility service, secrets and the rest — and closing it means
running this ceremony against evidence already partly in place, not building
another surface.

## NNA (test-only) and NND 20261007-13 — provider profiles are shown, not edited, and the class audit closes

The provider family closed 24 of its 37 open rows on a read-projection
basis, and the reason it cannot close more is now written down rather than
implied: **NNA's configuration contract offers no provider writes at all.**
Every provider path is excluded from the generic editing set, so the desktop
shows the resolved profile and stops there — writing belongs to the provider
and credential lanes.

What the projection guarantees turned out to be the valuable part. A
credential in any of its three shapes — the environment alias, an
environment binding, or a Secret Broker reference — reaches the view
`redacted` and never as text: the assertion hunts the whole serialized
projection for the variable name and the secret id. Derived facts say so:
the capability container has no printable value, capability probes read
`unknown` until observed, and a display name invented from the identifier
names no layer.

The five provider rows pinned before C1 claimed `unverified` where NNA's own
metadata says `engine_boundary`, and the mechanism confirms the metadata:
`applyConfiguration` replaces `engine.config` and rebuilds `engine.router` as
a fresh `ModelRouter` over it, including the credential resolver — so a
published profile is what the next request resolves. Correcting them takes
the standing class audit to zero mismatches: every pinned row now agrees
with NNA's catalog metadata. Thirteen rows stay open honestly — eleven
credential rows awaiting the credential lane, and two containers that are
not values. Census rows without a verified GUI: 67 → 43.

## NNA (test-only) and NND 20261007-12 — the route family closes against NNA's own offer

The 48-row `manifest_route` family lost 40 rows in one slice, and the eight
that stayed open are the honest remainder: the four route objects and the
primary and subagent provider/model pairs, which NNA's configuration
contract does not make editable at all. The offer is NNA's, not the
desktop's: 36 typed scalars are generically editable and the reviewer and
vision provider/model pairs are offered as one `bind_route` operation, and
that is exactly what the desktop surfaces — the routes page tunes reviewer
and vision, the paired binding form carries provider with model, and every
other advertised scalar rides the catalog-gated chooser.

Two behaviours the proof had to pin rather than assume. Non-primary routes
inherit from the primary route, so their provider, model, and derived
deadline rows report `source_unavailable` — the view will not name a layer
it did not observe. And a saved zero is canonical: `deadline_ms: 0` keeps
`explicit: 0` while the effective value becomes `null`, because zero means
"no deadline"; the same holds for the two optional limits where zero means
unset. Bounds fail closed with `invalid_limit`, and rebinding is refused for
any role but reviewer or vision.

All 40 rows are `engine_boundary`: a republished configuration recomputes
route resolution, so the next request uses the saved route. Census rows
without a verified GUI: 107 → 67.

## NNA (test-only) and NND 20261007-11 — the provider, timeout, and context scalars of the manifest family

The first sub-slice of the 38-row `manifest` family: its 16 scalar rows
(provider timeouts and the stream pair, connection and semantic-review
timeouts, approval wait, scheduling pair, tool concurrency, the session
deadlines, and the context ceiling with its four thresholds) closed against
the EXISTING configuration view and the focused editor blocks that already
exist for them.

The proof pins down the parts a reader would otherwise guess. Three values
carry no attributable source: `provider_timeout_ms` is derived from the
primary route deadline, and `first_token_timeout_ms`/`idle_timeout_ms` ride
the legacy stream-pair rule, so their rows report `source_unavailable`
instead of a guessed layer — and the idle row stays derived even when the
first-token half is set by hand. The two upper compression thresholds are
derived too: compression plus three and six sevenths of the span to the
compaction threshold (0.55 and 0.70 by default), and an unordered set is
refused with `context_thresholds_invalid`. Out-of-range drafts fail the
resolve with `invalid_limit`.

Eight of the rows are `engine_boundary` in NNA's metadata — a republished
configuration reaches `engine.config.limits`, and the reviewer timeout,
permission timeout, and scheduler capacity are pushed directly. The other
eight (tool concurrency, the two session flush/shutdown deadlines, and the
five context scalars) stay `unverified` because that is what NNA declares;
the notes record that the values are read at their use sites without
claiming a moment NNA has not certified. `tool_concurrency` has no focused
block at all — the field chooser offers it for raw editing, and the test
says so rather than pretending otherwise. Census rows without a verified
GUI: 123 → 107.

## NNA (test-only) and NND 20261007-10 — the reviewer-ledger budget closes the small families

The last single-row `manifest_*` family closed: `reviewer_ledger.retention_entries`
against the EXISTING configuration view and the reviewer-retention block,
which already bound the control at 1–100 000 (default 10 000) and reject
`0`, `05000`, and `100001` before preview. The new proof shows the view
serving the default with `source: compiled_default` and a user value with
`source: user`, `invalid_limit` for `0`, `100001`, and a non-integer, and
`reviewer_ledger_config_invalid` for any other key inside the block — NNA
accepts exactly one key there.

The row keeps `apply.class: unverified`, matching NNA's metadata and the
code: `engine/components.js` hands the resolved number to the ledger once at
construction, `persistence/reviewer-ledger.js` compacts settled reviews beyond
it at the next write, and `runtime-config.js` republishes nothing — so a save
is not verified to re-budget a ledger already running. With this, every
`manifest_*` family except the three big ones is closed; what remains under
the census metric is `manifest` 38, `manifest_route` 48, and
`manifest_provider` 37. Census rows without a verified GUI: 124 → 123.

## NNA (test-only) and NND 20261007-9 — telemetry rows are recorded as carried, not applied

The 3 `manifest_telemetry` rows closed against the EXISTING configuration view and
the settings inventory: the proof shows `enabled` false and both other
values `null` by default with `source: compiled_default`, user values with
`source: user` including the destination URL, a resolve that refuses to
enable telemetry without a string destination
(`telemetry_destination_required`), and a disabled block that resolves
destination and retention to `null` while the explicit source value stays
visible in the row.

These three keep `apply.class: unverified`, and this time the reason is
stronger than mixed propagation: the resolved block is carried into the
canonical configuration (`provider/route-configuration.js`), but nothing in
NNA reads `telemetry.enabled` or `telemetry.destination` at runtime, and
`runtime-config.js` republishes nothing for it. The desktop renders the
values NNA serves — including the destination string, which the native
projector serves in the clear, so the row keeps its private sensitivity
label rather than pretending otherwise. Census rows without a verified GUI:
127 → 124.

## NNA (test-only) and NND 20261007-8 — attachment fields ride the view and apply live

The 3 `manifest_attachments` census rows closed against the EXISTING
configuration view and the `NNA attachments` block: the proof shows the
defaults (`enabled` true, `max_bytes` 10 485 760, `retain` false) with
`source: compiled_default`, user values with `source: user`, the
asymmetric coercion NNA documents — anything but an exact `false` counts as
enabled, anything but an exact `true` does not retain — and byte ceilings
outside 1 024–104 857 600 refusing the resolve with `invalid_limit`. The
editor renders the three rows and mirrors the byte bounds in the input
(`min` 1024, `max` 104857600).

These three are `engine_boundary` in NNA's own metadata, and the code backs
it: `publishEngineConfiguration` assigns `engine.attachments.config` on a
compatible command, so `experience/attachments.js` checks enablement and the
size ceiling at the next admission and `attachments.js` consults retention
at the next cleanup — no session restart, unlike memory-adjacent fields that
need one. Census rows without a verified GUI: 130 → 127.

## NNA (test-only) and NND 20261007-7 — recovery budgets ride the view with an honest unverified class

The 4 `manifest_recovery` census rows closed against the EXISTING
configuration view and the native-configuration page: `max_model_steps`
(default 1024, bounded 16–100 000) and `local_retry_limit` (default 3,
bounded 2–5) already have focused editor controls that preview, save
through CAS, and read the receipt; `turn_wall_clock_ms` is unset by default
— `null` and `0` both mean unset, bounded 1 000–86 400 000 — and
`recovery.ladder` only accepts `nudge` and `compact`, at most four entries,
and NNA stores just the first `local_retry_limit − 1` steps, so an explicit
four-step ladder under the default limit resolves to two. A short ladder
or an unknown step fails the resolve with `recovery_config_invalid`; an
out-of-range budget fails with `invalid_limit`.

These four keep `apply.class: unverified`, which is what NNA's own catalog
metadata declares for them, and the code agrees that no single moment
covers all four values: `engine/step-loop.js` reads the step budget and the
turn wall clock from the live engine limits at each loop entry, while
`reliability/recovery-supervisor.js` fixes the retry limit and ladder when
the supervisor is constructed. Recording the honest non-claim is the point
of the field — the desktop shows the values and the bounds, not a moment it
cannot support. Census rows without a verified GUI: 134 → 130.

## NNA (test-only) and NND 20261007-6 — memory limits ride the view, and application classes follow NNA's own metadata

Two things in one slice. The 5 `manifest_memory` census rows closed against
the EXISTING configuration view and the `NNA memory` editor block: the proof
shows the five paths serving the documented defaults (`enabled` true —
opt-out, `required` false — opt-in, `timeout_ms` 750, `max_items` 8,
`max_bytes` 16 384) with `source: compiled_default`, user values with
`source: user`, and out-of-range values refusing the resolve with
`invalid_limit`; the `enabled`/`required` coupling (disabling memory also
clears required, requiring memory also enables it) was already proven
end-to-end through a real preview and save, and the editor says so on the
row.

Second, a correction recorded in the open. An audit compared every pinned
row's `apply.class` with the class NNA's own catalog metadata
(`src/configuration-catalog-metadata.js`) declares for that key, and three
recent slices disagreed: the 30 `manifest_mcp` rows claimed `census_only`
where NNA declares the fields session-scoped, the 20 `manifest_tui` rows
claimed `new_session` where NNA declares `surface_invocation` (with its own
`no_generic_live_application_claim` caveat), and the 6 `manifest_dream` rows
claimed `new_session` where NNA declares `construction_only` (a workspace
builds its coordinator once). All 56 now carry NNA's class with NNA's
evidence symbols, and rows that honestly say `unverified` stay that way
until each family is verified. Memory was pinned with the metadata class
from the start — `engine_boundary`: an accepted compatible configuration
command applies immediately while the engine is idle and otherwise at the
next model step, and `assertRuntimeConfigurationCompatible` does not list
memory among the changes that need a new session. Census rows without a
verified GUI: 139 → 134.

## NNA (test-only) and NND 20261007-5 — dream maintenance limits ride the configuration view

The 6 `manifest_dream` census rows closed against the EXISTING
configuration view and the `NNA dream maintenance` editor block — no new
native surface. The mechanical proof (NNA `test/nnd-configuration-view.test.js`)
shows the six paths serving user values with `source: user`, the documented
defaults with `source: compiled_default` (`enabled` true, `idle_ms` 45 000,
`inter_stage_ms` 5 000, `inference_idle_ms` 120 000, `hygiene_idle_ms`
300 000, `retention_days` 30), and out-of-range values refusing the whole
resolve with `invalid_limit` before anything can apply. The bounds are the
engine's own (`src/configuration-rules.js`) and the editor mirrors them
exactly (5 000–3 600 000, 1 000–300 000, 10 000–3 600 000,
30 000–7 200 000, 1–365 days), with the honest sentence that saved changes
take effect only in a new constructed context — a workspace builds its
`DreamCoordinator` from the resolved configuration the first time it
touches maintenance. Idle maintenance is opt-out for a standalone agent and
an authenticated hosted execution manifest always disables it
(`src/dream-config.js:validateDream`), which is why the block reads the
effective verdict from the native preview rather than claiming activation.
Census rows without a verified GUI: 145 → 139.

## NNA (test-only) and NND 20261007-4 — skill fields read through the native catalog

The 7 `manifest_skills` census rows closed against the EXISTING skills
catalog observation (`GET /v1/nnd/configuration/skills/catalog`, shipped
for the `skills_action:list` row) — no new native surface. The mechanical
proof (NNA `test/nnd-skills-routes.test.js`, real registry over a temp
skill root) shows the served grammar is exactly the seven census fields —
`id`, `version`, `description`, `invocation`, `source`, `requires_tools`,
and the body **only** as `body_sha256` — that the digest is the SHA-256 of
the real body and that the body text never crosses. Inline manifest skills
remain host-only: `validateManifestSkills` checks the principal first, so
the desktop is refused with `hosted_skills_forbidden` (echoing neither the
body nor the description), and hosted grants share the same seven-field
grammar through `validateHostedSkills`. The catalog the desktop does see is
discovered roots only — bundled, user, and (while the workspace is
trusted) project — with entries that need unavailable tools skipped under
a visible diagnostic rather than silently dropped. The skills panel already
renders every field per row and states that bodies are never rendered, only
their digests. Census rows without a verified GUI: 152 → 145.

## NNA (test-only) and NND 20261007-3 — mission authority stays host-only

The 16 `manifest_mission` census rows closed against the EXISTING
configuration view — the slice adds no native surface, and the desktop
never sets or observes a mission block: `validateMission` checks the
principal first (src/config.js), and the `authenticated-nnd-operator`
principal is refused with `mission_authority_forbidden` before the
schedule order, bounded lists, or termination conditions are ever reached.
The mechanical proof (NNA `test/nnd-configuration-view.test.js`) shows the
16 paths (plus the container) serve as honest absence for the desktop
view; a manifest that carries a mission is refused before resolution, and
the refusal never echoes the outcome, credential references, or schedule.
Host grants, when an authenticated headless host supplies them, must carry
the ordered schedule (`not_before` < `expires_at`), the bounded lists
(resources ≤ 32, targets ≤ 128, `side_effects` from the four choices,
credential references ≤ 64 environment-style names), the three resource
bounds (`max_turns`, `max_tool_calls`, `max_duration_ms`), and termination
that always requires `budget_exhaustion`, `expiration`, and `disconnect` —
validated in that order, and they apply to the sessions that host starts.
The desktop inventory page renders the rows as `Not set`; NNA owns mission
authority and NND renders the honest absence read-only. Census rows
without a verified GUI: 168 → 152.

## NND 20261007-2 — TUI keyboard family rides the configuration view

The 20 `manifest_tui` census rows closed against the EXISTING configuration
view — this slice adds no new native surface: the generic catalog already
serves every `tui` path, and the mechanical path proof (NNA
`test/nnd-configuration-view.test.js`) shows the 20 census paths carry their
explicit values, the merged validated binding map, and honest provenance.
The defaults always apply, even when the manifest omits the whole block:
`reduced_motion` is false, `color` is on (a tty still has to allow it and
`NO_COLOR` clears it), and all seventeen binding defaults are present before
validation. The bindings apply at TUI start
(`src/tui.js:runTui` re-validates the merged map through
`src/experience/key-bindings.js:validateKeyBindings` and feeds the decoder
via `src/tui.js:decoder.setBindings` before the first frame); `reduced_motion`
skips animation frames and `color` gates ANSI rendering. The container row
projects presence only. The desktop inventory page renders the rows — NNA
owns the tui block and NND renders it read-only. Census rows without a
verified GUI: 188 → 168.

## NNA 20261006-22 and NND 20261007-1 — MCP advanced-fields projection

The 30 `manifest_mcp` census rows closed with a real projection of the fields
the redacted editor route never serves. Nine rows (id, transport, enabled,
trusted, and the five deadline fields) were already native through the
`/v1/nnd/configuration/mcp` read + editor and are pinned to it; the other
twenty-one (credential/credential_env/credential_target with their binding
subkeys, header_env with map keys, header_credentials with binding subkeys,
tool_effects with per-tool rules, protocol_version, command, args, cwd,
endpoint) ride the new `GET /v1/nnd/configuration/mcp/advanced` with two
fail-closed grammars: **presence** (read right only — per server the
booleans `has_credential`/`has_credential_target`/`has_header_env`/
`has_protocol_version`/`has_command`/`has_args`/`has_cwd`/`has_endpoint`
plus the null-safe counts `header_credential_count` and
`tool_effect_count`, never a value) and **inner** (manage right, the
write-class right the manifest save demands — adds what the operator's own
manifest wrote back to them as references: the environment NAME or
`secret:<id>#<field>` credential pointer, the header-reference rows, the
header-environment name map, the tool-effect rules, the pinned protocol
version, and the transport surface; the secret VALUE still never crosses).
Both grammars validate with mechanical sort-joined key sets, a registered
`nnd_mcp_advanced_projection_invalid` in the 500 group, and the
dispatch-before-plain-MCP ordering; the projection reads the resolved
configuration verbatim and re-validates nothing. The desktop `MCP server
details` panel renders the presence rows under its read button and the
inner references behind an explicit `Load references` action, with the
honest sentence that values stay native. Census rows without a verified
GUI: 218 → 188.

## NNA 20261006-21 and NND 20261006-24 — CLI invocation flag vocabulary

The 23 `invocation:*` census rows closed with a real read surface over the
CLI's own flag grammar (`parseCli`): the invocation vocabulary the slice
added to `cli-options.js` is one entry per census row — flag, sibling
aliases, argument grammar (value / none / prompt-text), allowed modes
(universal rows are exact-match `'*'`, subcommand rows name their mode,
opencode-only rows included), the host/headless refusal (endpoint, model,
and the credential-environment NAME die on `host_override_requires_manifest`
because those overrides must come from the authenticated initialization
manifest), the parsed option key the branch lands on, and the
operator-facing effect. The native route `GET /v1/nnd/configuration/
invocation` projects the vocabulary fail-closed (a 23-row projection with
its own registered codes, a 500_GROUP projection slip, and the standing
parser/permission discipline — GET with a 16 KiB bound, read permission
only); the mechanical consistency test proves the table against `parseCli`
in every allowed mode (including the port bounds, mode-restricted flags
refusing outside their mode, and the headless guard), so the description
cannot drift from the parser without failing the suite. The flags stay
terminal-owned: the desktop `Invocation vocabulary` panel renders the
vocabulary as read-only language facts and states honestly that the CLI is
their authority. Census rows without a verified GUI: 241 → 218.

## NNA 20261006-20 and NND 20261006-20 — gateway/web-search operator verb triage

The 26 `gateway_action` + `web_search_action` census rows closed with a
per-verb triage over the two CLI authorities (`runGatewayCommand`,
`runWebSearchCommand`): the config-mutation verbs were ALREADY native through
the two save transactions (gateway `set_token`/`clear_token`/`authorize`/
`revoke`/`set`+`reset`; web-search `add_profile`/`promote_profile`/
`remove_profile`/`set_enabled` — token/token-stdin/token-env map to
set_token variants, authorize/revoke/workspace/enable/disable to authority
and set operations, add/promote/remove-profile/reset/disable/configure/
install-if-unconfigured to profile operations) and are now pinned to those
surfaces. Four new read surfaces reuse the CLI authorities verbatim: `GET
/v1/nnd/configuration/gateway/status` merges `gatewayPublicStatus` with the
identity-verified pid-file runtime status; `POST …/gateway/actions/test`
runs the live Telegram getMe probe over the resolved token as an honest
200-verdict receipt (`telegram_token_missing` / `gateway_test_unreachable`
refusal verdicts, read-only, no token value served); `GET
/v1/nnd/configuration/web-search/actions/managed-status` projects
`SearxngDeployment.status()` (HTTP probe + docker ps identity) as the
observation behind `refresh-managed`; and the eight runtime/lifecycle verbs
(gateway `run`/`start`/`stop`, SearXNG `deploy`/`install-local`/
`remove`/`remove-deployment` + the refresh's mutating twin) are REFUSED
natively with honest `nnd_action_cli_only` 200 verdicts carrying terminal
hints (the native service never detaches or kills processes or drives docker
compose — the CLI stays their authority), per the update_action:install /
compatibility_service_action:run precedent. New codes registered
(`nnd_action_triage_request_invalid`, `nnd_action_triage_projection_invalid`
— a 500 projection slip alongside its 400 sibling). The desktop gained the
`Gateway runtime` panel (merged view + probe verdict, refusal sentences)
and the `Managed SearXNG deployment` panel (endpoint, container identity,
search probe) — both stating the CLI-only stance honestly. Census rows
without a verified GUI: 267 → 241.

## NNA 20261006-19 and NND 20261006-19 — legacy provider credential alias observation

The `legacy_provider_credentials` census row closed with a real native
surface reusing the startup alias loader verbatim: `GET
/v1/nnd/configuration/legacy-provider-credentials`
(`nnd.configuration.read`) runs `loadManagedProviderCredentials` on the
served process against a **spare environment object** and projects only the
verdict — whether the legacy `NNA_PROVIDER_INITIAL_KEY` alias store
(`config/provider-credentials.json`) exists, validates, and would inject
(`loaded`, count 0|1, and an honest reason when the store is malformed or
oversized: the authority's own registered codes). The key value is never
served — the load verdict projects `loaded/verdict` only, matching the
row's `secret` sensitivity; the spare environment is discarded. An absent
store is a successful 200 describing absence (`loaded:false, count:0`), a
malformed/oversized store is an honest refused verdict (still 200, the
authority's code in `reason`), an unresolvable read is the wrapped 503, and
projector drift is the 500
`nnd_legacy_provider_credentials_projection_invalid`. The desktop `Legacy
provider credential alias` panel renders the three-line verdict without any
value. Census rows without a verified GUI: 268 → 267.

## NNA 20261006-18 and NND 20261006-18 — native skills catalog observation

The `skills_action:list` census row closed with a real native surface reusing
the skills CLI authority verbatim: `GET /v1/nnd/configuration/skills/catalog`
(`nnd.configuration.read`) initializes the same SkillRegistry
`runSkillsCommand` builds — bundled + user skills plus the serving
workspace's project root when, and only when, the workspace is trusted (the
read-only `workspaceIsTrusted` verdict, surfaced in the receipt) — and
freezes the catalog exactly as the CLI returns it: ids, versions,
descriptions, invocation, source scopes, tool requirements, and body
SHA-256 digests; a skill body is never served. Registry diagnostics
(skipped duplicates/capability gaps per scope) ride the receipt. A failed
discovery or initialization wraps to the CLI-equivalent
`nnd_skills_catalog_unavailable` (503, honest); an unresolved workspace is
the 400 `nnd_skills_request_invalid`; projector drift is the 500
`nnd_skills_projection_invalid`, and an over-bound catalog is the honest 413
`nnd_skills_catalog_too_large`. The desktop `Native skills catalog` panel
renders the catalog with digests only and the per-scope skip reasons. This
is the native registry read, distinct from the opencode skill-source
browser page. Census rows without a verified GUI: 269 → 268.

## NNA 20261006-17 and NND 20261006-17 — managed browser status and verify

The two `browser_action` census rows closed with a real native surface that
reuses the webbrowse CLI authority verbatim: `GET
/v1/nnd/configuration/browser` (`nnd.configuration.read`) reports the
managed Playwright Chromium exactly as `playwrightStatus` reads it —
presence, the pinned version, the browser path, and the honest refusal
reason (`not_installed` | `version_mismatch` | `validation_failed`); `POST
…/actions/verify` runs the same authority WITH the launch probe (headless
Chromium launches, renders a validation page, and closes) so an operator
learns the runtime works, not merely that files exist. The receipt is one
fail-closed grammar (the router normalizes the authority's two outcome
shapes before sending; drift is the 500 `nnd_browser_projection_invalid`),
the desktop `Managed browser` panel renders the observation and offers
status and verify buttons with the honest refusal sentences, and nothing on
disk ever changes — both verbs read. The service manage root derives from
the per-user data root (`managed/playwright`), the same root the product
uses. Census rows without a verified GUI: 271 → 269.

## NNA 20261006-16 and NND 20261006-16 — installation observation and registered-code surfacing

The six `installation` census rows (the install.json descriptor: product,
version, install_root, data_root, node, node_major) closed with a real
native surface: `GET /v1/nnd/configuration/installation`
(`nnd.configuration.read`) re-verifies the descriptor on every read through
the admission authority (`readNndServiceIdentity` — descriptor validation,
canonicalization, payload checks, runtime probe) and fails closed when the
disk no longer supports the admitted installation, surfacing the authority's
`nnd_install_*` verdicts verbatim at 503; a projected value the router
cannot accept is the 500 `nnd_installation_projection_invalid`. The desktop
panel `NNA installation` renders product, version, install root, data root,
and the node runtime. The slice also repaired two error-surfacing defects
the new surface exposed: the configuration router now passes **registered**
failure codes through verbatim (registered = safe to surface; unregistered
errors stay rebranded as `nnd_configuration_unavailable`), which uncovered
and closed a `-12` registry gap (`nnd_package_root_invalid`,
`nnd_package_command_invalid`, `nnd_package_root_mismatch` were never
registered while the shared filter silently rebranded them), and the
descriptor-unavailable/status mapping joined the honest 503 group.
Registered-code surfacing is enforced by the routing-filter test and the
installation drift test. Two served-family field rows
(`web_search:profiles[*].managed`, `gateway:updated_at`) pinned as
census-only projected fields riding their family views. Census rows without
a verified GUI: 279 → 271.

## NNA 20261006-10 (runtime unchanged) and NND 20261006-15 — session-review rows pinned

The two `session_review` rows closed as census pins of an already-served and
already-consumed surface: the NNA review-mode commit (`PUT
/v1/nnd/sessions/:id/review-mode`, `nnd.session.update`, apply class
`idle_session` with auto-review preserved as mandatory review) persists mode
and revision in `sessions/nnd-contexts.json`, and the desktop chat work
status panel consumes the read and the compare-and-set commit
(`setSessionReviewMode` PUT carrying `expected_revision`), with lib and page
drills asserting both. The rows now carry the verified chat consumer
(`packages/ui/src/chat/review-mode-control.tsx`), `security` sensitivity,
per-row source symbols, and the idle-session/CAS policing note.

## NNA 20261006-10 (runtime unchanged) and NND 20261006-14 — generated-state meta rows pinned

The four remaining un-GUI'd rows of the three served settings families
(`web_search:version`, `web_fetch:version`, `web_fetch:updated_at`,
`gateway:version`) are generated state delivered inside the read views those
family pages already consume (produced by the native transactions on every
save, `editability` unavailable, `application: not_applied`): they now carry
the read endpoint, read permission, verified family-page GUI,
`generated_state` sensitivity, and per-row evidence as in-place census pins.
No native change and no product change.

## NNA 20261006-10 (runtime unchanged) and NND 20261006-13 — trust and web-fetch action rows pinned

The `trust_action` (trust/revoke) and `web_fetch_action` (status/trust/revoke)
operator rows needed no new surface and no product change: the `-5`
trusted-workspaces surface already performs grant/revoke through the shipped
trust functions verbatim (`POST /v1/nnd/configuration/trust/grant` and
`/revoke` under `nnd.workspace.manage`, receipts the redacted
`{operation, root, trusted}` records, corrupt store fail-closed at 503), and
the `-1` WebFetch settings transaction already performs origin trust/revoke as
operations over the shipped web-fetch-config authority (`GET` status +
`POST .../save` with `{op:"trust"|"revoke"}` under
`nnd.configuration.manage`), with both desktop consoles and their page/lib
drills verified in their own slices. The five rows now carry the endpoint,
permission, verified GUI path, `security` sensitivity, and per-row source
symbols as an in-place census pin.

## NNA 20261006-12 and NND 20261006-12 — update and package operator actions

The five remaining C1 operator rows (`update_action:check`,
`update_action:install`, `nnd_package_action:activate`,
`nnd_package_action:deactivate`, `nnd_package_action:status`) closed with
native surfaces reusing the shipped operators verbatim and an NND console for
each. The runtime checks the repository through the update CLI authority
(`checkForUpdate` with force — the `-4` update-state observation stays the
cached read) and refuses the install line honestly
(`nnd_update_install_unsupported`): the installer inherits the owning console
and replaces the running implementation, which an HTTP handler cannot host, so
the CLI (`nna update`) stays its authority and the routes pin the refusal. The
package surface reuses `runNndPackageCommand` verbatim: status reads the
registry (`GET /v1/nnd/configuration/nnd-package`,
`nnd.configuration.read`), activate validates a package root through the
manifest transaction and registers root/version/protocol
(`nnd.package.manage`), deactivate unregisters only the matching root with
wrong-root lockstep refused at 400. Receipts pin the CLI's own verdict
grammars and fail closed on drift (`nnd_update_projection_invalid` /
`nnd_package_projection_invalid`, 500). The slice also fixed a real wiring
defect found during the census survey: `nnd-service-native.js` created seven
settings services but passed only nine context services to the listener —
the compatibility lifecycle, MCP-credentials, secrets, and hooks surfaces
were unreachable natively (their HTTP tests had injected services directly);
the options now spread the whole classified service set so a surface cannot
be silently dropped again, and the exported factory key list is locked by
test. New rights `nnd.update.manage` and `nnd.package.manage`; trial
principals keep none. NNA `0ac274e2`, NND console pages (`NNA update
actions`, `NND package actions`) with receipts rendering the CLI verdicts
and the installer refusal verbatim. Focus tests 4/4 NNA + 4/4 NND; masks: full
NNA 2,364 tests (2,354 pass — only the load-flaky census pair, verified green
solo), full UI+web seen in the NND slice record.

## NNA 20261006-10 (runtime unchanged) and NND 20261006-11 — the secret_action console

This slice added no native surface: the seven census `secret_action` rows
(list, create, update, rotate, enable/disable, delete, audit) were already
served by the runtime SecretBroker over the integration server
(`dispatchSecretBrokerRequest` — `GET`/`POST /v1/secrets`,
`PATCH`/`PUT /v1/secrets/:id[/values|/status]`, `DELETE /v1/secrets/:id`,
`GET /v1/secrets/audit`) and the NND operator principal already carries
`secret.read`/`secret.manage`/`secret.audit` — deliberately NEVER
`secret.use`, which stays with trusted local callers. The work was closure on
the NND side: a typed console client (`packages/ui/src/lib/nnd/
secret-actions.ts`) that pins the broker's redacted `publicSecret` grammar
(labels, kinds, scopes, field NAMES sorted, enablement, use counts, stamps —
never a value) and the values-free audit grammar (14 fixed keys, no value
field, bounded honest sentences for the broker's own refusal codes), and an
"NNA secret actions" settings section that performs all seven actions with
receipts: create (label/kind/fields/scope/metadata, values typed once), update
(label/scope/metadata without values), rotate (values typed once, inputs
cleared after send), enable/disable, delete, refresh, and the audit ledger
view (newest last, outcome + consumer + reason, no values, ever). There is
deliberately no client for the consumption path
(`POST /v1/secrets/:id/use`), and the lib's export surface pins that absence
structurally. Focused NND tests 4/4 (parser grammar + audit drift refusals +
sentences + the export pin; the console drill drives every verb with methods
and paths asserted, values never re-rendered). Census rows updated in place
(7 rows: verified GUI, `secret` sensitivity, per-row evidence); full UI 247
files (1,855 tests), web 132 files (1,447), typecheck clean.

## NNA 20261006-10 and NND 20261006-10 — native hooks bundle settings

NNA (`20261006-10`): the nine census `hooks` rows (name, version, and the seven
`subscriptions[*]` fields) gained their native surface at
`/v1/nnd/configuration/hooks`, reusing `src/hook-manifest.js`
`discoverHookBundles` VERBATIM — the sorted non-dot readdir, the 32-bundle cap
with the honest omitted diagnostic, per-bundle realpath containment, bounded
manifests, and the manifest/subscription validation authority
(`validateBundle`/`validateSubscription`). The projection carries only what the
census carries: bundle name, version, directory name, and subscriptions with
event, phase, command, blocking, priority, timeout_ms, max_concurrent (the
domain's camel `timeoutMs`/`maxConcurrent` renamed to the census snake pair);
the absolute directory stays out. Discovery's honesty channel survives the
trip: a malformed bundle is its own skipped diagnostic (never an empty or
partial list), the limit diagnostic reports the omitted count, and an absent
hooks directory reads as an honest `absent` source state with count 0. Field
grammar mirrors the domain exactly, including its tolerance (an empty version
string projects as-is, bounded only by the domain's 64-slice) and the runner's
own command grammar (shell metacharacters and newlines banned, 1..1024).
Runtime EXECUTION stays with hook-runner; authoring a manifest belongs to the
hook-store mutation story, so the surface applies or activates nothing
(application `next_hook_use`) and every catalog field refuses editability with
`hook_store_mutation_separate`. Projection drift fails closed
(`nnd_hooks_projection_invalid`, 500, registered client-side).

NND consumes in this version: a typed read client pinning the envelope, every
live bundle field, the diagnostics shapes (skipped and limit_reached), and the
grammar refusals, plus an "NNA hook bundles" settings section — the honest
absence sentence, per-diagnostic lines (cap omitted count, skipped bundles with
their credited codes), per-bundle subscription rows with the projected values,
and the no-writes/no-execution statement. Focused NND tests 5/5, full UI 245
files (1,851 tests), web 132 files (1,447 tests), typecheck clean; census rows
updated in place.

## NNA 20261006-9 and NND 20261006-9 — native compatibility-service lifecycle actions

NNA (`20261006-9`): the six census `compatibility_service_action` rows
(status/start/stop/enable/disable/run) gained their native surface at
`/v1/nnd/configuration/compatibility-service/actions`, reusing
`src/nnd-compatibility-lifecycle-routes.js` reuses `src/opencode/service.js`
VERBATIM — the opencode-start session lock, the detached managed runtime spawn
into `nna opencode run`, verified pid records, the Startup-folder `.vbs`, and
the OpenChamber user-environment wiring stay exactly as the CLI shipped them.
`status` is a GET read action on
`nnd.configuration.read` projecting the domain's redacted view: credential
presence and source only (the value never leaves the store), the runtime
variant grammar exactly as ProcessIdentity produces it, login wiring, the
presence-only environment observation, and `stale_binding`. start, stop,
enable, and disable are POST operator actions on the NEW dedicated right
`nnd.service.manage`, kept separate from the settings write right because they
reach outside the configuration file (a verified process kill, a Windows
Startup script, user-scope environment writes). start reads the persisted
wiring NOW into a fresh runtime (`start_service`); stop is immediate
(`stop_service`), refuses an unverified runtime with
`opencode_identity_unverifiable` so a wrong-process kill can never ride
identity drift, and is an honest no-op when nothing runs; enable/disable flip
the persisted flag and install or remove the login script with the same
rollback (`next_service_start` — the wiring surface applies at the next service
start, the immediate script install is reported in the receipt). `run` is
refused honestly (`nnd_service_run_unsupported`): it is the foreground managed
runtime the detached start and the login script drive, and an HTTP handler
cannot host a surface that never returns; input-less verbs accept only empty or
empty-object bodies so stray state can never ride an operator action.
Projection drift fails closed (`nnd_service_projection_invalid`, 500,
registered client-side); operational failures are honest 503s (start failure,
identity unavailability/unverifiability, Startup-folder and environment wiring
or probe failures).

NND consumes in this version: a typed client mirroring the status observation,
all seven runtime variants, and the per-verb receipts (start/stop/enable/
disable run with no inputs at all, so every button posts an empty body), plus
an "NNA compatibility service actions" settings section — the redacted wire
panel, honest runtime sentences (verified/unverified/stale variants), login and
environment lines, per-verb receipts with operation id and application class,
the run-less wording, and native code sentences (Windows-only wiring, refuses
to stop an unverifiable runtime, start failure → inspect opencode-console.log).
Focused NND tests 5/5, full UI 243 files (1,846 tests), web 132 files (1,447
tests), typecheck clean; census rows updated in place.

## NNA 20261006-8 and NND 20261006-8 — native secrets metadata read surface

NNA (`20261006-8`): the six census `secrets` rows (label, kind, scope,
`metadata.{name}`, `fields.{field}`, enabled) gained their native surface at
`/v1/nnd/configuration/secrets` — list + catalog only, both on the read right
`nnd.configuration.read`; there are no operations, and the query string is a
refusal. The list projects the runtime secret broker's redaction-safe
`publicSecret` envelope exactly: label/kind/scope, public metadata, FIELD NAMES
(never values), enabled, and the timestamps/use-count — values and encrypted
material never leave the vault. An absent vault reads honestly as
`source_state: "absent"` with `count: 0`; a corrupt vault or master-key damage
fails closed with the vault's own codes (`secret_vault_corrupt` /
`secret_key_invalid`, 503) and never degrades to an empty roster; a drifted
projection on either side refuses with `nnd_secrets_projection_invalid` (500,
registered client-side), and the response stays inside the same client-checked
2 MiB + 64 KiB ceiling. `application` is `next_secret_use`: records change live
in the vault, and their values reach a consumer only at the next broker
consumption point — the settings read applies nothing. Writes (create/rotate/
rename/enable/delete/audit) stay on the runtime broker surface and its own
`secret_action` source rows; this family must never become a vault or master-key
file editor.

NND consumes in this version: a typed read-only client mirroring the envelope
(exact keys, count parity, absent-as-absent) and its failure sentences — vault
damage says the vault needs native repair — plus a "NNA secrets metadata"
settings section rendering the redaction-safe roster (label, kind, enabled,
field count, scope, updated timestamp) with an explicit statement that values
never render there and all writes remain broker actions; a corrupt vault shows
the repair sentence with the forwarded code. The catalog is pinned (the six
read-only fields, each `editability: {available: false, reason:
secret_broker_actions}`); focused NND tests 5/5, full UI 241 files (1,841
tests), web 132 files (1,447 tests), typecheck clean; census rows updated in
place.

## NNA 20261006-7 and NND 20261006-7 — compatibility audit delta plus native managed MCP credentials

NNA (`20261006-7`, with `2f1489ab` as the -6 head): two bodies land together.
First, the compatibility service family absorbed the findings of its independent
non-author review (verdict NEEDS-FIX): preview now checks the revision BEFORE
building the merged candidate, so a corrupt or foreign-version store reports
`nnd_compatibility_source_invalid` on every spoke and error precedence matches
save (a stale revision wins over candidate grammar); the candidate must be a FULL
document view (all four wire keys; keep/clear never carry a value slot); the
projector got a server-side drift code `nnd_compatibility_projection_invalid`
(500, registered client-side) so version, `updated_at`, and receipt `replayed`
flags fail closed instead of coercing, and the response bound is defended by the
same code; and the credential source strings now come from the domain's new
`OPENCODE_PASSWORD_SOURCES` constant rather than a local literal copy. New route
tests pin the corrupt-store preview refusal, stale-revision precedence, the
sparse-candidate and stray-value refusals, and the projector drift refusals over
HTTP.

Second, the census row `managed_mcp_credentials:credentials.{NNA_MCP_MANAGED_reference}`
gained its native surface at `/v1/nnd/configuration/mcp-credentials`: list +
catalog (read right), save + delete (manage right) over the engine host's
`config/mcp-credentials.json`. There is no ledger here — builds are IMPLICITLY
idempotent: save derives the reference from the server id (`NNA_MCP_MANAGED_<stem>_<sha256:12>_TOKEN`)
and upserts it (same server id, same reference, 256-reference and 1 MiB caps,
16,384-character tokens), delete is an honest no-op receipt reporting `absent`
when nothing was stored, and the list carries references plus an `applied`
presence flag ONLY — token values never project, and the store changes take
effect at the next MCP server spawn (`application next_server_spawn`). A corrupt
store fails closed (`mcp_credentials_invalid`, 503); the session lock reports
`mcp_credentials_busy` (409) and capacity `mcp_credentials_full` (409).

NND consumes in this version: the audit-delta projection code joins the
compatibility page's honest sentences, and a typed managed-MCP-credentials client
plus a settings section renders the reference roster (references and an applied
flag, never values), stages an idempotent save from a server id, stages deletes
per reference, and treats deleted-or-absent receipts as safe repeats; the census
row updates its validator, native endpoints, and GUI columns; focused compat
tests 9/9 over HTTP, mcp lib + page tests 9/9, full UI 239 files (1,836 tests),
web 132 files (1,447 tests), typecheck clean.

## NNA 20261006-5 and NND 20261006-5 — workspace trust grants read and granted natively

NNA (`20261006-5`): the three trust rows gained the settings family's first
authority-grant surface at `/v1/nnd/configuration/trust` — list, catalog, and the
grant/revoke operations — where the operations run THROUGH the native trust
functions (`trustWorkspace`/`untrustWorkspace`), so admission semantics,
canonicalization via realpath, path locking, and atomic writes stay native. A
grant requires an existing root (the native admission check refuses a missing
target with `workspace_trust_target_missing`), a revoke of a gone root is an honest
no-op receipt, and receipts record the CANONICAL root the grant recorded, which may
resolve wider than the literal request. Lock contention maps to
`workspace_trust_busy` (409) and an unreadable store to `workspace_trust_invalid`
(503): the list deliberately never degrades to an empty list, because "nothing
trusted" would admit unsafe flows. Mutations require the workspace authority
right; reads and the catalog need only the read right.

NND consumes in this version: a typed client mirroring the list (exactly the three
census paths in the served order; each entry exactly `{root, trusted_at}`),
receipts pinned to the requested operation, and the catalog's authority-grant
statement (`nnd.workspace.manage`), plus a "Trusted workspaces" section with the
listed roots and trust times, a staged grant with the canonical-root receipt shown,
per-row restores through revoke, and honest refusals surfaced in sentences — a
missing target says the path does not exist; an unreadable store says it refuses to
claim which roots are trusted. Failed reads leave the error sentence on display and
the server-side refusal governs any mutation attempt.

## NNA 20261006-4 and NND 20261006-4 — update state reads natively and the web-search aliases reconcile

NNA (`20261006-4`): the update_state entries — eight census fields of the
release-channel check recorded by NNA's update worker at
`runtime/update-state.json` — gain an honest read-only native surface at
`/v1/nnd/configuration/update-state` (read plus catalog, read permission
only). The surface loads through the store's own validator, so any content
the validator refuses — an absent, corrupt, or foreign-shaped file —
projects as the sticky state `absent`, honestly meaning "no recorded check
is known to be valid" rather than claiming why; a validator-accepted record
projects as stored with store-grammar parity (v-prefixed or long-sequence
versions, offset timestamps, length-bounded brief strings), the eight census
fields only (the unclassified `installed_at` store field stays unprojected),
unavailability paired with whatever error code the store holds, unknown
fields dropped, and any further drift failing closed. The catalog marks
every field read-only (`reason: generated_state`) because only the update
worker and its install path write the store — the GUI never repeats the
private repository request and never writes.

NND consumes in this version: the typed client mirrors the projection
(whitelisted keys, honest absence, exact census shape, dropped extras,
fail-closed on missing or renamed fields, and store-grammar parity so any
content the native validator accepts also reaches the reader) and a
read-only "Updates (native service)"
section renders the recorded check (status, checked-at, latest version,
digest, last error) or the honest no-record-yet default with a refresh; the
census update_state rows (8) carry the native read endpoints, the paired
read permission, and the section path.

The same census commitment reconciles the web-search family's four
compatibility-alias rows: NNA accepts the legacy version-1 document keys
(root provider/endpoint/managed, profile displayName) on load and
normalizes them into the served version-2 shape, so the alias rows now
point at the WebSearch settings family's existing native chain (read,
preview, save, operation receipts) with a note that the surface serves the
modern shape only.

## NNA 20261006-3 and NND 20261006-3 — environment observations read natively

NNA (`20261006-3`): the environment rows — seven census-named entries from
the service process, two of them credentials — gain an honest read-only
native surface at `/v1/nnd/configuration/environment` (read plus catalog
with the read permission only). The observation projects exactly what the
served process resolves: public entries carry their value (including legal
empty values; oversize values are refused, never truncated), credential
entries project presence without a value, and the digest covers public
values plus credential presence only — hashing credential values would hand
readers an offline guess-verification oracle. Values carry source labels by
design: the scope is the service process, and the catalog reports every
field read-only (`reason: process_environment`) because environment changes
happen in the Windows shell and reach the service at its restart. Unknown
service fields are dropped, not rejected; a drifted projection fails
closed. The editability reason matches the census verdict. The first audit
round on this slice rejected its claims — the auditor probed the response
bound with five maximum-size legal values and found a legal-state refusal,
plus permission-check ordering that let a lesser token probe service
availability, a digest frozen at construction, and on the client a broken
typecheck, a parser that accepted an absent credential row carrying a
leaked value, and catalog template drift. Every finding was fixed (bound
rederived at 524,288 from the sixfold worst-case escaping of five 16,384
byte values with the proof in the code comment; permission first on both
actions; per-read digest with name-qualified sentinels so an absent entry
never collides with a legal value; the oversize code maps to an honest 413;
client parser refuses any absent-with-value row and any credential row
carrying a value and rebuilds the catalog strictly), and a bounded
re-audit then verified all ten findings closed with live probes
(legal maximum state reads 200; absent and sentinel-value digests differ;
oversize refuses 413; client typecheck exit 0).

NND consumes in this version: the typed client mirrors the projection
(whitelist of the seven names, credential redaction, empty-value and absent
row honesty) and the read-only default settings section renders the
determinations the service actually sees, with the shell/restart explanation
and a refresh; the census environment rows (7) carry the native read
endpoints, the paired read permission, and the section component path. The
rows' installed journey (application class) stays unverified until an
installed service is observed through its restart.

## NNA 20261005-16 and NND 20261006-2 — WebSearch settings family goes native-first

NNA first (`20261005-16`): the WebSearch settings family — the enabled flag
plus at most eight canonical SearXNG profiles in `config/web-search.json` —
moves through one CAS-protected transaction at
`/v1/nnd/configuration/web-search` mirroring the 20261005-14/15 family
mechanics (preview, per-save receipts, replay pre-read before the
stale-revision conflict). The operation grammar maps each operation to one
domain helper — set_enabled re-normalizes the document (an enable without a
profile keeps the domain's endpoint-required refusal), add_profile appends
with a domain-derived slug id and enables by domain parity, promote_profile
moves a profile to primary, remove_profile deletes one and honestly disables
when the last profile leaves — and domain semantic refusals (duplicate
endpoint, missing profile, id grammar) keep their governed codes at the
native boundary while both transport bounds double to 131,072 bytes because
a legal profile endpoint can approach the domain's 65,536-byte file cap. The
honest application class is `next_search`: the web search tool reloads this
file on every search invocation, so a saved change is honored by the next web
search with no restart. An absent file reads as sticky defaults and the
composition bootstraps it like the CLI. The automated implementation-safety
gates (AC-IMPLP) caught a function-size violation from the third service
wiring before commit and the settings-family factory extraction fixed it;
two independent non-author audits — the native family and the NND consumer —
then ran to completion and both returned PASS with no defects (the consumer
audit verified the mirror, receipts, census rows, and every ledger claim,
probing absent-basis and prototype-key hostility without finding a way
through; its pre-seal asks — BOM strip on two touched files, a staged-add
dedupe, and truth-precise suite arithmetic — were applied before the seal).
Focused suites 13/13 (8 transaction + 5 HTTP); the full NNA suite passed
2,320 of 2,334 tests (8 skipped) with six load-sensitive platform-timing
flakes, all proven green in isolation on the final tree.

NND consumes in this version: the typed client mirrors the projector
exactly — profile order is served order (primary first), identifiers and
1–128 character names validate client-side like the domain, endpoints
canonicalize with the same /search- and trailing-slash-collapsing rule; the
mirror derives slug ids with NNA's algorithm (including the -2…9999 suffix
walk), re-enables on add, fronts the promoted profile, disables when the
last profile leaves, and refuses the enable-with-no-profile composition with
the domain's code before any transport; the settings page stages profile
drafts (names and endpoints are public transport data, not credentials),
previews the exact list NNA will save, and holds the doubled transport
bounds. The census web-search settings rows (8) carry the native endpoints,
the paired permissions, and the settings-page path, and the C1 gate
re-verified the census against the paired NNA tree. Focused client tests
16/16, full UI 229/229 files (1,805 tests) and web 132/132 files
(1,447 tests), typecheck clean. The family rows' installed journey
(application class) stays
unverified until a real search exercises a saved change on an
installed instance; the remaining C6 external-store families stay open.

## NND 20261005-4 — prebuilt cancellation and reinstall acceptance green

The fixture journey now spans the full lifecycle: fresh install, upgrade,
rollback, guarded uninstall, mid-copy cancellation, transaction recovery,
and reinstall against the retained data root. `Real exported prebuilt
payload, upgrade, rollback, cancellation, reinstall, Chromium shells and
uninstall passed (20261005-3 -> 20261005-4 -> 20261005-3)`. Cancellation
kills the whole staging process tree of a never-seen payload while real
copying is in flight, discovers the open transaction under
`install-slots/transactions/`, and runs `-RecoverPrebuiltStageOperation`,
which resolved to `unpublished` with the installation unchanged; the same
payload then re-staged and activated cleanly, and nothing registered during
the cancelled window. Reinstall re-staged and re-activated the original
payload against the surviving data root after uninstall, preserving the
installation identity and operator data. Two genuine product bugs surfaced
on this leg and are fixed with regression tests in NNA (`65c55858`,
`55c5389f`): rotation of a consumed receipt pair after a guarded uninstall
must accept the missing-registration snapshot (the pair names a registration
that no longer exists and grants authority to nothing), instead of demanding
a live-revision match that can never succeed; the missing-state shape
`{state:'missing'}` from `readLockedManifestSnapshot` is what the guard
keys on, and the regression test now uses that real snapshot shape. The
harness preserves the whole fixture on any failure so the evidence survives.
L5 remaining: migration evidence for a data root carried across a version
line.

## NND 20261005-3 — prebuilt rollback acceptance green

The fixture journey extended past upgrade into rollback: after the upgrade to
the next payload version, the retained prior payload re-staged and
re-activated onto the same stable anchor, and guarded uninstall then removed
that anchor. `Real exported prebuilt payload, upgrade, rollback, activation,
Chromium shells and uninstall passed (20261005-2 -> 20261005-3 ->
20261005-2)`. Evidence asserted in-harness: the upgrade's consumed receipt
pair rotates to the archive so the rollback activation can commit its own
terminal evidence (two archived pairs by journey end), the anchor rebinds
back to the prior slot, registration and live service return to the earlier
version, both Chromium shells re-attach on the rolled-back service, operator
data still survives, and uninstall deactivates cleanly. Rollback is an
explicit re-activation of a retained immutable slot — no destructive state
rewrite exists on any path. L5 remaining: cancellation and
migration/reinstall evidence.

## NND 20261005-2 — prebuilt upgrade acceptance green

The disposable fixture journey extended past fresh install into a real upgrade:
a second exported payload at the next version was staged and activated after a
clean stop, and guarded uninstall then removed the rebound anchor.
`Real exported prebuilt payload, upgrade, activation, Chromium shells and
uninstall passed (20261004-15 -> 20261004-16)`. Evidence asserted in-harness:
exactly one consumed receipt pair archived under `install-slots/consumed/`
(NNA ADR 0069 rotation, `e4f2874a`), the upgrade writes its own terminal
commit, the stable launcher anchor rebinds only for a marked anchor bound to
the same installation identity, registration switches to the new immutable
slot, both Chromium shells re-attach, and operator data survives. The
anchor-passing harness exposed a latent uninstall bug: the registration-status
check compared against a non-existent capabilities field; the uninstall
resolver now returns the binding's `{root, version}` and the comparison uses
that (unit suite green). Failed journeys keep evidence instead of masking the
real error with a locked-fixture EBUSY. Rollback, cancellation, and
migration/reinstall evidence remain open for L5.

## NND 20261004-15 — prebuilt installed acceptance green

The disposable fixture ran the real exported prebuilt payload (20261004-8) through stage,
native activation, both Chromium shells, stop and guard-protected uninstall end to end:
`Real exported prebuilt payload, activation, Chromium shells and uninstall passed`.
Evidence: `scripts/installed-prebuilt-acceptance.mjs` (fresh harness; preserves fixtures on
uncertainty), ready frame carries `candidate_sha256` bound to the preflight candidate, and
post-activation validation now reads the surviving retirement commit + cleared witness and the
active registration instead of the cleaned candidate file. NNA side (20261004-7): native
principal selection latch, one-use promoted attach bound to the record step, discovery pointer
retired once, and ADR 0069 consumed-receipt admission (canonical commit+cleared pair bound to
this identity no longer bars guards; halves, alterations and foreign identities stay barred).
Focused activation/supervisor/evidence suites and NNA quality gates passed; census-style tests
flake only under full-suite parallel load with orphan fixture processes present (verified
identically flaky at clean HEAD, green in isolation). Known pre-existing open items unchanged:
UI suite jsdom `localStorage` failures and 7 web-suite failures reproduce at clean HEAD and are
unrelated to this slice.

## NND 20261004-7 — prebuilt uninstall release seal

The independent post-repair audit confirmed the uninstall runtime behavior and found the working
tree's provisional release hashes stale and the evidence helper omitted. The slice advanced one
bounded release version and regenerated the complete hash manifest from the final tree. Full UI
and web suites, typechecks, quality/graph/language gates, and the rerun release gate passed. The
audit's bounded NNA-status duration, trailing-ancestry normalization, and executable-path aliases
remain accepted follow-up observations.

## Recovery of the interrupted handoff

The handoff contained only this ledger, the contract draft and three untracked NNA
contract/test files. No implementation commit had landed after the pinned baseline.
The draft reversed NNA/NND process ownership, partitioned singleton ownership by
package root, omitted readiness facets and schema fields, and proposed a circular
release digest. These were repaired before L2 consumes the contract.

## L1 contract sub-slice evidence

Versions: NND 20261001-43; NNA 20261001-7. Contract validators and optional package
artifact admission are implemented. Legacy registration remains supported; explicit
service admission checks host capabilities. NND checks declared schema before startup
environment mutation. Paired source agreement and failure cases pass. Adversarial
review repaired a digest that could otherwise cover a helper instead of the server.

L1 remains in-progress: installed descriptor/independent TUI acceptance is outstanding.
L2 is not implemented; no new service capability is advertised. Full build completion
requires every remaining L/C/F/V row. NNA native-platform release certification is
separate from the source suite and has not been refreshed for this source slice.

## L1/L2 installation identity and singleton sub-slice

NNA 20261001-8 / NND 20261001-44. Source helpers now validate an explicitly selected
installed descriptor, contained native CLI/payload metadata and actual recorded
Node runtime. Canonical path identities preserve the same data identity across
installation moves; no PATH fallback or installed-file mutation occurs.

The Windows kernel named-pipe lock excludes concurrent and separate-process writers
for the same canonical data root, including junction/case aliases. Normal close is
idempotent and loss is observable. It contains no credentials or command protocol.
Service wiring, private Windows discovery storage and shared external-catalog locks
remain open. NND's paired endpoint contract also accepts explicit port 80 without
relaxing literal-loopback or valid-port checks.

Independent adversarial review found no further confirmed defects. Focused Windows
identity/lock/contract cases pass. Final full-suite and release evidence is recorded
in the paired commits. L1 still needs installed TUI independence acceptance; L2 remains
in-progress and service capabilities remain unadvertised. No installed operator
profile, startup entry, TUI state or running NNA was changed.

## L2 private directory and C1 working census

NNA 20261001-9 (`3c0ec7bf`) implements local-fixed-drive Windows private runtime
protection. It checks native ACLs, ancestors, null DACLs, foreign inheritance and
reparse points, then creates missing directories with protected ACLs. Existing ACLs
and evidence remain untouched. No credential files or lifecycle commands are wired.
Eight native ACL cases passed; full NNA suite passed 1,681 with five platform skips.
Mapped network drive rejection is code-reviewed; no live share was used for testing.

[Settings coverage working census](settings-coverage.json) contains 357 unique source
rows in 38 families, including four route roles and 17 TUI bindings. All rows remain
open, unknown values are explicit, and remaining census families are listed. This is
not a count of editable settings: containers/actions/internal/authority rows differ.
C1 remains in-progress pending complete enumeration, defaults/bounds/apply/permission
mapping and a new-key coverage gate. Existing native/GUI mismatches remain open.

## L2 protected controller discovery

NNA 20261001-10 / NND 20261001-46 implement protected controller discovery helpers.
An internally generated controller credential stays in a protected immutable
generation file; the current pointer contains no credential. Publication and
removal require a genuine held data-root lease and exact expected generation,
serialized by an exclusive file handle. Readers verify each file's ACL and
bounded structure. A discovery record is not proof of a live service.

Independent review found early lease release during helper cancellation and
retention growth across normal generation replacement. Repairs preserve ownership
until filesystem work has stopped and retire only the validated predecessor after
committed publication. Failed retirement does not misreport publication rollback.
Malformed and unpublished orphan evidence is preserved with a capacity limit.

The paired pure contract exposes its existing endpoint validator for reuse.
No lifecycle CLI, controller listener, installed service or GUI migration is
claimed. L2 remains in-progress. Setup-first hosting and native UI authentication
are the next integration boundaries; source helpers alone do not close them.

## L2 setup-first hosting and L3 native UI authentication

NNA 20261002-1 / NND 20261002-1. Local native integration now listens before
session restoration. Authenticated health/setup status stays reachable while
starting or unconfigured. Setup status and explicit activation require separate
native permissions. Missing/corrupt configuration is preserved; activation uses
a bounded UTF-8 manifest with an explicit absolute workspace. No initial save or
configuration repair concurrency is claimed. Provider connectivity remains unknown.

Independent review repaired failed-cleanup retries, slow restoration hiding the
setup listener, and held SSE responses blocking shutdown. Timed-out work remains
owned; late candidates are cleaned up and uncertain cleanup blocks retry. NNO
keeps its existing activation/secret realm. Setup does not admit execution, raw
secret use or provider probes until the native host is ready.

NND has a privileged `startServer({ nativeAuth })` seam for supervised startup.
It requires UI authentication even without a password. UI-only access tickets
are short-lived, bounded, one-use and redeemable only by the matching origin and
actual loopback peer. HTTP only redeems tickets; issuance is on the private server
handle. Session signing is memory-only per generation. Password/passkey behavior
is preserved with separate persistent passkey binding. Legacy device credentials
and pairing are explicitly unavailable in native mode pending native device scope.

Browser entry renders the advertised access-code form, posts the code in a body,
checks cookie admission and cancels on host change. Successful native redemption
clears stale injected bearer credentials. Revocation closes the service transports;
WebSocket admission uses the actual Host and dev-tunnel disposal cancels pending
and existing sockets. Audit and focused tests passed; full checks run before commit.

These seams do not yet switch the installed launcher, renew engine principals or
start a supervised GUI child. L2/L3 remain in-progress; L4-L6/C/F/V remain open.

## L2 composed supervisor and L3 private child attachment

NNA 20261002-2 / NND 20261002-2. Explicit native service commands now compose the
selected installation, data-root lease, setup-first runtime, protected discovery,
controller and registered NND child. The dedicated native listener derives fixed
operator permissions and configured workspace grants per request. Child authority
headers are ignored; no principal refresh or permission minting occurs in NND.

NND's explicit `--supervised` installed path validates package/version/platform,
bounded metadata and actual bundle hash before importing the server. Private
bootstrap/control frames carry the native token in memory; renderer/environment/
argv do not receive it. Ready frames bind generation and package identity. EOF,
malformed frames or parent loss revoke attachment and close transports. UI-only
codes issue over the private child channel through authenticated native control.
Source installer metadata generation now hashes the built artifact.

The disposable installed-payload smoke passes with copied native CLI and the genuine
built NND bundle: setup-required service, locked browser, one-use UI code, guarded
session execution, generation-bound status and graceful controller stop. No operator
installation changed. Native/desktop release certification remains separate.

Adversarial repairs include false process-exit proof after child errors, duplicate
readiness frames, selected-root credential loading, and pending provider mutations
after socket closure. Stop admission and dispatch drain precede lease release.
Smoke preserves its fixture when descendant termination cannot be established.

Fresh-data admission explicitly refuses existing manifest/session/tab data before
opening its catalog. Current legacy serve uses the same lease; older installed
hosts and data need verified migration. No broad TUI lock was introduced: its
catalog is separate. Desktop attachment, login startup, restart policy, generic
setup save and C/F/V product acceptance remain open. L2/L3 remain in-progress.

## L3 atomic admission, L4 desktop client and L5 mutation guards

NNA/NND 20261002-3. Native capabilities and atomic attach return selected identity,
generation, GUI endpoint and UI-only ticket; status validates the full paired schema.
Electron verifies the actual recorded Node and payload versions before native CLI
execution. Its private memory Chromium session redeems the ticket and backs all
native windows. Closing Electron preserves the NNA service. Reconnect replaces
generation sessions; there is no silent managed/local or remote fallback.

Actual Chromium acceptance passed in a disposable installed-payload fixture:
cookie authenticated, renderer bearer/authority headers empty, independent browser
still locked, and native service generation unchanged after shell quit. Audits fixed
menu Quit cancellation, selected runtime admission and credential environment loss.

Installer/uninstaller mutation now holds the same native lease. A protected marker
blocks startup after interrupted guard death. Explicit release plus EOF follows only
verified successful package changes; failed mutations abandon and retain evidence.
Removal validates roots, excludes reparse ancestors and unlinks internal junctions
before recursive removal. Disposable Windows PowerShell guard/removal probes passed.
No actual operator installation, removal or startup registration was performed.

L4 is in-progress; L5 is in-progress. Existing-data/grant migration and interrupted
installation recovery remain open, as do login startup, native device attachment,
complete settings and feature acceptance. Native full validation uses an isolated
checkout to preserve concurrent OpenCode protocol development.

## Slice 20261002-5 — configured admission, credential management and source identity

Native configured-NNA adoption now preserves unrelated manifest/TUI/journal data.
It requires the actual held data-root lease, checks bounded Windows legacy owners
on every startup, and syncs a protected selected-identity admission receipt.
Prior valid supervised receipts remain supported. Legacy NND catalogs and orphan
child/activity sidecars still require explicit migration; no grants are rewritten.
Unsupported pre-lease executable autostarts must be disabled: current process
census cannot guarantee that a different older executable never starts later.

The native GUI principal gains exact secret metadata/manage/audit operations with
broker scope checks. It has no secret-use, deployment-scope or wildcard grant.
Actual HTTP tests cover setup-required and ready states, rotation, foreign-scope
rejection, caller header forgery and plaintext retrieval denial.

The source seal includes root installers and Electron code/assets. Generated
build stamps and installed mode flags are excluded. Three release-content tests
include source digest changes, stable generated output and Windows junction refusal.
Independent adversarial audits applied portability and generated-file repairs.
Full UI: 1,630 passed. Native full suite: 1,742 passed, six skipped. Native quality,
actual composed/Chromium smokes, regenerated graphs and final release gates passed.
The real Chromium probe found transient discovery polling could abort shutdown.
Bounded retries now apply only to Windows sharing/lock contention. Fourteen
discovery tests and actual Chromium shutdown passed, with independent audit.
Native validation includes committed OpenCode version 20261002-4; this slice
advances native to 20261002-5. The prior uncommitted NND candidate seal remains
immutable; the corrected current evidence advances NND to 20261002-5.
Remaining lifecycle gaps: explicit legacy migration, login startup, transactional
upgrade/rollback and interrupted installation recovery. Setup repair and complete
native settings GUI remain open.

## NND 20261002-6 — native setup presentation

The providers page reads authenticated native setup status and offers explicit
refresh and activation. It separates saved configuration and execution readiness
from unchecked provider connectivity. Missing or invalid configuration still needs
independent NNA setup: this panel does not create, repair or replace the manifest.
Activation does not alter permissions or existing sessions. No automatic activation
or provider inference is introduced.

The client bounds responses, validates native state, preserves setup status returned
with activation HTTP 503, and hides raw errors. Runtime changes, authentication
transitions and unmount cancel pending requests and discard late results. Activation
is disabled while pending or after native cleanup/timeout failures requiring restart.
Independent audit found no confirmed production defect. Added regressions cover auth
expiry during activation, late completion, read-only reauthentication and both native
restart-required failures. Existing provider assertions now isolate the unrelated
setup transport. Full UI: 1,639 passed across 204 files; type and quality gates
passed for 737 production modules. Packaging and release checks passed before
commit `598cff1`.
C3 remains in-progress; generic configuration save, repair and complete settings
coverage remain open. This slice consumes native APIs already committed in NNA
`31fd90b1`; concurrent OpenCode protocol changes are a separate subsystem.

## Native 20261002-9 — explicit legacy catalog migration

Native commit `a92d4375` implements explicit `migrate` and `migration-recover`
commands under selected data-root ownership. It preserves exact backups, journals,
activity and review modes, and rewrites only recognized legacy workspace grants
after workspace/provenance validation. Pending evidence blocks service, legacy serve
and installer admission. Strict session locks preserve live or uncertain TUI owners.
Recovery restores incomplete transactions or verifies completed evidence before
clearing the marker; unexpected changes remain blocked.

Adversarial repairs covered historical renamed Node processes, dotted session IDs,
changed completed-recovery provenance, malformed activity and the combined 64 MiB
bound. An actual forced-death test verifies stale-lock recovery and exact-byte
rollback. Full native validation passed 1,769 tests with seven skips on the prior
committed OpenCode baseline. After integrating the latest independent OpenCode
commit, 42 focused migration/lock/registry/protocol tests passed with two skips;
native type/quality and graph checks passed for 433 modules. Unsealed migration
candidates were superseded to preserve the shared native version sequence.

Original NNA now contains both agents' committed work. No operator migration ran.
Login startup, transactional installation and installer recovery remain open.

## NND 20261002-7 — prebuilt payload foundation

The [payload contract](nnd-prebuilt-payload.md) defines bounded plain-file export,
deterministic artifact identity and prospective immutable slots. Production installer
delegation, native slot activation/CAS/rollback and startup remain open; this exporter
does not enable distribution. Audits repaired output junction containment and missing
Electron runtime resource admission. Twelve focused tests and all 1,639 UI tests
passed. The actual 178-file exported payload launched its copied Electron runtime
against native `20261002-9`: Chromium cookie admission, credential isolation,
independent-browser refusal, shell-independent service lifetime, exact service stop
and lease reacquisition passed. Payload bytes remained unchanged. Packaging passed;
release checks passed before commit `6aaca21`.

## Native 20261002-11 — raw-source manifest transactions

Native merge commit `b20b5bdb` preserves the independent OpenCode credential-presence
commit and the reviewed configuration transaction slice. First-party onboarding,
bootstrap, provider and TUI writers share canonical manifest ownership and exact-byte
revision checks. Prepared receipts reconcile interrupted publication before the next
writer; unknown changes preserve evidence. Terminal replay retention is bounded to
the latest 128 operations. Saved state and live runtime application remain distinct.

TUI edits patch the selected raw source without persisting defaults, higher overlays
or temporary launch settings. Resets resolve lower layers, repeated user/explicit
selection of one file remains coherent, and stale or provenance-free existing-file
writes fail. Private staging protects operator backups from linked destinations.
Bootstrap retains a secret if publication might already reference it. Bounded reads
cover startup and bootstrap files. Uncertain secret creation can leave an orphan;
automatic orphan collection is not implemented.

Independent audits and actual process-death/concurrent-writer tests passed. The exact
combined Windows build passed 1,802 tests with eight skips and zero failures, with
quality/current graph/language checks for 440 modules. POSIX permission behavior is
reviewed but unexecuted here. Native release certification remains separate.

C2 remains in-progress: the generic scoped native settings catalog/read/save/repair
HTTP API, browser revisions/operation IDs and pending-application visibility remain
open. This foundation does not close complete GUI settings coverage.

## Native 20261002-12 — classified settings catalog

Native commit `90192e97` shares executable structural keys and 44 scalar rules
with the existing validators. Its frozen catalog describes 223 fields, explicit
defaults, source stages, authority classification, validation owner and application
evidence. Catalog editability stays unavailable until a scoped native API exists.
Independent scalar comparison preserved 1,036 old/new resolution outcomes. The
exact Windows build passed 1,822 tests with eight skips and zero failures; quality,
graph and language checks passed for 444 production modules. C1 remains in-progress
because nonmanifest settings and installed GUI coverage are still required.

## Native 20261002-13 / NND 20261002-8 — immutable slot staging

Native commit `5acd3de3` adds payload validation and immutable slots in a protected fixed store.
Stage/recover commands hold the data-root lease and shared registration mutex;
preparation, copying and recovery preserve the prior active package pointer.
An atomic SQLite initializer intent closes the crash-before-prepared window;
incomplete owned metadata is recovered without exhausting transaction capacity.
Separate immutable provenance supports a fresh operation ID for an already
verified slot. The last 16 terminal receipts are retained with durable retirement;
16 distinct artifacts and 8 GiB aggregate are the current limits. Windows runtime
path admission rejects unsupported destinations before transaction preparation.

Adversarial review repaired altered-file recovery, repeated slot reuse, receipt
retention, missing Electron imports, legacy guard admission, stale package
validation under the mutex, malformed registry versions, unbounded metadata
reads and crash-before-prepared orphan capacity. The installer-focused native set
passed 87 tests, including eight initializer child deaths. The full Windows build
passed 1,882 tests with eight skips and zero failures; graph, language and quality
gates passed for 457 production modules. A real 178-file NND `20261002-8`
export was staged, recovered, reused, separately registered and launched through
Chromium from the immutable slot. Its manifest hash is
`26fa67698d145666943aff7804361af3a09c16b200fed4a312b7fed3201fdd80`.
The copied shell authenticated with a cookie, withheld renderer bearer material,
refused a second browser and left the supervised service alive after shell exit.
The real Chromium probe passed again after the initializer repair. NND version
eight commit `9f6ac7c` passed exporter tests, quality, smoke, production web build,
CSS and sealed release gates. Production
trial activation, CAS selection, rollback, stable launchers,
login startup and installer delegation remain open.

## Native 20261002-14 — scoped configuration control

Native commit `2f459b24` exposes authenticated catalog, source read, preview,
save, explicit repair and operation receipts in setup-required as well as ready
states. The selected user manifest is the only writable scope in this slice;
trusted project overlays remain read-only and revisioned. Bounded typed intents
exclude grants, credentials and collection mutations. Raw unknown fields remain
private and are preserved across saves. A saved receipt says `not_applied`, not
that running sessions changed. Browser-facing error messages omit source keys and
filesystem paths. The HTTP catalog advertises only the finite supported field
set and its required native manage permission.

Independent audits repaired repair/read workspace consistency, effective-default
projection, and error-response leakage. The focused source/service/HTTP/taxonomy
set passed 40 tests. The exact Windows full build passed 1,915 tests with eight
skips and zero failures; graph, language and quality checks passed for 462
production modules. C2 remains in-progress for nonmanifest families, provider
and MCP collections, and complete installed GUI controls.

## NND 20261002-9 — native configuration read surface

The settings window gains a read-only native configuration page using the same
authenticated runtime transport as browser and Electron. It distinguishes
missing/invalid source state, explicit and effective values, source provenance,
redaction, selected identity and saved-versus-applied state. Runtime/auth changes
abort and clear stale results. The parser bounds a 2 MiB response and rejects
contradictory value flags; an older native 404 is distinct from a missing source.
The setup panel links to the page. Independent audit repaired the contradictory
flag case and confirmed the authenticated proxy path. Focused UI tests passed
43 cases, the adapter tests passed 10, and UI typechecking passed. The full UI
suite passed 1,650 tests across 206 files. Quality, graph and language checks
passed for 745 production modules; the production web/Electron artifacts built.

An actual 178-file prebuilt export, SHA-256
`8c67f1ad1bad42ace25a39759e73d87bc7156728350d756c6202573fb41f5a9d`,
was staged through native `20261002-14` and launched in Chromium. Its authenticated
web proxy returned the native missing-source configuration projection while the
projected installation and data identities matched the started native service.
The renderer held no bearer token; a second browser remained locked and the native
service survived shell exit. This proves the read transport and attachment, not
an installed operator settings workflow. Native edits, repair UI, conflicts and
complete settings coverage remain C3–C7 work.

## NND 20261002-10 — bounded native configuration edits

The native configuration page can edit one finite user-manifest field at a time.
It reads NNA's authenticated catalog, validates a typed operation, previews under
the observed source and resolution revisions, and sends that exact operation to
native save with a stable operation ID. Native validation and permission checks
remain authoritative. The page displays saved versus applied state and offers
receipt lookup when persistence is uncertain. Pending IDs and CAS bases are kept
only for the same runtime, installation and data identity in bounded tab-session
storage; a runtime switch cannot show another installation's pending write.

A missing or invalid selected source has a separate explicit repair path. The
user supplies and confirms a replacement document; the UI does not derive it
from the redacted read projection. Native repair checks the selected revision
and retains the invalid original privately. The GUI neither edits provider/MCP
collections and credentials nor changes running sessions automatically.

Independent adversarial review repaired duplicate submission replacing the
operation ID, late cross-runtime response updates, malformed receipt acceptance
and loss of an uncertain operation ID during a runtime switch. The supervised
native service exposes this control plane; the legacy `nna nnd serve` path does
not. The production launcher must select the supervised service. Complete native
settings coverage, installed mutation acceptance and the production installer
remain open.

Focused client and UI mutation cases passed 17/17. The complete UI suite passed
1,662 tests across 208 files; UI typechecking, graph, controlled-language and
quality checks passed for 750 production modules. This is source-level GUI
mutation validation, not installed save/repair acceptance.

## NNA 20261002-15 — native activation preparation foundation

Native commit `013e8480` prepares verified immutable slots under a held data-root
lease and registration mutex. It records exact prior package bytes, candidate
evidence, a chained journal phase and a durable admission barrier without
starting the child or changing selection. Ordinary startup fails closed on
initializer, marker or surviving activation evidence. Independent review
repaired linked initializer ancestry and a lost-marker admission gap. The full
Windows suite passed 1,948 tests with eight skips and zero failures. Trial
startup, selection, rollback and terminal evidence retirement remain open.

## NND 20261002-11 — installed native configuration mutation probe

An opt-in disposable Chromium slot probe opens the actual NND settings page
against native NNA. It explicitly repairs a missing selected user manifest,
previews and saves a finite field through the authenticated NND proxy, matches
the GUI operation ID to its native receipt, reads back selected-source bytes and
revisions, and rejects stale CAS and an unauthenticated save. The probe checks
the selected private workspace/provider identity and retains browser credential
isolation and service lifetime after Electron exits. It does not install into
the operator's NNA or validate a production installer.

Independent adversarial review tightened receipt/identity/auth evidence and
ensured Electron launch failure cannot skip native service shutdown. Provider
and MCP collections, all settings coverage, and installer activation remain
open despite this installed browser write proof.

The focused exporter/parser set passed 12/12; the full UI suite passed 1,662
tests across 208 files. Graph, language and quality checks passed for 751
production modules. The exact 178-file version11 prebuilt payload has SHA-256
`ae0e621ce81156418e77bf6ec3fb250edb0dbfda264b2da1577b1de50f4aa136`;
its real Chromium write probe passed against committed native `20261002-15`.
Network-loss/unknown-outcome injection and an operator-installed save remain
separate acceptance cases.

## NNA 20261002-16 and 20261002-17 — unpublished trial prerequisites

Native `20261002-16` starts an unpublished immutable-slot trial under the
prepared lease and mutex, checks exact NNA/GUI health and identity, and then
confirms shutdown. It leaves the pending activation barrier; no registration,
discovery pointer or browser ticket is published. Its full serial Windows suite
passed 1,958 tests with eight skips and zero failures on the final run.

Native `20261002-17` uses the manifest writer's exact pretty JSON plus newline
bytes for candidate evidence and creates a private trial discovery generation
matching the live child. Independent adversarial review repaired private-record
retention after stop, a stop/preparation race and a lost controller-close retry.
Its full serial Windows suite passed 1,965 tests with eight skips and zero
failures. Crash-orphan cleanup, exact registration and pointer CAS, principal
transition, live transfer, rollback and terminal recovery are still open.

## NND 20261002-12 — native TUI preferences surface

The settings window has a dedicated NNA TUI preferences page for native color,
reduced motion and key bindings. It shows selected installation/data/source
identity and revisions, then uses native preview, compare-and-swap save and
operation lookup with a stable operation ID. A saved setting is shown as not
applied to running TUI sessions until native evidence says otherwise. This page
does not take over TUI tabs or change NND keyboard shortcuts.

An independent audit corrected a key-binding test value that NNA rejects and
made the target identity visible during editing. Focused tests and UI typecheck
passed. A disposable source-payload Electron/Chromium run saved
`tui.key_bindings.submit=ctrl+x`, matched the native receipt and manifest
revision, and rejected stale CAS and unauthenticated browser save. The full UI
suite passed 1,665 tests across 209 files; graph, language and quality gates
passed for 753 production modules. Prebuilt-slot and operator installation
acceptance, non-manifest TUI controls and remaining settings coverage are open.

## NND 20261002-13 — selected NNA installer preflight

The source installer now asks the selected installed NNA for bounded native NND
capabilities before its NND copy, build or registration. It checks the protocol,
version, installation/data identity and required service/guard commands, then
requires the installation guard to report the same identity. Missing or older
NNA receives update guidance; the explicit local-source dependency bootstrap
remains a development route, not a verified release download.

Independent review found that later installer steps could re-read a changed NNA
selection file after preflight and guard, potentially activating a different
installation. Registration and manifest validation now use the pinned NNA
selection. Disposable tests cover two roots, path spaces, missing/malformed or
oversized capability output, a hanging child and a changed selection. A read-only
probe of this machine's currently installed NNA found its required
`installed/VERSION` missing, so that installation cannot serve as positive
acceptance evidence. It was not modified. Production prebuilt consumption,
verified NNA dependency acquisition, native promotion and rollback remain open.

## NNA 20261002-18 and 20261002-28 — registration evidence

Native `20261002-18` added an internal held-live registration compare-and-swap.
It verifies the prepared trial and child PID/start identity, records exact
selected bytes and a `registration_cas` journal phase, then stops the trial
while retaining the protocol-three admission barrier. Independent review
repaired a continuation race that could otherwise hide a failed or still-running
CAS. The full serial Windows suite passed 1,973 tests with eight skips.

Native `20261002-28` adds held-owner observation of that registration outcome.
It compares exact prior, desired and current bytes with the durable manifest
receipt, marker, journal and child identity, returning only `not_selected`,
`selected_unresolved` or `unknown`. Any visible discovery pointer or uncertain
writer identity is `unknown`. This does not restore bytes, clear the barrier or
make NND available. Exact-byte rollback, crash-safe writer containment and live
publication/handoff remain open.

## NND 20261002-14 — reviewer and vision scalar tuning

The native settings window has a reviewer/vision route tuning page for scalar
fields that NNA's catalog actually marks editable. It uses the existing native
preview, source/revision compare-and-swap save and operation receipt flow.
Provider/model binding appears as read-only because NNA has no matching
reviewer/vision route write contract; saved tuning is shown as not yet applied
to the running service. An independent audit found no production defect and
added a late-response runtime-switch regression.

A disposable source-payload Electron/Chromium run saved
`routes.reviewer.temperature=0.35`, matched native receipt and selected-source
readback, and rejected stale CAS. This is a real browser path, not a prebuilt
slot or production installer acceptance. Full C4 route and provider management
remains open.

## NNA 20261002-29 — exact raw manifest transaction prerequisite

Native persistence now supports a receipt-backed, held-mutex compare-and-swap
of exact bounded bytes or true absence. An independent audit found no confirmed
defect and verified compatibility with the held-owner registration reconciler.
The full serial Windows suite passed 2,035 tests with eight skips and zero
failures. This primitive does not by itself prove writer shutdown, roll back a
selected NND package, publish discovery or clear the admission barrier.

## NND 20261002-15 — single native workspace admission guard

The shared GUI create path checks NNA's authoritative `/path` before opening a
session and verifies the created session's returned directory before selecting
it. The authenticated NND server admission route checks filesystem ancestry
and rejects an alternate repository or linked/ambiguous root. Independent
review found that direct API and background creation bypassed the first UI-only
check; the shared server harness adapter now applies the same admission to
session create/fork calls and preserves a race-created session for recovery.
The release smoke was corrected to initialize its explicit mock mode before
loading the server modules; native-mode admission is not bypassed.

Disposable two-repository and junction tests, direct server/API tests, UI race
tests and typechecks pass. NNA still has only a single native workspace root;
this is a partial F1 safety guard, not multi-project/worktree admission. Its
`/path` response lacks an immutable installation/data identity, so a same-path
runtime switch cannot yet be proven at this boundary. F2 durable state and
complete installed acceptance remain open.

## NNA 20261002-30 — owned confirmed-stop continuation

An unpublished native trial can run a private post-stop continuation after its
child shutdown is confirmed while the same service lease and registry mutex
remain held. A one-use proof binds the operation, generation, exact persisted
child process identity, ownership objects and live signal. The continuation can
observe an earlier failed registration step without reporting success; an
uncertain stop never invokes it. Independent review registered the new shutdown
error code and found no further concrete defect. This is a prerequisite for
rollback, not a rollback or publication. The pending admission barrier stays.

## NND 20261002-16 — reconnect session catalog reconciliation

After a non-skipped stream reconnect, the GUI now reads complete authoritative
root and child session catalogs for each active directory, then refreshes the
inclusive sidebar catalog. Failed or malformed reads preserve the prior
snapshot; a foreign-directory row cannot be merged into another workspace.
Newer live events and overlapping bootstraps retain precedence, and an
offline-deleted selected session is cleared only after a successful inclusive
read confirms its absence. Archived selections remain valid.

Independent review found and repaired silent native truncation at 500 sessions
and the stale selected-session loading state. Focused reconnect and related
tests, UI typecheck and diff checks passed. Initial bootstrap still uses its
500-entry cap, and the native API does not provide a snapshot revision across
the separate catalog reads. Durable event history, explicit gap signaling,
redaction/tombstones and installed browser acceptance remain open F2 work.

## NNA 20261002-31 and NND 20261002-17 — explicit replay gaps

NNA's bounded in-memory event ring now labels its cursor-free connection opener
`fresh`, `complete`, or `gap`. A retained cursor certifies a complete suffix
only under the current principal and full workspace grant; an evicted,
unknown, foreign-scope or pre-restart cursor reports `gap` without a partial
replay. Independent native review found no concrete defect in the additive
contract.

NND waits for that opener before establishing SSE, clears an invalid cursor
and queued events on a gap, and awaits authoritative recovery before delivering
later frames. Malformed frames and connection receipts do not advance the
cursor. The GUI retains its inclusive catalog refresh even for a `complete`
replay. Independent review repaired an undersized frame bound, a skipped
catalog refresh, and late WebSocket/runtime-abort recovery races. Focused
producer/consumer tests and GUI typecheck passed. The in-memory ring still
cannot recover every missed transient activity item; durable history and
installed browser/desktop gap acceptance remain open F2 work.

## NND 20261002-18 — visible gap evidence and Chromium recovery acceptance

When NNA explicitly reports an SSE replay gap, the Activity rail records a
per-runtime warning that transient observations may be missing even after
authoritative state recovers. It survives a reload for that endpoint and does
not invent events or alter drafts, queues, or native permissions. Independent
review prevented legacy/malformed recovery from being mislabeled a native
gap and kept the warning visible if local storage rejects a write. A future
native installation/data identity is needed to distinguish replacement of
NNA at the same endpoint from historical gap evidence.

An opt-in disposable Electron/Chromium scenario now blocks the UI's native
event streams, creates an idle session while disconnected, forces an expired
SSE cursor, and proves the native gap opener, renderer Activity warning,
cursor reset, and recovered sidebar session. Independent review added the
renderer warning and next-request cursor checks because sidebar recovery
alone could pass through an unrelated catalog refresh. The rebuilt source
bundle passed the complete private-fixture scenario twice against NNA v31
source; no operator installation was changed. Durable transient history,
redaction/tombstones, prebuilt installer and installed binary acceptance
remain open.

## NNA 20261003-1 through 20261003-5 — activation and primary-root prerequisites

NNA can restore exact prior registration bytes after a confirmed unpublished
trial stop while retaining the admission barrier. A read-only crash observer
classifies restored, unpublished, and unknown rollback evidence under genuine
held leases; unknown evidence never authorizes admission. A dormant native
workspace-grant catalog records verified primary/secondary roots and file
identity, but explicitly keeps secondary selection disabled. Native sessions
now bind to the configured primary root, reject workspace transitions and
replayed changes, and recheck the root before prompt admission. The managed
`/path` response supplies NNA's authoritative `workspace_id` for NND. A
private, unwired continuation can publish a selected discovery generation
under exact child, marker, journal, registration, and lease evidence; it does
not switch principal authority, transfer the live owner, or retire the barrier.
Each prerequisite passed its NNA serial suite and independent adversarial
review. Public activation, tool-time root checks, secondary execution scope,
and fresh installed acceptance remain open.

## NND 20261003-1 — native primary workspace identity at managed attach

The managed NND harness reads NNA's authenticated primary workspace identity
from the native grant catalog, or from NNA's `/path.workspace_id` only when the
managed listener does not expose that catalog. Session creation fails closed
while the identity is unavailable; NND no longer grants itself the synthetic
`local` workspace. It checks the native project ID returned by creation and
preserves a race-created session for recovery. Native admission compares
Windows path aliases without discarding NNA's own path spelling. Independent
review repaired mixed-case aliases and valid long catalog responses. Focused
tests, typecheck, and a disposable NND↔NNA source smoke prove the authoritative
ID and rejection of a second-directory create without creating a session.
This remains primary-only admission; secondary project/worktree selection and
installed supervisor activation are still open F1/L work.

## NNA 20261003-8 through 20261003-20 — native safety and attach prerequisites

NNA now rechecks the primary workspace at tool execution, exposes bounded
owner-scoped durable Activity pages, and pairs a durable snapshot with the
live event stream so the GUI can distinguish a complete handoff from a gap.
Deletion tombstones and authenticated HTTP pages make removed sessions and
retention gaps explicit. The native MCP configuration contract supports
scoped read, preview, save, and operation receipts with identity and revision
checks; credential-specific fields are excluded, while operator-supplied
commands, arguments, and paths still require care. The activation path has a
one-use private transition proof, closed-only native trial admission, and a
private dark controller challenge that proves point-in-time listener health.
These pieces do not yet make an operator principal effective or transfer the
held child into a completed NND installation. NNA v16 passed its complete
serial suite (2,139 passed, 8 skipped). V20 passed the complete serial suite
with 2,157 passed, 8 skipped, and no failures.

## NND 20261003-2 through 20261003-10 — managed GUI and installer safeguards

The GUI treats an SSE replay gap as an authority gate, recovering state before
send, create, rename, and other mutations resume. It exposes bounded saved
Activity separately from the live stream and probes the selected NNA service
through the private supervised health contract. Managed native mode no longer
offers the legacy OpenCode MCP editor or server API. Its replacement uses
NNA's typed MCP preview/save and operation receipts, including uncertain
result recovery. The installer and desktop launcher pin the selected NNA
installation and data identity, rejecting a different root even if a command
line supplies one. NND v6 passed 1,726 UI tests, 1,447 web tests, typechecks,
and both release-gate passes. V10's pinned and legacy installer-selection
regressions passed, as did both release-gate passes, a cross-product source
smoke, and a disposable prebuilt Chromium/native-slot attachment. Existing
root-only selection files need an installer rerun to acquire the new pin.
Browser and desktop operator-install acceptance, optional dependency
acquisition, public activation, full secondary workspace scope, and durable
completion remain open for the MVP.

## NND 20261003-11 — owner-scoped retained deletion receipts

The Activity rail can read NNA's bounded deletion receipts independently of
the selected session and live event stream. It shows the retention floor,
clears rows when the floor moves or the runtime/authentication scope changes,
and never labels the page a complete deletion history. Independent review
fixed retention-floor drift between pages and stale owner data after a same-
endpoint credential switch. The complete UI suite passed (1,732 tests), the
web suite passed (1,447 tests), and typecheck and quality gates passed.

## NND 20261003-12 — carried NNA dependency admission

When NNA is absent, the one-installer flow can accept a carried NNA release
directory plus an independently obtained SHA-256 of its release manifest. It
stages only listed regular files outside the NND target, verifies each file
and the manifest, executes the staged NNA installer, then rediscovers and
checks NNA before changing the NND target. The development source fallback
remains explicit. Independent review fixed a temp-directory overlap that
could otherwise write inside the NND target before rejection. Disposable
installer tests cover hash, tree, path, reparse, and target-overlap failures.
The supplied digest anchors the carried NNA files; NNA's separately selected
or downloaded Node runtime has its own trust path. Published immutable NNA
artifact discovery, download, and an authoritative checksum source are still
needed for fully automatic dependency acquisition.

## NND 20261003-13 — native attachment settings

The managed Settings page now exposes NNA's advertised attachment enablement,
maximum bytes, and retention controls. The typed inputs reuse NNA's native
catalog, preview, revision-checked save, and operation receipt path. A project
shadow or stale revision remains NNA-owned authority rather than a GUI guess.
Independent adversarial review found no concrete defect in the native mutation
path; the full UI suite (1,734 tests), web suite (1,447 tests), typecheck, and
quality gates passed after repairing a missing search anchor for unavailable
catalog data. Provider/model route bindings and external-store settings
still need dedicated native mutation contracts and GUI coverage.

## NND 20261003-14 — verified prebuilt payload staging entry

The installer can accept a carried prebuilt NND payload with an independently
obtained exact manifest SHA-256. It validates the payload and selected NNA
identity before any optional dependency setup or live-target mutation, then
asks the selected NNA runtime to stage an inert native slot. It verifies the
returned operation, payload digest, version, and `slot_ready` phase, and
preserves uncertain evidence for explicit recovery. Independent review fixed
preflight ordering and selected-identity verification defects. This is a
staging prerequisite, not an installed or activated GUI: transactional public
activation, service launch, rollback, and operator-installed acceptance remain
open.

## NND 20261003-15 — native memory limits

Managed Settings now offers NNA-advertised user-scope limits for memory timeout,
item count, and bytes, using the native preview, revision-checked save, and
operation-receipt flow. The settings search destination remains available even
when the catalog is absent; an independent adversarial review found and fixed
that concrete navigation defect. Memory enablement and required-mode toggles
remain governed through NNA's coupled TUI flow until a safe paired native
mutation contract is available.
The full UI suite passed (1,737 tests), as did the web suite (1,447 tests),
typechecks, and quality gates.

## NND 20261003-16 — native reviewer and vision route binding

Managed Settings now offers NNA-advertised reviewer and vision provider/model
bindings as a single typed native operation. Provider choices come from the
selected user's authenticated provider projection; preview, revision-checked
save, and operation receipts retain NNA authority over project shadows and
permissions. Independent adversarial review found no concrete defect in the
paired mutation or GUI flow. Primary and subagent routes retain their separate
native contracts.
The full UI suite passed (1,740 tests), as did the web suite (1,447 tests),
typechecks, and quality gates.

## NND 20261003-17 — catalog-gated memory toggles

Managed Settings now offers memory enablement and required-mode controls only
when NNA advertises the paired native mutation contract for both fields. The
preview shows the effect on both values and rejects inconsistent coupling;
save uses the selected NNA's revision-checked operation and receipt path.
Older NNA catalogs keep these controls unavailable. Independent adversarial
review found no concrete defect, including after integration with reviewer and
vision route bindings.
The full UI suite passed (1,744 tests), as did the web suite (1,447 tests),
typechecks, and quality gates.

## NND 20261003-18 — read-only active package launch plan

The new resolver reads the selected NNA installation and data identity, checks
the active native NND package registration, verifies the immutable payload and
slot identity, and returns a bounded launch plan without starting a process.
It rechecks registration and the NNA descriptor after payload verification;
independent adversarial review found and fixed a descriptor-change race that
could otherwise return a plan for the wrong data root. This prerequisite does
not attest activation completion or live GUI health, and no installed launcher
uses it yet.

## NND 20261003-19 — native provider scheduling limits

Managed Settings exposes NNA-advertised provider concurrency and queue limits
through bounded typed controls. Saves continue through native preview,
revision-checked publication, and operation receipts; they are explicitly
unapplied to running sessions. Search has a stable destination even when the
native catalog is unavailable. Independent adversarial review found no
concrete defect in the bounds or authority flow.
The full UI suite passed (1,745 tests), as did the web suite (1,447 tests),
typechecks, and quality gates.

## NND 20261003-20 — native dream maintenance controls

Managed Settings now offers NNA-advertised dream enablement, idle and stage
delays, and retention limits through bounded typed controls and the native
preview, revision-checked save, and receipt flow. The GUI explains that host
authority may keep dream disabled and that saved values affect newly built
contexts. Search remains navigable without a catalog. Independent adversarial
review found no concrete defect in the native bounds or authority behavior.
The full UI suite passed (1,747 tests), as did the web suite (1,447 tests),
typechecks, and quality gates.

## NND 20261003-21 — native connection and review timeouts

Managed Settings now exposes NNA-advertised provider connection and semantic
review timeout fields with native bounds, preview, revision-checked save,
reset, and receipts. A 15-second semantic review value is identified as NNA's
legacy inherited sentinel rather than a fixed limit. Independent adversarial
review found and corrected that misleading case. The full UI suite passed
(1,750 tests), as did the web suite (1,447 tests), typechecks, quality gates,
and the NND-to-NNA v29 source smoke. Packaged Chromium native-write acceptance
was still under investigation at this slice; the stale smoke selector was
repaired in v22. This slice does not claim an installed GUI write journey.

## NND 20261003-22 — packaged native settings acceptance repair

The real Electron/Chromium native-write smoke now uses the memory checkbox
provided by the current GUI, rather than an obsolete textarea. The packaged
v20 payload against NNA v29 passed selected-source repair, native preview and
save receipt, stale-revision rejection, cookie admission, browser isolation,
and service survival after the desktop shell quits. Independent adversarial
review found no defect in the corrected fixture. This is a disposable
packaged-payload journey; operator installation, startup, and public slot
activation remain open.

## NND 20261003-23 — native provider deadlines

Managed Settings now exposes NNA-advertised global provider and primary-route
deadlines through bounded controls. Zero disables a deadline; nonzero values
use NNA's 100–86,400,000 ms bounds. Preview shows the saved explicit-value
change and both effective values, including when the primary override masks
the global change until it is cleared. Saves retain native preview, revision
checks, and receipts and remain unapplied to current work. Independent
adversarial review found and fixed the masked-change preview and invalid
numeric draft cases. Installed GUI acceptance remains open.
The full UI suite passed (1,753 tests), as did the web suite (1,447 tests),
typechecks, and quality gates.

## NND 20261003-24 — native stream timeouts

Managed Settings now provides catalog-gated first-token and idle timeout
controls. Zero disables, reset inherits, and fixed values use NNA's bounds.
The GUI declines legacy values that NNA migrates to inherited semantics,
including its paired defaults, so it cannot promise a fixed override that
would not be applied. Preview shows both effective stream values and saves
retain native revision checks and receipts. Independent adversarial review
found no concrete defect. Installed GUI acceptance remains open.
The full UI suite passed (1,756 tests), as did the web suite (1,447 tests),
typechecks, and quality gates.

## NND 20261003-25 — native gateway polling timeout

Managed Settings now exposes NNA's bounded Telegram gateway polling timeout
through a separate native gateway configuration endpoint. The GUI reads the
selected installation's exact source revision, previews a 5–50 second value,
and saves with a durable operation receipt. It never handles the gateway token,
authorized users, or gateway enablement. Saved changes are marked not applied
until the gateway restarts. An independent adversarial review fixed recovery
dead ends for unpublished saves and operation receipts evicted from NNA's
bounded replay window. Installed GUI acceptance remains open.
The full UI suite passed (1,764 tests), as did the web suite (1,447 tests),
typechecks, and quality gates.

## NND 20261003-26 — selected NNA stage recovery

The Windows installer can now reconcile a previously started immutable payload
stage by its exact operation ID through the selected installed NNA. It validates
the terminal native response and reports whether a slot is ready or the operation
was unpublished; neither outcome is presented as activation. An existing pinned
NND selection cannot be overridden with a different explicit NNA root. An
independent adversarial review found and fixed an empty recovery ID that could
otherwise fall through to normal installation. Public service activation and
operator-installed acceptance remain open.

## NND 20261003-27 — native recovery budgets

Managed Settings now offers bounded controls for NNA's model-step and local
retry limits when the native catalog advertises those user-manifest fields.
The controls use native preview, revision-checked save, and operation receipts;
NNA still validates the recovery ladder and decides when saved values become
effective. An independent adversarial review fixed a leading-zero draft that
could offer an invalid Preview and corrected the application guidance.
Installed GUI acceptance remains open.
The full UI suite passed (1,765 tests), as did the web suite (1,447 tests),
typechecks, and quality gates.

## NND 20261003-28 — native session deadlines

Managed Settings now exposes NNA-advertised approval, persistence-flush, and
shutdown timeouts through bounded user-manifest controls. Native preview,
revision checks, and operation receipts remain the authority for every save.
Saved values are not presented as a permission-mode change or as applied to
running work. Independent adversarial review found no concrete defect; the
controls match the current native catalog bounds. Installed GUI acceptance
remains open.
The full UI suite passed (1,766 tests), as did the web suite (1,447 tests),
typechecks, and quality gates.

## NND 20261003-29 — native context budgets

Managed Settings now offers catalog-gated controls for NNA's context byte
ceiling and four compression/compaction thresholds. Fractional drafts remain
editable while incomplete; native preview shows the ordered threshold set and
NNA validates the final ordering. Saves use revision checks and operation
receipts without claiming an effect on running work. Independent adversarial
review fixed fractional typing that previously cleared `0.` before the
operator could enter a value. Installed GUI acceptance remains open.
The full UI suite passed (1,768 tests), as did the web suite (1,447 tests),
workspace typechecks, and quality gates.

## NND 20261003-30 — fresh source installer service verification

The Windows source installer now admits only a fresh target and absent selected
NNA package registration, repeats that check under NNA's install guard, and
reports success only after the guard releases and the selected NNA starts a
service with the exact installation, data, package, generation, and loopback
identity. A one-use attach ticket must authenticate the GUI, fail on replay,
and leave an independent browser locked. The installer prints the browser
origin and selected NNA command for a separate one-use browser code. An
independent audit fixed unbounded local UI response reads, a same-version
registration swap before success, and ambient authority inherited by the
detached native service. Interrupted installs remain explicitly incomplete;
existing installations and immutable prebuilt upgrades need separate recovery
and activation. The focused verifier suite passed (7 tests); operator-installed
browser/desktop acceptance remains open.

## NND 20261003-31 — reviewer-ledger retention control

Managed Settings offers a bounded `reviewer_ledger.retention_entries` control
only when the selected NNA advertises that user-manifest field in its native
catalog. Preview and save use the native revision check and operation receipt.
The GUI warns that older NNA builds can evict unfinished reviews at a low
retention limit because the configuration response does not expose a reliable
NNA product version. Repaired NNA builds preserve unresolved reviews,
including uncertain external effects. This is a field-specific control, not a
completed settings census or installed save/apply acceptance. The release's
full UI and web suites, workspace typechecks, quality, and release checks passed.

## NND 20261003-32 — disposable installed-source acceptance

The Windows acceptance harness invokes the real source `install.ps1` against
a fresh NND target and a private, source-composed installed NNA v37 fixture.
It uses a marked private shortcut root and isolated package-manager and Electron
profiles; it does not alter the operator's selected NNA. After installation,
an isolated Electron Chromium partition loads the installed service and submits
the Native code form, a second partition remains unauthenticated, and a
separate desktop launch attaches to the same service. The service survives
desktop exit. The harness stops it and removes the exact fixture only after
native discovery and the service lease clear. Native error parsing tolerates
Node diagnostic warnings, and attachment allows bounded cold-start latency.
Adversarial review corrected a concrete acceptance deadline mismatch. The
fresh integrated fixture passed; focused native-client and fresh-service tests
passed (17/17), as did UI (1,770), web (1,447), workspace typechecks, quality,
and release checks. This is [source-install evidence](nnd-installed-source-acceptance.md),
not immutable prebuilt activation, existing-install upgrade/rollback, real
provider traffic, or operator-installed browser/desktop acceptance. L5/L6 and
C/F parity remain open.

## NND 20261003-37 — detached prebuilt activation proof

The staged NND slot now has an isolated activation entry. It repeats native
activation preflight, starts the selected NNA's retained `activate-slot` owner
detached, reads the bounded public-controller frame, verifies package ownership,
and samples the existing read-only public attach proof. Success binds the
stage/activation operations, NNA identity, preflight candidate evidence, active
registration hash, version, generation, and loopback endpoint while leaving the
retained owner live. The attach sample is evidential and does not prove durable
service ownership. Ready-frame and proof mismatch tests keep the owner ambiguous
and never report activation. The activation helper and installer contract
targeted 3/3 tests; NNA focused service, supervisor, discovery, admission, and
activation-CLI suites passed 38/39 with one platform skip. This still does not
bind generation cryptographically to payload, copy the active target, select
the launcher, or claim upgrade rollback. Full routine gates passed; an
independent adversarial audit gates the final commit.

## NND 20261003-36 — prebuilt activation preflight

The prebuilt staging branch now generates a distinct activation operation after
native staging and invokes the selected installed NNA's exact
`activation-preflight` contract. It binds the returned candidate to the same
stage and activation UUIDs, NNA installation/data identity, payload digest, and
payload version. A failed or malformed preflight preserves the stage operation
and remains explicit recovery evidence; it does not start, activate, or attach
NND. The prebuilt stage suite passed 7/7. NNA focused service, supervisor,
discovery, admission, and activation-CLI suites passed 38/39 with one
platform-supported skip. Independent adversarial audit confirmed the read-only
preflight and its preservation behavior, then found only test-coverage, opaque
candidate-history, and process-cleanup polish items; the audit-specific bounds
were expanded and all bounds now reject while preserving the stage marker. Full
UI was 1,770/1,770 and web 1,447/1,447, with workspace typechecks, quality,
graph/language, and release gates green. Actual prebuilt activation, detached
health proof, registration swap, launcher integration, upgrade/rollback, and
operator-installed acceptance remain outstanding.

## NND 20261003-35 — stable selected-package launcher gate

Desktop and Start Menu shortcuts use the stable installation anchor and the
selected NNA runtime on every launch. The launcher rereads the pinned selection,
verifies the package registration and immutable payload or current source
manifest, proves a live public attach without starting NND, and passes the
sampled controller generation to Electron. The shell compares that generation
against its fresh attach. The probe explicitly does not bind generation to a
payload or claim uninterrupted upgrade handoff. In the targeted installed-source
run, the first NDD `service start` hit the NNA private-helper five-second
deadline; the selected NNA `20261004-2` repair raises the bounded helper startup
deadline to thirty seconds. Adversarial re-audit passed both slices after the
contract names were corrected. Focused NND tests passed 18/18, full UI 1,770
and web 1,447, typechecks, quality, graph/language, and release gates. The NNA
focused service suites passed 33/33 with one platform skip, while the NNA full
suite had four isolated reruns all pass under parallel test contention.
