# NND promoted private attach receipt

Status: private unresolved prerequisite. No public activation command uses this receipt.

The final held-live owned task may record a fresh private UI attach after its
ticket-bound same-process principal promotion. The writer holds the original
service lease and package registry mutex, verifies the exact private-ticket
receipt and selected activation evidence, and consumes the one-use promoted
attach probe. Only then may it append `promoted_attach_verified` after
`private_ticket_verified`. Its evidence hash binds the operation, stage
operation, installation and data identities, generation, ticket receipt,
selected registration revision, and recorded child bytes. It stores no ticket,
cookie, controller credential, or wider authority.

An uncertain append is never retried by issuing another ticket. Under both
locks, the crash observer verifies the full preceding ticket receipt,
candidate, selected registration, pointer, child identity, and journal chain.
It returns historical `promoted_attach_recorded_unresolved` or `unknown`;
neither result proves a live process or a retained in-memory principal. A
foreign or malformed receipt fails closed. The pending marker and activation
directory remain, so ordinary startup stays blocked after owner death.

`completed` requires this receipt in the journal sequence, but writing it
remains unsafe. A later private slice can retain the same quarantined child and
singleton lease after this receipt. It still leaves the pending marker and
activation evidence in place. Durable completion, terminal barrier retirement,
public attach and crash recovery remain separate work. This receipt alone does
not report successful installation or relax native or controller admission.
