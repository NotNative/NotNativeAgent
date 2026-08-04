# ADR 0003: Progress-supervised recovery and durable checkpoints

Status: accepted for milestone 3, 2026-07-31.

Provider retries and model-step recovery are distinct. Classified transient
failures before partial semantic output retry one immutable model step with a
new attempt identity, bounded jitter, and recorded delay. Connect, first-token,
idle, and overall deadlines remain independently bounded. Partial output stops
automatic provider retry.

Every surfaced boundary failure uses one safe envelope with a stable code and category,
the expired or failed boundary, retryability, a causal correlation identity, partial-data
state, and effect certainty. Internal exceptions do not expose their original message or
stack. Tool failures independently report effect certainty; unknown-effect mutations are
never selected for automatic retry.

Turn finalization preserves the first causal failure as the primary outcome. Failures
from child-lifecycle settlement, persistence, terminal event delivery, state cleanup, or
output are normalized and attached as `secondary_failures`; each remaining cleanup stage
is still attempted. Once the canonical terminal outcome is durably committed, it is
latched: a later projection/output-consumer failure is secondary and cannot make the
returned result contradict the journal.
Failed startup follows the same rule: hook, extension, ledger, journal, and writer-lock
cleanup are independently attempted, while the original initialization failure remains
the error returned to the caller.
Shutdown cleanup is similarly monotonic: a failing `session.end` hook remains the
primary error, but event, MCP, attachment, journal, ledger, hook, and lock cleanup still
runs before that error returns.
If a peer refuses to settle before the whole-runtime shutdown deadline, the timeout closes
hook admission and releases the durable session writer lock after the concurrently started
journal cleanup has run. Recovery can then reopen the verified journal prefix without
waiting on the uncooperative observer.

The engine validates every adapter event independently of the provider parser. Unknown or
malformed semantic events, data after a terminal marker, incomplete tool identities, and
malformed tool arguments end the model step before any tool review or execution begins.

Empty output and unchanged tool-result fingerprints consume a turn-scoped
three-attempt no-progress ladder. The ladder records a nudge and deterministic
context compaction before exhaustion. New authenticated steering or a unique
successful tool-result fingerprint is progress evidence. Distinct progressing
steps may continue under the configured generous model-step ceiling; exhaustion
records completed progress, recovery actions, the last checkpoint, remaining
work, effect certainty, and a safe resumption condition. Completed progress is
represented by bounded SHA-256 evidence fingerprints, content-free summaries,
and the actual durable checkpoint (`tool_results_committed`,
`partial_assistant_message_committed`, or `steering_consumed`) rather than raw tool
or model content. Effect certainty is derived from both live and durable correlated
tool-result shapes, including partial and unknown effects, instead of a generic
placeholder.

Steering is appended durably before acknowledgement and is never approval. The
engine consumes it once at a post-stream or post-tool-result checkpoint, adds it
to authenticated conversation authority, and atomically records the consumed
message. Resume reconstructs unconsumed steering.

Durable sessions use a per-session exclusive writer lock with PID liveness
checking and preserved stale-lock evidence. Startup recognizes accepted turns
without terminal outcomes, records interruption, and does not replay provider
or tool work. A corrupt journal remains untouched while its longest verified
prefix is written to a separate recovery artifact.

Resume reads and verifies only a bounded recent journal window, using the final
record's durable sequence and hash to continue the chain exactly. Older records
are available through bounded reverse pages. Corruption in a truncated window
falls back to a full verification pass solely to preserve the longest valid
prefix as recovery evidence; ordinary large-session startup remains bounded.

Journal records use format 1. Legacy format-0 journals are fully validated, copied to a
stable `.format-0.bak`, rewritten as a fresh verified format-1 chain, and then reopened;
repeating startup is idempotent. Unknown future journal formats fail closed without
rewriting the authoritative file. Canonical configuration follows the same backed-up,
atomic, future-version-safe migration rule.

A tool result must commit durably before the engine enters `preparing_continuation`.
If that exact boundary fails after execution, no second provider call begins, later
persistence remains failed closed, and restart observes the last valid prefix without
inventing a tool result. The reviewer ledger retains the correlated started operation
for uncertainty inspection.

Context preflight compacts before provider I/O. Deterministic micro-compaction builds a
schema-bounded continuation artifact containing authenticated objective/directives,
observed file effects, unresolved tools, and recent causal state. A bounded no-tool model
pass may enrich completed work, verified facts, questions, and next actions; malformed,
timed-out, or unsupported semantic output falls back to the deterministic artifact. The
full transcript remains local for display and audit while provider context restarts at the
fingerprinted continuation boundary. Repeated same-source or excessive compaction is
stopped by a local circuit breaker. Cancellation remains
monotonic; late provider output is ignored and cannot replace `cancelled`. Cancellation
checkpoints precede hook, attachment, memory, provider, review, and execution boundaries,
so accepting cancellation prevents any later boundary from starting new external work.
If mandatory context cannot fit after one deterministic compaction attempt, the engine
does not resend the unchanged request and returns concrete reduction/model-limit guidance.
