# Learning and memory ownership

NNA, NNM, and NNO share one learning contract without requiring one another to run.

## Ownership

- NNA owns optional local workspace continuity in `NNA.md`: project knowledge, decisions,
  architecture, verified environment state, known problems, and unresolved work. This path
  remains available when no external memory system is installed.
- Repositories own portable agent policy in `AGENTS.md`: engineering rules, commands, naming,
  layout, and contribution cadence.
- NNM owns structured durable knowledge: user preferences, named entities, relationships,
  provenance, confidence, conflicts, supersession, and cross-session retrieval.
- NNO owns authenticated business identity and scope. It supplies subject, workspace,
  group, and module boundaries to hosted NNA sessions; it does not become a second memory
  store.

NNM enables deep integration through its client bundle. NNA exposes hooks and consumes
their bounded results, but it does not require NNM or implement NNM semantics internally.

## Shared candidate contract

Learning candidates use `notnative.learning-candidate/1.0` and declare a destination:

- `project_memory`: handled by NNA's project-memory reconciler.
- `structured_memory`: eligible for NNM reconciliation when its bundle is installed.
- `discard`: diagnostic-only material that must not be persisted.

A structured-memory candidate must be self-contained outside the source turn. References
such as "both nodes", "that server", or "the current model" are rejected unless the
named entities are resolved. Existing related knowledge is read before a write; equivalent
candidates are omitted and mutable facts use NNM's temporal fact channel.

## Hosted isolation metadata

NNA hook payloads include a redacted `notnative.identity-scope/1.0` envelope containing
only bounded subject, role, workspace, group, module, project, and session identifiers.
It contains no bearer token, permission list, or secret. The envelope scopes retrieval and
reconciliation but grants no authority. NNO's authenticated hosted contract and NNM's own
server-side authorization remain the enforcement boundaries.

## Failure policy

Learning is advisory to turn completion. Invalid, ambiguous, duplicate, or unavailable
memory candidates are discarded or retried by their owning integration; they never wedge
or invalidate the foreground conversation. Every accepted or rejected effect remains
observable through the existing hook receipts and governance telemetry.
