# Owner-scoped Activity deletion pages

Status: bounded NNA HTTP prerequisite. The NND client does not yet consume it.

`GET /v1/nnd/activity-tombstones` exposes only the existing deletion journal for
the authenticated native principal. Every page requires `nnd.read` and selects
the journal by exact subject and sorted workspace grant. The request has no
session ID parameter, so it cannot probe whether another owner's session was
deleted. A missing owner journal yields an empty page with
`historyComplete:false`; it does not prove there were no earlier deletions.

The only query keys are `after` (default `0`, a canonical nonnegative safe
integer) and `limit` (default `50`, integer `1`–`100`). Duplicates, unknown keys,
noncanonical numbers, and out-of-range values fail before journal access.
`after` is the last observed owner-journal sequence. A page returns only
retained deleted session IDs, creation and deletion times, and sequence
numbers. `nextCursor` is the last returned sequence or the supplied `after`
when no record is available. It is a continuation position, not authorization.

At most 256 entries are retained per owner. If `after` falls below the
truncation `floor`, or points beyond the journal's next sequence, the response
has `status:gap`, `records:[]`, `nextCursor:null`, and `historyComplete:false`.
The client must then reconcile the authoritative session catalog; it must not
infer that every historical deletion was observed. A corrupt owner journal
fails closed. A durable intent written before catalog removal is visible as a
deletion only if that exact session incarnation is absent from the live
catalog, including after restart. The route uses the same host journal and
does not create a second deletion store.

This endpoint covers parent-session deletion only. It does not cover workspace
grant revocation, child-session history, or complete Activity replay. Future
NND recovery must pair these pages with authenticated catalog reconciliation
and the existing live SSE gap/boundary contract.
