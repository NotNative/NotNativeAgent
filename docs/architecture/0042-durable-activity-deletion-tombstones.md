# Durable Activity deletion tombstones

Status: internal deletion-only prerequisite. Grant revocation is not covered.

The live NND session catalog remains an array. A separate owner-scoped journal
records a deletion intent before the catalog removes a parent session. Both
writes use the existing atomic, synced JSON writer. The catalog remains the
authority for whether the session exists: an intent with a matching live
session is not a deletion; an intent whose exact session incarnation is absent
is a deletion even if the process crashed before journal finalization. A new
session with the same ID is held until that older intent is finalized. A
failed intent write prevents catalog deletion. Activity data is removed only
after catalog deletion and journal finalization, so history cannot silently
outlive a completed delete in the normal path.
If intent persistence fails, the still-live session is reopened for use and a
later delete may be retried. Concurrent deletes of the same ID are rejected
while the first is in progress. A crash after catalog deletion can leave the
old Activity file; same-ID creation removes that file before publishing the new
incarnation, including when the clock repeats its former creation timestamp.

Journals are keyed by the authenticated subject and exact sorted workspace
grant. Each retains at most 256 entries and a monotonic sequence floor. Only
committed entries can be pruned. Reads with a cursor below the floor, or a
cursor beyond the journal, receive an explicit `gap`, not an empty success.
Pages contain a bounded 1–100 records and always set `historyComplete:false`.
They expose only the session ID, incarnation creation time, deletion time and
sequence; no transcript, tool output, secret, or prior Activity snapshot is
retained. A different principal or changed workspace grant selects another
journal and cannot read the old owner's receipts.

This is an internal host read, not an HTTP endpoint. A future route must
require native `nnd.read` on every page and must not use an old journal as
permission to read Activity. A service restart can recover a deletion intent
against the durable catalog; a corrupt or unreadable journal fails closed.
Retention truncation and absent historic journals never claim complete
deletion history. Workspace grant revocation has no session transition hook in
this build, so no revocation tombstone is minted or implied. The NND client
still needs an authoritative session-list reconciliation and an explicit
revocation contract before it can treat deleted or inaccessible sessions as
fully recovered.
