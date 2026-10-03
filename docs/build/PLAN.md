# NotNativeDesktop executable build guide

Status: accepted product direction; implementation work packages remain open.
Decision date: 2026-10-01. Implementation resumed; see the [execution ledger](EXECUTION/LEDGER.md).
For a framework-first, multi-agent handoff from the current shipped baseline, use
the [MVP executor handoff](EXECUTION/mvp-agent-handoff.md). It identifies the
serial activation gates and the C/F work that can proceed in separate worktrees.

## Product and completion contract

NNA is an independent product with agentic, governance, and experience engines.
Its native TUI retains its identity, tabs, sessions, and interaction lifecycle.
NND is a separate, optional product installed on top of NNA. Its Windows installer
detects a compatible NNA installation and guides missing installation or setup.
Installing NND must not replace NNA or make the TUI a component of NND.

The first complete release runs on one Windows computer. NNA owns persistent
service lifecycle. The installed NND service serves a GUI reachable through a
browser or Electron. Closing either interface must not stop service-owned work.
Browser and desktop access the same NND session collection. TUI tabs remain separate.

The GUI must expose all supported operator-configurable NNA settings and the
OpenChamber chat and visibility feature scope, translated into NNA semantics.
NNA validates configuration, execution authority, review, and observable engine state.
NND must not introduce auto-accept or a Full control bypass. Existing modes are
Default, Auto-review, and Unattended; all retain mandatory review.

This is a broad MVP. A functional chat demonstration, registered package, large
test count, or hidden unsupported control does not satisfy it.

## Read and execute in this order

| Guide | Purpose |
|---|---|
| [01 — Architecture and audit](EXECUTION/01-architecture-audit.md) | Authority, evidence, document dispositions, confirmed gaps, migration boundaries |
| [02 — Installation and lifecycle](EXECUTION/02-installation-lifecycle.md) | L work packages: native lifecycle, attach contract, Windows installer and rollback |
| [03 — Complete NNA settings](EXECUTION/03-settings.md) | C work packages: configuration census, native APIs, GUI, application and recovery |
| [04 — Feature parity](EXECUTION/04-feature-parity.md) | F work packages: native chat, visibility, workspace, autonomy, all W-id coverage |
| [05 — Verification and handoff](EXECUTION/05-verification.md) | V gates: installed journeys, failure injection, release evidence, agent completion procedure |

Paths beginning `NND/` refer to this repository. Paths beginning `NNA/` refer to
the independently checked out NotNativeAgent repository. Never assume matching
version numbers imply compatible protocols. Record both commits in evidence.

## Authority and interpretation

1. Direct user decisions and applicable repository instructions govern execution.
2. ADR 0020 and this guide define NND's target architecture and accepted scope.
3. The EXECUTION guides define remaining work and acceptance criteria.
4. `GUI-PLAN/SECTION-1-feature-inventory.md` supplies stable W-ids and UX detail.
5. `docs/planning/00..15` records the OpenChamber reference, not NNA implementation authority.
6. Dated NOTES, PROGRESS, EVALUATION, and old GUI slices are historical evidence.

Do not copy upstream implementation code. Do not recreate OpenCode internals to
satisfy a reference route name. Extend NNA's native contracts and adapt existing
NND consumers. Retain compatibility adapters where needed for migration and tests.
If a future NNA capability is required, implement and verify that dependency before
counting its GUI complete. Proposed contracts in this guide are not existing APIs.

## Execution sequence and status

All following stages are **open**. Existing code is reusable evidence, not blanket closure.

| Order | Stage | Entry condition | Exit condition |
|---|---|---|---|
| 0 | Baseline and traceability | Read this guide and check both Git trees | Pin commits; expand each assigned W-id and settings family into exact acceptance rows; preserve operator changes |
| 1 | L1–L5: service and installation foundation | Baseline recorded | Native activation/attach contract; independent Windows service; both doors attach; transactional installation, upgrade, rollback, uninstall; authenticated setup works before provider configuration |
| 2 | C: complete NNA configuration | Native ownership and version contract defined | Every configurable setting has a native GUI path, authoritative readback, scope and application semantics; coverage gate detects additions |
| 3 | F: native chat and visibility | Service baseline usable; required C APIs available | Every required W-id and subfeature passes real NNA workflows; required native gaps closed |
| 4 | L6 and V: integrated acceptance | L1–L5/C/F implementation evidence available | Fresh installed Windows journeys and failure matrix pass on pinned artifacts; release content coverage verified |

