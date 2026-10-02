# Architecture decision 0023: Native NND payload staging

Status: staging foundation. Activation, trial startup, stable launchers and installed
acceptance remain required before this contract can report an installed product.

## Ownership and storage

NNA validates and copies the prebuilt NND payload without executing incoming code.
The selected NNA installation supplies observed Windows x64/Node identity and
implemented capabilities. Input cannot supply a fictional host capability grant.
The payload lists exact bounded file names, sizes and SHA-256 hashes. Validation
rejects links, namespace collisions, incomplete Electron resources, incompatible
service metadata and missing local imports in the known launcher module closure.
This integrity check does not claim publisher authentication or package signing.
Before preparation, native staging checks every final absolute payload path against
supported Windows runtime limits: 259 UTF-16 units per file, 247 per ancestor
directory and 255 per component. Recovery and readiness repeat this check. The
limit protects Electron snapshots and native helpers that cannot open a long path
even when Node copied it. An unsupported selected data root fails before a receipt
or admission barrier is created, with guidance to select a shorter root.

The protected store is fixed at `DATA_ROOT/runtime/nnd/install-slots`. A binding
records canonical installation and data identities. Arbitrary shared stores are
unsupported: a data-root lease cannot serialize writers for a separate shared
directory. Published slots are `versions/VERSION-PAYLOAD_SHA256`; staging never
updates an existing published slot or the selected package registration.

Lock order is the native data-root lease, then the SQLite mutex for
`config/nnd-package.json`. The lease covers census, admission validation and the
whole operation. The registration mutex covers preparation through terminal
receipt publication. Existing package activate/deactivate writers use that same
mutex and refuse a pending slot transaction. Legacy installer guards already hold
the data lease in a companion process, so those legacy registration commands do
not attempt to acquire a second data lease. This compatibility path is not the
future native activation transaction.

## Preparation and recovery

`nna nnd service stage-payload INSTALL_ROOT PAYLOAD_ROOT OPERATION_UUID` stages an
artifact. `stage-recover INSTALL_ROOT [OPERATION_UUID]` reconciles its evidence.
Only native recovery can clear `runtime/nnd/installation-pending.json`. Service
admission, legacy serving, migration and installer guards refuse that barrier.
Legacy serving also refuses unfinished version-one installer guards; process
absence does not prove their descendant writers have stopped.

Before allocating a transaction directory, a private SQLite initializer commits
one bounded intent with the selected identities and exact expected preparation
bytes. This closes the crash window before the prepared receipt exists. Recovery
accepts only its own complete or prefix-written metadata, prior registration and
pending marker; foreign or changed evidence remains blocked. An incomplete owned
initialization can be cleared without consuming the 16-directory staging limit.
The initializer hands off to the durable prepared receipt and pending barrier
before its row is removed. The receipt records exact payload inventory, prior
registration hash/backup and operation UUID. Staging ownership records directory
device/inode identity. Copies
are bounded, verified again, then renamed within the store. New publication and
recovery both verify directory ownership and final payload bytes. The terminal
result is `slot_ready`; it does not mean registered, activated, healthy or installed.

Interrupted incomplete owned copies can become `unpublished` after safe cleanup.
Complete files require their expected content hashes before removal. Owned short
writes are distinguished explicitly. Changed complete files, extra entries,
replacement directories, registration changes and unverifiable evidence preserve
the barrier and existing files. Cancellation never releases the lease while owned
filesystem work continues. Recovery uses evidence rather than a PID heuristic.

## Bounds and repeat operations

The last 16 terminal operation receipts remain replayable. A separate immutable
provenance record binds each published artifact to its first publication and
directory identity. It survives receipt retirement. A fresh UUID for an already
verified slot creates a new receipt without copying or replacing the artifact.
Reusing a retained UUID with a different payload fails. Retirement has a durable
bounded plan of exact file hashes and directory identity; interruption can resume,
while changed or extra evidence remains preserved.

Storage is limited to 16 distinct slots and 8 GiB aggregate. `nnd_install_store_full`
refuses another artifact before publication. Automatic artifact pruning is absent
until a native maintenance policy can protect active and rollback slots. Operators
must not manually remove provenance or receipts to bypass a failed transaction.

## Completion requirements

Next, implement a continuous native lease handoff from staging to trial supervisor
startup, authenticated health acceptance, and one compare-and-swap registration
publication. Stable desktop/startup launchers must resolve that native selection.
Only then may the installer report completion. Initial rollback must keep data
schemas unchanged; selecting old binaries cannot undo a data migration. The
existing copy-in-place installer is not covered by immutable-slot acceptance.

Independent review covers concrete crash, reuse, retirement, altered evidence and
runtime closure failures. The installer-focused set passed 87 tests, including
eight actual child deaths during initialization and six during staging. The exact
Windows build passed 1,882 tests, with eight skips and zero failures; quality,
graph and language checks passed for 457 production modules. A disposable real
NND `20261002-8` payload was staged, replayed, separately registered and launched
through Electron again after the initializer repair. Chromium admission, browser
isolation and shell-independent native service lifetime passed. No operator
installation, registry startup change or deployment was performed by these tests.
