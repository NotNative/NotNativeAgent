# NND final held-live window

Status: private prerequisite. No public activation command invokes this window and it cannot retain a service.

The unpublished trial now offers one internal `afterFinalVerification` callback after its last trial health check, while the original service lease and package mutex remain held. The callback receives a one-use `withFinalOwnership` operation. Work started through that operation is settled even when the callback forgets to await it; a retained wrapper is revoked on callback exit. Callback failure or an owned-task failure still goes through confirmed trial shutdown. The return value never suppresses `trial.stop()` or reports activation.

Inside that owned task, a one-use private verifier can connect the durable `private_ticket_verified` receipt to fresh post-publication health and the existing synchronous principal-transition proof. It reads exact receipt evidence before and after the health proof, consumes the proof in its brief synchronous callback, and returns only unresolved, credential-free evidence. A changed receipt, registration, pointer, child, listener, or ownership lock fails closed. Unawaited ticket verification is also settled before stopping the child.

This window does not promote the native principal, write `completed`, retire terminal evidence, transfer the singleton lease, open controller routes, or verify public attach. The durable commit and same-process owner-transfer protocol remain separate work; calling this window alone intentionally stops the trial and leaves the activation barrier unresolved.
