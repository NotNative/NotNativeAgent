# NND retained native admission transfer

Status: private, live-owner-only native transition; public controller remains dark.

After ADR 0065 has durably written and reopened the cleared witness and removed
the exact decision, plan, and pending marker, the same retained supervisor may
transfer its existing native listener from trial quarantine to ordinary NND
request admission. It must still hold the genuine data-root service lease and
selected package-registry mutex. The private verifier reopens the terminal
commit and cleared witness, proves their canonical hash relationship, requires
all three earlier barriers and activation artifacts absent, and checks the
selected registration, discovery pointer, listener state, and recorded live
Windows child identity. Missing, altered, or uncertain evidence refuses the
transition. A one-use in-memory proof binds the exact supervisor state, both
leases, identity, and generation.

The gate consumes this proof synchronously and switches once. Afterward it
continues to require the same live service lease, retained owner, promoted
principal, native listener, controller listener, child, operation, and
generation for every request. It no longer requires the package-registry
mutex, allowing that mutex to be released while the retained service runs.
The controller still returns no public record and does not issue ordinary
attach credentials. Controller publication and durable startup reconciliation
are separate transitions; a crash still leaves the terminal commit and
cleared witness as ordinary startup barriers.

The focused tests cover early and partial retirement, changed proof files,
lost child or registration/discovery authority, forged/replayed proof,
registry release after transfer, and service-lease loss after transfer.
