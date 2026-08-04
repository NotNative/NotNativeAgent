# Forced-termination recovery lab

`npm run recovery:force-kill -- --output RETAINED_REPORT.json` exercises the actual
durable `SessionEngine` path. It first discovers every session-journal append boundary in
a deterministic governed filesystem turn. For each sequence it starts a fresh engine,
waits until that exact record has been written and synchronized, forcibly terminates the
process, verifies the hash-chained prefix, and resumes the session with a provider probe.

The matrix fails if the prefix does not end at the selected boundary, corruption appears,
resume invokes the provider automatically, a durable tool result disagrees with the
filesystem state, or not every discovered boundary was exercised. Reports retain record
types, sequence numbers, state categories, counts, platform, product version, and stable
outcomes—not prompts, model output, tool arguments, file content, or credentials.

Run and retain the report separately on native Windows, macOS, and Linux for the exact
release candidate. The repository test runs only a short harness smoke test. A passing
single-platform report does not satisfy the cross-platform release gate, and the lab does
not replace manual cancellation, timeout, stale/late-result, or unknown-effect review at
other external boundaries.
