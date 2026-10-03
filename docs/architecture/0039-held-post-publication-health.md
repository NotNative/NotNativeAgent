# Held NND post-publication health prerequisite

The private verifier checks a selected, published NND trial while the original
native service lease and package-registry mutex remain held. It is intentionally
unwired: the existing trial continuation still stops its child, so calling this
verifier there would leave a published pointer to a stopping process.

The verifier requires the exact six-phase activation journal, pending barrier,
candidate and child evidence, forward registration receipt, selected registration
bytes, and the published discovery generation. It checks the recorded child PID
and start identity and the owning NNA process identity before and after health
requests. Native runtime health must answer with expected identity, state, and
bounded response while the original integration listener remains open. A
replacement listener could read the probe bearer and imitate its health body.
The GUI's public `/health` is anonymous; its supervised
private challenge must answer with a bounded HMAC over a fresh nonce and the
selected installation, data root, generation, and origin using its protected
bootstrap key. The earlier unpublished-trial health probe requires the same
proof before registration and discovery can be selected. The private controller must still be listening,
while authenticated `/status` and `/attach` requests remain denied with 401.
It never flips the supervisor's published flag, issues a browser ticket, changes
the native trial principal, clears the barrier, writes operator state, or marks
activation complete.

The supervised bootstrap frame carries a fresh, 32-byte base64url `health_key`
only through the protected child stdin. NNA sends a fresh 32-byte base64url
`nonce` in a bounded JSON `POST /__nna/health-proof`. NND responds with only
`{"protocol":"1.0","mac":"<64 lowercase hex characters>"}` and `no-store`.
The MAC is HMAC-SHA256 keyed by the decoded health key over the UTF-8 encoding
of `JSON.stringify(["NND_SUPERVISED_HEALTH_V1", nonce, installation_id,
data_id, generation, ui_origin])`. NNA compares the exact 32-byte digest in
constant time. This route exists only for the supervised child; the public
`/health` format remains unchanged.

A failed probe leaves the pointer and journal unresolved for owned recovery.
Later activation work must provide durable completion, same-process native
principal promotion, live owner transfer, and an explicit post-promotion attach
check before the installer may report an active NND service.
