# Held NND discovery publication prerequisite

This is an internal, dormant continuation. It does not provide a public activation command,
change the trial's read-only principal, issue a browser ticket, transfer the live owner,
clear the protocol-three admission barrier, or mark an installation complete.

Under the original service and package-registry leases, the native continuation first
requires registration reconciliation to prove `selected_unresolved` with the original
child process still alive. It verifies the five-phase journal, exact pending marker,
candidate stage operation and registration digest, selected package bytes, persisted
child PID/start identity and generation, and the private discovery generation. The
controller endpoint and token must match the private record. It rechecks the child and
native process identities immediately before and after a `current.json` compare-and-swap
from absence to the private generation.
The final pre-publication read requires the exact marker bytes and child schema, and
recomputes the trial-starting, trial-running, and registration-CAS journal evidence.
Changed evidence after registration reconciliation blocks pointer publication.

A saved pointer is confirmed by reading back the exact private record before appending
the `discovery_published` journal receipt. A throw after the pointer write is reconciled
by that read-back; a foreign, absent, or unconfirmable pointer remains unresolved.
The result is `discovery_published_unresolved` and the admission barrier remains. If a
crash or journal failure occurs after pointer publication, the pointer itself is evidence
of uncertainty; it must not be treated as a completed activation or removed from an
unproven process. The controller continues to withhold its record and tickets while the
supervisor's published flag is false.

The current trial always shuts down after its continuation and then discards an
unpublished generation. Calling this primitive from that trial would publish a pointer
to a stopping process, so it is intentionally unwired. A later owned-live activation
transaction must add post-publication health, durable completion, same-process native
authority transition, live owner transfer, and rollback/crash reconciliation before this
primitive can be used to expose an installed service.
