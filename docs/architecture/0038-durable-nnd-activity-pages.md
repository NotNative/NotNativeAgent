# Durable NND Activity snapshot pages

Status: internal foundation.

The NND engine host can page a parent session's persisted Activity snapshot only after it
checks the complete authenticated principal grant for that live context. The reader uses the
disk snapshot, not the in-memory event list. The existing snapshot contains at most the latest
500 sanitized records. A page returns records in chronological order, starting with the newest
retained page and moving backward. It reports the exact snapshot digest, session creation time,
retained count, and first and last retained record IDs. `historyComplete` is always false: the
snapshot cannot prove that no earlier records were discarded or that pending live records have
reached disk.

The opaque cursor binds the session ID, creation time, snapshot digest, and next record offset.
It does not grant access; the host checks the principal again for every page. A changed snapshot
or recreated session returns an explicit `gap` response with no mixed records. Invalid or foreign
cursors fail. Unchanged durable pages remain readable across an NNA restart. Missing disk state
is reported as absent rather than as complete history.

This internal read is not an SSE replay cursor or a full F2 recovery protocol. It does not pair
the disk snapshot with the live event-stream cursor, retain deletion or revocation tombstones,
or recover records beyond the bounded suffix. An HTTP route and NND client should be added only
after the cross-stream snapshot boundary and gap behavior are reviewed together.