Within each stage follow the guide's dependencies. Independent read-only audits
and UI work may proceed in parallel. Do not parallelize conflicting writers or
claim installed acceptance before the lifecycle migration. Run V journeys
incrementally after each relevant slice; stage 4 consolidates their evidence.

This is a dependency order, not a prohibition on delivering prerequisite slices
across stages. L1 freezes the authenticated setup/configuration boundary; L2 makes
it reachable without a usable provider. C1–C4 supply its complete settings APIs
and GUI. L5 can verify installation in setup-required state before C/F completion.
Its final configured onboarding journey is rerun after C4. L6 aggregates C/F
installed journeys and therefore must not be a prerequisite for C or F work.
Likewise, F implementation unlocks the V tests that finally verify F acceptance;
requiring completed V before implementing F would be circular.

Implementation resumed by user request. L1 is in progress; the execution ledger
records partial work and acceptance separately from this target plan.

## Scope boundaries

Required now: Windows same-computer install, NNA setup/configuration, local browser
and desktop access, NND chat and visibility inventory, durable recovery, independent
TUI operation, reviewer governance, local authentication, and safe upgrade/removal.
Detailed W-id dispositions are in guide 04; subfeatures cannot disappear inside a
family marked complete. External-service features require their configured provider
and explicit acceptance evidence; unavailable credentials do not make a feature done.

Remote NNA deployment, SSH provisioning, relay/tunnel deployment, NNO delegated
organization identities, VS Code, native mobile, and non-Windows installers are
outside this first deployment gate. Preserve existing implementations and their
security boundaries. These deferrals do not remove local child-session visibility,
browser functionality, or ordinary desktop chat features from the release.

The baseline reference is OpenChamber 1.23.0 plus the recorded product deltas in
NOTE 16 and the NNA-first experience in NOTE 17. Do not silently reinterpret
"all chat features" as parity with an unspecified future upstream release.
Record any additional discovered chat/visibility expectation before implementation.

## Agent work procedure

1. Select the earliest unclosed package whose dependencies are satisfied.
2. Read actual implementation and relevant tests; classify reuse, repair, replacement,
   or native dependency. Search for moved files before inventing new parallel modules.
3. Record contracts and failure cases before changing their consumers.
4. Implement one coherent slice across the owning repositories as necessary.
5. Verify successful use, rejection, cancellation, interrupted writes, and recovery.
6. Obtain an adversarial subagent audit. Trace each plausible defect through its
   downstream consequence. Apply confirmed fixes; leave correct code unchanged.
7. Record evidence, update applicable guide status and progress, regenerate graphs,
   advance each changed product's `yyyymmdd-<increment>` version, and commit.
8. Follow the immutable seal procedure in guide 05. Never change an already sealed
   version's covered content and re-seal it under the same version.

Do not push, deploy, change the operator's installed service, or consume paid
external services merely to complete a development check without applicable authorization.
Use disposable installation profiles for acceptance. A missing required environment
is an explicitly unverified gate, not a reason to reduce the required scope.

## Earlier phase crosswalk

P0-P7 and P10-P11 map to reusable UI/server code and the F/C packages.
P8's local authentication remains required; remote deployment moves after this MVP.
P9 maps to F autonomy and native governance. P12 and PB map to L service/shell/install.
P13 maps to V installed acceptance. PA maps across L contracts, C settings, and F
projection/recovery; it is not closed by the current source smoke. PC organization
delegation stays deferred; existing NND subagents remain in F's local scope.
The earlier phase tables and Slice A-G chronology are not the execution order.
