# Installation and lifecycle execution plan

Status: implementation plan; installed Windows acceptance remains open.
Scope: Windows, one machine, the signed-in operator's NNA and optional NND module.
NNA stays a standalone product. Installing or removing NND must not make the TUI
dependent on Electron, a browser, or the NND service. TUI tabs and NND sessions
remain independent collections; this plan does not merge their conversations.

## Authority and reference interpretation

Read ADR 0020 in both repositories before implementing these packages.
Planning documents 01, 02, 03, 08, and 09 describe the reference product, not
permission to reproduce its process ownership or auto-accept behavior.
Preserve their useful contracts: one served GUI, authenticated proxy boundaries,
instance identity, bounded recovery, native IPC isolation, and truthful health.
Replace their managed-harness and Electron-owned-server lifecycle with NNA-owned
activation and supervision. Preserve NNA's mandatory reviewer in every mode.
The following lifecycle API names and storage additions are proposals until L1
freezes them in the NNA contract and both repositories test the same contract.

## Baseline findings and current dispositions

| Evidence | Baseline behavior | Current disposition and remaining closure |
| --- | --- | --- |
| NND `packages/electron/main.mjs`, `packages/web/src/server/index.ts`, `harness/nna-local.ts` | Shell imports server; server starts and kills an NNA child | Selected installed native attachment now preserves the supervised service after shell quit; explicit legacy development path remains separate |
| NNA `src/nnd-package.js` | Activation registers metadata; it does not supervise a service | Registered does not mean running or usable |
| NND `packages/electron/main.mjs` | Local health is required before choosing remote target | Client-only remote boot fails without local NNA |
| NND `install.ps1` | Copies into current install before dependencies/build/activation succeed | Failed upgrade can leave package version and registration inconsistent |
| NND `install.ps1`, `harness/nna-local.ts` | Custom NNA root is used during install, but runtime prefers default descriptor | Native selection now binds the exact installation; transactional selected launcher and two-installation production acceptance remain required |
| NNA `src/integration-principal.js`; NND attach adapter | Principal freshness is five minutes; attach accepts a static envelope | Supervised native requests derive authority per request and ignore child authority headers; device scope remains pending |
| NND `scripts/release-gates.js` | Release include list excludes Electron and root installers | Source seals now cover root installers and Electron lifecycle code, with bounded junction refusal tests |
| NND `scripts/nna-source-smoke.mjs` | Source CLI and source app are exercised directly | Actual disposable installed-payload and Chromium probes now verify attachment; production installer acceptance remains open |

Source smoke remains useful regression evidence. It must not be renamed or
reported as installed-product acceptance. Existing NSIS generation is disabled;
do not re-enable distribution until this plan's installer gates pass.

## Target process and ownership contract

NNA owns its persistent runtime, NND package registration, launch authorization,
listener policy, recovery, and service controls. NND supplies the GUI service,
its bundle, companion APIs, and an optional Electron shell. Browsers and shell
attach to the same active service instance and served bundle.
The service may be a supervised subprocess; process separation does not transfer
engine lifecycle authority to NND. NND must never launch a replacement NNA when
its authenticated NNA connection fails. Engine recovery belongs to NNA.

MVP account policy: run NNA supervision and NND under the same Windows user as
the operator. No LocalSystem account, administrative elevation, stored Windows
password, or machine-wide service is required by this MVP.
Persist across shell/browser exits and reconnect after application crashes.
For the initial per-user implementation, logoff stops the user's runtime;
reboot restores enabled service operation after that user next signs in.
Work must not be advertised as surviving logoff or running before login.
If unattended operation without a signed-in user becomes required, record a
separate account/credential/service decision and acceptance matrix first.

## Path and identity inventory

Resolve paths from the validated installed NNA descriptor, not the current
working directory, a guessed PATH entry, or the shell's inherited environment.
Respect custom absolute roots and preserve the selected installation identity.
The initial private runtime storage implementation supports local fixed Windows
volumes only. Reject UNC, mapped network and removable storage with actionable
setup guidance; never silently redirect the selected NNA data root. Shared remote
storage would need cross-computer ownership and a separate credential trust policy.

