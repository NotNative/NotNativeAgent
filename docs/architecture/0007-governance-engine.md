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

The initial implementation mirrors mandatory-reviewer decisions into this shared record
while retaining the existing reviewer ledger. This is a compatibility migration, not a
second authorization vote. Once field evidence proves recovery and diagnostics, the
reviewer ledger may become a domain-specific projection of governance records.

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

## Performance rule

Deterministic policy is preferred. Semantic governance runs only when uncertainty or
consequence justifies it. NNA does not add a general claim-supervisor inference to every
turn. Foreground work wins over idle analysis, and governance persistence is bounded by
the same cancellation, shutdown, and supportability expectations as the agent engine.
