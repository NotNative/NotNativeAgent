# NND external retirement decision

Status: private historical proof; admission remains barred.

The activation journal is inside the directory that terminal cleanup will
eventually remove. Its `completed` row and the v35 retirement plan therefore
cannot be the only evidence for a later crash-reopening reader. A retained,
live same-process owner, holding the original NND singleton lease and a fresh
genuine package-registry mutex, may write one canonical
`install-slots/activation-retirement-decision.json` after reopening the exact
v35 plan and predecessor chain. A missing or partial decision never authorizes
cleanup; `wx` publication is single-use and uncertain writes are not retried.

The decision binds the plan hash, completed receipt, pending marker, candidate,
original registration bytes, child sidecar and Windows process identity,
selected manifest revision and operation identity, and published discovery
generation hash. It carries no controller token, UI ticket, or secret. Before
writing, the owner checks the recorded child against a live OS process capture
and checks that the selected manifest and discovery pointer still identify its
retained generation. The writer rereads the canonical decision after writing.

The private reader requires the data-root lease and registry mutex, a canonical
decision and plan, and the selected registration. It checks the exact bytes of
the marker, sidecars, and journal files that still exist against the plan. It
reports complete, partial, or absent journal and sidecar evidence, and present
or absent marker and discovery pointer, without interpreting any of those
states as success. Foreign or modified evidence fails closed. The historical
decision therefore survives journal and sidecar deletion. If a future cleanup
removes the marker before retiring the decision, ordinary NND startup remains
barred because the install transaction guard checks the external plan and
decision independently of the marker and activation directory.

This decision is **not** a barrier-cleared receipt. Later cleanup must prove
shutdown or safe owner transfer, reconcile discovery, remove only exact planned
artifacts, and record each crash prefix before it can remove the marker or open
native and controller admission. A dead or unconfirmed owner remains barred.
