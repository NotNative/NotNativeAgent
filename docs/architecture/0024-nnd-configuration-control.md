# Architecture decision 0024: Native NND configuration control

Status: `20261002-14` bounded user-manifest implementation. This decision records the bounded user-manifest
control plane; complete NNA settings coverage and installed NND GUI acceptance
remain separate work.

## Boundary

NNA owns configuration resolution, validation, persistence and permission checks.
The optional NND service calls authenticated native routes at
`/v1/nnd/configuration`. The same NND web service presents browser and Electron
clients; neither client writes NNA files or becomes a configuration authority.
The NNA TUI retains its own tabs, contexts and session identity.

Only the selected user manifest is writable through this adapter. An explicitly
selected absolute workspace is required. A trusted project file may overlay that
workspace but cannot change the selected root; its values are read through the
same native resolver and cannot be silently persisted into the user file. The
native options retain authenticated NND authority rather than accepting hosted
grants from a project file. Provider reads in the native service use this effective
resolution while provider mutations continue to target the raw user document.

## Protocol

The authenticated listener exposes catalog, read, preview, save, repair and
operation-receipt routes. Native principal permissions distinguish read, manage
and repair. The supervised listener derives that principal inside NNA and does
not accept browser authority headers as a grant. Requests carry selected
installation/data identity, user scope and an exact selected-source revision.
Preview and save also carry an observed resolution revision, so changed trust or
project overlays force refresh. Save and repair require a stable operation ID;
receipts remain bound to identity and authenticated subject across restart.
The HTTP catalog marks only the finite native user-scope allowlist as available
and names its required manage permission. It does not change the static catalog
or grant that permission to a caller.

The editable set is a finite allowlist of scalar or bounded array manifest
fields. It excludes grants, workspace switching, credential references, provider
collections, MCP collections and unknown extensions. A save patches only the
selected raw source, preserving private unknown fields. Reset removes its raw
override so lower layers resolve normally. Native validators check the complete
candidate before publication. Missing or invalid selected files are never
replaced by a normal save; repair is an explicit, separately authorized operation
that backs up the original and validates the replacement and trusted overlay.

Read and preview return an allowlisted projection of explicit and effective
values, revisions, source state and application state. Unknown containers,
credential references and MCP arguments remain withheld. A resolved value with
no reliable provenance says so instead of inventing a source. Raw source bytes,
parser text and native paths must not cross the HTTP error boundary. Saved
receipts report `not_applied`; they do not claim that existing sessions or the
running engine adopted new settings. The setup/repair routes remain reachable
when execution is unavailable.

## Remaining work

The descriptive 223-field catalog does not itself authorize an edit. This
adapter covers only its finite user-manifest allowlist. Provider and MCP
collections, credentials, trust, hooks, skills, nonmanifest stores and TUI
preferences need their native typed actions and GUI controls. NND still needs a
typed client, source-aware settings page, revision conflict handling and actual
browser/Electron acceptance. Installed lifecycle, feature parity and release
certification remain independent gates.

## Verification

The source, service, route, projection and failure-taxonomy focused set passed
40 tests on the native immutable-slot base. It includes live authenticated HTTP
read/preview access during setup-required, exact revision conflicts, durable
operation replay, explicit repair, trusted project scope and an error-response
regression that withholds private source keys and paths. The exact Windows build
passed 1,915 tests, with eight skips and zero failures. Quality, graph and
language checks passed for 462 production modules. Installed browser/Electron
settings acceptance remains a separate NND consumer gate.
