# Architecture decision 0020: Ecosystem integration (NNA root product)

Status: accepted.

## Decision

NNA is the root product of the NotNative bot ecosystem: the agent harness whose core
ships with the agentic engine, the governance engine, the projection fold, headless
service operation, and the TUI. NNA core ships without a web or desktop interface.
The GUI is an installed integration package, not a congenital surface. Two integration
packages are named today: NNO (business layer, active) and NND (GUI, planned).

Integration packages add-on to NNA through NNA's package activation contract. The
existing `nno-integration-activation` mechanism is the first instance of this
contract; it is hereby generalized as the canonical add-on path: a package manifest
(identity, version, capabilities), activation lifecycle owned by the NNA daemon,
route-mount slots, and per-package settings. NND mounts as the second package.

## NND service contract implementation boundary

The NND L1 contract is implemented as bounded activation/status validators in
`src/nnd-service-contract.js`, `src/nnd-manifest-extensions.js` and
`src/nnd-service-package.js`. Registration validates optional service metadata
and actual bundle identity. Explicit service admission additionally requires an
observed host capability descriptor; no runtime supervision capability is
advertised merely because its schema is known. Legacy registration is preserved.

The selected target has an NNA supervisor hosting native integration and launching
an attach-only NND service child, with a private stdin bootstrap. Existing
`nna nnd serve` is the native integration host, not that GUI child. Current
Electron/managed startup has not yet migrated. Planned commands are
`nna nnd service start|stop|status|restart`; lifecycle commands elsewhere in this
ADR remain architectural targets until implemented and verified.

Windows startup will use an NNA-owned per-user HKCU Run entry targeting a hidden
launch helper. An exclusive named-pipe listener keyed by canonical data root
protects ownership across package upgrades and differing NNA installation roots;
shared catalog paths also require exclusivity. Discovery alone never authorizes
process termination. TUI tabs, sessions and startup remain independent.

The paired NND `docs/build/EXECUTION/nnd-local-activation-contract.md` records
startup ownership, separate controller and engine credentials, setup-required
health, migration gates and remaining installed acceptance. Neither schema tests
nor package registration prove persistent service operation.

`src/nnd-service-identity.js` now reads the explicitly selected installation,
validates bounded descriptor/payload metadata and canonical roots, and probes its
recorded Node executable with startup hooks removed. It never falls back to PATH.
Installation and data IDs derive from canonical paths; moving an installation
changes its installation identity, while retaining a data root retains its data ID.
The helper writes nothing and does not claim package signing or ACL verification.

`src/nnd-service-lock.js` now supplies the Windows named-pipe ownership primitive.
Concurrent processes and junction/case aliases share the same canonical data-root
lock. Release is idempotent; unexpected loss is observable and must stop admission
in the future supervisor. The pipe carries neither commands nor credentials.
These helpers are tested foundations, not wired lifecycle commands. Protected
Windows discovery storage, authenticated control, setup-first hosting, supervised
launch, startup registration and client migration remain required before enabling
`service_supervision`. Shared external catalogs require additional catalog ownership
before they can be opened; a data-root lock alone cannot protect those catalogs.

The Windows private-directory helper (`src/nnd-service-private-storage.js`)
now creates `runtime/nnd` with a protected DACL owned by the current operator,
allowing that SID, SYSTEM and Administrators. It validates existing directories
without changing their ACLs and rejects unsafe ancestor ownership/replacement
rights, null DACLs, foreign inherited grants and reparse points. The initial
storage scope is a local fixed drive; UNC/mapped-network and removable roots
are unsupported. A remote server's Administrators SID is not local-machine
trust, and a local singleton cannot protect a shared remote catalog.

The helper uses bounded native Windows PowerShell with paths on stdin, never
credentials in argv or environment. It does not yet write discovery credentials
or implement lifecycle control. Existing broad ACLs are not silently repaired.
Native disposable-directory tests cover creation, concurrent initialization,
unsafe permissions and unchanged evidence. Network-drive rejection is reviewed
in code; no mapped-share acceptance was run.

