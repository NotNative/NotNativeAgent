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

Shell-free process requests retain an independent comprehensibility floor. Malformed or
mechanically prohibited plans fail before semantic review. Opaque package scripts, large
argv sets, interpreted patterns, and dynamic flags are classified as uncertain and reach
semantic review with their complexity intact; they are not disguised as simple commands.

Completed tool-call identities are cached with a bounded operation fingerprint. A replay
of the same identity and operation reuses the prior terminal result without repeating
review or execution; reuse of an identity with different tool arguments is rejected as
drift. Durable transcript recovery rebuilds the cache for resumed conversations.

The reviewer is mandatory kernel policy registered on the permission `pre`
phase. Ordinary callers cannot remove that subscription. It deterministically approves
mechanically safe work, enforces mission ceilings and clear authenticated-intent conflicts,
and reserves a short immutable denial floor for prohibited operations. Other uncertain
or consequential operations reach semantic review. Review-required work uses a
tool-less `reviewer` model route with a portable structural JSON Schema response
constraint, strict local decision validation, bounded time, and a
fail-closed default. The semantic default is permissive toward a reasonable, proportionate
means of carrying out authenticated intent; ordinary intermediate commands and targets
derived from prior results need not be named verbatim.

File, web, memory, MCP, hook, attachment, and tool-result content remains explicitly
untrusted evidence in provider context. It is never added to the authority record. Even
when such content induces a later mutation, it cannot independently authorize the call.
Authenticated operator or mission intent must still cover the objective, while the semantic
reviewer may recognize proportionate intermediate actions and causally derived targets.

The reviewer alone owns a separate hash-chained ledger. It stores normalized
operation hashes, redacted target fingerprints, decisions, repetition counts,
and executor facts rather than raw arguments or tool content. An approval binds
the request digest, authority and policy versions, and expiry. Execution starts
only after exact revalidation; results are persisted and ledger-settled before
the next model step. The bounded approval window begins when the reviewer or operator commits
the decision so slow local semantic review cannot consume the execution window while the call
is still waiting for judgment. Revalidation still rejects expired decisions and any drift in
the exact request, authority, policy, tool definition, or workspace binding.

Built-in filesystem executors are structured, canonicalized, and operationally bounded.
Ordinary root sessions may address host-visible paths; execution-manifest sessions retain a
hard canonical workspace ceiling. Writes are atomic, and replacing an existing file requires
an expected SHA-256 checked immediately before the write. Exact in-workspace writes and text
edits may derive that digest from a bounded runtime-owned transaction snapshot when the model
has no explicit read receipt. That snapshot is sealed to one request, is not reusable by
destructive tools, and contributes only before/after hashes and byte counts to semantic review.
Line edits, transfers, deletion, and host-path mutations retain explicit read requirements.
Git-tracked working-directory mutations and new targets can be classified as recoverable only
when authenticated intent matches the action and target. An explicit build, implementation,
scaffold, repair, or refactor objective covers proportionate derived reversible files inside
that workspace; a read-only request or any later mutation restriction defeats that coverage.
Untracked, external, destructive, shell, and complex process
effects reach mandatory semantic review instead of being prohibited by the tool layer.
`process.run` retains minimal-environment inheritance, bounded output, deadlines, and
process-tree cancellation. `docs/TOOLS.md` is the canonical current catalog.

A guidance denial constrains the attempted route rather than completing the objective.
Equivalent denied requests are latched within the same authority snapshot; a newer
authenticated operator instruction creates a new snapshot and may reopen review. The engine
directs the agent to try a materially different safer, narrower, or more reversible route and
to ask the operator only after useful alternatives are exhausted. Immutable policy denials
and reviewer unavailability remain distinct and cannot be presented as withheld permission.

Interactive operation preauthorization fingerprints the complete canonical target set. File
transfers bind source and destination together; process requests bind working directory,
executable, and argv. Workspace-scoped grants remain deliberately broader but still bind the
tool, side-effect class, authority restriction epoch, policy, definition, workspace, and expiry.
