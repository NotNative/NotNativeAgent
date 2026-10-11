# Prebuilt NND payload contract

Status: exporter and native staging foundations, with an opt-in prebuilt staging
branch in `install.ps1`. Activation, rollback, and complete installation remain
open; this branch does not enable NSIS distribution.

## Build and export

Build the production GUI/server and Electron artifacts before exporting. The
exporter requires the current source/artifact build stamp before and after copying.
Run `node scripts/export-prebuilt-payload.mjs ABSOLUTE_NEW_DIRECTORY` on Windows
x64. The destination must not exist, must have an existing regular parent and must
not overlap the repository or resolved Electron dependency root. Export performs
no dependency installation, download or build.

The payload contains root product identity, the built web/server and native PTY,
the supervised entrypoint and its local module dependencies, the Electron shell
and its complete supported Windows runtime. Dependency-root junctions are resolved
deliberately; shipped files are plain independent copies. The existing `script`
install marker identifies the unpackaged installed shell. No selected NNA path,
credentials, user settings or source-development tests enter the artifact.

The future stable launcher must resolve the active native package registration and
pass `--nna-install-root` with the exact selected installation as a separate
argument. It must not write per-machine selection into an immutable version slot.
Current explicit native shell attachment already accepts that argument.

`scripts/resolve-active-nnd-package.mjs ABSOLUTE_SELECTION_FILE` is a read-only
launcher prerequisite. It checks the external pinned NNA installation/data IDs,
queries that selected NNA's `nnd package status` with its data root, requires the
registered root to be a child of that data root's immutable `versions` directory,
and verifies the complete prebuilt payload and slot name. It returns a launch
plan without starting a process or changing registration. Package status proves
registered bytes only; the activation-pending barrier can still prevent a usable
service. A future stable shortcut must preserve the external selection, recheck
native completion/health, and bind launch to the selected generation. Do not use
the resolver result alone as installation completion or activation evidence.

## Artifact identity

`NND_PAYLOAD.json` has exactly these fields:

```json
{
  "schema_version": "1.0",
  "version": "yyyymmdd-<increment>",
  "platform": "win32",
  "architecture": "x64",
  "files": [{"path": "relative/portable/path", "bytes": 123, "sha256": "64 lowercase hex characters"}]
}
```

File rows sort by exact portable path. The manifest excludes itself. SHA-256 of its
exact UTF-8 bytes identifies the prospective slot; native installation must verify
every row and reject unexpected payload entries. Hashes identify artifact bytes;
they do not establish publisher authenticity.

Limits: 20,000 files, 512 MiB per file and 2 GiB aggregate. Portable paths reject
traversal, alternate streams, Windows reserved names, trailing dots/spaces and
case-insensitive duplicate or file/ancestor collisions. Source links, hardlinks,
unknown file types, stale build identity and changed copied bytes are refused.
The resolved Electron dependency's bounded package metadata may be hardlinked by
pnpm; it is read and rechecked, never shipped. Copied runtime files remain subject
to the single-link requirement.
Destination parent checks precede child creation. Failed export removes only its
freshly created directory after proving its exact identity and parent.

## Acceptance evidence

The `20261002-7` Windows export contained 178 files. Its exact manifest SHA-256 was
`5134f4c6fe673169d7c15e37a469119f67d12afcd1d394f5e043afeb58241434`.
`electron-native-attach-smoke.mjs NNA_SOURCE --payload EXPORTED_ROOT` verified,
copied and reverified that artifact in a protected disposable installation. The
copied Electron runtime authenticated to the native-supervised GUI using Chromium's
one-use cookie, exposed no renderer bearer credential and refused an independent
browser. The service survived shell exit, then stopped through native control and
released its lease. The installed GUI payload remained byte-identical. This proves
artifact attachment against native `20261002-9`; it does not prove the unfinished
production installer or slot recovery.

## Native immutable staging

NNA owns `DATA_ROOT/runtime/nnd/install-slots`, bound to the selected canonical
installation and data identities. `nna nnd service stage-payload INSTALL_ROOT
PAYLOAD_ROOT OPERATION_UUID` validates the exact payload without executing its code,
holds the data-root lease and shared registration mutex, and publishes a verified
`versions/VERSION-PAYLOAD_SHA256` slot. Staging preserves package registration and
returns only `slot_ready`. `stage-recover INSTALL_ROOT [OPERATION_UUID]` reconciles
interruption; altered or uncertain evidence remains preserved behind an admission
barrier. These commands are the native staging foundation, not a complete installer.

Native destination admission must also bound final absolute file paths for Windows
runtime compatibility. Node's long-path copying alone does not prove Electron or
native PTY helpers can load those files. An overlong selected data root must fail
before transaction preparation, with guidance to select a supported shorter root.

Separate immutable provenance survives rolling retention of the last 16 terminal
operation receipts. A fresh operation ID can reuse a verified artifact without
replacing it. Retirement verifies exact evidence before removal and resumes its own
interrupted work. The store admits at most 16 distinct slots and 8 GiB aggregate;
automatic artifact pruning awaits an active/rollback-aware maintenance contract.

