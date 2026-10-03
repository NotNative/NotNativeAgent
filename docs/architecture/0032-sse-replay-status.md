# Architecture decision 0032: Explicit event replay status

Status: additive NND event-stream contract in `20261002-31`.

NNA retains only a bounded in-memory suffix of events. A client cursor that is
missing after eviction or restart cannot certify that the client saw all
intervening activity. Previously the connection looked identical to a complete
replay, leaving a browser to infer continuity from a live-only stream.

The cursor-free `server.connected` opener now carries `replayStatus`. `fresh`
means no cursor was supplied; `complete` means the cursor remains in the
contiguous ring and is visible under the current principal and full workspace
scope; `gap` means completeness cannot be certified. A gap sends no partial
suffix. A complete admission replays the visible suffix in order under the
same filter as live delivery. A foreign cursor never acts as proof for the
current principal. The opener has no SSE `id`, so it cannot replace the last
resumable event cursor.

This status is transport evidence, not durable event history or an
authoritative state snapshot. NND still reconciles current sessions, statuses
and viewed transcripts after reconnect. Recovering every missed transient
activity item requires a separate durable history contract.
