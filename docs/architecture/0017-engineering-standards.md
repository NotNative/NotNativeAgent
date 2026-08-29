# Architecture decision 0017: NNA engineering standards

Status: accepted.

## Decision

NNA applies POWER10 to production code and GUI-POWER10 to interactive surfaces. These rules use
engineering judgment. They are review and design standards, not reasons for ceremonial refactors.

NNA controlled technical language remains defined by
[ADR 0016](0016-controlled-technical-language.md). It is inspired by ASD-STE100 Issue 9 without
claiming ASD-STE100 conformance.

## POWER10

1. Avoid recursion when bounded iterative or async-sequential control flow is practical.
2. Give loops, retries, traversals, and agent cycles explicit termination or convergence conditions.
3. Bound growing collections, queues, caches, buffers, retained history, and external input.
4. Keep functions cohesive and understandable. Treat roughly 60 lines as a diagnostic signal, not
   a mechanical limit. Extract code only when doing so improves responsibility or failure isolation.
5. Check meaningful return values and outcomes. Never silently swallow exceptions. Preserve or
   record actionable failure evidence.
6. Validate untrusted input, external data, state transitions, and critical invariants at their
   owning boundary. Do not duplicate noisy checks inside already-protected helpers.

## GUI-POWER10

1. Each authoritative state has one owner.
2. Each interaction changes only the state it names.
3. Rendering observes state and does not reinterpret user intent.
4. UI collections and work remain bounded without discarding authoritative data.
5. Lifecycle transitions and partial-failure recovery are explicit.
6. Hidden or inactive views remain inert.
7. Execution state comes from structured engine or service events, not presentation inference.
8. Platform-specific behavior stays behind capability adapters.
9. Tests assert state transitions and invariants, not snapshots alone.
10. Presentation failure preserves user control and authoritative state.

## Application

Apply the standards to every materially changed function, class, and interface. Inspect relevant
pre-existing code in a touched file, but do not broaden a focused change into unrelated cleanup.
Mark a genuinely irrelevant rule `NOT_APPLICABLE` with a short reason when a formal review needs a
disposition.

Where applicable, verification covers malformed input, cancellation, partial failure, recovery,
authorization, secret handling, observability, accessibility, responsive layout, and platform
differences. Deterministic evidence precedes semantic judgment.

The standards complement governance. They cannot grant authority, bypass review, weaken safety,
or replace evidence requirements.
