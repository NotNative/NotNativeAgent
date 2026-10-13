# Verification, release and agent handoff

Read [PLAN](../PLAN.md) first. All V gates are open at the audited baseline.
Existing automated tests provide regression evidence, not installed acceptance.

## Evidence format and closure rules

For each package/subfeature, record: ID; owner repo; baseline/final commit; changed
paths; native contract/version; prerequisite IDs; positive/negative/recovery cases;
commands or manual steps; actual result; artifact location; NNA/NND versions;
Windows/runtime version; reviewer; unresolved limitations.
Use `open`, `in-progress`, `blocked`, `implemented-unverified`, `verified`.
Only observed acceptance sets `verified`. A missing required dependency is `blocked`,
not a feature exclusion. Keep fixtures and disposable profile locations explicit.
Sanitize secrets and operator content from evidence. Screenshots prove appearance;
native receipts and logs establish execution and recovery.

## V1 — Build and installed identity

Dependencies: L registration, packaging, transactional installer and release coverage.

1. Build pinned artifacts; record NNA and NND commits and versions.
2. Verify release identity covers all shipped installers, Electron, server, GUI,
   native dependencies, integration metadata and launchers.
3. Compare served GUI, desktop, active package and native protocol/capability
   identities. Refuse inconsistent combinations.
4. Install without sibling source trees, developer PATH, pnpm stores, source imports
   or undeclared runtimes. Recover dependency-acquisition failures before activation.
5. Test missing/compatible/incompatible NNA, custom roots, spaces/Unicode, two NNA
   installations, and an ordinary non-admin Windows user.
6. Start from NNA with no manifest/provider credentials. Reach authenticated setup
   in both doors, configure through native APIs, and run the first governed prompt.
   Repeat with malformed configuration: retain the original and complete explicit
   repair. Prove unavailable inference never blocks access to settings or status.

Pass: usable browser URL and desktop launch, verified identities, preserved NNA/TUI
configuration and data. Success must not depend on a developer terminal staying open.

## V2 — Independent service and interface lifetime

Dependencies: L persistent runtime, native attach and desktop migration.

Run a real turn from the browser before opening Electron. Open Electron and observe
the same NND session. Close its window, then quit its tray. Browser and turn remain
functional. Reverse the initiating interface. Reopen Electron without duplicate work.

Start independent NNA TUI, create/switch tabs, and run a governed turn. NND does not
adopt or rename its tabs. NND install, shell exit and uninstall must not terminate
the TUI. Global settings report their scope; session changes do not alter other
sessions implicitly.

Exercise explicit service stop, process crash, sleep/resume, sign-out and reboot
according to L's declared account/start policy. Abrupt interruption need not resume
unsafe effects automatically: preserve uncertainty and native recovery evidence.
Never label a killed turn successful. Reconnect after more than five minutes,
with stale credentials, and after credential rotation/revocation.

Pass: interface detach is distinct from authenticated service stop; lifecycle,
start policy, cancellation and recovery match the native contract.

## V3 — Complete settings and effective configuration

Dependencies: C census, native read/write/application APIs and GUI controls.

Every field in the supported NNA census has a disposition and UI location.
For editable fields test persistence, authoritative readback and observable effect.
For immutable/derived values test accurate explanations. Secrets use set/replace/
remove and configured/test state without secret echo.

Test conflicting and disjoint edits in two windows; invalid values; defaults/reset;
inherited sources; external TUI edits; busy-session changes; restart-required and
new-session-only changes; failed write; failed apply. Verify primary/reviewer/vision/
subagent routes separately. Add a native setting in a test schema and prove the
coverage gate detects an unmapped field. Saved text is not proof of runtime application.

Pass: no operator-configurable setting requires manual file edits solely because
the GUI lacks support. Denied authority and immutable invariants remain explained.

## V4 — Chat, workspace and visibility parity

Dependencies: required F implementations at `implemented-unverified` and the W-id
subfeature ledger. V4 supplies their installed evidence; it does not require F to
have already passed V4. Promote each F row to `verified` only after its V evidence.

Execute each required W-id with real NNA and installed artifacts: draft/create/send/
stream/stop/retry; attachments/context; questions; review modes; history/reload/search;
archive/restore/export; fork/revert; queue/steer; goals/schedules; child transcripts
and permitted controls; tool evidence; usage/context; files/Git/diffs/worktrees;
terminal reconnect; preview/annotation; notes/memory/skills/MCP; model helpers;
notifications and session links. Guide 04 supplies implementation tasks.

Use two workspaces and a worktree. Prove the displayed workspace equals admitted
engine and companion-operation scope. Reject altered paths/grants. A label is not
an authorization receipt.

For every browser/desktop difference, distinguish an OS affordance from a missing
required capability. Electron-only browser control does not prove browser-only
inspection/annotation. Implement a scoped capability or leave acceptance open.
No silent parity exemptions.

