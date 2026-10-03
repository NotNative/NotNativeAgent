# NND retained public controller transition

Status: private same-process transition; no installer or CLI activation command yet.

The retained trial owner may expose its already selected controller only after the
native gate has transferred under ADR 0066. `publishController` requires the
original live service lease and selected package-registry mutex. It reopens the
terminal commit and cleared witness, confirms the three earlier barriers and
activation artifacts are absent, and checks the selected registration, discovery
pointer, listener state, and recorded Windows child identity. The verifier repeats
those checks before a synchronous in-memory controller switch. No caller can
provide a controller record or override the selected generation.

After the switch, the owner makes an ordinary authenticated HTTP `attach` request
through the selected controller. The existing attach validator checks generation,
identity, loopback endpoint, and the returned ticket shape. Only a successful
request returns `public_controller_attached`. A failed or changing response
immediately darkens the controller and leaves the owner alive. Publication is
single-attempt in that process because a ticket might have escaped during an
uncertain response. The terminal commit and cleared witness remain durable;
ordinary fresh startup still refuses them. A crash after the switch therefore
does not silently authorize a replacement service.

The transferred native gate accepts the retained owner's public-controller flag
while continuing to check the original service lease, process, generation,
principal, and listeners on every native request. Before transfer, that flag
remains invalid. Without this paired gate change, attach could succeed while
every native request from the GUI failed.

The public activation command remains a separate integration slice. It must
bind an explicit staged operation and activation UUID, acquire the genuine
service lease and selected registry mutex, run the unpublished trial and its
final retained-owner window, then drive completion, retirement plan, external
decision, exact cleanup, terminal commit, barrier clearance, native transfer,
and this controller transition on that same owner. It must retain ownership
through an attach verification and only then report readiness. Interrupted
prefixes require explicit reconciliation of the live child, selected pointer,
registration, terminal files, and in-memory gates. The current witness does
not authorize a new process to resume a lost owner. Until that recovery path
exists, the command must refuse those prefixes and preserve evidence. NNA's
standalone TUI path does not depend on NND.
