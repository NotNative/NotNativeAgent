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

## Responsibility boundaries

1. NNA core owns: the agent loop, governance decisions, the projection fold and its
   13-state machine, session records, daemon lifecycle (`nna service start/stop/status`,
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
- The 13-state projection machine becomes the sole turn-state authority on the wire.
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

ADR 0018 (web operator surface) and ADR 0019 (native desktop surface) describe the
pre-ecosystem console direction. With this decision, NNA's own web console modules
(`web/console-*`) reconcile against the NND package: they either retire, remain the
fallback operator surface, or wrap NND. Reconcile explicitly before the NND package
activates beside them; do not run competing GUI stacks on one daemon.

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