| Data or artifact | Existing location / proposed treatment |
| --- | --- |
| NNA install descriptor | `<NNA install root>/install.json`; validates product, runtime, install/data roots |
| NNA executable payload | `<NNA install root>/installed`; preserve independent NNA upgrade ownership |
| NNA state | Descriptor `data_root`, normally `%USERPROFILE%/.nna` |
| NNA provider configuration and secrets | Existing NNA config and SecretBroker paths; never duplicate into NND settings |
| NND registration | Existing `<NNA data root>/config/nnd-package.json`; migrate transactionally if schema changes |
| NND executable versions | Proposed immutable `<NND install root>/versions/<version>-<artifact-hash>` slots; native package registration is the sole authoritative active pointer |
| NND presentation state | Existing `%USERPROFILE%/.notnative-desktop` or explicit selected data root; preserve on upgrade |
| Supervision state | Proposed NNA-owned bounded runtime record with installation ID, generation, endpoint, owner identity |
| NND sessions and journals | Existing NNA-owned session/catalog paths; keep ownership and replay checks |
| Logs | Bounded per-product diagnostics with versions and instance IDs, excluding credentials and principal bodies |

Do not relocate all user state merely to match this proposal. Migration must
identify the old owner, preserve data, and refuse ambiguous multiple installations.
Resolve filesystem junctions before destructive operations and verify the final
absolute target belongs to the selected marked installation.

## L1 — Freeze the executable activation contract

Dependencies: none; precedes L2–L6 and all claims of installed integration.
Owners: NNA lifecycle/activation plus NND installer and service entrypoint.
Read: NNA `src/nnd-package.js`, `src/integration-cli.js`,
`src/nno-integration-activation.js`, `src/cli-options.js`; NND
`scripts/serve-installed.mjs`, `install.ps1`, ADR 0020 in both repositories.

Deliver one bounded design slice: choose the Windows per-user startup mechanism,
authenticated local control transport, singleton primitive, and activation schema.
Prefer an NNA-owned login registration launching an NNA supervisor with a
supervised NND subprocess; document the exact owned registration and removal rule.
Do not leave transport or ownership as an indefinite prerequisite.

Proposed control operations are `nna service start|stop|status` and NND module
activation/deactivation/status operations. Existing `nna nnd package` operations
are registration only; new behavior must be versioned and documented explicitly.
Define machine-readable results for absent, incompatible, starting, ready,
degraded, stopping, stopped, and failed; include stable failure codes.
Separate NNA runtime health from NND package readiness and provider readiness.
Define an authenticated `setup-required`/repair state whose configuration control
plane works without a usable provider or an initialized session engine. Freeze its
narrow operations with C1: native configuration diagnostics, validation, credential
setup, save, and explicit activation. It must not admit turns or confer workspace,
tool, or review authority before the normal native admission requirements pass.

Manifest contract must include package identity/version, activation protocol,
required NNA capabilities, supported data schemas, platform/runtime architecture,
entrypoint, bundle identity, and authenticated callback requirements.
Do not infer compatibility from date versions or `protocol: 1.0` alone.
Define a tested minimum NNA capability set and reject unknown required features.
Return actionable setup/update guidance before mutating an installed package.

Acceptance: contract tests cover compatible/incompatible NNA, absent/corrupt
descriptors, unsupported protocol/capability, and independent TUI startup with
no NND installed. Both repository docs identify actual APIs versus proposals.

## L2 — NNA supervision, startup health, and singleton ownership

Dependencies: L1. Implement and test in NNA before switching the production shell.
Likely changes: NNA lifecycle modules alongside `src/integration-cli.js` and
`src/nnd-package.js`; NND `scripts/serve-installed.mjs` and server startup wiring.
Keep new modules bounded under the applicable repository engineering rules.

