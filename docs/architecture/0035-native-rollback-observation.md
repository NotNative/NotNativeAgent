# Native registration rollback observation

Status: implemented as a private, read-only activation primitive in NNA `20261003-3`.

An interrupted NND activation can leave a pending admission barrier after a
confirmed trial shutdown and an attempted registration rollback. Under the
held NND service lease and registry manifest lease,
`reconcileNndRollbackUnderOwnership` compares the exact marker,
journal chain, selected candidate, child record, prior registration bytes,
forward and rollback receipts, current raw registration bytes, and absence of
the discovery pointer. It reports `registration_restored_barrier_held`,
`rollback_not_published_barrier_held`, or `unknown`.

The observer does not retry a compare-and-swap, append a journal phase, infer
child shutdown from a missing PID, publish discovery, or clear the barrier.
Malformed, missing, or foreign evidence fails closed. A later recovery
continuation must establish child quiescence and decide whether to resume or
retire the barrier; this read-only result alone cannot authorize admission.
