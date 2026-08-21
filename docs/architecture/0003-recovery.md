# ADR 0003: Progress-supervised recovery and durable checkpoints

Status: accepted for milestone 3, 2026-07-31.

ADR 0013 assigns the policies and judgments described here to `ReliabilityEngine`.
`SessionEngine` applies and durably records those decisions.

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
three-attempt no-progress ladder. Every authenticated user turn creates a fresh
supervisor, so progress fingerprints, episode counts, and recovery actions never
carry into the next turn. Distinct repeated tool-request fingerprints also own
distinct episodes; unrelated read-only exploration cannot jointly exhaust one
generic tool-no-progress counter. The ladder records a nudge and deterministic
context compaction before exhaustion. New authenticated steering, a unique
successful tool-result fingerprint, or the first completed-nonzero diagnostic
for a distinct tool invocation is progress evidence. A completed-nonzero result
does not become successful verification: it only proves that the command ran and
returned new negative evidence. Repeating the same tool and arguments receives
no additional progress credit, even if volatile output such as timestamps changes.
Distinct progressing steps continue for as long as they produce distinct verified progress. There is no
generic productive-step cutoff. No-progress exhaustion ends the turn as incomplete
with a concise explanation to the operator; it records completed progress, recovery
actions, the last checkpoint, remaining work, effect certainty, and a safe resumption
condition. Completed progress is
represented by bounded SHA-256 evidence fingerprints, content-free summaries,
and the actual durable checkpoint (`tool_results_committed`,
`partial_assistant_message_committed`, or `steering_consumed`) rather than raw tool
or model content. Effect certainty is derived from both live and durable correlated
tool-result shapes, including partial and unknown effects, instead of a generic
placeholder.

Raw SSE chunk receipt is transport activity even when a compatible server has not yet exposed
visible text or a complete semantic delta. Typed reasoning and partial tool-call fragments are
semantic activity as well. Public-network requests retain independently bounded first-event,
idle, and overall deadlines. Trusted loopback and private-network inference has no implicit
deadline; explicit operator settings remain authoritative and cancellation remains immediate.
At 11 tokens per second, a healthy 32K-token reasoning/tool response can take roughly 49
minutes before prompt processing overhead, so elapsed time alone is not failure evidence.
Trusted local routes therefore use a provider-only native HTTP transport with no implicit
response-body deadline; the Reliability Engine remains the sole timeout authority. A bounded
out-of-band health probe runs after 60 seconds without a stream event and leaves a content-free
telemetry receipt. Probe success never fabricates stream activity, and probe failure never
terminates inference. Transport failures are normalized through nested client causes into
stable retryable provider codes rather than escaping as `internal_failure`.

Semantic permission review is explicitly non-thinking. The reviewer requests one bounded,
schema-constrained decision and sends both generic and Qwen-compatible reasoning-disable
controls. This keeps mandatory governance latency predictable without changing reasoning policy
for primary or delegated model work.

The configured model-step ceiling remains a final bounded guard (1,024 by default), so a
long build can exceed dozens of useful tool steps without being mistaken for a loop.

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
stopped by a local circuit breaker. Normal projection preserves the active turn and five
newest completed turns without rewriting their conversational content. Older history is
reduced first. If a protected turn alone prevents provider admission, only recoverable bulk
payload is reduced first; tool output becomes a typed, ledger-referenced receipt while its
request/result pairing remains intact. The protected tool-payload limit scales with the active
context budget, up to a bounded ceiling, so large-context models retain substantial recent
evidence. Oversized intermediate model steps may be omitted only
after the final response for that turn is retained. The full records remain in the durable
journal, and content-free telemetry records the policy, protected counts, byte reduction,
exception count, and source fingerprint. Cancellation remains
monotonic; late provider output is ignored and cannot replace `cancelled`. Cancellation
checkpoints precede hook, attachment, memory, provider, review, and execution boundaries,
so accepting cancellation prevents any later boundary from starting new external work.
If mandatory context cannot fit after one deterministic compaction attempt, the engine
does not resend the unchanged request and returns concrete reduction/model-limit guidance.

Preflight measures the complete provider envelope rather than transcript messages alone:
serialized context, injected model guidance, the tool catalog and schemas, request
configuration, and the reserved output budget all participate in admission. Every transport
attempt then commits a content-free token receipt, including failed retries and route
fallbacks. Reported provider usage is retained as measured evidence. When a provider omits
usage, the receipt records a conservative serialized-byte estimate as unreported usage so
turn and conversation totals remain honest about their measurement coverage.
