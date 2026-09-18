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