## V5 — Recovery and authority failure matrix

| Injected condition | Required observation |
|---|---|
| Lost prompt acknowledgment after admission | Durable operation ID prevents another governed turn on retry |
| Disconnect, expired cursor, native restart | Explicit coverage/freshness, snapshot repair, no fabricated complete history |
| Crash during tool effect | Native uncertainty/evidence retained; GUI never blindly repeats effects |
| Restart with pending question/review | Restore supported native state or interrupted disposition, never authority from transcript |
| Concurrent configuration/session writes | Revision conflict or deterministic arbitration, no silent lost update |
| Revoked session/package/workspace grant | Reads/events/writes lose access; cached views cannot keep acting |
| Corrupt catalog/preferences/migration | Recoverable failure and preserved originals, no automatic empty overwrite |
| Disk full/denied write | Prior committed state survives; UI distinguishes unsaved from unapplied |
| Service unavailable | Recovery UI, no mock or unrelated-installation fallback |
| Guest page invokes privileged IPC/URL | Origin/capability rejection, no credential exposure |
| Unresponsive provider | Native deadline/cancel/recovery; user stop remains available |
| Two queue/scheduler consumers | Durable admission/occurrence identity prevents duplicate work on restart/lost acknowledgment |
| Large session/history/tool inventory | Bounded memory and explicit paging/retention, no silent loss of discoverability |
| Interrupted upgrade/activation | Recoverable old or new pair; migrations preserve rollback safety |

Trace each plausible defect through visible state, durable state and future retries.
Avoid speculative rewrites without a concrete failure scenario.

## V6 — Upgrade, removal and release decision

Dependencies: V1-V5 and all required W/settings rows.

Upgrade from the previous compatible installed pair. Inject failures at staging,
verification, dependency acquisition, build if applicable, registration, migration,
activation and health probe. Verify executable and state recovery. Data rollback
requires a tested migration/backup strategy, not just swapping binaries.

Uninstall NND: unregister only its package; stop its components; remove its executable
files; preserve NNA, TUI, secrets and journals. Optional NND data deletion needs
explicit named scope. Reinstall and verify restoration. Never use operator data as
a disposable fixture.

Closure requires all local MVP packages verified, required W subfeatures covered,
settings census complete, and no unresolved critical defect. Remote/NNO/VS Code/
native-mobile exclusions cannot mask local chat or visibility omissions.

## Repository checks and immutable version procedure

Inspect current scripts before assuming command names. Baseline NND checks include:

```powershell
pnpm --filter @notnative/ui test
pnpm --filter @notnative/web test
pnpm typecheck
$electronTestPaths = @(rg --files packages/electron -g '*.test.mjs')
if ($electronTestPaths.Count -eq 0) { throw 'No Electron test files discovered' }
node --test --test-concurrency=4 @electronTestPaths
pnpm integration:smoke ../..
```

After the 20261012-2 fold into `NotNativeAgent/desktop/`, the NNA source root for
this and every installed journey is the repository root one level up (`../..`); the
journeys' default-root assumptions were re-anchored accordingly.

The PowerShell array avoids relying on shell glob expansion. `pnpm test` alone
covers only UI. NNA implementation slices require
`npm test -- --test-concurrency=4`, or the current supported bounded equivalent.
Source suites do not establish V1-V6.

Documentation-only slices validate links, IDs, authority consistency and citations.
Do not invent runtime test claims. Release gates still apply to sealed documentation.
Focused code reproductions can validate disputed findings without implementing repairs.

After final edits and adversarial repairs:

1. Update applicable guide status, evidence and progress.
2. Bump each changed product with its canonical script using the client date.
3. Regenerate graph and affected reports; review unrelated changes.
4. Run required checks. NND `node scripts/release-gates.js --write-hashes` runs
   quality, smoke and build gates and must follow all covered-content edits.
5. Never edit covered content after sealing. A later repair requires another version.
6. Commit the verified slice. Commit NNA dependencies first and record their identity.
   Do not push or install to the operator's machine without applicable authorization.

Current graph/seal omit shipped surfaces (A06). Until L/V fixes coverage, report
the limitation even if existing gates pass. Do not modify production scripts just
to make this documentation slice appear complete.

## Handoff template

```text
Package/subfeature IDs and state; dependency IDs:
NND commit/version; NNA commit/version; schema/capabilities:
Changed paths and ownership:
Observed positive, rejection, cancellation and recovery cases:
Commands/results and sanitized installed evidence:
Adversarial findings, repairs and remaining defects:
Migration/rollback and operator-data impact:
Next executable package and missing prerequisite:
```

No agent may convert unverified work into completion through prose. When documents
conflict, update their authority/disposition and this guide together. Preserve dated
evidence with its original scope.
