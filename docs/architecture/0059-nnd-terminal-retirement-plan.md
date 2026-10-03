# NND terminal retirement plan

Status: private barred intent only. No pending marker, activation evidence, native
admission gate, or public controller route is changed by this slice.

The same retained child and original data-root lease may, under a genuine
package-registry mutex, prepare one durable cleanup intent after the nine-phase
`completed` receipt. The planner reopens the complete predecessor chain,
selected registration, discovery pointer, recorded child, and pending marker;
checks the retained child and both listeners; and hashes every exact sidecar and
journal file. A bounded `activation-retirement.json` at the protected slot root
binds operation, stage, installation and data identities, generation, completion
receipt, directory identity, marker, and expected files. It contains no ticket,
token, cookie, or control credential. Its state is explicitly `planned_barred`.

The private observer accepts only a complete canonical plan and unchanged
evidence under the service lease and registry mutex. A missing plan is
`unknown`; an interrupted write, missing or changed file, foreign identity,
or replaced directory is unresolved and leaves the marker intact. The writer
does not retry a partially written plan. This is a single outstanding plan;
future terminal recovery must finish or reconcile it before a new activation
can reuse the slot. The plan never means that the installer succeeded.

Before any barrier deletion, the retained owner's stop path must reconcile the
published discovery pointer and singleton lease. Today an unpublished trial
stop tries to discard its private generation, which refuses a generation still
named by the published pointer. The native trial gate also remains closed and
bound to the original registry lease, while the controller remains dark.
Those same-process lifecycle transitions must be proven before terminal
retirement can safely remove the marker. Later retirement will keep the
activation directory until after marker removal, append `barrier_cleared`,
delete only exact planned evidence, and remove the directory last. Recovery
must verify each prefix; a dead or unconfirmed owner remains barred.

The stop repair belongs in `closeSupervisor` in `nnd-service-supervisor.js`.
After confirmed listener and child shutdown, a retained trial with a published
activation pointer must verify that the pointer still names its exact private
generation, remove that pointer under the original service lease, then discard
its private generation. If pointer removal has an uncertain result, reread it:
an absent pointer permits discard, and the unchanged own pointer permits a
bounded retry. A
foreign pointer, failed close, or unconfirmed removal must retain the singleton
and marker. The stop path must not classify `state.published === false` alone as
proof that no pointer was published. Add stop and crash tests for prepublication,
published, lost-response, foreign-pointer, and failed-close states.

The later gate transition belongs in `nnd-trial-admission.js` and the retained
session in `nnd-service-supervisor.js`. The closed gate currently checks the
original registry lease on every native request; `startNndNativeService` in
`nnd-service-native.js` installs that gate for the listener's lifetime. A
one-use internal transition must verify the terminal receipt, absent admission
barriers, unchanged manifest/pointer/child identities, live original service
lease, and same-process principal. It can then change the gate to service mode
without requiring the registry mutex for each later request. Open native
admission before making the controller's `getRecord` return the published
record, in one owned transition with no external await between those in-memory
steps. `startNndController` in `nnd-service-controller.js` opens `/attach`,
`/status`, `/stop`, and `/ui-ticket` when that record becomes visible. Verify a
fresh public attach before reporting installation success; any failed
transition keeps the owner live and barred or confirms shutdown.
