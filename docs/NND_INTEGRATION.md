# Local NND integration

`nna nnd serve` starts NNA's authenticated loopback service for a local
NotNativeDesktop process. NND owns the child process and reads one JSON
readiness line from stdout. The line contains protocol `1.0`, the loopback
endpoint, an instance ID, and an ephemeral bearer token. Diagnostics use
stderr. NND must keep the token in its server process.

NNA loads its configured manifest and constructs the governed session engine
before it emits readiness. Missing or invalid configuration fails startup.
Requests need both the bearer token and a fresh `X-NNA-Principal` envelope;
the route layer checks the permissions and workspace grants.

The local session API supports creating/listing sessions, reading transcript
messages, submitting a turn, renaming a title, archiving/restoring, cancelling
an active turn, and removing a session from the desktop catalog. Each mutation has its own
`nnd.session.*` permission. Catalog removal closes the governed engine but
retains its NNA journal for recoverable operator inspection; it is not a
secure erase. Browser-supplied directory fields cannot select the engine's
workspace.

Session listing accepts `roots=true` for parent sessions or `roots=false` for
child sessions; omitting it returns both. `limit` bounds the returned list in
parent-then-child order, with each group sorted by session ID. NND has no list
cursor yet, so a limit smaller than the available list cannot discover the
remaining sessions. `GET /session/:id/children` lists an owned parent's
accessible child sessions in session-ID order. These read paths require `nnd.read`
and the full original workspace grant. They do not grant child steering.

With durable persistence, NNA keeps a bounded session catalog beside its
session journals. A new NND child reopens those sessions under their original
subject and workspace grants before it emits readiness. An invalid catalog
stops startup while preserving the file for inspection. Ephemeral NNA
configurations keep sessions in memory only.

`nna integration serve` remains the NNO-owned entry point. It still requires
an installed NNO activation. The NND command has a separate NNA-owned local
activation and does not change NNO's installation contract.

The session description projects canonical NNA conversation work in
`metadata.nnd.work`: revision, goal identity/objective/status, and bounded task
identity/title/status. The projection comes from `SessionEngine.workStatus()`;
it is not the OpenCode-compatible todo cache. Completion evidence, blocked
reasons, staged completion, and journal details remain inside NNA. A committed
`work_status` output causes a live `session.updated` projection, and normal
session reads reconstruct the same summary after restart. If work state cannot
be validated, the field is absent rather than fabricated.

NND-created engines use a distinct `nnd` output surface. NNA emits semantic
`state_status` records for that surface; its NND host also folds NNA-authored
text/tool lifecycle records into streaming/tool phases. The owned session
description projects the latest validated phase as `metadata.nnd.turnState`.
The projection includes only the phase name; it carries no reasoning text,
provider payload, tool arguments, or decision details. NNA's completion path
settles it to idle. NND's generic busy/idle status remains transport and
reconciliation bookkeeping, not the source of a semantic phase. This phase
display does not yet satisfy the broader replayable 13-state wire contract.
