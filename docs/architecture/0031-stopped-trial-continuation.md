# Architecture decision 0031: Confirmed trial shutdown continuation

Status: internal activation prerequisite in `20261002-30`. This does not
restore registration, publish discovery, remove the admission barrier, or
claim that an installed NND service is ready.

## Owned post-stop boundary

An unpublished NND trial can invoke an internal `afterStop` continuation only
after its supervisor's `stop()` resolves. The original data-root service lease
and package-registry mutex remain held. A rejected or uncertain stop never
invokes the continuation; the activation remains unresolved with its barrier.
The continuation also runs after a confirmed shutdown when an earlier trial
or registration step failed, so it can inspect the original failure without
mistaking it for a successful activation.

`withShutdownProof` tracks and awaits work started by the continuation. Its
opaque proof is one-use and scoped to the held lease objects, installation and
data identities, stage and activation operations, generation, live ownership
signal, and the exact persisted child PID/start evidence. Missing or changed
child evidence cannot authorize a mutation. The proof is revoked when the
tracked work settles. A future caller must put the entire asynchronous write
inside `withShutdownProof`; detached work is outside this ownership boundary.

## Rollback is a separate transaction

The proof is only a prerequisite for a future NND-specific rollback. That
transaction must verify the forward registration receipt, marker, journal,
candidate, child identity, exact prior and desired bytes, and absence of a
discovery pointer before it writes. It must record an intent, use a distinct
receipt-backed exact-byte manifest CAS, and record completion while retaining
the admission barrier. Process death does not recreate this in-process proof;
crash reconciliation needs separate evidence and must not infer shutdown from
an absent PID alone.