Acquire one ownership lock per validated NNA installation/data-root identity.
A second launcher queries the existing owner; it never starts another catalog
writer. Lock recovery verifies owner identity and process generation, not PID
alone. A reused PID or unrelated occupied port must never authorize termination.
Serialize start, stop, restart, activation, and upgrade operations.

Launch the registered NND version with exact executable and argument arrays.
Use hidden Windows processes and an explicit, minimal environment.
NNA supplies authenticated engine access and approved listener configuration.
Readiness follows validation of bundle, native runtime, data access, engine
connection, auth middleware, and actual listener binding. A listening socket
alone is insufficient. Keep setup-required provider state distinct from crash.
Separate service readiness from execution readiness: a fresh installation with no
manifest/provider/credentials must serve an authenticated setup GUI and native
configuration API. The current `src/integration-cli.js` creates the engine host
before starting the integration server, and `readIntegrationManifest` throws for
missing/invalid configuration; migrate that ordering. Do not require a successful
model call or an existing engine session to configure the provider that enables it.
Preserve corrupt configuration for diagnosis/explicit repair; never replace it with
an empty default during startup. After native validation and explicit activation,
transition to execution-ready without creating a duplicate service instance.
Bound startup time, frame size, retries, diagnostic retention, and shutdown time.
Fail a persistent configuration error promptly instead of restarting forever.

Use fresh service generation identifiers after restart and stable installation
identity across upgrades. Discovery must reject another product on a reused port.
Publish endpoint changes through authenticated discovery; never silently attach
to whatever now answers the previous port. Preserve loopback-only default.
Define repair/status results for stale records, occupied ports, missing assets,
permission failures, and incompatible native PTY dependencies.

Acceptance: concurrent launches produce one owner; crash restart is bounded;
missing manifest, wrong service, port collision, malformed readiness, and logoff
are classified. TUI starts/stops independently and does not acquire NND sessions.
Also test missing manifest, invalid manifest and absent/expired credentials: setup
or repair remains reachable, execution is rejected with a typed reason, the old
file is preserved, and a valid configuration can enable execution through the GUI.

## L3 — Authenticated service attachment and principal renewal

Dependencies: L1–L2; required before long-lived service acceptance.
Read: NNA `src/integration-principal.js`, `src/integration-cli.js`,
`src/secret-broker.js`; NND `harness/nna.ts`, `harness/nna-local.ts`,
`packages/web/src/server/env.ts`, `packages/web/src/server/index.ts`.

Replace static attached principal envelopes with an authenticated supplier or
NNA-issued renewable scoped capability. A five-minute envelope cannot be treated
as a permanent service credential. Renewal must preserve subject, workspace,
surface, and permitted actions; it must not expand authority or invent a new user.
Define expiry, bounded clock skew, revocation, NNA restart, and failed renewal.
On failure reject new privileged requests clearly; never fall back to mock,
anonymous engine access, another principal, or a newly spawned NNA child.

Keep the integration token and principal out of renderer state, browser storage,
URLs, process arguments, logs, telemetry, and public health responses.
Use an authenticated local channel or protected handoff chosen in L1.
Validate ACLs for runtime records, secret material, package state, and custom
data roots. Inherited ACLs alone do not prove isolation on shared Windows hosts.
Use the existing local NNA SecretBroker realm for the same operator; do not
grant NND broad secret enumeration or borrow NNO's principal-scoped secret realm.

Loopback is transport placement, not authentication. Browser/shell access retains
the NNA-approved bootstrap and UI credential policy with exact origin validation.
Third-party content and browser guests must not receive local control authority.
Renewed service authority is independent of the user's conversation permission
mode; Default/Auto-review/Unattended retain mandatory NNA review.

Acceptance: requests and SSE reconnects work after six minutes and token renewal;
revocation takes effect; forged subject/workspace and another Windows user fail;
NNA restart reacquires authority without replaying a mutation or exposing secrets.
Use a controllable clock and an installed long-lived probe; do not weaken expiry.

## L4 — Migrate shell and browser without losing service work

