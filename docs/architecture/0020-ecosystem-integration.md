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
- Session owner/affinity metadata and directory-less sessions.
- Identity/entitlement header slot (entitlement-neutral local token now; NNO
  principal pass-through later).

## Mid-turn operator questions

The OpenCode-wire surface (OpenChamber-compatible serve mode) exposes one
operator-question contract, owned by the engine and voice-rendered per surface:

1. An unanswered question pauses indefinitely. It never times out into denial;
   only an authenticated `question_response`, an explicit `question_decline`,
   or turn abort settles it. The interactive permission broker's bounded
   approval window deliberately does not apply.
2. `question_response` and `question_decline` are canonical interactive-only
   commands. They travel the same authenticated ingress as `permission_decision`
   (wire: `/question/:id/reply` and `/question/:id/reject`) and are unknown
   controls elsewhere.
3. The question broker is engine-internal and surface-neutral. Surfaces observe
   asked/settled events and render the transport voice; the broker decides
   nothing about rendering.
4. The batch shape keeps OpenCode question-tool parity: one to eight questions,
   one to sixteen labelled options each, answers as a row-per-question matrix
   of bounded labels. Bounds fail closed; partial answers never coerce.
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

The NND integration host connects `SessionEngine.output` to its authenticated
session event stream. Text deltas form a bounded, temporary assistant preview;
completion removes that preview and publishes the canonical journal-backed
transcript. Tool lifecycle rows carry tool name and state, not arguments or raw
tool output. The Activity rail receives turn and tool events as live evidence.
These activity events are not yet a durable replay feed; reconnects recover the
canonical transcript, while durable activity replay remains separate work.
Display delivery failures cannot change the governed engine outcome.

Child sessions appear under their NND parent in the session list. Their message
view is available during delegation and remains as a bounded in-memory excerpt
after the child finishes. A completed child has no steering grant. Closing the
parent revokes child access. This child index does not yet survive an NNA service
restart; durable child discovery and activity replay remain separate work.
Session reads and event delivery both require the full original workspace grant,
not merely a shared first workspace.

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
