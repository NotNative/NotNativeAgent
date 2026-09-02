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
facts with stable conversation lineage and snapshot version. Durable
resume rebuilds authority only from those facts; transcript text is never promoted back
into authority. NNA does not classify free-form operator prose as a restriction with keyword
or pattern matching. Risky actions grounded in an unclassified statement reach mandatory
semantic review. Scoped preauthorization is removed by expiry, scope mismatch, policy or
definition drift, or the explicit `/permissions revoke ID` operator action.
Within a turn, the engine also retains a bounded projection of recent authenticated conversation
intent, with the accepted turn request anchored through later steering. Reviewer evidence
selection and semantic review receive this projection so a terse continuation or recent additive
instruction does not obscure older causal evidence or the broader objective. This projection
supplies context, not authority: restrictions and replacements remain governed by the complete
authenticated authority record, and model text, tool output, or a plan cannot expand it.
When authenticated input is a conservative referential approval, the engine may also present the
immediately preceding completed assistant proposal as separately attributed, user-adopted objective
context. Semantic review may use it only where it remains compatible with the authenticated intent
ledger; it cannot override a restriction, invent scope, or become standalone authority.
Mission turn consumption is a separate durable authority fact. It is restored across process
restart and deliberately survives conversation clear; persistence must succeed before the
turn proceeds, so restart, clear, or a failed journal write cannot replenish mission bounds.
Bounded-tail resume never assumes omitted authority is harmless. If no confirmed clear
boundary appears in the retained tail, the restored conversational authority is marked
incomplete: deterministic reads remain available, but consequential work is denied until
the operator clears or replaces the conversation and restates authority. An active mission
cannot resume from a truncated tail unless at least one cumulative mission-budget fact is
present; otherwise initialization fails closed rather than minting resource budget.
Mission failure envelopes carry the declared disposition as `terminate_turn` or
`suspend_mission`, in addition to the triggering condition and cause. Consumers therefore do not
have to infer control flow from a generic failure code.

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
mechanically safe work, enforces structured mission ceilings,
and reserves a short immutable denial floor for prohibited operations. Other uncertain
or consequential operations reach semantic review. Review-required work uses a
tool-less `reviewer` model route with a portable structural JSON Schema response
constraint, including an explicit outcome enumeration, strict local decision validation, bounded
time, and a fail-closed default. If the first response is malformed, NNA records that provider
attempt and makes one schema-repair attempt with a separate receipt. A second malformed response
fails closed. The semantic default is permissive toward a reasonable, proportionate
means of carrying out authenticated intent; ordinary intermediate commands and targets
derived from prior results need not be named verbatim.

Deterministic safe-tool review depends on the sealed tool effect and scope. NNA does not use
greeting words or other natural-language patterns to revoke a safe tool mid-turn. This rule does
not bypass review: every request still crosses the mandatory reviewer, and all non-safe effects
retain their authority, policy, and semantic-review requirements.

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
the next model step. NNA reviews each sequential request or parallel execution group immediately
before that group starts. A long-running earlier tool therefore cannot consume the approval
window of a later request in the same provider batch. The bounded approval window begins when
the reviewer or operator commits the decision, so slow local semantic review cannot consume the
execution window while the call is still waiting for judgment. Revalidation still rejects
expired decisions and any drift in the exact request, authority, policy, tool definition, or
workspace binding.

Built-in filesystem executors are structured, canonicalized, and operationally bounded.
Ordinary root sessions may address host-visible paths; execution-manifest sessions retain a
hard canonical workspace ceiling. Writes are atomic, and replacing an existing file requires
an expected SHA-256 checked immediately before the write. Exact in-workspace writes and text
edits may derive that digest from a bounded runtime-owned transaction snapshot when the model
has no explicit read receipt. That snapshot is sealed to one request, is not reusable by
destructive tools, and contributes only before/after hashes and byte counts to semantic review.
Line edits, transfers, deletion, and host-path mutations retain explicit read requirements.
New-file writes may create missing parent directories after the complete prospective path has
been canonicalized and reviewed. A committed full write records its resulting digest and content
as reusable authored state, because the model supplied the complete post-write representation;
an ordered later whole-file write or still-valid exact-text edit may advance from that exact
runtime-authored digest without changing its reviewed target or requested effect. This continuity
does not accept arbitrary drift: a live state that does not match the latest runtime-authored
receipt still fails closed. Built-in filesystem mutation tools also normalize a small set of
unambiguous conventional argument aliases before validation and review; conflicting spellings are
rejected, and the sealed request and audit record always use canonical field names.
denied, failed, cancelled, or externally drifted writes never create that state.
Git-tracked working-directory mutations and new targets can be classified as recoverable, but
recovery evidence does not grant intent. Free-form authenticated language, including action,
target, restriction, and derived-work meaning, is interpreted only by semantic review. A
structured mission that passes its resource, effect, target, credential, schedule, and budget
ceilings may deterministically cover a reversible request.
Untracked, external, destructive, shell, and complex process
effects reach mandatory semantic review instead of being prohibited by the tool layer.
`process.run` retains minimal-environment inheritance, bounded output, deadlines, and
process-tree cancellation. `docs/TOOLS.md` is the canonical current catalog.

Native elevation is temporarily disabled. No active runtime installs `system.elevate`.
Ordinary process tools reject native privilege launchers and direct the agent to ask the
operator to run the required command independently. The dormant adapter and its tests retain
the intended boundary for future focused repair, but they grant no callable authority.

A guidance denial constrains the attempted route rather than completing the objective.
Equivalent denied requests are latched within the same authority snapshot; a newer
authenticated operator instruction creates a new snapshot and may reopen review. The engine
directs the agent to try a materially different safer, narrower, or more reversible route and
to ask the operator only after useful alternatives are exhausted. Immutable policy denials
and reviewer unavailability remain distinct and cannot be presented as withheld permission.
Reviewer availability failures do not latch a substantive denial for later requests.
They still fail closed and retain the normal per-turn no-progress and request replay bounds.
Streaming duplicate-stop and execution deduplication share one bounded exact-identity function.
Free-form monitoring words do not enlarge the retry budget. Repeated work retains configured retry and mission limits.

Interactive operation preauthorization fingerprints the complete canonical target set. File
transfers bind source and destination together; process requests bind working directory,
executable, and argv. Workspace-scoped grants remain deliberately broader but still bind the
tool, side-effect class, policy, definition, workspace, and expiry. The retained restriction
epoch field supports structured and legacy authority records; ordinary prose does not mutate it.