Dependencies: L2–L3; coordinate with feature ownership and verification packages.
Change NND `packages/electron/main.mjs`, `desktop-boot.mjs`, tray/IPC handlers,
`packages/web/src/server/index.ts`, and `scripts/serve-installed.mjs`.
Retire the production managed-child path after installed migration passes.
Keep any source-development launcher explicit and isolated from installed state.

Shell startup discovers the selected NNA installation, requests NNA-owned service
start when necessary, authenticates, and loads its served GUI bundle.
Browser launch uses that same service endpoint and instance identity.
Do not retain a second writable in-process backend or independently versioned
packaged UI that can diverge from the active service's API and assets.
Shell-only bridges remain capability-gated; service operation must not depend on
an Electron guest being present. Unavailable browser-control tools fail clearly
or advertise unavailable until an authenticated capable shell attaches.

Closing a window, quitting tray, browser disconnect, renderer crash, or updating
the shell releases only its client resources. It does not cancel turns, terminate
PTYs owned by the persistent service, stop scheduled work, or close NNA.
Expose an explicitly named service-stop action separately, with affected work
and cancellation policy visible before the operator uses it.
NNA owns graceful draining/cancellation and records terminal outcomes before stop.
On forced failure, expose interrupted/uncertain effects; never label them complete.

After service restart, recover durable sessions and reconcile projection epochs,
pending questions/review state, queues, and scheduled dispatch ownership.
Preserve request IDs and idempotency; do not automatically replay non-idempotent
tool effects, timed-out prompts, or stale approvals. Current in-memory SSE replay
is not durable history; use authoritative snapshots and explicit gap behavior.
TUI and GUI retain their own session collections throughout migration.

Acceptance: submit a governed turn, quit all GUI clients, then reopen browser and
shell and observe its result once. Repeat for pending questions, cancellation,
service crash, active PTY, scheduled work, and shell update. Preserve remote
instance selection and credentials; client-only remote delivery remains outside
Windows same-machine MVP closure and must not be silently removed.

## L5 — One transactional installer, upgrade, rollback, and removal

Dependencies: L1–L4. Own `install.ps1`, package build/stamp scripts, NNA package
registration, and the replacement installed launch descriptors.
Deliver one operator-facing NND installer that detects compatible NNA and guides
missing/incompatible NNA setup. Never overwrite a configured NNA silently.
When NNA is absent, offer a separate, explicit dependency-install step using a
verified released NNA installer (downloaded or carried with the NND installer),
then discover and validate that NNA installation normally. Do not copy NNA's
engine into NND's package or make NND removal uninstall an independently usable
NNA. An existing compatible NNA is reused; incompatible installations remain
untouched until the operator chooses an NNA upgrade or another installation.
Persist the chosen NNA installation identity and custom roots into the protected
launch configuration. Test without PATH and with two NNA installations.

Stage the complete payload outside the active version, verify hashes/build stamp,
architecture, runtime and native PTY load, then validate NNA compatibility.
Production installation consumes built artifacts; it must not depend on a source
checkout, pnpm, sibling repository, or network build succeeding on the user host.
Record an interrupted transaction before activation and retain a known-good version.
Quiesce only affected NND work through NNA's lifecycle controls; do not kill by port.
For the first upgrade from the existing Electron-owned backend, the new singleton
lock cannot exclude an old launcher that never used it. Discover the selected
legacy installation's exact shell/server/native child ownership and active data
root; request graceful drain and verify those catalog writers have exited before
the new service opens the same state. If ownership or safe shutdown cannot be
established, refuse activation with recovery instructions. Never kill by a guessed
process name/port or terminate independent TUI work. Reconcile legacy queue,
schedule and accepted-operation records before enabling the new dispatcher; do
not run both consumers during takeover or replay an unknown prior outcome.
Atomically switch native registration, including the exact slot/artifact identity,
under the data-root lease. The stable desktop launcher resolves that record through
the selected NNA; do not create a second independently mutable active-version pointer.
Retain exact previous registration bytes/hash and a protected prepared transaction
before mutation. Native code owns and awaits slot copy/publication; production
installation launches no dependency/build writers. Existing source-build guard
markers cannot establish surviving child-writer quiescence and must remain blocked
until verified recovery; absence of a PID or port is insufficient evidence.
Start through NNA,
and require health plus authenticated GUI/engine probes before reporting success.
On a fresh unconfigured NNA, successful installation may report `setup-required`
after authenticated service/configuration probes; it must not report chat readiness
or roll back solely because no model is configured. Guide the operator through C's
native setup and distinguish installation completion from execution readiness.
After C4 lands, rerun the installer journey through a first governed prompt using
the deterministic provider/reviewer fixture. A model outage must not hide repair
settings or make an otherwise valid package installation appear corrupt.

