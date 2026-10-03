# NND dark controller challenge

Status: private post-publication health prerequisite. It does not complete
activation, promote a principal, issue a UI ticket, or grant public attach.

The selected discovery pointer can be published while its controller remains
dark. Public `/status`, `/attach`, `/stop`, and `/ui-ticket` still return 401
because the controller's `getRecord` callback returns null. The held-owner
health verifier now asks that same live controller to prove a read-only view
of the exact selected installation, data identity, generation, UI endpoint,
and native service state. It does this through a distinct loopback challenge
route with a random one-use credential and a bounded deadline and response.
The controller consumes the credential before reading status and never calls
the child ticket command. The verifier compares the response with the
selected pointer, GUI proof, registration, journal, child process identity,
and both original ownership leases that it already checked. A failed or
ambiguous challenge leaves the activation barrier in place.

This challenge proves the controller listener and selected status are live;
it does not authenticate a browser session or prove that a UI ticket can be
issued and redeemed. A later private ticket/attach proof must keep ordinary
native mutations closed and public controller routes dark until durable
completion and same-child ownership transfer are implemented. Recording a
`completed` phase from this challenge alone would be false: the current trial
runner still stops the child before returning.
