# NND retained trial discovery cleanup

Status: private barred lifecycle repair. It does not open native admission,
expose the controller, remove the activation marker, or report installation
success.

A quarantined trial may have a published discovery pointer while its in-memory
`published` flag remains false. After confirmed native-listener, GUI-child and
dark-controller shutdown, the original service lease is still held. The stop
path reads the protected current pointer. An absent pointer permits private
generation discard. A pointer must exactly equal the retained owner's record,
including installation/data identity, generation, endpoint, controller token,
process identity and creation time, before removal is attempted. A foreign or
changed pointer is preserved and blocks singleton release.

The protected discovery mutator can remove the pointer before its response is
lost. The stop path rereads current state under the still-held service lease.
Absence permits idempotent private generation discard. The unchanged exact own
pointer permits one bounded retry. A second unchanged pointer, foreign pointer,
failed readback or failed discard leaves the singleton held for diagnosis.
Resource shutdown failure performs no pointer removal or generation discard.
This path does not clear activation evidence; the pending barrier continues to
deny ordinary service startup even after a clean stop.