Protected discovery now uses immutable generation records and a secretless
`current.json` pointer. Each file has its own verified protected ACL. Publication
and removal compare the expected generation under an exclusive file handle.
Only a genuine held data-root lease can create or publish credentials. The
controller credential is generated internally and is distinct from engine and
browser credentials. Discovery is a candidate connection record, never proof
that a process is live or authorization to terminate a PID.

Successful replacement retires only its validated predecessor. Cleanup failure
reports the committed publication separately; malformed or unpublished evidence
is preserved. Generation retention and concurrent operations are bounded. The
private reader returns credential material and must never become a status-output
serializer. Authenticated controller challenge, lifecycle wiring and governed
orphan recovery remain required before advertising supervision.

Local `nna nnd serve` now starts its authenticated listener before session
restoration. Native health and `/v1/nnd/setup/status` remain reachable during
initialization or configuration failure. Status requires `nnd.setup.read`;
explicit `/v1/nnd/setup/activate` requires `nnd.setup.activate`. Activation reads
a bounded valid UTF-8 manifest with an explicit absolute workspace. It never
creates configuration or grants those permissions automatically.

The runtime publishes a host only after initialization succeeds. Missing or
invalid configuration produces setup-required state; catalog or engine failure
is distinct. Execution, raw secret use and provider network probes are blocked
until the host is ready. Configuration readiness does not prove provider network
availability. Existing scoped credential management remains available. Initial
configuration save and repair concurrency remain pending.

Activation and shutdown have explicit deadlines. Timed-out work remains owned
until it settles; late hosts are disposed and failed cleanup prevents another
activation in that process. Listener shutdown drains briefly, then closes held
connections so an SSE subscriber cannot prevent runtime shutdown. NNO keeps its
separate activation and secret realm. These native APIs do not yet supervise the
GUI child or advertise `service_supervision`.

## Responsibility boundaries

1. NNA core owns: the agent loop, governance decisions, the projection fold and its
   authored phase machine, session records, daemon lifecycle (`nna service start/stop/status`,
   OS service registration, health), loopback-first bindings, and the harness wire
   surface. NNA decides; it never renders the business layer's definitions.
2. Integration packages own their surface inside NNA's activation slots. NND provides
   the web GUI service (serves its own bundle) and the desktop shell. NNO provides the
   business layer: RBAC, user management, and managed NNA contexts per acting
   principal.
3. Clients (TUI, NND desktop shell, browsers) present state and set policy levels;
   they never decide engine truth. Permission-mode set/get is governance-owned.

## Deployment shapes

- Local personal: NNA core plus the NND local-integration package; tray and shell
  front NNA's lifecycle API; browser and desktop doors serve the same NND bundle.
- Headless server: NNA core plus NNO. No desktop package. Users reach the harness
  through NNO-managed contexts; root stays root.
- Delegated contexts: one engine instance per consumer principal (NNO users, gateway
  conversations), spawned through the headless mechanism and scoped by the acting
  principal's entitlement. The engine never holds more visibility than the principal.
- Remote clients: NND client-only installs connect to NNA instances that have the NND
  web-service package installed. GUI access is installed; it is never ambient.

## Binding and trust policy

Loopback by default. Token handshake applies even on loopback (shared multi-user
hosts). Exposing bindings beyond loopback is an explicit operator decision that
activates the auth surface and is presented as a consent moment in settings. Remote
clients always authenticate against the target instance's configured surface.

## Harness surface work NNA inherits (from the ecosystem ADR)

- Expose the doc-02 harness wire surface (REST + SSE) directly over `SessionEngine`
  with projection frames as first-class streaming payloads; frame replay and cursor
  semantics for remote durability.
- The NNA-authored phase machine is the sole turn-state authority on the wire.

