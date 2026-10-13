# Architecture decision 0017: NND engineering standards

Status: accepted.

## Decision

NotNativeDesktop applies POWER10 to production code and GUI-POWER10 to interactive
surfaces. These standards use engineering judgment. They are review and design standards,
not reasons for ceremonial refactors. NND controlled technical language remains defined by
[ADR 0016](0016-controlled-technical-language.md).

Unlike the sister product, NotNativeDesktop enforces the mechanical POWER10 subset through
`scripts/quality-gates.js` with hard limits: 500 lines per production file, 60 lines per
function, bounded file sizes, no trailing whitespace, Apache-2.0 SPDX headers, and runtime
dependencies inventoried in `dependency-registry.json`. `npm run check` composes these
gates with the repository graph check and the controlled-language gate.

## POWER10

1. Avoid recursion when bounded iterative or async-sequential control flow is practical.
2. Give loops, retries, traversals, and agent cycles explicit termination or convergence
   conditions.
3. Bound growing collections, queues, caches, buffers, retained history, and external
   input.
4. Keep functions cohesive and understandable. 60 lines is the enforced matrix maximum;
   extract code only when doing so improves responsibility or failure isolation.
5. Check meaningful return values and outcomes. Never silently swallow exceptions.
   Preserve or record actionable failure evidence.
6. Validate untrusted input, external data, state transitions, and critical invariants at
   their owning boundary. Do not duplicate noisy checks inside already-protected helpers.

## GUI-POWER10

1. Each authoritative state has one owner.
2. Each interaction changes only the state it names.
3. Rendering observes state and does not reinterpret user intent.
4. UI collections and work remain bounded without discarding authoritative data.
5. Lifecycle transitions and partial-failure recovery are explicit.
6. Hidden or inactive views remain inert.
7. Execution state comes from structured engine or service events, not presentation
   inference.
8. Platform-specific behavior stays behind capability adapters.
9. Tests assert state transitions and invariants, not snapshots alone.
10. Presentation failure preserves user control and authoritative state.

## Application

Apply the standards to every materially changed function, class, and interface. Inspect
relevant pre-existing code in a touched file, but do not broaden a focused change into
unrelated cleanup. Mark a genuinely irrelevant rule `NOT_APPLICABLE` with a short reason
when a formal review needs a disposition.

The standards complement governance. They cannot grant authority, bypass review, weaken
safety, or replace evidence requirements.
