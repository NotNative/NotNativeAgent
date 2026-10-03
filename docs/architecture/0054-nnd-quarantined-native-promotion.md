# NND quarantined native principal promotion

Status: private held-live prerequisite. No public activation command calls this operation.

After the same listener has a ticket-confirmed principal selection, the final held-live owned task can promote its in-memory native principal exactly once. The operation binds the original service lease, registry mutex, activation operation, stage operation, and generation. It runs synchronously while the controller is dark. A foreign owner, missing ticket confirmation, changed generation, closed listener, or repeated attempt fails closed. The final callback still stops the trial and retains the activation barrier.

Before promotion, the unpublished listener uses the trial principal and admits read-only requests. Promotion changes the resolver to the native operator principal on that same listener. In the same synchronous turn, its admission gate enters a stricter quarantine: only exact `GET /v1/health` can reach routing. All other reads and every mutation are denied before principal resolution. The native health check remains available for the next private proof, but no ordinary GUI operation gains broader access while completion is pending. The controller still returns no public record or attach ticket.

The held owner can issue one fresh UI ticket after promotion and redeem it on loopback. This second proof verifies the authenticated session and rejects ticket replay while the controller stays dark. It rechecks the exact ticket receipt, selected registration, pointer, child, and health evidence before returning only unresolved evidence. An unknown IPC or HTTP outcome burns its one attempt.

In-memory promotion and this private attach are not a durable completion decision. Owner death loses them; the pending marker and activation journal still block ordinary startup. A later held-live transaction must bind the post-promotion proof to a durable `completed` receipt, transfer the same supervisor and singleton lease, retire terminal barriers safely, then open and verify public attach. Until those steps exist, this slice cannot claim installation success.