The `--native-slot` option on `electron-native-attach-smoke.mjs NNA_SOURCE --payload
EXPORTED_ROOT --native-slot` stages a real exported artifact in a disposable native
installation, verifies unchanged registration and recovery/reuse, then separately
registers the slot for Chromium attachment. This fixture registration does not
implement production trial activation. Failed native staging fixtures are preserved
because a rejected operation alone cannot prove all owned writers have stopped.

The `20261002-8` Windows candidate exported 178 files with exact manifest SHA-256
`26fa67698d145666943aff7804361af3a09c16b200fed4a312b7fed3201fdd80`.
Its native-stage probe verified slot recovery and fresh-operation reuse, launched
the copied Electron runtime, authenticated Chromium by one-use cookie without a
renderer bearer, rejected an independent browser, and confirmed native service
survival after shell exit and clean stop. The native staging path guard rejected
an earlier overlong fixture before publication; a shorter disposable path passed.

## Remaining installation work

`install.ps1 -StagePrebuiltPayload -PrebuiltPayloadRoot ABSOLUTE_DIRECTORY
-PrebuiltManifestSha256 TRUSTED_SHA256` is a narrow installer entry for the
existing native staging foundation. It can install a carried NNA dependency
after checking the payload root, target separation, manifest bound, version
shape, and externally pinned exact manifest digest. It then validates selected
NNA capabilities and invokes NNA's bounded `stage-payload` command using the
selected NNA Node runtime. No `node` or `pnpm` command on `PATH` is required.
It then creates a distinct activation operation ID and proves the immutable slot
through NNA's bounded `activation-preflight` command. The installer displays and
keeps those UUIDs distinct. Preflight failure remains explicit staging recovery
evidence and cannot become installed or attached.
For an existing NND install, pinned selection identities must still match the
selected NNA capabilities before staging; a changed data root is refused.
It does not copy into the active NND install, update registration or shortcuts,
launch a service, or claim an installed GUI. A failed or uncertain native
response prints the operation UUID for explicit `stage-recover`; it does not
delete evidence or guess rollback. A `slot_ready` result is inert pending
transactional activation. The source-build path remains separate.

`install.ps1 -ActivatePrebuiltSlot -PrebuiltStageOperation STAGE_UUID
-PrebuiltPayloadRoot ABSOLUTE_DIRECTORY -PrebuiltManifestSha256 TRUSTED_SHA256`
is an isolated activation entry. It verifies the same trusted payload and
selected NNA identity, runs an exact activation preflight, then starts NNA's
retained `activate-slot` owner detached and binds the preflight candidate
evidence and active registration hash to the reported root and version. Success
reports the activation operation, slot root, and package version. It performs
registration/activation only; it does not start the service or sample an attach
proof - service start and health are operator actions (`nna desktop start`).
Failure reports the stage UUID and an uncertain retained owner; do not retry
blindly. The activation mode accepts only its payload, stage operation, NNA
root, and NND target arguments. This slice still neither copies the active
target, writes a stable selection anchor, nor creates shortcuts.

`install.ps1 -Uninstall` now distinguishes the public launcher anchor from the
immutable native package. A prebuilt target must bind the selected NNA identities
and exact `versions/version-payload_sha256` slot. Uninstall confirms that slot
registration through the selected NNA, deactivates the slot, and removes only the
fresh anchor and shortcuts. The immutable NNA slot, provenance and user data are
preserved unless `-PurgeData` is explicitly requested. An Electron child running
from that exact native slot refuses removal.

`install.ps1 -RecoverPrebuiltStageOperation OPERATION_UUID` delegates that
reconciliation to the already selected installed NNA. It checks the existing
selection pin and native capability identity before invoking `stage-recover`,
requires the exact requested operation ID in a bounded terminal response, and
reports either `slot_ready` or `unpublished`. It does not bootstrap a different
NNA, change package registration, create shortcuts, or mark activation complete.
An explicit NNA root cannot override an installed NND selection; this also
protects source upgrades and uninstall from silently switching native owners.

The installer delegates to native staging and compare-and-swaps the sole native
package registration, without starting or trialing a live service.
Previous-registration backups and durable staging evidence already exist.
The installer reports completion on successful registration/activation; the
operator verifies service behavior afterwards with `nna desktop start` (a fresh
unconfigured installation reaching setup-required is valid). The shortcuts are
NNA-branded (`NotNativeAgent.lnk` / `notnativeagent.desktop`, NNA icon assets),
and a Windows upgrade removes the stale pre-rename `NotNativeDesktop.lnk`.

Binary rollback cannot undo a data-schema migration. The payload manifest may
declare a bounded `data_schema` (absent = the historical first schema); the
retained anchor records the schema it binds, and slot activation refuses a
payload whose declared schema differs from the operator's existing anchor
before any native staging call, stating the backup/restore requirement. The
migration execution path itself (a verified backup/restore transaction for a
future schema change) is not implemented. Login startup, installer recovery,
uninstall and installed acceptance remain separate required L-series work.
