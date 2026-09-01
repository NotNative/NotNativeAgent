# Architecture decision 0005: operator product and release candidate

Status: accepted for milestone 5 implementation; external release acceptance pending.

The interactive **NNA Console** is an adapter over `SessionEngine` and
`CanonicalIngress`, not an agent loop. A bounded deterministic projection owns view state,
one editor owns each conversation's draft, and rendering is observational. Terminal
capability detection, raw-mode lifecycle, input decoding, escape neutralization, and frame
layout are separate adapters. Hidden conversations consume bounded engine events but do
not receive input or repaint. The terminal owner restores bracketed paste, cursor, raw
mode, and alternate-screen state idempotently on exit and signals.

Reviewer escalation uses an engine-owned interactive permission broker. Only the TUI
ingress accepts permission decisions. Every prompt identifies one immutable request and
expires; allow-once/deny/cancel are distinct actions. The private ledger records the
reviewer escalation and authenticated operator outcome, after which the ordinary
execution-boundary revalidation still controls execution. Headless and one-shot surfaces
cannot express this command.

Operating-system elevation is not a reviewer escalation prompt. After the reviewer approves
`system.elevate`, the Console returns the terminal to native UAC or `sudo` authentication.
That native operation blocks the active workflow and can wait for an absent operator. A native
rejection, cancellation, or timeout records no authorization and does not run the command.

Multiple attached conversations share a bounded fair provider scheduler while retaining
independent engines, transcripts, authority, drafts, cancellation, and projections.
Configuration changes publish immutable versions only at idle or a model-step boundary.
Persistence and MCP topology changes require a new session. Generic configuration publication
cannot change workspace scope. A reviewed `workspace.change` tool can replace one conversation's
working directory without changing provider, host, mission, or governance configuration.

Observability consists of content-free bounded structured logs, read-only health,
expanded redacted governance audit, and explicit local diagnostic bundles with preview
across TUI, headless, and plain-text surfaces, with no upload behavior. Headless protocol
and local log records retain the same non-content correlation identities. Health reports
effective source provenance, provider/model reachability,
persistence and lock evidence, deterministic and semantic reviewer status, memory, hooks,
event-queue pressure, MCP, extensions, sandbox containment, and context pressure without repair
or inference side effects. Session export is redacted by default and includes separate
transcript and reviewer-ledger records plus a category preview. Deletion requires an exact
confirmation and moves controlled transcript, ledger, attachment, backup, migration, and
recovery artifacts to recoverable local trash while reporting every incomplete move.

Authenticated stdio hosts receive one immutable execution snapshot per session. Host
capability declarations are ceilings: disabling tools leaves the registry empty, while
memory, attachment, MCP, and steering restrictions are enforced at their canonical
boundaries. Cancel-on-disconnect is mandatory. The safe snapshot is persisted and checked
on resume so a different or missing host manifest cannot silently inherit the session.

The distribution remains dependency-free JavaScript for Node.js 24 or newer; platform
installers reuse a compatible operator runtime or retrieve a checksum-verified per-user
Node.js 24 LTS binary. Automated release-candidate gates verify tests, static bounds,
license and SBOM metadata, dependency notices, platform evidence, and release hashes.
Native multi-platform, live-server, security, accessibility, performance-lab, and
interaction-design reviews remain human publication gates and are not inferred from
automated tests.