NND root and child session descriptions carry a versioned projection of phase,
active-tool names/count, and numeric context observations. The identical
`nnd.projection` frame follows each created/updated description with the same
owner and full workspace scope. Engine-context epochs and monotonic display
revisions separate corrections from stale replay. The current authored phase
set contains twelve names; historical references to thirteen did not name a
thirteenth state. Unknown fields remain unknown. Replay is a bounded in-memory
suffix with snapshot recovery after restart, not durable event history.
- Permission-mode get/set as a governance-owned, session-scoped capability.

NND-owned root contexts expose authenticated `GET/PUT
/v1/nnd/sessions/:id/review-mode`. Reads need `nnd.read`; writes need
`nnd.session.update`, the owning principal/workspace scope, an idle session,
and the current revision. NNA persists the choice before changing its engine
posture and publishes the resulting `session.updated`. Failed persistence
does not change the running posture; stale writes fail rather than overwrite.

Available choices are `default` (startup `auto-review`), explicit `auto-review`,
and `unattended`. Review and hard policy remain mandatory in all choices.
The NND connection has no permission-decision voice, so `prompt` is unavailable;
there is no full-control bypass posture. This root-session setting does not
change NNA's separately governed delegated-child policy.

Authenticated `GET /v1/nnd/pending` requires `nnd.read` and observes the
complete owned root/child request set, including archived roots. It returns
`coverage: complete`, per-session permission/form arrays, and explicit
`unsupported` or `observe-only` capabilities. Native NND root engines expose
question forms as observe-only and permissions as unsupported. Headless and
delegated engines retain their own supported capabilities; unsupported arrays
do not clear semantic needs-input or governance attention. A missing or failed
broker observation is an error, never an empty request set. Live broker
snapshots expose bounded request identities and question batches, without
permission argument summaries, and grant no settlement authority. Completed
child display snapshots have no live broker. NND reconnects can therefore
replace stale display requests from engine state without replaying old
questions or inventing approval. Engine restart recovery does not resurrect
an interactive broker promise from transcript text.
- Session owner/affinity metadata and directory-less sessions.
- Identity/entitlement header slot (entitlement-neutral local token now; NNO
  principal pass-through later).

## Mid-turn operator questions

The native NND and OpenCode-wire surfaces expose one
operator-question contract, owned by the engine and voice-rendered per surface:

1. An unanswered question pauses indefinitely. It never times out into denial;
   only an authenticated `question_response`, an explicit `question_decline`,
   or turn abort settles it. The interactive permission broker's bounded
   approval window deliberately does not apply.
2. `question_response` and `question_decline` are canonical commands enabled
   by an operator-question voice. Native NND reads use `GET /question` with
   `nnd.read`; replies and declines use `/question/:id/reply` and `/reject`
   with `nnd.session.submit` and the owning principal/workspace scope. This
   question voice does not enable `permission_decision`. Headless engines
   without a question voice reject these controls.
3. The question broker is engine-internal and surface-neutral. Surfaces observe
   asked/settled events and render the transport voice; the broker decides
   nothing about rendering.
4. The batch shape keeps OpenCode question-tool parity: one to eight questions,
   one to sixteen labelled options each, answers as a row-per-question matrix
   of bounded labels. Option labels are unique. Answers cover every question,
   obey single/multiple selection and declared choices unless custom input is
   enabled. Bounds fail closed; partial answers never coerce. Native reply
   bodies allow 256 KiB for the bounded matrix after UTF-8/JSON encoding;
   other integration routes retain their existing 96 KiB limit.
5. Review posture never gates questions. Asking is operator speech, not an
   effect; an answer supplies exactly the choice it states and grants no
   execution authority. Authority remains reviewer-governed as in ADR 0002.

The wire session pins `auto-review` and mounts no permission card transport.
Semantic escalations on this surface settle immediately as
`deny_with_guidance` (governor `interactive_escalation_unavailable`) instead of
parking on a voice the wire does not carry; `permission_decision` remains an
interactive-only command with no route here.

