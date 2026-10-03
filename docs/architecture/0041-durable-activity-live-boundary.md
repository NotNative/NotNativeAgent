# Durable Activity and live stream boundary

Status: bounded prerequisite. This does not claim complete Activity history.

Each authenticated parent-session Activity page now carries a `liveBoundary` in
addition to its durable `page` or `gap` result. The host reads the disk snapshot,
rechecks the exact owned context, and compares the snapshot digest with its
current sanitized in-memory Activity suffix. Only when they agree does it insert
a session-scoped checkpoint into the same replay ring used by `/global/event`.
The checkpoint is synchronous with the comparison. Its cursor denotes a point
after all Activity represented by that snapshot. A reconnect with that cursor
gets strictly later retained events and a `complete` opener, or a `gap` opener
if eviction, restart, or scope change removed the proof.
Checkpoint admission requires the exact original principal and workspace grant
set; an expanded grant cannot reuse the checkpoint to hide earlier events from
the newly granted workspace. Ordinary event visibility remains grant-based.

If disk lags memory, the page snapshot changed, or the bus cannot retain a
checkpoint, `liveBoundary` is `{status:'gap', cursor:null, reason:...}`. The
durable page may still be displayed, but a client cannot treat it and live SSE
as a continuous history. The snapshot's `historyComplete` remains `false`; the
500-record cap and failed observational writes may have discarded earlier rows.
The page cursor remains separate from the SSE cursor, and neither is authority:
every HTTP page reauthenticates the principal and exact session owner; SSE
replay checks its current subscriber scope.

An NND consumer must load the page and resume SSE from `liveBoundary.cursor`
only for `paired`, deduplicate Activity IDs, and surface either the page gap or
SSE opener gap. Session deletion and grant revocation still need durable
tombstones or another authoritative invalidation contract. This slice does not
make offline deletion or revoked history recoverable.
