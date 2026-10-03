# NND quarantined owner handoff

Status: private held-live prerequisite. No public activation command uses this path.

After the promoted private attach is durably recorded, the final owned task may
retain the same live supervisor rather than stop its child. The supervisor
requires that exact receipt and keeps the original singleton lease. The native
listener remains quarantined, the controller remains dark, and the pending
activation marker and journal still block ordinary startup. The returned owner
is an in-process stop/status handle, never a public attach ticket.

The final callback is one-use. Retention before the receipt, repeated retention,
an exited child, a closed listener, changed generation, lost lease, callback
failure or cancellation fails closed. Failure after retention still stops the
trial; an uncertain stop retains the singleton for diagnosis. Lease release is
armed only after the trial's outer lease operation settles, so stopping during
handoff cannot wait on its own lease operation.

The held process can still die before or after a durable completion decision.
Its pending barrier prevents ordinary restart from treating either historical
receipt as live authority. A following transaction must retire the marker and
terminal evidence with bounded recovery, open controller and native admission,
and verify public attach before an installer may report success.
