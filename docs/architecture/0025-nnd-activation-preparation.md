# Architecture decision 0025: Native NND activation preparation

Status: dormant preparation foundation in `20261002-15`. This decision does not
declare installed NND activation. Trial startup, native health acceptance,
registration selection, discovery publication, rollback and terminal recovery
remain separate work.

## Boundary

NNA owns the optional NND service lifecycle and package selection. NND remains a
separate artifact; NNA's TUI and engine can run without it. Activation preparation
may inspect a verified immutable NND slot, but cannot execute it or change the
selected package. Only a later held-owner transaction may carry the same genuine
data-root lease and registration mutex through trial and publication.

## Durable preparation

The native preparer validates the selected installation and data identities,
the slot provenance and complete payload, and the exact prior package
registration bytes. It acquires the data-root lease before the registration
SQLite mutex. A private SQLite initializer intent covers the crash window before
file evidence is durable. Prepared evidence then records the candidate, exact
prior bytes, a chained journal phase and the protocol-three pending admission
marker. The initializer row is cleared only after the barrier is durable.

Candidate trial authority is an internal one-use capability bound to the genuine
held locks and verified evidence. Browser input, a path string, and a service
command cannot mint it. The preparer does not publish a user-facing activation
command. Ordinary service admission fails closed when an initializer row, pending
marker, or surviving activation evidence makes ownership unresolved. It checks
the fixed protected storage and refuses linked ancestors; it never follows an
arbitrary candidate path for recovery.

## Failure semantics and next step

An interrupted preparation preserves the barrier and evidence for native
reconciliation. Missing or changed evidence is uncertain, not proof that the
candidate was never started. The current conservative census continues to block
ordinary startup even if a pending marker disappears. A later completion or
rollback slice must record and verify a terminal outcome before retiring its
evidence and clearing admission. It must not simply delete the marker or release
locks after trial begins.

The initial activation transaction must keep the lease through unpublished trial
startup, exact native health and process checks, compare-and-swap registration
selection, discovery publication and confirmed settlement or rollback. It must
preserve exact prior bytes and prohibit schema-changing migration during trial.
Only after these steps and installed browser/desktop acceptance may an installer
claim a healthy NND installation.