If activation or health fails, restore the prior version and registration together.
Schema migrations must be backward-compatible or have a verified backup/restore
transaction; binary rollback alone cannot undo destructive data migration.
Recover predictably after interruption at each transaction stage. Remove stale
payload only after successful activation and after its processes have released it.

Uninstall asks NNA to deactivate/drain the NND service, removes only owned startup
entries, shortcuts, active package records, and marked NND payloads, and preserves
NNA runtime, TUI, provider configuration, secrets, and user work by default.
Deleting NND presentation data is a separate explicit choice. Never interpret NND
removal as permission to delete NNA journals or reviewer evidence.
If NNA is unavailable, record incomplete deactivation and give recovery guidance;
do not claim successful live cleanup or stop an unrelated process.

Acceptance: fresh install, reinstall, upgrade, rollback, cancellation, and uninstall
under standard Windows user; inject disk, copy, dependency, migration, registration,
startup, and locked-file failures. Verify the old installation remains usable or
the installer accurately reports a recoverable state. NNA standalone still works.
Include upgrade from the current managed-child version with Electron still open,
an active turn, pending queue/schedule intent and a stale legacy process record.
Prove there is never more than one writer/dispatcher for the migrated NND state.

## L6 — Installed acceptance, complete release identity, and closure

Dependencies: L1–L5, required C/F implementation, and the shared verification plan;
prerequisite for MVP release, not for beginning C/F work. Build manifest/graph
coverage can land earlier; final integrated installed acceptance follows C/F.
Update `scripts/release-gates.js`, `scripts/repository-graph.js`, packaging tests,
artifact manifests, and installed acceptance scripts as needed.
Graph all owned lifecycle modules, shell entrypoints, installers and service paths;
where shell scripts cannot be parsed, record explicit owned artifact relationships.
Seal every shipped first-party file, including `packages/electron`, root installers,
activation manifests, generated GUI/server bundles, native dependencies and launch
assets. Keep source release identity and artifact hashes distinct and reproducible.
Version both changed products using their existing date-increment conventions.

Run isolated installed tests against pinned NNA and NND artifacts, with independent
data roots and a deterministic provider/reviewer fixture. No operator data mutation.
Exercise actual browser HTTP/auth and Electron navigation, not only `createApp()`.
Verify provider configuration reuse, governed prompt/tool/delegation, mode changes,
projection reconnect/restart, cancellation, terminal, settings persistence, and
continued work after every GUI closes. Validate browser/shell bundle identity.
Include custom roots, spaces, no PATH, no admin, invalid ACL, wrong instance,
expired authority, duplicate start, stale lock, forced crash and failed upgrade.
Record evidence by artifact hash, OS/runtime, scenario, result and recovery outcome.

After each logical implementation slice, run its concrete failure tests and the
repository-required checks, obtain the requested adversarial review, resolve real
defects, refresh docs/graphs, then version and commit. Do not reseal an immutable
version after changing covered files. No publish/deploy follows from these tasks.
Close L6 only when all installed scenarios pass or explicitly approved exclusions
are recorded. Remote, other operating systems and delegated NNO contexts retain
separate acceptance gates; they are not implied by Windows local MVP success.
