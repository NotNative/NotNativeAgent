# Architecture decision 0021: Native manifest transactions

Status: implemented foundation in `20261002-11`; Windows exercised, POSIX execution
not yet verified. Generic NND configuration HTTP mutation remains separate work.

## Ownership and source identity

NNA owns manifest persistence across first-run onboarding, provider bootstrap,
provider profile management and TUI configuration. These first-party writers use
the same canonical file identity and SQLite `BEGIN IMMEDIATE` mutex. The stable
private sibling storage and lock database are not deleted or replaced to unlock a
writer. Kernel database ownership ends when the process exits. Lock acquisition
is bounded; actual pending filesystem work settles before ownership is released.
Cancellation is not proof that publication stopped.

Writable targets must be bounded absolute local paths with safe ancestor ownership.
Links, multiple links, Windows alternate namespace aliases and unsupported filesystems
are refused. The recovery path recognizes only the exact two-link initial publication
described by its durable receipt, expected bytes and matching inode. Read-only
snapshots create no transaction directory. Missing writable parents must be prepared
by the owning caller. Windows uses operator/SYSTEM/Administrators private storage;
POSIX storage requires operator ownership and private modes, and existing targets
must not permit group or other writes. These checks are not protection from a
malicious process running as the operator or a privileged administrator.

## Persistence contract

`readManifestSnapshot(path)` returns the exact-byte SHA-256 revision and raw parsed
document. Missing files use the explicit `absent` revision. Malformed bytes remain
available for explicit repair. A document is bounded to 1 MiB.

`transactManifest` requires an expected revision, bounded operation ID, payload,
trusted typed transform and validator. `transactLockedManifest` and
`readLockedManifestSnapshot` use a genuine lease; forged or expired leases fail.
The latter reconciles pending receipts before a caller performs migration or
quarantine. Transforms receive clones rather than cached source objects.

Before publishing, the transaction retains exact prior bytes and records prepared
intent with before/after hashes and the staged file identity. JSON publication and
the receipt database are separate durable operations. Recovery compares current
bytes with those hashes: before means unpublished, after means saved, and a third
value preserves evidence and blocks the next writer. Initial creation uses an
atomic no-clobber link; replacement uses atomic rename. Noncooperating manual
editors do not acquire this mutex; this is a first-party writer protocol, not a
filesystem-wide atomic compare-and-swap against arbitrary editors.

Reusing an operation ID with changed payload or expected revision fails. The latest
128 terminal operations form the advertised replay window. Only terminal receipts
and their associated backups are evicted under ownership; pending evidence is
never evicted. Callers must not retry an operation older than that window as though
its result were unknown. Unknown publication results preserve possibly referenced
secrets. Bootstrap deletes a newly created secret only after confirmed unpublished
failure. Uncertain secret creation can leave an orphan; automatic orphan collection
is not implemented.

Persistence results distinguish saved, unpublished and unknown from runtime
application. A durable save does not imply a running engine accepted it. Operator
`.bak` compatibility files are published from exact snapshot bytes through private
staging; linked backup destinations are rejected.

## TUI configuration publication

Startup carries raw user/project/explicit documents, byte revisions, ordered source
snapshots and separate launch override provenance. Persistence patches only typed
requested fields or stable-ID provider/MCP records into the selected raw document.
It does not serialize effective defaults, project overlays or temporary launch
settings. Reset removes the explicit field and resolves lower sources. Repeated
selections of the same physical file update every corresponding snapshot together.

Edits controlled by a higher source or a temporary launch override fail with owning
source guidance. An inherited provider/MCP record cannot be materialized implicitly
into another source. Existing files without provenance refuse programmatic saves;
explicit `initializeManifest: true` permits absent-file initialization only without
overlays. Injected two-argument `manifestWriter(path, manifest)` adapters retain
ownership of their persistence and do not trigger implicit filesystem reads.

Runtime publication prepares engines before saving and attempts every prepared
session. After save, the persisted revision advances even when runtime application
fails; `configuration_saved_not_applied` reports that distinction. Receipt replay
does not replay runtime application. Session-only edits remain ephemeral.

## Verification and remaining integration

Tests cover real process death, competing processes, exact before/after/foreign
receipt recovery, first-create hardlink interruption, cancellation and unawaited
work ownership, receipt retention, stale revisions, layered resets, same-file source
selection, partial runtime application, backup links and credential preservation
after publication acknowledgement loss. Windows is the executed platform; POSIX
permission coverage is platform-conditional and remains unexecuted here.
The frozen `20261002-10` Windows build passed the complete sequential test run:
1,801 passed, eight skipped, zero failures (1,809 total). Native quality and current
graph/language checks passed for 440 production modules. The sequential run avoids
cross-test interference from fixtures that intentionally create global legacy NND
processes. Release certification and publisher signing are not claimed.
The independent OpenCode credential-presence commit `8666f05a` was then preserved
in the combined `20261002-11` candidate. Its merged protocol, transaction and source
checks passed 43 tests with two skips. The exact combined `20261002-11` Windows
build then passed all 1,802 tests with eight skips and zero failures (1,810 total).

NND still needs the scoped configuration catalog/read/save/repair API, authenticated
authority checks, browser expected-revision and operation-ID propagation, pending
application visibility and explicit service activation. OpenCode compatibility
configuration is a separate store. This decision does not change permission modes,
reviewer governance, integration authority or installed release certification.
