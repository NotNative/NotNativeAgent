# Architecture decision 0026: Unpublished NND trial health

Status: dormant native trial foundation in `20261002-16`. It does not activate,
select, publish or attach NND for an operator. The pending activation barrier
remains after this probe.

## Held ownership and authority

The trial continues a prepared immutable-slot candidate under the original
data-root lease and registration mutex. An internal one-use capability binds
the selected identities, slot and preparation receipt. The trial starts a native
listener and GUI child without publishing discovery or issuing browser tickets.
Its native principal permits read and health operations only; an unpublished
child cannot change native settings or execution state through this principal.

The journal records `trial_starting`, `trial_running` and `trial_healthy` phases
against the selected operation. The running proof checks exact installation and
data identities, package version, generation, native `ready` or
`setup_required` state, a bounded authenticated native health response, a
bounded loopback GUI `/health` response, and child liveness before and after
the requests. A degraded, unresolved, changed or exited child fails. An expired
outer ownership operation cannot advance to a new phase after preparation.

The trusted internal continuation runs while the same child and both locks
remain held. The current default continuation performs no publication. The
trial then verifies health again and awaits confirmed child and native shutdown.
An uncertain stop requires the caller to retain both locks and the pending
barrier; release is not proof that descendant writers stopped.

## Completion dependency

This probe leaves a healthy journal phase but no selected package or live
published service. It is not an installer success criterion. A later activation
transaction must provide a promotion path inside the held-live continuation:
durable child PID and start identity, exact registration compare-and-swap,
discovery compare-and-swap, post-publication health, transfer of the live owner,
and exact rollback or conservative recovery after every crash boundary.
Journal and initializer evidence must be retired only after a verified terminal
outcome. The legacy source installer and pinned desktop shortcuts are outside
this trial and remain unsuitable for immutable-slot upgrades.
