# NND private ticket proof

Status: dormant held-owner prerequisite. It does not complete activation,
enable public attach, or broaden native request permissions.

After post-publication health and one-use principal selection, an internal
held-owner operation may ask the *same* supervised NND child for one UI
ticket. It checks the original service lease and package-registry mutex, the
exact selected native listener and trial state, selected operation and
generation, and the durable registration, journal, pointer, child process,
GUI proof, and dark controller challenge through the existing health verifier.
The request is marked used before child IPC, so a timeout or unknown result
cannot cause a second ticket request for that trial state.

NNA redeems the ticket through NND's loopback native-bootstrap route, checks
the returned cookie against NND's session-status route, and verifies that the
same ticket cannot be redeemed twice. The ticket and cookie stay inside this
private call and are never returned to a browser, controller, CLI, or caller.
The operation repeats exact post-publication health afterward and returns
only an unresolved, non-credential proof. A failure preserves the pending
activation barrier and original owners for reconciliation. Public controller
`/status`, `/attach`, `/stop`, and `/ui-ticket` remain dark, and the native
listener still uses the trial principal and closed-only mutation gate.

This proves private ticket issuance and redemption by the selected live NND
service. It does not prove that a user browser can attach, that the effective
native principal has changed, or that the child will survive an ownership
transfer. Durable completion, terminal evidence retirement, transfer of the
same child/listeners/lease, and public attach remain separate requirements.
