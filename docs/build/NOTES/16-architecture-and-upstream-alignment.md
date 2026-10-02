# Architecture and upstream-alignment audit

> **Historical implementation note — 2026-10-01:** Retained for contracts and dated evidence.
> Current scope, ownership, remaining work, and acceptance are defined by
> [PLAN](../PLAN.md) and the [execution audit](../EXECUTION/01-architecture-audit.md).
> Old mock-only, auto-accept, lifecycle, and deferral instructions are superseded.
> A recorded test pass is limited to its stated version and surface.


Date: 2026-09-24
Authority: user direction in the active NND workspace
Scope: NND architecture and product-inspiration delta; no production code changed.

## Decision record

NNA is the agentic engine and governance authority. It owns execution, projection,
authority decisions, service lifecycle, and network-listener policy. NND is a separate
product that installs as an NNA web-service integration package. It owns the GUI bundle,
GUI-oriented routes, and presentation state. Electron is a desktop shell that renders
the NND web GUI; it does not host a second engine.

The normal local door binds to loopback. LAN binding is an explicit operator choice,
not a desktop convenience flag, and must activate the NNA-authenticated exposure path.
NND may supply the UI for that decision but cannot weaken it.

The eventual NNA/NND local contract is NNA-owned and versioned. An in-process adapter,
loopback channel, or supervised subprocess can carry it. If NNA supervises NND as a
subprocess, stdin/stdout are framed protocol channels and stderr is diagnostics only.
This note deliberately does not choose a framing protocol or make a renderer consume
the stream. The integration must preserve authenticated authority, cancellation,
replayable projection frames, and bounded recovery.

## Existing-doc alignment

ADR 0020 already established the core topology: NND as an NNA integration package,
loopback by default, explicit network exposure, and Electron as a rendering shell.
This audit clarifies three points in the governing documents:

1. OpenChamber is product inspiration, not an integration target or architectural
   authority.
2. A remote NND door is available only through an NNA instance with the NND package
   activated; NND is not a standalone engine server.
3. NNA owns activation, lifecycle, binding policy, and the eventual local contract.

## Upstream inspiration delta

The baseline planning corpus remains a v1.23.0 static-analysis record. A read-only
product-level audit of the local OpenChamber checkout, currently v2.0.1, used its
README, package topology, and 2.0.0/2.0.1 changelog. No upstream source code, assets,
or dependencies were copied. The following is an independently worded backlog of
capabilities to evaluate against NNA rather than a parity mandate.

| Candidate capability | NND planning status | NNA-first interpretation |
|---|---|---|
| Usage history and per-model/project cost/token views | Not separately enumerated in the GUI inventory | NNA should expose auditable accounting projections; NND renders them without inventing authority. |
| Restart/reload after configuration or extension changes | Partial lifecycle surfaces exist | NNA must decide which configuration is live-reloadable and which operation is safe; NND requests and reports the outcome. |
| Warm idle-session prompt cache | Not enumerated | Treat as an NNA resource-policy feature with explicit accounting and cancellation, never a hidden UI poll. |
| Plugin/agent-origin notices and plugin-generated notifications | Plugin UI is a P10 concern; notifications exist | NNA should attest origin and permission; NND should show status and notification receipts. |
| Script/code-mode tool batches | Not separately enumerated | NNA governance must validate every constituent operation; NND renders the batch and its evidence. |
| Browser-provider service with user take-over | Preview/inspection exists but provider takeover is not explicit | Define an NNA capability/service contract before a GUI surface; preserve the browser isolation boundary. |
| Rich file previews and folder uploads | Files/review is present; preview types/uploads need a gap review | Keep preview parsing and upload grants bounded and workspace-scoped. |
| Diff file-tree navigation, quoted-comment lifecycle, and `/fork <prompt>` | Related review/fork/comment pieces exist; these exact acceptance cases are not enumerated | Add as GUI acceptance tests after the current review/chat slices, using NNA session and comment authority. |
| Suggested next-step signal, worktree sort controls, and cross-project timeline polish | Related sidebar/status surfaces exist | Treat as presentation over NNA projection frames, never as a second activity classifier. |
| OAuth-aware MCP controls and custom provider capability display | MCP/provider management is planned | NNA remains the configuration and secret authority; NND can provide the editable, explained surface. |

## Next contract work

Before replacing the mock harness, write a joint NNA/NND contract slice that settles:

1. NND activation manifest, version negotiation, capability declaration, and readiness
   receipt.
2. NNA-owned local endpoint or subprocess lifecycle, including stdout protocol versus
   stderr diagnostic separation when subprocess activation is chosen.
3. Projection-frame replay, cursor, cancellation, governance mode get/set, permission
   and question flows, and authenticated identity/entitlement propagation.
4. Loopback-only default, explicit LAN consent gate, authentication requirements, and
   an exposure-state projection NND can display.
5. A contract test suite runnable against the NND mock and the real NNA integration.

## Non-goals

- Do not copy OpenChamber implementation code, assets, or dependency choices.
- Do not make NND a second agent engine, lifecycle owner, or governance authority.
- Do not expose a LAN listener implicitly through Electron or a development default.
- Do not select a process transport before the NNA activation contract is designed.
