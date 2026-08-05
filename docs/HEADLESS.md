# Headless host protocol

`nna host` is a UTF-8, newline-delimited JSON protocol over standard input and standard
output. `nna headless` remains a stable compatibility alias. Standard output is
protocol-only; diagnostics use standard error.
The spawning process is the authenticated controlling principal and must initialize the
runtime before sending work.

Input lines, JSON depth, collection size, strings, and the number of concurrently owned
requests are bounded. When the request ceiling is reached, NNA returns the stable
`request_queue_full` error without starting that request.
While a turn or its auto-review is active, new submissions receive a correlated
`accepted:false` busy acknowledgement; replaying the same request identity receives a
correlated duplicate acknowledgement. Review status remains bound to the engine tool
request identity. No permission-response control exists in the headless protocol.
Malformed JSON, incompatible major versions, unknown control types, and bounds violations
return typed protocol errors before initialization or provider/tool work. Compatible newer
minor versions and unknown optional fields are tolerated. An overlong unterminated frame
is unrecoverable for that stream, so NNA emits `line_too_large` when possible and exits.

One writer serializes all output. It admits at most 4 MiB of serialized records at once,
limits any one record to approximately 2.25 MiB, and applies stream backpressure before
admitting more. Records are not byte-interleaved, and terminal/control records are not
dropped to make room for model deltas. If the controlling host closes or breaks the
output pipe, NNA reports `output_broken_pipe` on standard error when possible, stops
reading commands, closes the provider iterator, and finalizes active session work.

The initialization response includes the immutable authenticated execution manifest and
the effective capability ceilings. Disconnect policy is currently always `cancel`;
detached execution is deliberately unsupported.

An authenticated host may provide `manifest.allowed_tools` as an exact list of native or
MCP tool names. NNA filters every registration through that list, including capabilities
discovered after startup, binds the canonical list into durable-session provenance, and
returns the effective `tools` inventory in `initialized`. Omitting `allowed_tools` retains
the standalone tool catalog; an empty list grants no tools. A prompt cannot add to this
grant, and a resumed session must present the same grant.

`agent.run` is reserved for standalone root NNA. Hosted manifests cannot grant it, and
hosted tool catalogs never install or advertise it. A host that needs parallel work must
create separate, independently scoped NNA executions with authenticated manifests.

An authenticated host may also provide bounded inline `manifest.skills`. NNA validates
their identifiers, invocation direction, bodies, source attribution, and required exact
tool names. It binds a digest and descriptor grant to durable-session provenance and
returns the effective skill catalog in `initialized`. Agent-invocable hosted skills are
unavailable unless `skill.search` and `skill.load` are explicitly granted. Skill content
is workflow guidance only and cannot expand the execution manifest.

NNO and other authenticated hosts may also send `host_identity` with bounded, secret-free
identity and RBAC claims. NNA canonicalizes those claims into the immutable execution
manifest and requires an exact match on resume. Capability tokens and credentials remain
outside this record; the host's tool boundary remains responsible for authorizing every
business operation against current server-side policy.

`application_system_prompt` is attributed host business policy, not authenticated tool
authority. Its legitimate behavioral instructions remain in model context, but requests
inside it to disable review or authorize an effect cannot enter the authority record.
Every resulting tool call still crosses deterministic policy, auto-review, ledger commit,
and execution-boundary revalidation.

## Host and operator responsibility

The host operator remains responsible for the authority in the execution manifest and
for actions performed by configured models, tools, credentials, MCP servers, hooks, and
scheduled or unattended workflows. NNA's policy, reviewer, permission, and audit controls
reduce risk; they are not guarantees, and reviewer approval is not proof that an operation
is harmless. The Apache License 2.0 warranty disclaimer and limitation of liability apply.
