# Architecture decision 0007: evidence-governed runtime

Status: accepted incrementally, 2026-08-06.

NNA governance is the shared control plane for what the runtime may do, what information
it may treat as support for a claim, and what observed behavior may become durable
guidance or learning. Governance does not mean one universal LLM reviewer. It is a common
record and policy boundary containing distinct domains with different evidence and
failure rules.

## Domain separation

1. **Action authorization** decides whether a prepared operation may execute. The
   mandatory reviewer remains its current policy implementation.
2. **Evidence admission** decides whether retrieved or observed information is eligible
   to enter model context and under what labels.
3. **Memory eligibility** applies scope, freshness, conflict, supersession, and
   invalidation rules before memory injection.
4. **Guidance promotion** governs movement from an observed correction to project or
   global operating guidance.
5. **Learning promotion** governs model-dialect, recovery, routing, and skill candidates.
6. **Claim support** binds material local, current, or consequential assertions to
   admitted evidence without adding an unconditional second LLM pass to every response.

Authority and epistemic reliability remain deliberately separate. A tool result may be
strong evidence that an observation occurred while remaining untrusted as an instruction.
A user statement may authorize an action without proving an unrelated factual claim.

## Evidence contract

Every governed evidence record has a stable identity, origin, trust class, scope,
observation time, validity interval, freshness, conflict state, lifecycle state, source
fingerprint, and content fingerprint. The governance journal stores references and
fingerprints rather than duplicated transcripts, tool output, credentials, or unrestricted
memory content. Raw supporting material remains with its owning bounded journal, forensic
event, memory record, file, or retrieval artifact.

Evidence lifecycle is explicit: `active`, `stale`, `conflicting`, `quarantined`,
`superseded`, `invalidated`, or `expired`. State changes are append-only decisions with
reason codes and supporting evidence references. Invalidated evidence cannot silently
become active again. A replacement is registered as new evidence and may supersede the
old record.

## Decision contract

Each decision records its policy domain, subject reference and fingerprint, outcome,
stable reason code, policy version, evidence references, authority references, decision
time, expiry, and terminal effect when applicable. Decision identities cannot be reused
with changed content. Execution settlement distinguishes applied, not-applied, failed,
cancelled, and unknown-effect outcomes.

Health counts a decision as unsettled only when its policy domain expects a later effect:
action authorization and an approved guidance or learning promotion. Evidence admission,
memory eligibility, claim support, rejection, and deferral decisions are themselves final
classifications and do not create a false incomplete-effect warning.

The initial implementation mirrors mandatory-reviewer decisions into this shared record
while retaining the existing reviewer ledger. This is a compatibility migration, not a
second authorization vote. Once field evidence proves recovery and diagnostics, the
reviewer ledger may become a domain-specific projection of governance records.

Each mirrored authorization decision cites two immutable, content-free evidence records:
the sealed tool request and the authenticated intent snapshot considered for that exact
request. The records contain hashes, versions, scope, and classifications—not prompt text,
arguments, credentials, or tool output. Execution settlement is then attached to the same
governance decision, producing one causal chain from authority through review to effect.

## Durability and observability

The governance journal is local-only, hash-chained, flush-before-effect where required,
bounded by retention, and restored before durable session work resumes. Corrupt tails fail
initialization rather than silently discarding governance history. All evidence,
decisions, transitions, and terminal effects also emit sanitized forensic telemetry with
stable correlations. Support artifacts expose classified projections and fingerprints,
not secrets or unrestricted learned content.

The session journal remains the conversational source of truth. Forensic SQLite remains
the detailed troubleshooting timeline. The dream database remains the idle-maintenance
checkpoint and candidate store. Governance links these systems; it does not duplicate
their full payloads.

## Learning rule

Model output alone can propose a candidate but cannot promote it. Durable learning needs
attributable evidence, correct scope, acceptable freshness, resolved conflicts, a
measurable success criterion, and the promotion policy required by its candidate type.
Failed, cancelled, denied, malformed, unknown-effect, or otherwise uncertain episodes are
quarantined until independently resolved. Self-learning never expands authority.

