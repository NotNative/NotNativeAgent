# NND retained barrier clearance

Status: private barrier retirement; ordinary admission and public controller remain barred.

After the exact terminal commit of ADR 0064, the same live retained supervisor may
write a canonical `install-slots/activation-retirement-cleared.json` witness. The
genuine data-root service lease and selected package-registry mutex must remain
held. Before the first write, the operation reopens the plan, decision, marker,
terminal commit, empty activation inventory, selected registration and discovery
pointer, and live Windows child identity. Both listeners must still be alive and
the controller unpublished. The witness binds the terminal hash and the
historical plan, decision, completion, and marker hashes, as well as the
registration revision, discovery generation hash, and child process identity.
It contains no controller credential or UI ticket.

Only after the witness is written and reopened may the owner unlink the exact
decision, plan, and pending marker, in that order. Before and after each unlink,
the owner reopens the canonical witness and terminal commit, checks every
remaining barrier's bytes, the private activation inventory, registration,
discovery, live child, listener state, and retained ownership. An interruption
leaves a prefix that the same live retained owner can resume. A missing witness
never permits removal; an altered witness or terminal commit stops recovery.
No replacement or dead owner can infer success from the historical files.

The terminal commit and cleared witness both remain durable. Ordinary startup
continues to reject either file independently, including if the other is
missing. This operation does not expose the controller, open native admission,
rotate credentials, or select a new process. A later separately reviewed
transition must reconcile the live admission gate and public controller before
ordinary startup can treat the cleared witness as an admission receipt.
