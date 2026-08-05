# ADR 0002: Mandatory reviewer and structured tool boundary

Status: accepted for milestone 2, 2026-07-31.

Every complete provider tool call is assembled under bounded memory, assigned a
new engine identity, schema-validated, path-resolved, and frozen before review.
Provider call identities remain correlation data and never become authority.
Each conversation owns a separately versioned authority record derived only from
authenticated operator input and authenticated mission updates. Agent responses,
tool output, reviewer explanations, and restatements of operator intent are evidence,
not authority, and cannot mutate that record.
Authenticated submissions and consumed steering are persisted as dedicated authority
facts with stable conversation lineage, snapshot version, and restriction epoch. Durable
resume rebuilds authority only from those facts; transcript text is never promoted back
into authority. Ordinary later turns preserve scoped preauthorization, while a newer
authenticated clarification or restriction invalidates it before execution.
Mission turn consumption is a separate durable authority fact. It is restored across process
restart and deliberately survives conversation clear; persistence must succeed before the
turn proceeds, so restart, clear, or a failed journal write cannot replenish mission bounds.
Bounded-tail resume never assumes omitted authority is harmless. If no confirmed clear
boundary appears in the retained tail, the restored conversational authority is marked
incomplete: deterministic reads remain available, but consequential work is denied until
the operator clears or replaces the conversation and restates authority. An active mission
cannot resume from a truncated tail unless at least one cumulative mission-budget fact is
present; otherwise initialization fails closed rather than minting resource budget.

Shell-free process requests retain an independent comprehensibility floor. Opaque
package scripts, large argv sets, interpreted patterns, and dynamic flags are denied
with structured-tool guidance before semantic review; a permissive reviewer cannot
authorize a command the deterministic boundary cannot understand.

Completed tool-call identities are cached with a bounded operation fingerprint. A replay
of the same identity and operation reuses the prior terminal result without repeating
review or execution; reuse of an identity with different tool arguments is rejected as
drift. Durable transcript recovery rebuilds the cache for resumed conversations.

The reviewer is mandatory kernel policy registered on the permission `pre`
phase. Ordinary callers cannot remove that subscription. It classifies bounded
workspace reads as safe, treats writes as review-required, and rejects unknown
or out-of-scope operations before semantic review. Review-required work uses a
tool-less `reviewer` model route with a portable structural JSON Schema response
constraint, strict local decision validation, bounded time, and a
fail-closed default. Mutation approval additionally requires authenticated
intent to name the mutation class and target.

File, web, memory, MCP, hook, attachment, and tool-result content remains explicitly
untrusted evidence in provider context. It is never added to the authority record. Even
when such content induces a later mutation and the semantic reviewer returns approval,
the deterministic intent/target floor denies the call unless authenticated operator or
mission authority independently permits it.

The reviewer alone owns a separate hash-chained ledger. It stores normalized
operation hashes, redacted target fingerprints, decisions, repetition counts,
and executor facts rather than raw arguments or tool content. An approval binds
the request digest, authority and policy versions, and expiry. Execution starts
only after exact revalidation; results are persisted and ledger-settled before
the next model step.

Built-in filesystem executors are structured, canonicalized, and operationally bounded.
Ordinary root sessions may address host-visible paths; execution-manifest sessions retain a
hard canonical workspace ceiling. Writes are atomic, and replacing an existing file requires
an expected SHA-256 checked immediately before the write. Git-tracked working-directory
mutations and new targets can be classified as recoverable only when authenticated intent
matches the action and target. Untracked, external, destructive, shell, and complex process
effects reach mandatory semantic review instead of being prohibited by the tool layer.
`process.run` retains minimal-environment inheritance, bounded output, deadlines, and
process-tree cancellation. `docs/TOOLS.md` is the canonical current catalog.

Interactive operation preauthorization fingerprints the complete canonical target set. File
transfers bind source and destination together; process requests bind working directory,
executable, and argv. Workspace-scoped grants remain deliberately broader but still bind the
tool, side-effect class, authority restriction epoch, policy, definition, workspace, and expiry.
