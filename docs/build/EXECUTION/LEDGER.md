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
| L5 | Transactional installer/upgrade/rollback | L1-L4 | in-progress | NND `install.ps1`, package/stamp scripts, NNA registration, install guard/marker | mutation exclusion implemented; migration/recovery/rollback pending |
| L6 | Installed acceptance + release identity | L1-L5, C/F | open | docs/build/PROGRESS, evidence records, V gates | — |
| C1 | Settings census + contract ledger | L1 | in-progress | NNA settings sources; NND `components/settings/*` mapping | — |
| C2 | Native resolution/concurrency (NNA) | C1, L2 | in-progress | NNA `integration-cli.js`, `startup-configuration.js`, `configuration-sources.js`, `runtime-config.js`, `provider\profile-store.js` | native `20261002-14` scoped user-manifest HTTP read/preview/save/repair verified; remaining settings families open |
| C3 | NND settings transport/presentation | C2 | in-progress | NND `harness\nna.ts`, `ui\lib\nnd\client.ts`, settings `window.tsx`, `search.ts`, settings pages | finite native user-manifest preview/save and explicit repair UI; installed mutation acceptance and other settings families open |
| C4 | Providers/routes/engine controls | C3 | open | NND `pages\providers.tsx` etc. | — |
| C5 | MCP/skills/hooks/trust/project config | C3, C2 | open | NND `routes\mcp-config.ts`, `lib\mcp\*`, `stores\useMcpConfigStore.ts`, `pages\mcp.tsx` etc. | — |
| C6 | Non-manifest + TUI preferences page | C3, L | in-progress | settings pages; NNA TUI prefs contract | native TUI color, motion and key bindings page verified below; external stores remain open |
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
