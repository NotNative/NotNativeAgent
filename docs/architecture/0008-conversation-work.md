# Architecture decision 0008: durable conversation work

Status: accepted and implemented.

NNA provides an optional conversation-scoped work model consisting of one goal and an
ordered list of tasks. A task is `pending`, `in_progress`, `completed`, or `blocked`, and
at most one task may be in progress. Completion requires bounded evidence; blocking
requires a bounded reason. A goal cannot complete while any task remains unfinished.

Every mutation appends a complete versioned `work_state` snapshot to the conversation's
hash-chained session journal and emits content-bounded forensic telemetry. Active work is
also checkpointed immediately before each terminal turn outcome so bounded-tail recovery
keeps a recent authoritative snapshot. Recovery uses the newest valid snapshot. `/resume`
therefore restores progress without a parallel state store, and context compaction cannot
erase it.

The provider receives only the current snapshot as trusted engine state when work exists.
Mutation history does not consume prompt context. The always-visible `work.status`,
`work.goal`, `work.task_add`, and `work.task_update` tools let the agent maintain the same
state machine used by operator commands. These tools add no filesystem, process, secret,
or network authority. Hosted sessions receive them only when their execution manifest
explicitly grants their exact tool names.

The Console's `/plan` hub is the primary view. `/tasks` is an alias for the same hub, while
`/goal` and `/task` provide direct keyboard workflows. The footer shows only a compact
completed/total count. Ordinary conversations remain plan-free unless the operator or
agent deliberately creates work state.
