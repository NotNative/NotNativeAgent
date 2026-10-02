# Architecture decision 0020: NNA ecosystem topology

Status: accepted; product direction amended 2026-10-01.

## Current build authority

The [executable build guide](../build/PLAN.md) defines the Windows same-computer
release and changes required in the existing repositories. NND remains separately
installed and optional. Its installer detects compatible NNA and guides missing
setup. NNA retains its own TUI identity, tabs, sessions and interaction lifecycle.
NND is not a container for the TUI. Browser and desktop share NND's own collection.
All supported operator-configurable NNA settings must be available through the GUI
using native contracts; this does not make engine configuration surface-local.
The paired NNA ADR must be reconciled during L1 before its lifecycle contract changes.

## Decision

NotNativeDesktop is an add-on package and GUI product for NNA. NNA is the root,
headless-first agent harness: agentic engine, governance engine, projection, and
daemon lifecycle live in NNA core. The TUI is NNA's native interface. NNA core ships
without a web or desktop interface. NND provides the GUI as an integration package
(web service serving the GUI bundle) plus an installable desktop shell and remote
client. NNO is the business layer that installs on top of NNA and drives it.

The three products keep separate repositories, identities, and responsibilities. The
seam between them is NNA's versioned native integration surface. Reference doc 02
and the P-01…P-24 port catalog inventory consumers; they do not prescribe native
wire semantics. OpenChamber is inspiration
for NND's product surface only; it is not an integration target or architectural
authority.

## Product roles

| Product | Ships | Institutes | Does not |
|---|---|---|---|
| NNA core | Harness, TUI, headless/IPC, daemon lifecycle, governance, projection, providers | Add-on activation contract, service registration, loopback bindings | Own no web/desktop GUI; no surface configuration; no client policy |
| NND (local integration) | NND web-service package (GUI bundle + static serving + GUI-companion routes) mounted into NNA; desktop shell; tray | The GUI surface on a local NNA; tray + shell as the face of NNA's lifecycle API | Decide engine state; own lifecycle commands; ship services outside its package |
| NND (remote door) | Desktop shell + client sync engine + connection manager | Connections to NNA endpoints that have the NND web-service package installed | Spawn or host harness processes; substitute for the NNA TUI |
| NNO | Business layer: RBAC, user management, org integrations | Managed NNA contexts per user/conversation; entitlement pass-through | Grant NNA more visibility than the acting principal holds |

Installation rule (the keystone): NNA must be installed before its local NND
package. During source development, the NND installer may first ask to run the
local sibling NNA installer, or use an explicit unattended opt-in. It then
validates the installed NNA before copying or downloading the GUI package and
registers the built package with NNA before declaring success. An
NND client can only connect to an NNA instance with the NND web-service package
installed. GUI access is installed, like NNO — it is not a congenital feature
of the harness. A separately launched service process is an internal package
component under NNA supervision. NND still has its own product installer and
upgrade/removal lifecycle; this does not authorize an independently supervised
copy of NNA inside NND.

## Local integration boundary

NND is installed as an NNA integration package. NNA activates it, supplies the
authenticated engine-facing capability, and owns service lifecycle and listener
policy. NND supplies GUI assets, GUI-companion routes, and presentation state. The
Electron shell renders the activated web GUI; it does not become an engine host.

The package-to-engine transport is an NNA-owned, versioned local integration
contract. NNA may use an in-process adapter, a loopback service channel, or a
supervised subprocess. When a subprocess is used, standard input and standard output
carry framed protocol messages and standard error carries diagnostics only. No browser
or Electron renderer consumes that process stream directly. The final transport choice
must preserve the harness contract, authenticated authority, replayable projection
frames, cancellation, and bounded recovery.

This decision intentionally does not define a new wire format. Native NNA
activation and integration contracts own that work, with paired contract tests.
The native adapter already exists; preserve and extend it. Mock adapters remain
isolated test seams and cannot establish production feature completion.

## Engine contexts and lifecycle

- An **engine context** is one NNA engine instance scoped by surface identity,
  principal/entitlement, and directory root. Contexts spawn per consumer; the engine
  stays single-principal per instance.
- Resident service contexts belong to NNA. NND and delegated consumers receive
  their own authenticated contexts. The independent TUI retains its tab/session
  lifecycle; no shared resident TUI/NND session collection is required.
- Delegated contexts run with the acting principal's entitlement (run-as isolation).
  NNA must never see more than the user it acts for.
- Lifecycle split (confirmed): NNA core owns daemon lifecycle commands
  (planned service start/stop/status, startup registration and health probes),
  headless with zero desktop dependencies. NND contributes tray and shell controls
  for that lifecycle API. The independent TUI keeps its current tab/session model;
  TUI attachment to a resident engine is not an NND implementation prerequisite.
  The initial Windows service runs under the operator's account, survives GUI exits,
  and follows the explicit sign-in/logoff policy in execution guide 02.

## State and configuration authority

1. **Turn state**: NNA's projection is the single authority (authored phase vocabulary:
   idle, preparing, waiting_provider, reasoning, streaming, awaiting_approval,
   running_tool, recovering, attention_required, cancelling, failed, needs_input).
   This list does not prescribe a linear transition order; use NNA's native machine.
   Projection frames are first-class wire payloads with replay. NND maps frame state
   to presentation and DOES NOT derive its own turn state; client `idle|busy|retry`
   remains only as replica bookkeeping.
