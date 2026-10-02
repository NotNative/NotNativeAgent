# NND local activation contract, revision 1.0

Status: L1 validators, L2 native setup runtime and L3 UI authentication seams implemented;
supervised child, controller and installed client wiring remain pending.
This records decisions for L2-L5;
it does not claim a running supervisor, startup registration, or installed acceptance.
The executable validators are mirrored in NNA `src/nnd-service-contract.js` and
`src/nnd-manifest-extensions.js`, and NND `scripts/nnd-service-contract.js` and
`scripts/nnd-manifest-extensions.js`. Paired tests must reject contract drift.
[Execution guide 02](02-installation-lifecycle.md) governs lifecycle scope.

## Process ownership

NNA owns the supervisor, native integration host, configuration control plane,
engine contexts, and lifecycle control. It launches the registered NND Node
entrypoint `scripts/serve-installed.mjs` as a supervised child. That child serves
the GUI and companion routes and attaches to the supplied native endpoint.
Browser and Electron attach to the same GUI service. TUI ownership is unchanged.

Existing `nna nnd serve` is an NNA integration host, not the NND GUI child.
Existing `serve-installed.mjs` forces managed mode and launches an NNA child.
L2-L4 must replace that inversion before claiming supervised service operation.
The service path must reject missing/invalid bootstrap and never fall back to
launching NNA. Legacy development mode remains explicitly separate until migration.
The current package activation CLI only registers a package; it does not start it.

## Startup decision

Windows MVP uses an NNA-owned per-user HKCU Run value named
`NotNativeAgent-<installation_id>`. Its command invokes the installed NNA hidden
launch helper with the selected absolute installation descriptor, without secrets.
The helper uses exact executable/argument arrays and hidden Windows processes.
L2 implements and tests quoting, ownership and startup; this file registers nothing.

Only NNA lifecycle operations write/remove that value. NND installer requests
module enablement through NNA after validated activation. The native owner verifies
the existing value belongs to this installation before replacing or removing it.
A collision is an actionable error, never permission to overwrite another product.
The NNA supervisor reads enabled module state: NND deactivation stops/disables NND
without changing TUI data. A shared NNA startup value may remain for other enabled
modules; NNA uninstall removes its owned value. Upgrade updates the owned target
transactionally. Disabled or absent NND never causes an endless startup retry.

Run under the signed-in operator, without administrator rights, LocalSystem or
stored Windows passwords. Closing clients preserves service operation. Logoff ends
that user's runtime; reboot restores enabled operation after their next sign-in.

## Control and credential transport

Supervisor to child bootstrap is one bounded JSON frame over the child's private
piped stdin (`protected_stdin`). The NNA supervisor retains the writer. No bootstrap
secret appears in command arguments, environment, URL, diagnostics or renderer state.
Child stdout is bounded protocol framing only; stderr is bounded diagnostics.
Readiness is a non-secret frame bound to the launched generation and package identity.
EOF or supervisor loss invalidates attachment; recovery never spawns a replacement NNA.
L2 defines time/byte limits and tests truncated, duplicate and invalid bootstrap frames.

Native requests use authenticated loopback HTTP on `127.0.0.1`, using the existing
bearer transport. The integration token and short-lived scoped principal are distinct.
L3 must issue/refresh native principal context through NNA; a static five-minute
principal is not a persistent attachment contract. Restart/revocation invalidates
credentials. The child cannot mint broader workspace/review grants.

CLI-to-supervisor commands use a separate generation-bound controller credential,
read from an owner-only ACL-protected discovery record beneath NNA's runtime root.
L2 must apply and verify Windows ACLs before writing credentials; POSIX mode 0600
alone is insufficient on Windows. The implemented private-directory helper
requires a local fixed drive and validates namespace/ACL ownership before creation;
credential-file validation and discovery publication remain pending. Retain controller discovery while running so
later clients can reconnect; remove only the exact owned generation at shutdown.
The native engine token is never a browser bootstrap ticket. L3 supplies separately
authenticated UI sessions with origin/guest checks. Network exposure is outside MVP.