## Memory admission

Recalled memory crosses an epistemic boundary before it enters provider context:

- current, non-conflicting memory is admitted with attribution;
- memory with unknown freshness is admitted only as qualified, unverified context;
- stale memory is admitted only as historical context and must be revalidated before a current assertion;
- conflicting memory is quarantined and excluded from provider context.

Every considered item receives a content-free evidence record and a `memory_eligibility`
decision. The governance journal stores fingerprints, source references, scope, policy
version, and disposition; it does not duplicate the recalled memory text.

Workspace `NNA.md` files and hook-supplied context cross the same evidence boundary.
Workspace guidance is admitted as configured behavioral policy for its path scope; it
cannot prove a factual claim or expand authority. Hook context remains untrusted,
qualified context. A changed guidance document supersedes its prior fingerprinted
version, leaving an auditable history without retaining a second copy of its content.

Retention preserves referential integrity: governance will drop older decisions before
it permits a retained decision to outlive the evidence records it cites.

## Performance rule

Deterministic policy is preferred. Semantic governance runs only when uncertainty or
consequence justifies it. NNA does not add a general claim-supervisor inference to every
turn. Foreground work wins over idle analysis, and governance persistence is bounded by
the same cancellation, shutdown, and supportability expectations as the agent engine.

## Context as addressable evidence

Compaction controls provider input; it does not erase the durable conversational source
of truth. The active context keeps the current turn and five newest completed turns as
intact as practical, while older records remain addressable through bounded, redacted
session-history tools. Search returns record indexes and snippets; an exact read must name
an index and may request only a small neighboring window. This lets a smaller model recover
an earlier requirement or result without reinjecting an entire transcript or inventing a
summary from memory.

History lookup is session-local and read-only. It cannot recover a deliberately cleared
conversation, inspect another principal's session, widen hosted authority, or bypass
secret redaction. Search/read activity emits content-free telemetry so context recovery
can be evaluated without storing a second transcript.

## Refinement and execution boundary

Behavioral refinements are supplemental candidates, not rewrites of the engine policy,
reviewer floor, authority model, secret boundary, or evidence rules. Model output may
propose a candidate; promotion requires attributable eligible evidence, measurable success
criteria, and explicit active authority. Candidate identity and payload fingerprints are
immutable, state transitions are checked, and regression/rollback states remain auditable.
Activation never expands tools, scope, permissions, or hosted capability grants.

Sub-agents are children of an active parent tool call. Capacity may permit concurrent
children, but cancellation propagates and every child is shut down before `agent.run`
settles. Tabs and Telegram attachments may retain resumable session state; they do not
retain execution authority or continue work after the active turn ends. Hosted NNO
sessions retain the same rule and additionally omit root sub-agent authority unless a
future authenticated derived-authority contract explicitly supplies it.

Completion is evidence-gated rather than duration-gated. Durable conversation goals
cannot complete while tasks remain pending, active, or blocked, and every completed task
and goal requires evidence. `/devteam` adds package acceptance ledgers, deterministic
checks, independent review, repair convergence, and a whole-product integration gate.
Failure leaves inspectable state; it does not create a detached worker that continues
unsupervised.

## Governed learning candidates

Idle analysis may observe an improvement, but observation is not promotion. Candidates
live in the bounded dream-state database with an explicit lifecycle from `observed`
through validation and proposal. Their payloads reject secret-bearing fields, have a
16 KiB ceiling, and retain only bounded evidence references.

The governance ledger records a fingerprinted candidate evidence item in quarantine and
a completed deferred-promotion decision. This expected proposal quarantine is reported as
pending evidence, not degraded governance health. Activation requires all cited evidence to remain active
or explicitly historical, non-conflicting, and present. It also requires an active
operator-authority evidence record. Successful promotion activates the candidate evidence
and settles the promotion decision; failure leaves an auditable terminal rather than
pretending the change applied.

