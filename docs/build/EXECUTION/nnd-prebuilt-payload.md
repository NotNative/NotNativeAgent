# Prebuilt NND payload contract

Status: exporter foundation; native transactional installation and rollback remain
open. This contract does not enable NSIS distribution or replace `install.ps1` yet.

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

## Remaining installation work

Native installation must own the data-root lease, bounded slot staging, registration
CAS, exact previous-registration backup and durable pending/completion evidence.
It must recover interruption before admitting a new writer and preserve uncertain
state. Native package registration is the sole authoritative active pointer.
Trial service activation and authenticated GUI health must succeed before the final
installer reports completion; setup-required is valid installation state.

Binary rollback cannot undo a data-schema migration. Initial slot activation must
require unchanged supported data schemas. Login startup, installer recovery,
uninstall and installed acceptance remain separate required L-series work.
