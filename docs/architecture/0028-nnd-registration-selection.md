# Architecture decision 0028: Held NND registration selection

Status: dormant activation prerequisite in `20261002-18`. Selection alone does
not install, publish or attach an NND service. The protocol-three admission
barrier remains in place and the unpublished trial still stops.

## Exact held-live checkpoint

An internal trusted continuation may select a verified immutable-slot package
only while the same trial child, data-root lease and registration mutex remain
held. Native code verifies the healthy journal chain, exact pending marker,
candidate evidence, prior package bytes or absence, and the package record
schema. It records the live child PID and start identity in private evidence,
rechecks that identity around the receipt-backed manifest compare-and-swap,
then appends a `registration_cas` journal phase. The selected bytes must match
the candidate's exact manifest serialization and digest.

The continuation's selector is revoked when the continuation returns. The
outer trial awaits every selection attempt, including an unawaited promise,
before health checks and shutdown. A failed attempt remains an unresolved
result even if the continuation catches its error. This prevents a late CAS
after the trial child has stopped or a misleading `trial_healthy` result after
a potentially saved CAS.

## Visibility and recovery boundary

No discovery pointer, browser ticket or write-capable principal is issued.
`nnd package status` reports registration bytes, not activation readiness;
an installer must use a separate completed activation result. Ordinary service
startup remains denied while the pending marker and journal survive. A crash
after the CAS but before its phase receipt is an uncertain outcome requiring
native reconciliation of exact prior/current bytes and child evidence. It is
not resolved by clearing the marker, repeating activation, or claiming health.

The next transaction work must reconcile that uncertain outcome, publish the
matching discovery generation under CAS, verify post-publication health,
transfer the live owner and principal, and complete or roll back with durable
evidence before lifting the barrier.
