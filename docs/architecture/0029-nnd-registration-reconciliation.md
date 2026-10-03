# Architecture decision 0029: Held NND registration reconciliation

Status: dormant activation evidence classifier in `20261002-28`. It does not
publish NND, restore registration, clear the pending barrier or report service
readiness.

## Evidence and classification

Only the genuine holder of the native data-root lease and registration mutex
may reconcile a prepared operation. Native code checks the exact protocol-three
marker, chained trial journal, canonical candidate and stage transaction,
recorded prior bytes or absence, desired registration bytes, child generation
and PID/start identity, and the durable manifest operation receipt. The new
locked receipt lookup avoids reacquiring the registration mutex. Receipt reads
may settle a prepared SQLite receipt through the existing manifest transaction
reconciler; discovery reads may initialize private gate storage. Neither action
changes registration, the public pointer, or the activation barrier.

The result is limited to `not_selected`, `selected_unresolved`, or `unknown`.
A missing, contradictory or foreign byte sequence, unavailable or reused child
identity, or any visible discovery pointer produces `unknown`. Preparation did
not record a predecessor pointer, so even a foreign pointer cannot be assumed
unrelated to this activation. A matching registration without a matching durable
receipt is not proof of a completed compare-and-swap. An unprovable stopped
child is not proof that all descendants stopped.

## Recovery boundary

The classifier is an observation under held ownership, not a recovery action.
`unknown` retains all evidence and the barrier. A later exact-byte rollback
primitive must restore either the recorded raw prior bytes or true absence with
its own receipt and compare-and-swap. Postmortem recovery also needs proof that
the GUI and integration writers have stopped; lease availability or PID absence
alone does not provide that proof. Public discovery publication, live ownership
transfer and terminal barrier retirement remain separate transactions.