The wire session is cancellable: `POST /session/:id/abort` submits the
authenticated engine `cancel` command and drains queued prompts that never
reached the engine. Operator-stopped turns settle as `cancelled`; the wire
voice labels their assistant finish `abort` so OpenChamber can render the
distinction. Pending questions release with `operator_cancelled` (clause 1).

## NND native live projection

The authenticated NND `/config` bootstrap projection reports only the
resolved primary provider ID and model ID from NNA's trusted manifest. It does
not expose provider endpoints, credentials, or the broader provider profile.
The current local bridge does not support per-prompt model or agent overrides:
matching primary-model requests and the `nna` agent marker are accepted, while
different selections fail before submission. NNA still owns routing, including
its configured fallbacks. NND presents this as a configured model, not a live
provider picker; a future override contract must be governed by the engine.
Each authenticated session description also reports only the configured route's
provider and model IDs. A delegated child reports its own subagent route, which
may differ from the root's primary route; this is not a claim about which
fallback actually answered a turn. Provider endpoints, profiles, and credentials
  remain private. The child route ID remains available in its bounded
  description after completion.
The delegated agent type is a separate, bounded display field in live and
retained child descriptions. NND does not infer it from the child title.

The NND integration host connects `SessionEngine.output` to its authenticated
session event stream. Text deltas form a bounded, temporary assistant preview;
completion removes that preview and publishes the canonical journal-backed
transcript. Tool lifecycle rows carry tool name and state, not arguments or raw
tool output. The Activity rail receives turn and tool events as live evidence.
An authenticated submit request ID is journaled with its user message and becomes
that message's NND ID. A repeated request ID after service restart cannot start
another turn. Journal-backed assistant messages carry completed time; the live
preview alone remains unfinished. Synthetic transcript-position IDs are reserved
so submitted IDs cannot collide with them. This keeps optimistic chat rows and
reloaded transcripts convergent without comparing message text.
Durable authority recovery accepts the bounded authenticated integration
principal shape persisted with NND submissions. It rejects arbitrary object
origins rather than treating a failed replay as an empty conversation.
For NND-created engines, numeric context-status measurements are emitted and
projected into session metadata as explicitly estimated token use and a known
limit, when available. The context text itself is never part of that projection.
The measurement is in memory only: after an NNA service restart, a restored
session reports no context estimate until its next governed turn.
Session metadata also projects the current NNA review posture and a classified
governance-record health summary when the engine supplies them. The summary is
limited to ready/attention/unavailable, journal durability, and bounded counts
of attention evidence, unsettled decisions, and uncertain effects. It does not
carry decision records, evidence bodies, authority references, tool arguments,
or credentials. A missing or failed health observation is not interpreted as
approval or as a healthy governance ledger.
The authenticated `GET /session/:id/activity` endpoint returns up to 500 recent
sanitized Activity records (`id`, `sessionID`, `time`, `kind`, `status`, `summary`).
It requires `nnd.read` and the session's complete original workspace grant.
Root-session snapshots persist beside the NND session catalog when that catalog
is durable; otherwise they remain in memory. A corrupt durable snapshot fails
session restoration clearly and is not silently replaced. Snapshot writes are
coalesced and observational: a write failure cannot change a governed turn.
The canonical transcript remains the authoritative conversation record; Activity
is a bounded recent operational view, not a complete audit ledger or cursor feed.
Completed child Activity is retained with its bounded display-only child
snapshot when the NND catalog is durable. Older child snapshots without
Activity reopen with an empty log. Neither root nor child Activity is a full
audit replay or SSE cursor feed.
Display delivery failures cannot change the governed engine outcome.