## Singleton and migration

Acquire an exclusive Windows named-pipe listener at
`\\.\pipe\nna-nnd-<sha256(canonical_data_root)>`. Canonicalization resolves junctions
and Windows case before hashing. Kernel listener lifetime provides exclusivity;
persisted discovery JSON is not a lock and never permits lock stealing or PID killing.
Record installation identity, data identity, package version/root and random process
generation in owner metadata. Package versions and NNA install paths never partition
exclusivity for the same data root. A second launcher authenticates the current owner
or fails closed with recovery guidance. An occupied port proves no ownership.

Configuration that shares an NND catalog outside the data root must acquire equivalent
catalog exclusivity before opening it. Do not allow two data roots to evade the
single-writer rule. Serialize start/stop/restart/activation/upgrade under this owner.
The lock helper tests concurrent/cross-process launch and canonical data-root aliases.
Lifecycle upgrade, stale discovery and PID-reuse acceptance remain for L2/L5 wiring. Legacy Electron-owned processes do not hold this new lock: L5 must discover
and drain the exact old owner, or refuse migration before opening its catalog.

## Activation schema and compatibility

Existing identity/version/protocol/assets validation remains in `nnd-package.js`.
New manifests may declare `service_activation`; its exact shape is defined by the
paired pure validators. Fields cover schema revision, required native capabilities,
data schema contracts, Windows architecture, Node runtime floor, relative entrypoint,
server bundle path and SHA-256, and authenticated callback exchange.

The digest identifies a built bundle. It never hashes the release manifest that
itself includes this activation manifest. L5 additionally verifies the full release
inventory, including GUI assets and lifecycle artifacts, before activation.
Path syntax validation is not filesystem containment: activation resolves real paths,
rejects escaping junctions/symlinks, checks regular files and verifies bundle bytes.
The bundle identity must resolve to the required `packages/electron/dist-server/server.mjs`
artifact; hashing an unrelated helper cannot establish server integrity.
Supported data schemas are activation contract requirements, not a claim that every
existing presentation store already has a migration version.

An explicitly supplied host capability descriptor is checked independently of shape.
The default advertised service capability set is empty until L2 implements it.
Knowing the name `service_supervision` does not mean this NNA build implements it.
Legacy registration without `service_activation` remains supported, but is not service
activation. Registration validates declared schema and artifact integrity without claiming
host support. Explicit service admission supplies the actual host descriptor and rejects
unknown required capabilities or incompatible runtime/architecture before starting work.
No compatibility inference from release date alone.

## Health and setup

States: absent, incompatible, starting, ready, degraded, stopping, stopped, failed,
and setup_required. The status envelope separates runtime, package and provider
readiness, identifies installation/data/generation, and gives bounded setup guidance.
The validators reject malformed fields and non-loopback endpoints. Unknown states
are execution-guarded. A valid envelope is a data check, never authorization.

A live setup_required service exposes only native diagnostics, validation, credential
setup, configuration save and explicit activation. It admits no turns/tools/workspace
or review authority until normal native admission succeeds. Missing/corrupt configuration
must not prevent the repair plane; preserve corrupt bytes for diagnosis and explicit
repair. No successful inference is needed to configure a provider.

Starting may become ready, setup_required, incompatible or failed. Ready may degrade;
repair can restore readiness. Stop drains ready/setup/degraded states within a bound,
then reports stopped or a typed failure. Retry budgets belong to the supervisor;
failed never implies unlimited restart. Provider failure is not package absence.

## CLI decision and remaining acceptance

Planned commands: `nna nnd service start|stop|status|restart` plus NNA-owned startup
enable/disable operations. They are not implemented by a constants module.
Existing `nna nnd package activate ROOT|deactivate ROOT|status` remains registration.
The service status must never be inferred from that registration result.

L1 validates shape, fail-closed compatibility and paired contract agreement. L2-L5
must prove authenticated startup, descriptor validation, lock ownership, setup plane,
credential renewal, independent TUI and transactional installation. V gates require
real disposable installed Windows artifacts; source tests do not close them.