This contract applies equally to project guidance, provider dialect observations,
recovery ordering, retrieval tuning, and future skill proposals. Candidate bodies remain
in their domain store; governance retains their identity, fingerprints, causal evidence,
authority, state changes, and terminal effect.

## Idle evidence pipeline

Stage 0 seals a bounded, redacted telemetry window and registers its fingerprint as
governance evidence. The aggregate packet is durable, so a restart cannot lose the work
between harvesting and diagnosis. Stage 1 consumes that packet, classifies operational
failures, and may observe a quarantined reliability candidate when the same stable reason
recurs at least three times. It does not change runtime policy or recovery ordering.

Project-memory reconciliation is proposal-only at this boundary. It reads the current
`NNA.md`, rejects symbolic links, malformed managed markers, oversized files, and
secret-like content, then produces an expected-hash proposal that preserves every byte
outside the managed region. Applying that proposal remains a normal reviewed filesystem
effect under a workspace-specific maintenance grant.

The eligibility stage considers only authenticated operator messages from turns named by
the sealed evidence window. A deliberately narrow deterministic grammar recognizes
explicit decisions and conventions; assistant prose, generic conversation, unrelated
turns, and secret-like text are excluded. Existing managed knowledge is merged into the
proposal so a partial observation cannot erase prior memory. The resulting candidate is
inspectable in `/dream`, remains quarantined, and does not write `NNA.md`.

## NNM effect receipts

NotNativeMemory owns semantic-memory content and extraction. Its detached NNA
`turn:post` analyzer emits `nnm.turn-analysis-receipt/1.0` records containing only
session/turn correlation, a workspace fingerprint, aggregate candidate/write counts,
and completion time. It never copies extracted memory text into NNA telemetry.

Idle governance reconciles these receipts after deterministic diagnosis and the
project-memory eligibility stage. Each accepted receipt becomes observed governance
evidence plus a settled `memory_eligibility` decision. Missing, malformed, late, or
legacy receipt contracts degrade the maintenance stage only; they never fail a user
turn. This establishes causal auditability without giving NNA a second semantic-memory
store or letting NNM widen NNA authority.

NNM also participates in the final idle stage through the read-only
`maintenance:idle` hook. The hook calls NNM's deterministic review-candidate query and
returns `nnm.hygiene-receipt/1.0`: a unique scan identity, workspace fingerprint, bounded
candidate count, and a fixed vocabulary of reason-code counts. Memory IDs, text, model
output, and mutation instructions are excluded. Governance admits each scan as observed
evidence and folds recurring equivalent results into one quarantined
`memory.hygiene_attention` candidate. This stage never edits, promotes, merges, or deletes
memory; it only gives an operator an attributable queue for later inspection.

Explicit operator requests to make a reusable workflow are admitted through the same
boundary as `operator_skill_request` evidence with proposal-only authority. The resulting
`skill.workflow_opportunity` candidate is quarantined and carries value, verification,
deduplication, maintenance, and security gates. Operator wording that proposes a skill is
evidence that the proposal should be evaluated; it is not authority to build, install,
activate, or grant capabilities to that skill.

Every idle stage has two complementary records: the durable dream-state receipt used for
restart recovery and a content-free `maintenance.stage` forensic event used for timeline
diagnosis and support bundles. Governance decisions cite stable evidence identities rather
than relying on either record's mere existence as proof of truth or authority.

## Operator inspection

`/audit` begins with aggregate governance integrity: evidence and decision counts,
unsettled decisions, quarantined or conflicting evidence, and effects whose completion
is uncertain. The records below retain stable domains, outcomes, reasons, evidence
references, and terminal certainty without prompts, tool output, memory text, or secret
values.

`/dream` is the governed learning control plane. It shows the pending evidence stage and
typed learning candidates, supports one-stage manual execution and pause/resume, and
allows candidate inspection. Rejection requires the explicit
`/dream reject ID REASON` command; inspection never promotes or activates a candidate.
