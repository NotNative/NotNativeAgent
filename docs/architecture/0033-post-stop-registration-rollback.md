# Architecture decision 0033: Post-stop registration rollback

Status: internal activation recovery prerequisite in `20261003-1`. The
ordinary NND admission barrier remains held. This slice does not publish a
service, clear the barrier, or retry a rollback after process death.

## Restore only the selected transaction

After an unpublished trial's shutdown is confirmed under its original service
lease and package-registry mutex, a one-use proof permits an exact registration
rollback. The private operation rechecks the protocol-three pending marker,
prepared candidate and immutable slot provenance, journal chain, persisted
child PID/start/generation, exact prior bytes or true absence, saved forward
manifest receipt, current selected bytes, and absence of a discovery pointer.
Any missing, changed, or foreign evidence leaves the registration and barrier
unresolved.

The operation appends `rollback_pending` before mutation, then uses a distinct
stable receipt-backed manifest compare-and-swap to restore the copied prior
bytes or absence. It verifies the rollback receipt and exact readback before
appending `rollback_complete`. The result means only that registration was
restored while the barrier remains. The same operation ID cannot be silently
reused against changed evidence.

## Interrupted outcomes

A death before the intent retains selected registration and the barrier. A
death after the intent but before publication retains `rollback_pending` and
the barrier. A death after publication but before completion retains its raw
receipt, restored bytes, `rollback_pending`, and the barrier. These states
need a separate held-owner observer and explicit recovery decision. An absent
PID after a crash does not recreate the in-process shutdown proof and never
authorizes an automatic retry or barrier retirement.