2. **Surface configuration**: each surface owns its own sessions and its own
   configuration. TUI tabs, NND folders, and directory-less general chats belong to
   the surface that created them; there is no cross-surface session sharing (v1).
   Layout, drafts and presentation preferences remain surface-local. NNA owns
   engine configuration, effective defaults and their legal scopes. The NND GUI
   exposes all supported operator settings through native validated contracts.
   Session model/agent/tool overrides require native admission; current configured
   model restrictions remain until those contracts exist.
3. **Resolved parameters**: the engine owns the resolved per-conversation values
   (model, agent, tools currently active). Surface presets may express requested
   choices only through native-advertised admission contracts. Current NND native
   sessions reject prompt model/agent overrides; F5 must implement authorized
   selection before consumers enable it. Preset storage never grants authority.
4. **Governance**: NNA's governance engine owns decisions. The permission-mode ladder
   (default / auto-review / unattended) is a governance-owned, session-scoped policy level;
   clients (TUI shift+tab, NND toggle) set it and present it, never decide it.
   Engine validation decides which levels a principal may use.
   Every supported NND mode retains NNA's mandatory reviewer; no Full control
   mode exists. Unattended denies unresolved escalations instead of prompting.
5. **Edge behavior**: optimistic sends, launcher state, and in-flight views are
   client-held intent awaiting engine echo. Reconciliation anchors on projection
   frames and replay; the client never asserts engine truth. NNA preserves an
   accepted user prompt's client message ID in the journal-backed transcript,
   suppresses a repeated ID after restart, and marks persisted assistant replies
   complete. NND replaces optimistic parts with authoritative parts even when
   their part IDs differ; it never deduplicates distinct turns by prompt text.

## Web and desktop mirror

The web GUI is primary; the desktop shell renders it. Desktop and web are two doors
to one served bundle and authoritative NND collection. Each client still must
reconcile events, snapshots, edits and reconnects; sharing assets does not itself
prove state consistency. Device layout may differ without changing engine state.

## Binding and trust

- Default binding: loopback only, with authenticated local bootstrap and origin
  checks. A UI bootstrap ticket, if used, is short-lived, one-use and distinct from
  the engine integration token/principal; exchange it for the authorized UI session
  and remove it from the URL. Never put engine authority into renderer state or
  URLs. L1/L3 must define the exact handshake and test other-user/guest rejection;
  convenient single-user setup does not mean anonymous privileged routes.
- Network exposure (0.0.0.0) is an explicit opt-in that activates NNA's auth surface
  (password/passkey/token) and recommends relay/TLS. The settings and first-run UX
  present exposure as a consent moment.
- A remote NND door exists only after a target NNA instance has activated the NND
  web-service package. It authenticates against that configured surface; the shell
  stores instances and entitlements per connection.

## Harness surface deltas (doc 02 amendment owner: NNA, via its harness package)

| Delta | Purpose |
|---|---|
| Projection frames as first-class streaming payloads | Authored state, ordered views, token accounting delivered; replaces client derivation |
| NNA-authored phase machine as sole wire authority | One state model for all surfaces; client mapping is presentation-only |
| Frame replay + cursor semantics | Reconnect durability for remote clients (NND client engine depends on it) |
| Mode get/set (governance level) | Client setters for permission modes; engine validates per principal |
| Per-request override contract (native work remains) | NNA admits supported model/agent/tool choices; current native NND sessions remain configured-model only |
| Session owner/affinity and directory-less sessions | Surface-owned session collections; general chats without a bound directory |
| Identity/entitlement header slot | Entitlement-neutral local token now; NNO principal pass-through later |

## Historical assembly outline

The following records the earlier assembly concept, not the remaining execution
order or current acceptance criteria. Native adapter/projection work now exists;
the L/C/F/V guide owns its repairs, installed migration and complete feature gates.

1. NNA harness surface (doc-02 wire on `SessionEngine` + projection fold push).
2. NND client attaches (adapter replaces the mock harness; 84 sync tests as the
   acceptance suite).
3. NND web-service package (GUI hosting fuses toward NNA packaging; NND's server
   role becomes the package, not a standalone product).
4. NND desktop shell (Electron; remote attach rides the same client path).
5. Verify independent TUI tabs and sessions still work after NND installation,
   operation, upgrade and removal. Do not migrate its interaction model into NND.
6. Delegated contexts (NNO user contexts with entitlement; gateway conversation
   restore; existing NNO headless pipe migrates only when it needs the new surface).

The executable L/C/F/V packages supersede the old numbered phase ordering.
Local authentication is required now. Remote deployment remains a later gate;
preserve existing transport security and implementation while completing the
Windows service, all native settings, and local chat/visibility workflows.

## Concerns register (for future operators, not current work)

- NNA's `SessionEngine` in-process API likely needs reshaping to expose the harness
  surface directly (domains, worktree metadata, permission shapes); treat as NNA-side
  cavitation work, observed by contract tests from both sides.
- NNA's `experience/projection.js` fold was validated for TUI and console map push
  semantics; multi-surface frame availability (throttling, per-surface views) may
  require additions.
- NNA's existing web console modules (`web/console-*`) and ADRs 0018/0019 describe an
  operator surface that the NND package supersedes or wraps; reconcile before the NND
  package activates alongside them.
- Lifecycle service hooks on NNA core (OS service registration, tray-less health) are
  prerequisites for step 3 and step 6; register early rather than late.
- Entitlement admission (NNO principal pass-through) is a future NNA concern;
  the seam reserves the header slot now so the retrofit is additive.

## Language

Registered terms introduced with this decision: integration package, engine context,
projection frame, shell (registry nnd-terminology.json; gates enforce usage).