Child sessions appear under their NND parent in the session list. Their message
view is available during delegation and remains as a bounded excerpt after the
child finishes. When the NND catalog is durable, completed child descriptions,
transcript excerpts, and sanitized recent Activity persist as display-only
snapshots. Restoration requires the original parent creation time and complete
owner/workspace grant. Restored children have no live engine, busy state, or
steering grant. Closing the parent revokes child access and removes its snapshots.
Session reads and event delivery both require the full original workspace grant,
not merely a shared first workspace.
While a child runs, its own text deltas and tool lifecycle events stream under
the child session ID. The live text preview is bounded; on completion it is
replaced by the retained child transcript. Child event delivery is observational
and cannot change delegated work if a GUI subscriber fails.

## Related surface ADRs

The owned notification-text inference route requires its own
`nnd.notification.generate` grant. It supplies no tools or permission-decision
authority and does not alter a live turn or transcript. NNA validates bounded
untrusted context and strict title/body output, owns provider credentials, and
limits explicit configured-profile selection to the primary route's network
trust zone or an inward zone. NND remains responsible for deterministic fallback
and checking that the event is still eligible when generation finishes.

ADR 0018 (web operator surface) and ADR 0019 (native desktop surface) describe the
pre-ecosystem console direction. With this decision, NNA's own web console modules
(`web/console-*`) reconcile against the NND package: they either retire, remain the
fallback operator surface, or wrap NND. Reconcile explicitly before the NND package
activates beside them; do not run competing GUI stacks on one daemon.

## Explicit supervised local service

`nna nnd service run|start|status|stop|ui-ticket INSTALL_ROOT` uses the selected
installed NNA descriptor and its verified Node/CLI. The native supervisor holds
the data-root lease, hosts the setup runtime, publishes protected controller
discovery and launches the registered built NND child through private pipes.
Controller and engine credentials remain separate; public status contains neither.
The supervised listener derives operator permissions and the configured workspace
grant inside NNA on each request. Child headers cannot widen that authority.
Mandatory reviewer governance remains unchanged; provider connectivity stays unknown
until observed independently of service readiness.

Initial admission requires fresh data or the exact native owner marker. Current
legacy NND serve also holds this lease. Older installed hosts require explicit
migration; existing manifest/session/tab data is preserved and refused at first
admission. This is not full existing-user integration. The independent TUI keeps
its own catalog and identity. Login registration, configuration
save/repair concurrency and verified migration remain planned work.

Shutdown first stops native request admission and closes child attachment. It
drains native dispatch work, including configuration writes after socket closure,
before removing owned discovery and releasing the lease. Uncertain cleanup retains
ownership. Child restart budget is zero; malformed protocol or child exit ends the
owned service rather than opening a second engine.

## Concerns register

The local service also supports read-only `capabilities`, atomic `attach`, and
private-pipe `install-guard` commands. Attachment returns only selected identity,
generation, GUI endpoint and a short-lived UI ticket. It checks the same controller
generation before and after issuance. Native status uses the paired exact schema.
Electron redeems the UI ticket in a memory-only Chromium session shared by its
windows; native/controller credentials never enter the renderer. Shell exit leaves
the native service running.

An installation guard takes the same data-root lease before package mutation and
writes a protected durable marker. Explicit matching release followed by EOF clears
the marker after verified completion. Pipe loss alone retains ownership; process
death leaves the marker, which blocks supervised startup. Interrupted or failed
installation requires verified recovery. Existing-data migration remains separate.

## Concerns register

- `SessionEngine` in-process API vs the harness wire surface needs a gap pass
  (domain shapes, worktree metadata, permission request shapes).
- Projection fold push semantics need per-surface frame availability review
  (throttling, view filtering) before multi-surface frames ship.
- Lifecycle service hooks (OS registration, tray-less health probes) are
  prerequisites for the NND local-integration package and NNO service mode.
- NNO entitlement pass-through (run-as principal contexts) is a future engine and
  governance concern; the seam reserves the header slot now.

## Companion

The full topology decision, authority matrix, and client assembly order live in the
NND repository: `docs/architecture/0020-nna-ecosystem-topology.md`. This NNA-side ADR
is the authoritative statement of NNA's role, the add-on contract, and inherited
surface work; the two documents together lock the ecosystem framing.
