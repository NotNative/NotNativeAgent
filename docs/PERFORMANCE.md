# Performance methodology

Performance targets remain provisional until they are measured on representative release
platforms. Run `npm run performance:lab` on each release platform and retain the JSON
result with the artifact. The report records OS, architecture, Node version, CPU
model/count, memory, sample count, p50/p95/p99, and the exact measured operation.

The lab measures `--help` startup, engine initialization, deterministic first-frame work,
bounded projection of 100,000 ordered events, high-rate forwarding to a deliberately slow
observer, detector scaling and visible tool-schema weight, and a completed-turn resource
soak. Use `node scripts/performance-lab.js --quick` only as a harness smoke test; quick
results are not release evidence.
Provider inference is deliberately excluded. Durable journal resume reads a bounded
10,000-record tail and exposes older records through bounded reverse pages; an executable
100,000-record conformance fixture verifies append continuity and page ordering without
materializing the complete journal. Console PageUp consumes those pages on demand, keeps a
bounded 4,096-event history window, and preserves the visible reading anchor. Deep paging
and true native terminal readiness still require platform-specific interactive
measurements. None of these values may be inferred from unit-test duration.

The bounded tail is a presentation and startup optimization, not permission to forget
security state. Missing conversational authority makes consequential review fail closed
until explicit operator reauthorization, while missing cumulative mission-budget evidence
prevents mission resume. A retained clear boundary or cumulative budget fact proves the
corresponding recovery state without scanning or materializing the complete journal.

Context-compression performance is evaluated as a workflow, not as a compression ratio.
Recorded-session comparisons must retain provider/model identity and compare completion
status, ordered material tool decisions, and final outcome. Reports include pre/post context
bytes and tokens, tokenizer identity, reducer attribution, history rediscovery cost, and any
additional tool calls caused by omitted hot context. Representative Qwen evaluations use the
actual tokenizer when available and retain the conservative UTF-8 estimate as an explicitly
identified fallback. Synthetic repeated text may test bounds, but it is not release evidence
of equivalent agent behavior.

Provider accounting is attempt-scoped. The complete serialized outbound envelope is measured
before transport and its section inventory is retained without prompt content. Provider usage
is reconciled against that estimate after each attempt, including failed retries and route
fallbacks. Reports must keep provider-measured tokens and estimated unreported tokens in
separate fields; their sum may be used for capacity accounting but must never be labeled as an
authoritative provider count.
