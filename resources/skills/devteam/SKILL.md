---
id: devteam
version: 2
description: Bring a full software-delivery team to turn an agreed change into a planned, implemented, tested, independently challenged, and evidence-verified delivery
invocation: both
requires_tools: [agent.run, fs.read_text, fs.write_text, fs.create_directory, fs.delete_file]
---
# Devteam

Treat every invocation as a request for the full delivery team. Quality verification is the default; do not require the user to know a special mode or keyword.

Resolve material product ambiguity with the user before implementation. Create `.devteam/` and preserve artifacts from an interrupted or blocked run unless the user authorizes replacement.

## 1. Establish the delivery contract

Delegate through `agent.run` with type `planner` to inspect the repository and write `.devteam/spec.md`. It must define:

- requested outcome, constraints, and explicit non-goals;
- observable acceptance criteria, including applicable UX qualities;
- affected components and interfaces;
- a dependency graph of bounded work packages;
- deterministic checks and evidence required for each criterion;
- integration risks and user decisions that cannot safely be inferred.

The planner must not edit product code or tests. Read the result and resolve missing or contradictory requirements before continuing. Do not accept vague criteria such as "excellent" or "be impressive" without observable evidence.

### Engineering standards inherited by every run

First discover and obey the target repository's own architecture, contributor guidance, language conventions, test commands, and acceptance standards. Add the following NNA baseline wherever it is relevant; do not require the user to ask for it.

Apply the general Power of Ten as an engineering sanity standard to every function and class in every file touched by the team, including pre-existing code in those files:

1. Avoid recursion when bounded iterative or async-sequential control flow is practical.
2. Give loops, retries, traversals, and agent cycles explicit termination or convergence conditions.
3. Bound growing collections, queues, caches, buffers, retained history, and external input.
4. Keep functions cohesive and understandable at a glance. Treat roughly 60 lines as a diagnostic signal, not a mechanical limit; extract only when it improves responsibility or failure isolation.
5. Check meaningful return values and outcomes. Never silently swallow exceptions; preserve or record actionable failure evidence.
6. Validate untrusted inputs, external data, state transitions, and critical invariants at their owning boundary without duplicating noisy validation inside already-protected helpers.

Use judgment. These rules exist to improve reliability, readability, and efficiency, not to generate ceremonial refactors.

For terminal, web, desktop, or mobile interface changes, also apply the UI Power of Ten:

1. Each authoritative state has one owner.
2. Each interaction changes only the state it names.
3. Rendering observes state and does not reinterpret user intent.
4. UI collections and work are bounded without discarding authoritative data.
5. Lifecycle transitions and partial-failure recovery are explicit.
6. Hidden or inactive views remain inert.
7. Execution state comes from structured engine or service events, not presentation inference.
8. Platform-specific behavior stays behind capability adapters.
9. Tests assert state transitions and invariants, not snapshots alone.
10. Presentation failure preserves user control and authoritative state.

Where applicable, the delivery contract must also include security and authorization boundaries, secret redaction, useful local observability, cancellation and recovery behavior, cross-platform differences, keyboard and screen-reader accessibility, responsive layout, and failure-path tests. Mark a standard `NOT_APPLICABLE` with a short reason rather than pretending to verify it.

## 2. Build in dependency waves

Delegate through `agent.run` with type `coder` according to the dependency graph. Give each coder only its work package, relevant interfaces, acceptance criteria, and required handoff. Each writes a package handoff under `.devteam/packages/<id>/changes.md` with files changed, decisions, checks run, and remaining concerns.

Run independent packages concurrently only when their file ownership and interfaces do not overlap. Concurrency must follow NNA's discovered sub-agent capacity. Serialize overlapping edits and integration-sensitive work. A coder must read an existing file before modifying it and must not broaden scope.

## 3. Verify with evidence

Delegate through `agent.run` with type `tester` to run the deterministic checks in the contract, add focused tests where authorized, and write `.devteam/packages/<id>/test-results.md` with exact commands, outcomes, and criterion coverage. Deterministic evidence comes before semantic judgment.

The tester must exercise applicable Power of Ten boundaries and UI invariants, including malformed input, cancellation, partial failure, and recovery paths—not only the happy path.

After package checks pass, delegate through `agent.run` with type `reviewer` against distinct relevant dimensions such as correctness, specification compliance, Power of Ten, UI Power of Ten, security, reliability, observability, maintainability, accessibility, or visual quality. Run independent read-only reviews concurrently when capacity permits. Give reviewers the specification, artifact, diff, and test evidence, but not the builder's private reasoning.

Each reviewer writes a bounded findings artifact containing, for every material finding:

- failed acceptance criterion;
- concrete file, test, screenshot, or runtime evidence;
- severity and confidence;
- responsible work package;
- the verification that would demonstrate repair.

Reviewers do not edit product code or tests. Subjective assertions without evidence are advisory, not release blockers.

## 4. Integrate findings and repair

Have the parent agent deduplicate findings, reject unsupported claims, resolve cross-package conflicts, and maintain `.devteam/acceptance-ledger.md` with every criterion marked `PASS`, `FAIL`, `BLOCKED`, or `NOT_APPLICABLE` plus its evidence.

Send only failed criteria and relevant evidence back to the responsible `coder`; then rerun the affected tester and reviewer checks. Do not impose a fixed number of repair cycles. Continue while material progress occurs. Stop and report rather than churn when:

- all required criteria pass;
- the same finding or tool-request fingerprint repeats without new evidence;
- repairs oscillate or create contradictory findings;
- an external dependency or user decision blocks verification;
- the user cancels or an explicit mission deadline is reached.

## 5. Whole-product integration gate

After package criteria pass, delegate a final `tester` for repository-level regression checks and a fresh `reviewer` for cross-component assumptions, unintended scope, and requirements traceability. Update the acceptance ledger from evidence; a package-level pass cannot override an integration failure.

Write `.devteam/final-summary.md` with the delivered outcome, changed-file summary, verification evidence, review disposition, repaired findings, and remaining user action. Report it concisely.

Do not commit, push, switch branches, publish, deploy, or broaden scope unless the user separately authorizes it. Preserve evidence on failure or uncertainty. On success, retain the final summary and acceptance ledger; intermediate artifacts may be removed only after their evidence is represented there.
