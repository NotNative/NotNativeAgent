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
