# NND held-live ownership transfer boundary

The existing unpublished-trial continuation already runs while the same GUI
child, native runtime, service lease, and package-registry mutex are live.
`runNndUnpublishedTrialUnderOwnership` bounds that work with a service-operation
signal, waits for registration-selection tasks to settle, verifies the trial
again, and then stops the child. A second held-live callback would duplicate
this contract without making activation possible.

The next distinct operation is a transfer of the *same* supervisor session.
It must run inside the current held-live ownership scope after the final
`trial.verify()` in `verifyAndContinue` and before `liveTrial`'s unconditional
`trial.stop()`. The existing continuation callback runs before that final
verification, so it cannot itself be the transfer commit point without a
change to that ordering. The transfer must accept only an internal, one-use
proof bound to the operation, selected
registration bytes, published generation, recorded child PID and start
identity, completed post-publication health, and both original leases. The
transfer must replace the trial's stop and discovery-discard policy with
long-lived supervision of that same child, native listener, controller,
discovery generation, and singleton lease. The caller's lease-release
responsibility must move into the supervisor's stop path: the trial session
currently has `releaseLease: null` and its stop path discards the trial
generation. It must not spawn a replacement child or release the registry
mutex before the durable completion decision.

The private post-publication health verifier can now issue a one-use,
same-process transition proof during a synchronous held-owner callback. The
proof is bound to its verified registration revision and journal receipt, live
trial objects, operation, generation, and both original leases. It is retired
when that callback returns. Consuming it only returns unresolved evidence: no
principal changes, completion receipt, ownership transfer, or public attach
follow from consumption. The current code has no transfer transition. Returning a live
handle from the trial now would end `runManifestLeaseWork` while selection and
completion remain unresolved under the registry mutex.
Suppressing `trial.stop()` on a callback's unverified return would leave a
published pointer or private credential attached to an unowned process. A
throw, timeout, or cancelled callback must therefore retain the existing
confirmed-stop or unresolved-shutdown behavior; it cannot report activation.

The transfer transaction must revalidate exact registration, pointer,
journal, pending marker, child/process identities, and health under both
locks. Principal promotion and a new private attach/ticket probe must occur
while the controller remains dark; the existing `issueSupervisorTicket`
rejects unpublished trials, so this requires a separate internal path rather
than bypassing its guard. The current controller exposes `/status`,
`/attach`, `/stop`, and `/ui-ticket` together when `state.published` becomes
true, and its public attach path does not inspect the activation marker; a
public attach request cannot serve as the pre-retirement probe. The durable
`completed` phase must bind same-process promotion and the successful private
probe, but remains unresolved while the marker or activation evidence remains
and cannot prove that a principal survived process death. The terminal
receipt and evidence-retirement protocol must allow ordinary-start admission
only after the pending marker, preparation row, and activation-directory
evidence are gone; a terminal journal record left in that directory still
blocks admission. Only after terminal evidence is durably established and the
admission barrier is safely retired may the controller open public attach. A
successful public attach check is then required before reporting activation
to the installer;
failure must retain the live owner for diagnosis or shut it down with
confirmed cleanup. Crash recovery must distinguish intermediate states by
receipts and live identities, never by `completed` alone. A marker unlink
alone is not completion:
`assertNoNndInstallTransaction` also rejects the preparation row and remaining
activation evidence.
Terminal evidence retirement and ordinary-start admission must be designed
together, with a crash between their writes remaining fail closed.
