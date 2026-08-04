# ADR 0001: Initial runtime architecture

Status: accepted for milestone 1, 2026-07-31.

## Decision

Use ECMAScript modules on Node.js 24+, initially with only built-in APIs. This
matches the available cross-platform runtime, avoids supply-chain additions,
and provides streaming fetch, cancellation, filesystem durability, and tests.

Package boundaries are `protocol` (validated commands/projections), `engine`
(the sole per-session state owner), `lifecycle` (guarded transitions and nested
instances), `events` (ordered subscription snapshots), `provider` and `router`
(generic OpenAI-compatible role routing), `authority` (immutable snapshots),
and `persistence` (replaceable append-only journal). Adapters submit commands to
the canonical ingress and observe events; they never own orchestration.

Each session engine serializes commands and alone mutates state. Legal
transitions are an explicit table. A common lifecycle record identifies every
turn, step, attempt, and later tool/steering/recovery child. Events are facts,
not state. Dispatch creates one detached recursively immutable, structure-bounded
snapshot, so an observer cannot mutate nested payload data seen by governance or
the engine. Nonblocking subscribers are scheduled first; blocking subscribers
then execute by priority and registration order under deadlines. Nonblocking
work uses a bounded queue with a drop-newest policy for noncritical observers;
scheduled, queued, and cumulative dropped counts remain inspectable. Registration
and shutdown deadlines are finite, and shutdown closes the hub before bounded drain.

Durable sessions use one checksummed NDJSON journal per validated random session
identity. Each accepted record is appended, synced, and only then projected.
Recovery accepts the longest checksummed prefix, preserves corrupt evidence,
and never replays external work. Ephemeral sessions instantiate no store.
They also instantiate no durable reviewer ledger, do not produce automatic memory
writes, and remove managed ephemeral attachments during shutdown.

Provider profiles are generic endpoint/model/trust-zone records. The router has
primary, reviewer, subagent, and vision role slots with bounded, cycle-checked
fallbacks. Capability-incompatible and less-trusted candidates are excluded before
inference. Classified transient failures may advance to the next eligible route only
before assistant text or tool-call output exists; every attempt retains one logical
request identity and its own lifecycle identity. Credentials are resolved inside the provider immediately before I/O.
The initial adapter implements the public OpenAI-compatible chat-completions
SSE shape and emits typed text, metadata, and terminal records.

At milestone 1, reviewer and tool execution were reserved as separate packages
and no executor was registered. ADR 0002 now supplies the mandatory reviewer,
private ledger, and governed executors without changing this boundary. Authority
snapshots contain authenticated interactive intent or a validated headless
mission envelope; prompt text is never authority.

NDJSON is an adapter over canonical ingress and engine event projection. The
Console uses those same contracts, and tests derive from observable scenarios.

## Ambiguity disposition

HEAD-013 allows an explicit endpoint/path while CONF-006 requires stable provider
profiles. A manifest endpoint is treated as an immutable run-scoped synthetic
profile and never mutates saved defaults. This should be confirmed through the
specification amendment process but does not block the observable behavior.
