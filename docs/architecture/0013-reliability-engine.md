# ADR 0013: Reliability Engine ownership

## Status

Accepted.

## Decision

NNA has one `ReliabilityEngine` that owns evidence-based judgments about execution
progress, protocol integrity, context fitness, provider/model behavior, and bounded
recovery. Its helper implementations live under `src/reliability/`.

The Reliability Engine owns:

- per-turn recovery supervisors, episode budgets, progress evidence, exhaustion facts,
  and recovery guidance;
- completion supervision, including explicit or usage-inferred truncation, lost-task,
  unfinished-work, unfulfilled future-action pledges, and unresolved-tool-failure judgments;
- context budgeting, long-horizon pressure policy, deterministic hot/cold projections,
  and cold-evidence continuity;
- context-compression safety classification, content-identity duplicate receipts,
  tokenizer-aware efficacy measurements, rediscovery accounting, and outcome-equivalence
  evaluation;
- compaction projections, continuation artifacts, semantic continuation refinement, and
  handoff generation;
- provider-context-limit, reasoning-only, and reasoning-truncated-before-action recovery decisions;
- bounded, turn-local continuation of provider-native `reasoning_content` across tool
  boundaries on the same provider profile and model;
- model-dialect observations and reliability guidance;
- authoritative host-environment facts, shell-command shaping signals, and unavailable-interpreter recovery guidance;
- cross-platform process-instance identity used to distinguish live owners from recycled PIDs;
- command-shaping signals and repair guidance for fragile inline interpreter programs;
- deterministic reconciliation of tool requests left open by process interruption, distinguishing calls that were never dispatched from calls whose external effect is unknown;
- content-free provider-request manifests and immediate pre-transport reconstruction checks;
- complete provider-envelope measurement, pre-transport context admission, and content-free
  per-attempt token receipts that distinguish provider measurements from conservative estimates;
- bounded, route-specific observations of provider cache hits used to select cache-aligned semantic compaction;
- tool-call stream assembly and protocol-integrity bounds;
- stable tool-progress and failure fingerprints; and
- deterministic filesystem-prerequisite extraction, shared-root failure grouping, and
  recovery guidance that requires a missing ancestor before descendant mutations;
- convergence-aware productive-loop supervision: distinct successful evidence may continue
  through the configured model-step ceiling, while unchanged success, narration, and repeated
  failures consume bounded no-progress budgets before parking for operator attention; and
- provider-activity interpretation in which typed reasoning, text, tool fragments, usage, and
  terminal events are live stream activity without exposing private reasoning content.

The engine consumes facts and returns bounded decisions. It does not execute tools,
grant authority, mutate provider wire protocols, own the transcript, publish interface
state, or persist Session Engine lifecycle records.

## Execution boundary

`SessionEngine` remains the owner of turns, model steps, lifecycle transitions,
transcript state, and durable recovery records. It applies Reliability Engine decisions.
Provider adapters remain responsible for translating route controls to provider wire
formats. Governance remains the sole authority and admissibility boundary. Experience
remains responsible for presentation and operator interaction.

In shorthand:

- Agentic Engine: what happens next;
- Governance Engine: whether and how an action is authorized;
- Experience Engine: what the operator sees and controls; and
- Reliability Engine: whether execution is healthy and which bounded continuation class
  is permitted.

Reliability may recommend retry, context reduction, reasoning disablement, continuation,
operator input, or termination. It cannot turn a governance denial into approval or
bypass review.

## Compatibility and migration

The former module paths remain forwarding facades during migration. Existing extensions,
tests, and callers may continue importing those paths without behavioral change. Runtime
code uses the Reliability Engine facade so there is one authoritative composition root.

The `engine.dialects` and `engine.continuationCompactor` properties remain transitional
aliases to Reliability Engine-owned components. They do not represent independent state.

## Invariants

1. Reliability decisions are deterministic for the same facts except for an explicitly
   bounded retry delay.
2. Recovery is finite, observable, checkpoint-aware, and never replays external effects.
3. New authenticated input or changed external evidence may settle stale recovery
   episodes; narration alone may not manufacture authority.
4. Context projection never mutates or replaces the durable session ledger.
5. Reliability cannot depend on Session, Governance, Experience, TUI, or gateway owners.
6. A behavior-preserving migration retains existing lifecycle events, recovery records,
   public result shapes, configuration semantics, and provider requests.
7. A provider request must still match its durable manifest immediately before every
   transport attempt; nested request mutation fails closed instead of sending drifted input.
8. Startup reconciliation must pair every interrupted tool request with a durable result,
   but must never claim that a dispatched external effect did or did not occur.
9. Every dispatched provider attempt receives one durable token receipt. Provider-reported
   usage remains authoritative; absent or partial usage is represented separately as an
   estimate and is never relabeled as measured consumption.
10. A stale filesystem prerequisite may clear only from structured success that proves the
    required directory exists: exact creation, exact listing, or a successful direct-child
    filesystem operation. Unstructured shell success is not accepted as proof.
11. Productive steps are bounded by the configured model-step ceiling, not a small legacy
    turn cutoff. Every continuation must still contribute distinct verified evidence.
12. A typed reasoning chunk resets provider idle observation exactly like other valid stream
    events, while the overall attempt deadline remains authoritative.
13. Completion headroom and input pressure are planned together. An unconfigured ordinary
    route receives a bounded 32,000-token completion ceiling, reduced only by an explicit
    provider/route limit or a smaller discovered context window. Reaching that ceiling during
    hidden reasoning is not classified as an ordinary empty response.
14. Private reasoning continuity is ephemeral and route-bound. It is never written to the
    session ledger, telemetry payloads, support archives, or operator output. Only a provider
    that emitted OpenAI-compatible `reasoning_content` receives it back, and only on the same
    provider profile and model. Complete reasoning blocks are retained while the effective input
    envelope has room. Under actual context pressure, whole oldest blocks yield first; a partial
    suffix is never replayed as though it were complete. An individual block that exceeds its
    bounded turn-local capture allowance is omitted rather than truncated.
15. Primary turns consistently honor the route's configured reasoning behavior across ordinary
    tool continuations. Only a typed reasoning-only recovery may temporarily retry without
    reasoning; specialist and sub-agent routes remain independently configured.
16. Completion supervision treats provider-reported output usage at the exact requested ceiling
    as truncation even when a compatible provider labels the finish `stop`. Concrete future-action
    pledges such as `let me verify` or `I will implement` are partial progress, not terminal task
    completion; the engine preserves the text and issues a bounded continuation hint.
17. Language-derived completion judgments and unchanged durable-work state have category-specific
    continuation limits below the global model-step ceiling. When the evidence does not change,
    NNA parks the active turn for operator attention instead of manufacturing progress or ending
    the durable goal. New tool evidence or authenticated steering resets stale recovery episodes.

## Consequences

New reliability mechanisms enter through `ReliabilityEngine` and receive explicit facts.
Session orchestration stays smaller and model/provider compatibility can improve without
weakening governance. Compatibility facades can be removed only in a separately versioned
breaking change.
